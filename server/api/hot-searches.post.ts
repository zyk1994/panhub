import { defineEventHandler, readBody } from 'h3';
import { getOrCreateHotSearchService } from '../core/services/hotSearchService';

interface RequestBody {
  term: string;
}

export default defineEventHandler(async (event) => {
  try {
    const body = await readBody<RequestBody>(event);

    if (!body || !body.term) {
      console.log('[POST /api/hot-searches] ❌ 缺少搜索词参数');
      return {
        code: -1,
        message: '缺少搜索词参数',
        data: null,
      };
    }

    console.log('[POST /api/hot-searches] 收到搜索词:', body.term);
    const service = getOrCreateHotSearchService();
    await service.recordSearch(body.term);
    console.log('[POST /api/hot-searches] ✅ 记录成功:', body.term);

    // 验证记录是否真的写入了
    const afterRecord = await service.getHotSearches(5);
    console.log('[POST /api/hot-searches] 📊 验证 - 最近5条:', afterRecord.map(s => `${s.term}(score:${s.score})`).join(', '));

    return {
      code: 0,
      message: 'success',
      data: null,
    };
  } catch (error) {
    console.error('[POST /api/hot-searches] ❌ 错误:', error);
    return {
      code: -1,
      message: '记录搜索词失败',
      data: null,
    };
  }
});
