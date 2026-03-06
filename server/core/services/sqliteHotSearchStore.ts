import { join } from "path";
import { mkdirSync, existsSync, statSync } from "fs";
import type { IHotSearchStore, HotSearchItem, HotSearchStats } from "./hotSearchStore";

/**
 * SQLite 热搜存储实现
 * 提供持久化存储支持
 */
export class SQLiteHotSearchStore implements IHotSearchStore {
  private db: any = null;
  private readonly DB_DIR = "./data";
  private readonly DB_PATH = "./data/hot-searches.db";
  private initPromise: Promise<void> | null = null;
  private isInitialized = false;

  constructor() {
    this.initPromise = this.initDatabase()
      .then(() => {
        this.isInitialized = true;
        this.initPromise = null;
      })
      .catch((err) => {
        console.log("[SQLiteHotSearchStore] ❌ 初始化失败:", err.message);
        this.initPromise = null;
        throw err;
      });
  }

  private async waitForInit(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initPromise) {
      await this.initPromise;
    }
  }

  private async initDatabase(): Promise<void> {
    try {
      console.log("[SQLiteHotSearchStore] 🔍 开始初始化数据库...");

      // 动态导入 better-sqlite3
      let Database;
      try {
        Database = (await import("better-sqlite3")).default;
        console.log("[SQLiteHotSearchStore] ✅ better-sqlite3 模块加载成功");
      } catch {
        const { createRequire } = await import("module");
        const require = createRequire(import.meta.url);
        Database = require("better-sqlite3");
        console.log("[SQLiteHotSearchStore] ✅ better-sqlite3 通过 require 加载成功");
      }

      // 确保数据目录存在
      if (!existsSync(this.DB_DIR)) {
        mkdirSync(this.DB_DIR, { recursive: true });
        console.log(`[SQLiteHotSearchStore] ✅ 创建数据目录: ${this.DB_DIR}`);
      }

      // 打开数据库
      this.db = new Database(this.DB_PATH);
      console.log(`[SQLiteHotSearchStore] ✅ SQLite 数据库已初始化`);

      // 创建表
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS hot_searches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          term TEXT UNIQUE NOT NULL,
          score INTEGER DEFAULT 1,
          last_searched INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);

      // 验证数据库可写
      const testStmt = this.db.prepare(
        "INSERT OR IGNORE INTO hot_searches (term, score, last_searched, created_at) VALUES (?, ?, ?, ?)"
      );
      testStmt.run("__test__", 1, Date.now(), Date.now());
      const cleanupStmt = this.db.prepare("DELETE FROM hot_searches WHERE term = ?");
      cleanupStmt.run("__test__");
      console.log("[SQLiteHotSearchStore] ✅ 数据库读写验证通过");
    } catch (error) {
      console.log(`[SQLiteHotSearchStore] ❌ 数据库初始化失败:`, error instanceof Error ? error.message : error);
      throw error;
    }
  }

  async recordSearch(term: string, now: number): Promise<void> {
    await this.waitForInit();
    if (!term || term.trim().length === 0) return;

    // 违规词检查
    if (await this.isForbidden(term)) {
      console.log(`[SQLiteHotSearchStore] 违规词被过滤: ${term}`);
      return;
    }

    try {
      const stmt = this.db.prepare(`
        INSERT INTO hot_searches (term, score, last_searched, created_at)
        VALUES (?, 1, ?, ?)
        ON CONFLICT(term) DO UPDATE SET
          score = score + 1,
          last_searched = ?
      `);

      stmt.run(term, now, now, now);
      console.log(`[SQLiteHotSearchStore] ✅ 记录搜索词: "${term}"`);

      // 清理超出限制的低分记录
      await this.cleanupOldEntries(30);
    } catch (error) {
      console.log(`[SQLiteHotSearchStore] ❌ 记录搜索词失败:`, error instanceof Error ? error.message : error);
    }
  }

  async getHotSearches(limit: number): Promise<HotSearchItem[]> {
    await this.waitForInit();

    try {
      const stmt = this.db.prepare(`
        SELECT term, score, last_searched as lastSearched, created_at as createdAt
        FROM hot_searches
        ORDER BY score DESC, last_searched DESC
        LIMIT ?
      `);

      const rows = stmt.all(Math.min(limit, 30));
      return rows.map((row: any) => ({
        term: row.term,
        score: row.score,
        lastSearched: row.lastSearched,
        createdAt: row.createdAt,
      }));
    } catch (error) {
      return [];
    }
  }

  async cleanupOldEntries(maxEntries: number): Promise<void> {
    try {
      const stmt = this.db.prepare(`
        DELETE FROM hot_searches
        WHERE id NOT IN (
          SELECT id FROM hot_searches
          ORDER BY score DESC, last_searched DESC
          LIMIT ?
        )
      `);

      const result = stmt.run(maxEntries);
      if (result.changes > 0) {
        console.log(`[SQLiteHotSearchStore] 清理旧记录: ${result.changes} 条`);
      }
    } catch (error) {
      console.log(`[SQLiteHotSearchStore] 清理记录失败 (可忽略):`, error instanceof Error ? error.message : error);
    }
  }

  async clearHotSearches(): Promise<{ success: boolean; message: string }> {
    await this.waitForInit();

    try {
      const stmt = this.db.prepare("DELETE FROM hot_searches");
      stmt.run();
      return { success: true, message: "热搜记录已清除" };
    } catch (error) {
      return { success: false, message: "清除失败" };
    }
  }

  async deleteHotSearch(term: string): Promise<{ success: boolean; message: string }> {
    await this.waitForInit();

    try {
      const stmt = this.db.prepare("DELETE FROM hot_searches WHERE term = ?");
      const result = stmt.run(term);

      if (result.changes > 0) {
        return { success: true, message: `热搜词 "${term}" 已删除` };
      }
      return { success: false, message: "热搜词不存在" };
    } catch (error) {
      return { success: false, message: "删除失败" };
    }
  }

  async getStats(): Promise<HotSearchStats> {
    await this.waitForInit();

    try {
      const countStmt = this.db.prepare("SELECT COUNT(*) as total FROM hot_searches");
      const countResult = countStmt.get();
      const total = countResult?.total || 0;

      const topStmt = this.db.prepare(`
        SELECT term, score, last_searched as lastSearched, created_at as createdAt
        FROM hot_searches
        ORDER BY score DESC, last_searched DESC
        LIMIT 10
      `);
      const rows = topStmt.all();
      const topTerms = rows.map((row: any) => ({
        term: row.term,
        score: row.score,
        lastSearched: row.lastSearched,
        createdAt: row.createdAt,
      }));

      return { total, topTerms };
    } catch (error) {
      return { total: 0, topTerms: [] };
    }
  }

  getDatabaseSize(): number {
    try {
      if (existsSync(this.DB_PATH)) {
        const stats = statSync(this.DB_PATH);
        const size = Math.round((stats.size / (1024 * 1024)) * 100) / 100;
        console.log(`[SQLiteHotSearchStore] 📊 数据库文件大小: ${size} MB`);
        return size;
      }
      return 0;
    } catch (error) {
      console.log(`[SQLiteHotSearchStore] ❌ 获取数据库大小失败:`, error instanceof Error ? error.message : error);
      return 0;
    }
  }

  private async isForbidden(term: string): Promise<boolean> {
    const forbiddenPatterns = [
      /政治|暴力|色情|赌博|毒品/i,
      /fuck|shit|bitch/i,
    ];
    return forbiddenPatterns.some((pattern) => pattern.test(term));
  }

  close(): void {
    if (this.db && this.db.close) {
      this.db.close();
    }
  }
}
