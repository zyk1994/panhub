import { defineEventHandler } from 'h3';
import { getOrCreateHotSearchSQLiteService } from '../core/services/hotSearchSQLite';
import { existsSync } from 'fs';

export default defineEventHandler(async (event) => {
  try {
    const service = getOrCreateHotSearchSQLiteService();

    // 获取统计信息
    const stats = await service.getStats();
    const dbSize = service.getDatabaseSize();

    // 检查数据库文件是否存在
    const dbExists = existsSync('./data/hot-searches.db');

    // 检查是否在内存模式（通过检查是否有数据库方法）
    const isMemoryMode = !service['db']?.close;

    return {
      code: 0,
      message: 'success',
      data: {
        stats,
        dbSizeMB: dbSize,
        dbExists,
        isMemoryMode,
        dbPath: './data/hot-searches.db',
        mode: isMemoryMode ? 'memory' : 'sqlite'
      }
    };
  } catch (error) {
    return {
      code: -1,
      message: '获取统计信息失败',
      data: {
        error: error instanceof Error ? error.message : String(error)
      }
    };
  }
});
