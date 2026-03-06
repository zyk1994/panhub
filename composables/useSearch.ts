import type { MergedLinks, GenericResponse, SearchResponse } from "~/server/core/types/models";
import { useSearchStore } from "~/stores/searchStore";
import { ALL_PLUGIN_NAMES } from "~/config/plugins";

export interface SearchOptions {
  apiBase: string;
  keyword: string;
  settings: {
    enabledPlugins: string[];
    enabledTgChannels: string[];
    concurrency: number;
    pluginTimeoutMs: number;
  };
}

export function useSearch() {
  const searchStore = useSearchStore();

  // 使用 storeToRefs 来正确处理响应式
  const loading = computed(() => searchStore.loading);
  const deepLoading = computed(() => searchStore.deepLoading);
  const paused = computed(() => searchStore.paused);
  const error = computed(() => searchStore.error);
  const searched = computed(() => searchStore.searched);
  const elapsedMs = computed(() => searchStore.elapsedMs);
  const total = computed(() => searchStore.total);
  const merged = computed(() => searchStore.merged);
  const hasResults = computed(() => searchStore.hasResults);
  const platforms = computed(() => searchStore.platforms);

  let searchSeq = 0;
  const activeControllers: AbortController[] = [];

  // 取消所有进行中的请求
  function cancelActiveRequests(): void {
    for (const controller of activeControllers) {
      try {
        controller.abort();
      } catch {}
    }
    activeControllers.length = 0;
  }

  // 暂停搜索
  function pauseSearch(): void {
    if (searchStore.loading || searchStore.deepLoading) {
      searchStore.setPaused(true);
      // 取消当前的请求，但保留已获取的结果
      cancelActiveRequests();
    }
  }

  // 继续搜索（从暂停处继续）
  async function continueSearch(options: SearchOptions): Promise<void> {
    if (!searchStore.paused || !searchStore.searched) return;

    searchStore.setPaused(false);
    searchStore.setDeepLoading(true);

    // 继续执行深度搜索
    const mySeq = ++searchSeq;
    try {
      await performDeepSearch(options, mySeq);
    } catch (error) {
      // 忽略错误
    } finally {
      searchStore.setDeepLoading(false);
    }
  }

  // 合并按类型分组的结果
  function mergeMergedByType(
    target: MergedLinks,
    incoming?: MergedLinks
  ): MergedLinks {
    if (!incoming) return target;
    const out: MergedLinks = { ...target };
    for (const type of Object.keys(incoming)) {
      const existed = out[type] || [];
      const next = incoming[type] || [];
      const seen = new Set<string>(existed.map((x) => x.url));
      const mergedArr = [...existed];
      for (const item of next) {
        if (!seen.has(item.url)) {
          seen.add(item.url);
          mergedArr.push(item);
        }
      }
      out[type] = mergedArr;
    }
    return out;
  }

  // 执行单个搜索请求
  async function executeSearchRequest(
    url: string,
    params: Record<string, any>,
    signal: AbortController
  ): Promise<SearchResponse | null> {
    try {
      const response = await $fetch<GenericResponse<SearchResponse>>(url, {
        method: "GET",
        query: params,
        signal: signal.signal,
      } as any);
      return response.data || null;
    } catch (error: any) {
      // 请求失败或被中止，返回 null
      return null;
    }
  }

  // 快速搜索（第一批）
  async function performFastSearch(
    options: SearchOptions
  ): Promise<MergedLinks> {
    const { apiBase, keyword, settings } = options;
    const conc = Math.min(16, Math.max(1, Number(settings.concurrency || 3)));
    const batchSize = conc;

    // 插件批次
    const fastPlugins = settings.enabledPlugins.slice(0, conc);
    // TG 频道批次
    const fastTg = settings.enabledTgChannels.slice(0, batchSize);

    const promises: Array<Promise<SearchResponse | null>> = [];

    // 插件请求
    if (fastPlugins.length > 0) {
      const ac = new AbortController();
      activeControllers.push(ac);
      promises.push(
        executeSearchRequest(
          `${apiBase}/search`,
          {
            kw: keyword,
            res: "merged_by_type",
            src: "plugin",
            plugins: fastPlugins.join(","),
            conc: conc,
            ext: JSON.stringify({ __plugin_timeout_ms: settings.pluginTimeoutMs }),
          },
          ac
        )
      );
    }

    // TG 频道请求
    if (fastTg.length > 0) {
      const ac = new AbortController();
      activeControllers.push(ac);
      promises.push(
        executeSearchRequest(
          `${apiBase}/search`,
          {
            kw: keyword,
            res: "merged_by_type",
            src: "tg",
            channels: fastTg.join(","),
            conc: conc,
            ext: JSON.stringify({ __plugin_timeout_ms: settings.pluginTimeoutMs }),
          },
          ac
        )
      );
    }

    const results = await Promise.all(promises);
    let merged: MergedLinks = {};
    for (const r of results) {
      if (r?.merged_by_type) {
        merged = mergeMergedByType(merged, r.merged_by_type);
      }
    }
    return merged;
  }

  // 深度搜索（后续批次）
  async function performDeepSearch(
    options: SearchOptions,
    mySeq: number
  ): Promise<void> {
    const { apiBase, keyword, settings } = options;
    const conc = Math.min(16, Math.max(1, Number(settings.concurrency || 3)));
    const batchSize = conc;

    // 剩余插件
    const restPlugins = settings.enabledPlugins.slice(conc);
    const pluginBatches: string[][] = [];
    for (let i = 0; i < restPlugins.length; i += batchSize) {
      pluginBatches.push(restPlugins.slice(i, i + batchSize));
    }

    // 剩余 TG 频道
    const restTg = settings.enabledTgChannels.slice(batchSize);
    const tgBatches: string[][] = [];
    for (let i = 0; i < restTg.length; i += batchSize) {
      tgBatches.push(restTg.slice(i, i + batchSize));
    }

    const maxLen = Math.max(pluginBatches.length, tgBatches.length);

    for (let i = 0; i < maxLen; i++) {
      if (mySeq !== searchSeq) break;
      // 检查是否暂停
      if (searchStore.paused) break;

      const reqs: Array<Promise<SearchResponse | null>> = [];

      // 插件批次
      const pb = pluginBatches[i];
      if (pb && pb.length) {
        const ac = new AbortController();
        activeControllers.push(ac);
        reqs.push(
          executeSearchRequest(
            `${apiBase}/search`,
            {
              kw: keyword,
              res: "merged_by_type",
              src: "plugin",
              plugins: pb.join(","),
              conc: conc,
              ext: JSON.stringify({ __plugin_timeout_ms: settings.pluginTimeoutMs }),
            },
            ac
          )
        );
      }

      // TG 批次
      const tb = tgBatches[i];
      if (tb && tb.length) {
        const ac = new AbortController();
        activeControllers.push(ac);
        reqs.push(
          executeSearchRequest(
            `${apiBase}/search`,
            {
              kw: keyword,
              res: "merged_by_type",
              src: "tg",
              channels: tb.join(","),
              conc: conc,
              ext: JSON.stringify({ __plugin_timeout_ms: settings.pluginTimeoutMs }),
            },
            ac
          )
        );
      }

      if (reqs.length === 0) continue;

      try {
        const resps = await Promise.all(reqs);
        for (const r of resps) {
          if (!r || mySeq !== searchSeq) continue;
          if (r.merged_by_type) {
            searchStore.updateMerged({
              [Object.keys(r.merged_by_type)[0]]: r.merged_by_type[Object.keys(r.merged_by_type)[0]]
            });
          }
        }
        // 更新总数
        searchStore.setTotal(
          Object.values(searchStore.merged).reduce(
            (sum, arr) => sum + (arr?.length || 0),
            0
          )
        );
      } catch (error) {
        // 单批失败忽略
      }
    }
  }

  // 主搜索函数
  async function performSearch(options: SearchOptions): Promise<void> {
    const { keyword, settings } = options;

    // 验证
    if (!keyword || keyword.trim().length === 0) {
      searchStore.setError("请输入搜索关键词");
      return;
    }

    const enabledPlugins = settings.enabledPlugins.filter((n) =>
      ALL_PLUGIN_NAMES.includes(n as any)
    );

    if (
      (settings.enabledTgChannels?.length || 0) === 0 &&
      enabledPlugins.length === 0
    ) {
      searchStore.setError("请先在设置中选择至少一个搜索来源");
      return;
    }

    // iOS Safari 兼容性：确保输入框失去焦点
    if (
      typeof window !== "undefined" &&
      document.activeElement instanceof HTMLInputElement
    ) {
      document.activeElement.blur();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // 重置状态
    searchStore.setLoading(true);
    searchStore.setError("");
    searchStore.setSearched(true);
    searchStore.setElapsedMs(0);
    searchStore.setTotal(0);
    searchStore.setMerged({});
    searchStore.setDeepLoading(false);

    const mySeq = ++searchSeq;
    const start = performance.now();

    try {
      // 1) 快速搜索
      const fastMerged = await performFastSearch(options);
      if (mySeq !== searchSeq) return;

      searchStore.setMerged(fastMerged);
      searchStore.setTotal(
        Object.values(fastMerged).reduce(
          (sum, arr) => sum + (arr?.length || 0),
          0
        )
      );

      // 2) 深度搜索
      searchStore.setDeepLoading(true);
      await performDeepSearch(options, mySeq);
      // 如果暂停了，停止后续操作
      if (searchStore.paused) return;
    } catch (error: any) {
      searchStore.setError(error?.data?.message || error?.message || "请求失败");
    } finally {
      searchStore.setElapsedMs(Math.round(performance.now() - start));
      // 如果暂停了，保持 loading 状态，只取消 deepLoading
      if (!searchStore.paused) {
        searchStore.setLoading(false);
      }
      searchStore.setDeepLoading(false);
    }
  }

  // 重置搜索
  function resetSearch(): void {
    cancelActiveRequests();
    searchSeq++;
    searchStore.reset();
  }

  // 复制链接
  async function copyLink(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
    } catch (error) {
      // 忽略复制失败
    }
  }

  return {
    // 使用 computed 值避免直接访问 store
    loading,
    deepLoading,
    paused,
    error,
    searched,
    elapsedMs,
    total,
    merged,
    hasResults,
    platforms,
    performSearch,
    resetSearch,
    copyLink,
    cancelActiveRequests,
    pauseSearch,
    continueSearch,
  };
}
