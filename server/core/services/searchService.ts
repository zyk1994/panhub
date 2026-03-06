import pLimit from "p-limit";
import { UnifiedCache, CacheNamespace } from "../cache/unifiedCache";
import { safeExecute, fetchWithRetry } from "../utils/fetch";
import type {
  MergedLinks,
  SearchRequest,
  SearchResponse,
  SearchResult,
} from "../types/models";
import { PluginManager, type AsyncSearchPlugin } from "../plugins/manager";
import { PluginHealthChecker, createPluginHealthChecker } from "../plugins/pluginHealth";
import { ErrorCollector, classifyError, ErrorType } from "../utils/errors";

export interface SearchServiceOptions {
  priorityChannels: string[];
  defaultChannels: string[];
  defaultConcurrency: number;
  pluginTimeoutMs: number;
  cacheEnabled: boolean;
  cacheTtlMinutes: number;
}

export class SearchService {
  private options: SearchServiceOptions;
  private pluginManager: PluginManager;
  private cache: UnifiedCache;
  private errorCollector: ErrorCollector;
  private healthChecker: PluginHealthChecker;

  constructor(options: SearchServiceOptions, pluginManager: PluginManager) {
    this.options = options;
    this.pluginManager = pluginManager;
    this.cache = new UnifiedCache(
      {
        enabled: options.cacheEnabled,
        ttlMinutes: options.cacheTtlMinutes,
      },
      "search"
    );

    this.healthChecker = createPluginHealthChecker();
    this.errorCollector = new ErrorCollector();
  }

  getPluginManager() {
    return this.pluginManager;
  }

  async search(
    keyword: string,
    channels: string[] | undefined,
    concurrency: number | undefined,
    forceRefresh: boolean | undefined,
    resultType: string | undefined,
    sourceType: "all" | "tg" | "plugin" | undefined,
    plugins: string[] | undefined,
    cloudTypes: string[] | undefined,
    ext: Record<string, any> | undefined
  ): Promise<SearchResponse> {
    // 日志已精简：只在搜索完成时打印结果，避免重复打印用户搜索词

    const effChannels =
      channels && channels.length > 0 ? channels : this.options.defaultChannels;
    const effConcurrency =
      concurrency && concurrency > 0
        ? concurrency
        : this.options.defaultConcurrency;
    const effResultType =
      !resultType || resultType === "merge" ? "merged_by_type" : resultType;
    const effSourceType = sourceType ?? "all";

    let tgResults: SearchResult[] = [];
    let pluginResults: SearchResult[] = [];

    const tasks: Array<() => Promise<void>> = [];

    if (effSourceType === "all" || effSourceType === "tg") {
      tasks.push(async () => {
        const concOverride =
          typeof concurrency === "number" && concurrency > 0
            ? concurrency
            : undefined;
        tgResults = await this.searchTG(
          keyword,
          effChannels,
          !!forceRefresh,
          concOverride,
          ext
        );
      });
    }
    if (effSourceType === "all" || effSourceType === "plugin") {
      tasks.push(async () => {
        pluginResults = await this.searchPlugins(
          keyword,
          plugins,
          !!forceRefresh,
          effConcurrency,
          ext ?? {}
        );
      });
    }

    await Promise.all(tasks.map((t) => t()));

    const allResults = this.mergeSearchResults(tgResults, pluginResults);
    this.sortResultsByTimeDesc(allResults);

    const filteredForResults: SearchResult[] = [];
    for (const r of allResults) {
      const hasTime = !!r.datetime;
      const hasLinks = Array.isArray(r.links) && r.links.length > 0;
      const keywordPriority = this.getKeywordPriority(r.title);
      const pluginLevel = this.getPluginLevelBySource(this.getResultSource(r));
      if (hasTime || hasLinks || keywordPriority > 0 || pluginLevel <= 2)
        filteredForResults.push(r);
    }

    const mergedLinks = this.mergeResultsByType(
      allResults,
      keyword,
      cloudTypes
    );

    let total = 0;
    let response: SearchResponse = { total: 0 };
    if (effResultType === "merged_by_type") {
      total = Object.values(mergedLinks).reduce(
        (sum, arr) => sum + arr.length,
        0
      );
      response = { total, merged_by_type: mergedLinks };
    } else if (effResultType === "results") {
      total = filteredForResults.length;
      response = { total, results: filteredForResults };
    } else {
      // all
      total = filteredForResults.length;
      response = {
        total,
        results: filteredForResults,
        merged_by_type: mergedLinks,
      };
    }

    return response;
  }

  private async searchTG(
    keyword: string,
    channels: string[] | undefined,
    forceRefresh: boolean,
    concurrencyOverride?: number,
    ext?: Record<string, any>
  ): Promise<SearchResult[]> {
    const chList = Array.isArray(channels) ? channels : [];
    const cacheKey = `tg:${keyword}:${[...chList].sort().join(",")}`;
    const { cacheEnabled, cacheTtlMinutes, priorityChannels } = this.options;

    // 缓存检查
    if (!forceRefresh && cacheEnabled) {
      const cached = this.cache.get(CacheNamespace.TG_SEARCH, cacheKey);
      if (cached.hit && cached.value) {
        return cached.value;
      }
    }

    // 获取配置
    const { fetchTgChannelPosts } = await import("./tg");
    const perChannelLimit = 30;
    const requestedTimeout = Number((ext as any)?.__plugin_timeout_ms) || 0;
    const timeoutMs = Math.max(
      3000,
      requestedTimeout > 0
        ? requestedTimeout
        : this.options.pluginTimeoutMs || 0
    );
    const concurrency = Math.max(
      2,
      Math.min(concurrencyOverride ?? this.options.defaultConcurrency, 12)
    );

    // 分批策略：优先频道 + 普通频道
    const prioritySet = new Set(priorityChannels || []);
    const priorityList = chList.filter((ch) => prioritySet.has(ch));
    const normalList = chList.filter((ch) => !prioritySet.has(ch));

    // 辅助函数：创建频道搜索任务
    const createChannelTask = (channel: string) => async () => {
      const result = await safeExecute(
        () =>
          this.withTimeout<SearchResult[]>(
            fetchTgChannelPosts(channel, keyword, {
              limitPerChannel: perChannelLimit,
            }),
            timeoutMs,
            []
          ),
        []
      );
      return result;
    };

    // 所有任务并发执行（优先频道和普通频道并行）
    const allTasks = [...priorityList, ...normalList].map(createChannelTask);
    const allResults = await this.runWithConcurrency(allTasks, concurrency);

    // 合并结果
    const results: SearchResult[] = [];
    for (const arr of allResults) {
      if (Array.isArray(arr)) {
        results.push(...arr);
      }
    }

    // 缓存结果
    if (cacheEnabled && results.length > 0) {
      this.cache.set(CacheNamespace.TG_SEARCH, cacheKey, results);
    }

    return results;
  }

  private async searchPlugins(
    keyword: string,
    plugins: string[] | undefined,
    forceRefresh: boolean,
    concurrency: number,
    ext: Record<string, any>
  ): Promise<SearchResult[]> {
    const cacheKey = `plugin:${keyword}:${(plugins ?? [])
      .map((p) => p?.toLowerCase())
      .filter(Boolean)
      .sort()
      .join(",")}`;
    const { cacheEnabled, cacheTtlMinutes } = this.options;

    if (!forceRefresh && cacheEnabled) {
      const cached = this.cache.get(CacheNamespace.PLUGIN_SEARCH, cacheKey);
      if (cached.hit && cached.value) {
        return cached.value;
      }
    }

    const allPlugins = this.pluginManager.getPlugins();
    
    // 过滤掉不健康的插件（熔断器开启的插件）
    const healthyPlugins = allPlugins.filter((p) => 
      this.healthChecker.isHealthy(p.name())
    );
    
    let available: AsyncSearchPlugin[] = [];
    if (plugins && plugins.length > 0 && plugins.some((p) => !!p)) {
      const wanted = new Set(plugins.map((p) => p.toLowerCase()));
      available = healthyPlugins.filter((p) => wanted.has(p.name().toLowerCase()));
    } else {
      available = healthyPlugins;
    }

    const requestedTimeout = Number((ext as any)?.__plugin_timeout_ms) || 0;
    const timeoutMs = Math.max(
      3000,
      requestedTimeout > 0
        ? requestedTimeout
        : this.options.pluginTimeoutMs || 0
    );

    // 使用 safeExecuteAll 统一处理错误，避免单个插件失败影响整体
    const pluginPromises = available.map((p) => async () => {
      p.setMainCacheKey(cacheKey);
      p.setCurrentKeyword(keyword);

      const startTime = Date.now();
      const pluginName = p.name();

      // 主搜索
      let results = await this.withTimeout<SearchResult[]>(
        p.search(keyword, ext),
        timeoutMs,
        []
      );

      // 记录健康状态
      const responseTime = Date.now() - startTime;
      if (results && results.length > 0) {
        this.healthChecker.recordSuccess(pluginName, responseTime);
      } else {
        // 超时或无结果记录为失败
        this.healthChecker.recordFailure(pluginName);
      }

      // 短关键词兜底逻辑
      if (
        (!results || results.length === 0) &&
        (keyword || "").trim().length <= 1
      ) {
        const fallbacks = ["电影", "movie", "1080p"];
        for (const fb of fallbacks) {
          const fallbackResults = await this.withTimeout<SearchResult[]>(
            p.search(fb, ext),
            timeoutMs,
            []
          );
          if (fallbackResults && fallbackResults.length > 0) {
            results = fallbackResults;
            break;
          }
        }
      }

      return results || [];
    });

    // 使用并发控制执行，同时利用 safeExecuteAll 提供统一错误处理
    const resultsByPlugin = await this.runWithConcurrency(
      pluginPromises.map((promiseFactory) => async () => {
        try {
      const result = await promiseFactory();
      return result;
    } catch (error) {
      // 记录错误
      const errorDetail = classifyError(error, "plugin_search");
      this.errorCollector.record(errorDetail);
      return [];
    }
      }),
      concurrency
    );

    const merged: SearchResult[] = [];
    for (const arr of resultsByPlugin) {
      if (Array.isArray(arr)) {
        merged.push(...arr);
      }
    }

    if (cacheEnabled && merged.length > 0) {
      this.cache.set(CacheNamespace.PLUGIN_SEARCH, cacheKey, merged);
    }

    return merged;
  }

  private withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    fallback: T
  ): Promise<T> {
    if (!ms || ms <= 0) return promise;
    let timeoutHandle: any;
    const timeoutPromise = new Promise<T>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(fallback), ms);
    });
    return Promise.race([
      promise.finally(() => clearTimeout(timeoutHandle)),
      timeoutPromise,
    ]) as Promise<T>;
  }

  private mergeSearchResults(
    a: SearchResult[],
    b: SearchResult[]
  ): SearchResult[] {
    const seen = new Set<string>();
    const out: SearchResult[] = [];
    const pushUnique = (r: SearchResult) => {
      const key = r.unique_id || r.message_id || `${r.title}|${r.channel}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(r);
    };
    for (const r of a) pushUnique(r);
    for (const r of b) pushUnique(r);
    return out;
  }

  private sortResultsByTimeDesc(arr: SearchResult[]) {
    arr.sort(
      (x, y) => new Date(y.datetime).getTime() - new Date(x.datetime).getTime()
    );
  }

  private getResultSource(_r: SearchResult): string {
    // 可根据 SearchResult 增补来源字段，这里返回空表示未知
    return "";
  }

  private getPluginLevelBySource(_source: string): number {
    return 3;
  }
  private getKeywordPriority(_title: string): number {
    return 0;
  }

  public mergeResultsByType(
    results: SearchResult[],
    _keyword: string,
    cloudTypes?: string[]
  ): MergedLinks {
    const allow =
      cloudTypes && cloudTypes.length > 0
        ? new Set(cloudTypes.map((s) => s.toLowerCase()))
        : undefined;
    const out: MergedLinks = {};
    for (const r of results) {
      for (const link of r.links || []) {
        const t = (link.type || "").toLowerCase();
        if (allow && !allow.has(t)) continue;
        if (!out[t]) out[t] = [];
        out[t].push({
          url: link.url,
          password: link.password,
          note: r.title,
          datetime: r.datetime,
          images: r.images,
        });
      }
    }
    return out;
  }

  private async runWithConcurrency<T>(
    tasks: Array<() => Promise<T>>,
    limit: number
  ): Promise<T[]> {
    const limitFn = pLimit(limit);
    const limitedTasks = tasks.map((task) => limitFn(task));
    return Promise.all(limitedTasks);
  }

  getCacheStats() {
    return this.cache.getStats();
  }

  clearCache(namespace?: CacheNamespace) {
    if (namespace) {
      this.cache.clearNamespace(namespace);
    } else {
      this.cache.clearAll();
    }
  }

  getPluginHealthStatus() {
    return this.healthChecker.getAllStatus();
  }

  getWarnings() {
    return this.errorCollector.getWarnings();
  }


  // 流式搜索 TG 频道
  async searchTGStream(
    keyword: string,
    channels: string[] | undefined,
    forceRefresh: boolean,
    concurrency: number | undefined,
    ext: Record<string, any> | undefined,
    onProgress: (results: SearchResult[], isBatch: boolean) => void
  ): Promise<SearchResult[]> {
    const chList = Array.isArray(channels) ? channels : [];
    const cacheKey = `tg:${keyword}:${[...chList].sort().join(",")}`;
    const { cacheEnabled, priorityChannels } = this.options;

    // 缓存检查
    if (!forceRefresh && cacheEnabled) {
      const cached = this.cache.get(CacheNamespace.TG_SEARCH, cacheKey);
      if (cached.hit && cached.value) {
        onProgress(cached.value, true);
        return cached.value;
      }
    }

    const { fetchTgChannelPosts } = await import("./tg");
    const perChannelLimit = 30;
    const requestedTimeout = Number((ext as any)?.__plugin_timeout_ms) || 0;
    const timeoutMs = Math.max(
      3000,
      requestedTimeout > 0
        ? requestedTimeout
        : this.options.pluginTimeoutMs || 0
    );
    const effConcurrency = Math.max(2, Math.min(concurrency ?? this.options.defaultConcurrency, 12));

    const prioritySet = new Set(priorityChannels || []);
    const priorityList = chList.filter((ch) => prioritySet.has(ch));
    const normalList = chList.filter((ch) => !prioritySet.has(ch));

    const createChannelTask = (channel: string) => async () => {
      const result = await safeExecute(
        () =>
          this.withTimeout<SearchResult[]>(
            fetchTgChannelPosts(channel, keyword, {
              limitPerChannel: perChannelLimit,
            }),
            timeoutMs,
            []
          ),
        []
      );
      return result;
    };

    // 所有频道任务
    const allTasks = [...priorityList, ...normalList].map(createChannelTask);
    
    // 分批执行，每批完成后立即推送
    const limitFn = pLimit(effConcurrency);
    let allResults: SearchResult[] = [];
    
    for (const task of allTasks) {
      const result = await limitFn(task);
      if (Array.isArray(result) && result.length > 0) {
        allResults.push(...result);
        onProgress(result, false); // 每个频道完成时推送
      }
    }

    if (cacheEnabled && allResults.length > 0) {
      this.cache.set(CacheNamespace.TG_SEARCH, cacheKey, allResults);
    }

    // 最终推送所有结果
    onProgress(allResults, true);
    return allResults;
  }

  // 流式搜索插件
  async searchPluginsStream(
    keyword: string,
    plugins: string[] | undefined,
    forceRefresh: boolean,
    concurrency: number,
    ext: Record<string, any>,
    onProgress: (results: SearchResult[], pluginName: string) => void
  ): Promise<SearchResult[]> {
    const cacheKey = `plugin:${keyword}:${(plugins ?? [])
      .map((p) => p?.toLowerCase())
      .filter(Boolean)
      .sort()
      .join(",")}`;
    const { cacheEnabled } = this.options;

    if (!forceRefresh && cacheEnabled) {
      const cached = this.cache.get(CacheNamespace.PLUGIN_SEARCH, cacheKey);
      if (cached.hit && cached.value) {
        onProgress(cached.value, "all");
        return cached.value;
      }
    }

    const allPlugins = this.pluginManager.getPlugins();
    const healthyPlugins = allPlugins.filter((p) => 
      this.healthChecker.isHealthy(p.name())
    );
    
    let available: typeof allPlugins = [];
    if (plugins && plugins.length > 0 && plugins.some((p) => !!p)) {
      const wanted = new Set(plugins.map((p) => p.toLowerCase()));
      available = healthyPlugins.filter((p) => wanted.has(p.name().toLowerCase()));
    } else {
      available = healthyPlugins;
    }

    const requestedTimeout = Number((ext as any)?.__plugin_timeout_ms) || 0;
    const timeoutMs = Math.max(
      3000,
      requestedTimeout > 0
        ? requestedTimeout
        : this.options.pluginTimeoutMs || 0
    );

    // 每个插件单独执行，完成后立即推送
    const limitFn = pLimit(concurrency);
    let allResults: SearchResult[] = [];
    
    for (const plugin of available) {
      const pluginTask = async () => {
        plugin.setMainCacheKey(cacheKey);
        plugin.setCurrentKeyword(keyword);

        const startTime = Date.now();
        const pluginName = plugin.name();

        let results = await this.withTimeout<SearchResult[]>(
          plugin.search(keyword, ext),
          timeoutMs,
          []
        );

        const responseTime = Date.now() - startTime;
        if (results && results.length > 0) {
          this.healthChecker.recordSuccess(pluginName, responseTime);
        } else {
          this.healthChecker.recordFailure(pluginName);
        }

        // 短关键词兜底
        if (
          (!results || results.length === 0) &&
          (keyword || "").trim().length <= 1
        ) {
          const fallbacks = ["电影", "movie", "1080p"];
          for (const fb of fallbacks) {
            const fallbackResults = await this.withTimeout<SearchResult[]>(
              plugin.search(fb, ext),
              timeoutMs,
              []
            );
            if (fallbackResults && fallbackResults.length > 0) {
              results = fallbackResults;
              break;
            }
          }
        }

        return { results: results || [], pluginName };
      };

      const { results, pluginName } = await limitFn(pluginTask);
      if (results.length > 0) {
        allResults.push(...results);
        onProgress(results, pluginName); // 每个插件完成时推送
      }
    }

    if (cacheEnabled && allResults.length > 0) {
      this.cache.set(CacheNamespace.PLUGIN_SEARCH, cacheKey, allResults);
    }

    return allResults;
  }
  clearErrors(source?: string) {
    this.errorCollector.clear(source);
  }

  resetPluginHealth(pluginName?: string) {
    if (pluginName) {
      this.healthChecker.reset(pluginName);
    } else {
      this.healthChecker.resetAll();
    }
  }
}
