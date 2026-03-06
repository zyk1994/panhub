import { defineEventHandler, getQuery } from 'h3';
import { getOrCreateHotSearchService } from '../core/services/hotSearchService';

export default defineEventHandler(async (event) => {
  try {
    const service = getOrCreateHotSearchService();

    // 获取limit参数，默认30
    const query = getQuery(event);
    const limit = parseInt((query.limit as string) || '30', 10);

    console.log(`[GET /api/hot-searches] 请求 limit=${limit}`);
    const hotSearches = await service.getHotSearches(limit);
    console.log(`[GET /api/hot-searches] 返回 ${hotSearches.length} 条:`, hotSearches.map(s => `${s.term}(score:${s.score})`).join(', '));

    return {
      code: 0,
      message: 'success',
      data: {
        hotSearches,
      },
    };
  } catch (error) {
    console.error('[GET /api/hot-searches] ❌ 错误:', error);
    return {
      code: -1,
      message: '获取热搜失败',
      data: {
        hotSearches: [],
      },
    };
  }
});
