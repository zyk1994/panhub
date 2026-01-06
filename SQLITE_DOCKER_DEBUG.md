# 🔍 SQLite Docker 持久化排查指南

## 当前状态

已添加调试日志来追踪 SQLite 模式：

- ✅ **hotSearchSQLite.ts**: 添加了初始化、记录、清理的日志
- ✅ **searchService.ts**: 添加了搜索关键词和结果数量的日志
- ✅ **hot-search-stats.get.ts**: 新增统计 API 用于验证

## 📋 检查步骤

### 1. 重新构建并启动容器

```bash
# 在 1Panel 中或命令行
cd /path/to/panhub.shenzjd.com

# 重新构建镜像
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

### 2. 查看启动日志

```bash
# 查看容器启动时的日志
docker logs panhub 2>&1 | grep -E "(HotSearchSQLite|SearchService)"

# 或者实时查看
docker logs -f panhub
```

**你应该看到类似这样的日志：**

```
[HotSearchSQLite] ✅ SQLite 数据库已初始化: ./data/hot-searches.db
[HotSearchSQLite] ✅ 表结构已创建/验证完成
```

**如果看到：**
```
[HotSearchSQLite] ⚠️ 降级到内存模式: ...
```
说明 better-sqlite3 不可用，会自动降级到内存模式。

### 3. 测试搜索功能

访问网站并进行一次搜索，然后查看日志：

```bash
docker logs panhub 2>&1 | grep -E "(SearchService|HotSearchSQLite)"
```

**应该看到：**
```
[SearchService] 🔍 用户搜索: "电影"
[HotSearchSQLite] ✅ 记录搜索词: "电影"
[SearchService] ✅ 搜索完成 keyword="电影" total=25
```

### 4. 验证数据库文件

```bash
# 进入容器
docker exec -it panhub sh

# 检查 data 目录
ls -la /app/data/

# 应该看到：
# hot-searches.db (如果使用 SQLite 模式)
```

### 5. 检查数据库统计信息

访问 API 验证：

```bash
curl http://localhost:3000/api/hot-search-stats
```

**SQLite 模式返回示例：**
```json
{
  "code": 0,
  "data": {
    "stats": {
      "total": 5,
      "topTerms": [...]
    },
    "dbSizeMB": 0.02,
    "dbExists": true,
    "isMemoryMode": false,
    "mode": "sqlite"
  }
}
```

**内存模式返回示例：**
```json
{
  "code": 0,
  "data": {
    "stats": {
      "total": 5,
      "topTerms": [...]
    },
    "dbSizeMB": 0,
    "dbExists": false,
    "isMemoryMode": true,
    "mode": "memory"
  }
}
```

## 🔧 1Panel 配置检查

### 挂载路径验证

在 1Panel 中检查容器配置：

1. **容器列表** → 点击 `panhub` 容器
2. **文件夹挂载** 标签页
3. 确认有以下挂载：

| 宿主机路径 | 容器路径 | 状态 |
|-----------|---------|------|
| `/你的路径/panhub.shenzjd.com/data` | `/app/data` | ✅ 已挂载 |

**注意**：宿主机路径必须是**绝对路径**，例如：
- ✅ `/root/panhub/data`
- ✅ `/home/user/panhub/data`
- ❌ `./data` (相对路径)

### 权限检查

在 1Panel 的容器终端或 SSH 执行：

```bash
# 检查宿主机目录权限
ls -ld /你的路径/panhub.shenzjd.com/data

# 应该有写权限，例如：
# drwxrwxrwx 2 root root 4096 Jan 6 10:30 /root/panhub/data
```

如果没有写权限：
```bash
chmod 777 /你的路径/panhub.shenzjd.com/data
```

## 🐛 常见问题

### 问题 1：better-sqlite3 编译失败

**现象**：日志显示降级到内存模式

**原因**：Docker 镜像中缺少编译环境

**解决**：
1. 使用我修改后的 Dockerfile（已包含）
2. 或者在 1Panel 中使用预编译镜像：
   ```bash
   # 使用包含 better-sqlite3 的镜像
   # 需要先在本地构建并推送
   ```

### 问题 2：数据库文件未创建

**现象**：`dbExists: false`

**原因**：
- 挂载路径错误
- 权限不足
- 目录不存在

**解决**：
1. 检查挂载路径是否正确
2. 确保目录存在且有写权限
3. 重启容器

### 问题 3：数据不持久化

**现象**：重启后数据丢失

**原因**：
- 使用了内存模式
- 挂载路径配置错误

**解决**：
1. 检查日志确认是 SQLite 模式
2. 验证挂载路径
3. 检查容器重启后数据库文件是否还在

## 📊 验证清单

- [ ] 启动日志显示 `✅ SQLite 数据库已初始化`
- [ ] 搜索后日志显示 `✅ 记录搜索词: "关键词"`
- [ ] `docker exec panhub ls /app/data/` 显示 `hot-searches.db`
- [ ] 访问 `/api/hot-search-stats` 显示 `"mode": "sqlite"`
- [ ] 重启容器后热搜数据仍然存在

## 🚀 快速诊断命令

```bash
# 一键诊断脚本
echo "=== 检查容器状态 ==="
docker ps | grep panhub

echo -e "\n=== 检查启动日志 ==="
docker logs panhub 2>&1 | grep HotSearchSQLite | head -5

echo -e "\n=== 检查数据库文件 ==="
docker exec panhub ls -la /app/data/ 2>/dev/null || echo "目录不存在或无权限"

echo -e "\n=== 检查统计信息 ==="
curl -s http://localhost:3000/api/hot-search-stats | jq .

echo -e "\n=== 测试搜索日志 ==="
echo "请在网页上搜索一次，然后按回车继续..."
read
docker logs panhub 2>&1 | tail -20 | grep -E "(SearchService|HotSearchSQLite)"
```

## 📝 下一步

如果确认是内存模式且无法解决 better-sqlite3 问题，可以考虑：

1. **使用 SQLite 的替代方案**：将数据存储到外部数据库（MySQL/PostgreSQL）
2. **使用文件持久化**：将整个 data 目录备份到外部存储
3. **接受内存模式**：数据只在容器运行时存在，适合测试环境

需要我帮你修改代码使用其他数据库吗？
