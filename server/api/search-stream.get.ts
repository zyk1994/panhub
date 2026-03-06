import { defineEventHandler, getQuery, setHeader, H3Event } from "h3";
import { getOrCreateSearchService } from "../core/services";
import type { SearchRequest, MergedLinks, SearchResult } from "../core/types/models";

function parseList(val: string | undefined): string[] | undefined {
  if (!val) return undefined;
  const parts = val
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
}

// SSE 辅助函数
function sendSSE(event: H3Event, data: any, eventName?: string) {
  const message = eventName ? `event: ${eventName}\n` : "";
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  event.node.res.write(message + payload);
}

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();
  const service = getOrCreateSearchService(config);
  const q = getQuery(event);

  const kw = ((q.kw as string) || "").trim();
  if (!kw) {
    setHeader(event, "Content-Type", "text/event-stream");
    setHeader(event, "Cache-Control", "no-cache");
    setHeader(event, "Connection", "keep-alive");
    sendSSE(event, { error: "kw is required" }, "error");
    event.node.res.end();
    return;
  }

  let ext: Record<string, any> | undefined;
  const extStr = (q.ext as string | undefined)?.trim();
  if (extStr) {
    if (extStr === "{}") ext = {};
    else {
      try {
        ext = JSON.parse(extStr);
      } catch (e: any) {
        setHeader(event, "Content-Type", "text/event-stream");
        setHeader(event, "Cache-Control", "no-cache");
        setHeader(event, "Connection", "keep-alive");
        sendSSE(event, { error: "invalid ext json: " + e?.message }, "error");
        event.node.res.end();
        return;
      }
    }
  }

  // 设置 SSE 响应头
  setHeader(event, "Content-Type", "text/event-stream");
  setHeader(event, "Cache-Control", "no-cache");
  setHeader(event, "Connection", "keep-alive");
  setHeader(event, "X-Accel-Buffering", "no"); // 禁用 Nginx 缓冲

  const req: SearchRequest = {
    kw,
    channels: parseList(q.channels as string | undefined),
    conc: q.conc ? parseInt(String(q.conc), 10) : undefined,
    refresh: String(q.refresh).trim() === "true",
    res: (q.res as any) || "merged_by_type",
    src: (q.src as any) || "all",
    plugins: parseList(q.plugins as string | undefined),
    cloud_types: parseList(q.cloud_types as string | undefined),
    ext,
  };

  // 互斥逻辑
  if (req.src === "tg") req.plugins = undefined;
  else if (req.src === "plugin") req.channels = undefined;
  if (!req.res || req.res === "merge") req.res = "merged_by_type";

  try {
    // 发送开始事件
    sendSSE(event, { type: "start", message: "搜索开始" }, "search");

    // 执行流式搜索
    await streamSearch(event, service, req);
    
    // 发送完成事件
    sendSSE(event, { type: "complete", message: "搜索完成" }, "search");
  } catch (error: any) {
    sendSSE(event, { 
      type: "error", 
      message: error?.message || "搜索失败" 
    }, "error");
  } finally {
    event.node.res.end();
  }
});

// 流式搜索函数
async function streamSearch(
  event: H3Event,
  service: any,
  req: SearchRequest
) {
  const { kw, channels, conc, refresh, res, src, plugins, cloud_types, ext } = req;

  // 使用内部方法进行流式搜索
  // 这里需要重构 SearchService 来支持流式返回
  // 为了简化，我们先使用现有的 search 方法，但分批调用
  
  const effChannels = channels && channels.length > 0 ? channels : service.getPluginManager().getDefaultChannels();
  const effConcurrency = conc && conc > 0 ? conc : 3;
  
  let allResults: SearchResult[] = [];
  let mergedLinks: MergedLinks = {};
  let total = 0;

  // 处理 TG 搜索
  if (src === "all" || src === "tg") {
    const tgResults = await service.searchTGStream?.(
      kw,
      effChannels,
      !!refresh,
      effConcurrency,
      ext,
      (results: SearchResult[], isBatch: boolean) => {
        // 每批结果返回时推送
        const batchMerged = service.mergeResultsByType?.(results, kw, cloud_types) || {};
        mergedLinks = mergeMergedLinks(mergedLinks, batchMerged);
        total = Object.values(mergedLinks).reduce((sum, arr) => sum + arr.length, 0);
        
        sendSSE(event, {
          type: "progress",
          source: "tg",
          merged_by_type: batchMerged,
          total,
          isFinal: !isBatch
        }, "result");
      }
    );
    
    if (tgResults) {
      allResults.push(...tgResults);
    }
  }

  // 处理插件搜索
  if (src === "all" || src === "plugin") {
    const pluginResults = await service.searchPluginsStream?.(
      kw,
      plugins,
      !!refresh,
      effConcurrency,
      ext || {},
      (results: SearchResult[], pluginName: string) => {
        // 每个插件返回时推送
        const batchMerged = service.mergeResultsByType?.(results, kw, cloud_types) || {};
        mergedLinks = mergeMergedLinks(mergedLinks, batchMerged);
        total = Object.values(mergedLinks).reduce((sum, arr) => sum + arr.length, 0);
        
        sendSSE(event, {
          type: "progress",
          source: "plugin",
          plugin: pluginName,
          merged_by_type: batchMerged,
          total,
          isFinal: true
        }, "result");
      }
    );
    
    if (pluginResults) {
      allResults.push(...pluginResults);
    }
  }

  return {
    total,
    merged_by_type: mergedLinks
  };
}

// 合并 MergedLinks
function mergeMergedLinks(
  target: MergedLinks,
  incoming: MergedLinks
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
