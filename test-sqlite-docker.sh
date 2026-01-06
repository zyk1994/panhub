#!/bin/bash

# SQLite Docker 持久化测试脚本

echo "================================"
echo "PanHub SQLite Docker 测试工具"
echo "================================"
echo ""

# 检查容器是否运行
if ! docker ps | grep -q panhub; then
    echo "❌ 错误: panhub 容器未运行"
    echo "请先启动容器: docker-compose up -d"
    exit 1
fi

echo "✅ 容器正在运行"
echo ""

# 1. 检查启动日志
echo "1️⃣ 检查 SQLite 初始化日志"
echo "-------------------------------"
docker logs panhub 2>&1 | grep HotSearchSQLite | head -5
if [ $? -ne 0 ]; then
    echo "⚠️  未找到 SQLite 日志，可能还未初始化"
fi
echo ""

# 2. 检查数据库文件
echo "2️⃣ 检查数据库文件是否存在"
echo "-------------------------------"
docker exec panhub ls -la /app/data/ 2>/dev/null
if [ $? -ne 0 ]; then
    echo "❌ /app/data/ 目录不存在或无权限"
else
    echo "✅ 目录存在"
fi
echo ""

# 3. 检查统计信息
echo "3️⃣ 获取数据库统计信息"
echo "-------------------------------"
curl -s http://localhost:3000/api/hot-search-stats 2>/dev/null | jq . 2>/dev/null || curl -s http://localhost:3000/api/hot-search-stats
echo ""
echo ""

# 4. 测试搜索功能
echo "4️⃣ 测试搜索记录功能"
echo "-------------------------------"
echo "请在浏览器中搜索任意关键词（如：电影）"
echo "然后按回车查看日志..."
read

echo "最近的搜索日志："
docker logs panhub 2>&1 | grep -E "(SearchService|HotSearchSQLite)" | tail -10
echo ""

# 5. 检查持久化
echo "5️⃣ 测试数据持久化"
echo "-------------------------------"
echo "重启容器测试数据是否保留..."
echo "按 Ctrl+C 取消，或按回车继续"
read

docker restart panhub
echo "等待容器启动..."
sleep 5

echo "重启后检查数据："
curl -s http://localhost:3000/api/hot-search-stats 2>/dev/null | jq .data.stats 2>/dev/null || curl -s http://localhost:3000/api/hot-search-stats | grep -o '"total":[0-9]*'
echo ""

echo "================================"
echo "测试完成！"
echo "================================"
