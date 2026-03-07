<template>
  <!-- 无数据时不显示整个组件 -->
  <div v-if="!loading && searches.length === 0" class="hidden"></div>

  <div v-else class="hot-search-section">
    <div class="section-head">
      <h2 class="section-title">热门搜索</h2>
      <p class="section-subtitle">点击任意关键词可快速发起搜索</p>
    </div>
    <div class="cloud-container">
      <!-- 加载状态 -->
      <div v-if="loading" class="loading-state">
        <div class="spinner"></div>
        <span>搜索热度加载中…</span>
      </div>

      <!-- 智能标签云 -->
      <div v-else class="tag-cloud">
        <button
          v-for="item in searches"
          :key="item.term"
          class="tag-item"
          :style="getTagStyle(item.score)"
          :aria-label="`搜索热词 ${item.term}`"
          @click="onSearchClick(item.term)"
        >
          {{ item.term }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

interface Props {
  onSearch: (term: string) => void;
}

interface HotSearchItem {
  term: string;
  score: number;
  lastSearched: number;
  createdAt: number;
}

const props = defineProps<Props>();

// 状态
const loading = ref(false);
const searches = ref<HotSearchItem[]>([]);
const hasInitialized = ref(false);

// 获取热搜数据
async function fetchHotSearches() {
  loading.value = true;
  try {
    const response = await fetch('/api/hot-searches?limit=30');
    const data = await response.json();

    if (data.code === 0 && data.data?.hotSearches) {
      // 按分数排序，高分在前
      searches.value = data.data.hotSearches
        .sort((a: HotSearchItem, b: HotSearchItem) => b.score - a.score)
        .slice(0, 30);
    }
  } catch (error) {
    // 失败时不显示任何内容
    searches.value = [];
  } finally {
    loading.value = false;
  }
}

// 首次初始化（只在页面加载时执行一次）
async function init() {
  if (hasInitialized.value) {
    return;
  }
  hasInitialized.value = true;
  await fetchHotSearches();
}

// 刷新数据（每次重置时调用）
async function refresh() {
  await fetchHotSearches();
}

// 根据分数计算标签样式
function getTagStyle(score: number) {
  if (searches.value.length === 0) return {};

  // 分数映射到字体大小（12px - 24px）
  const minScore = Math.min(...searches.value.map(s => s.score));
  const maxScore = Math.max(...searches.value.map(s => s.score));
  const normalized = (score - minScore) / (maxScore - minScore || 1);
  const fontSize = 12 + normalized * 12; // 12px - 24px

  // 分数映射到粗细和透明度
  const fontWeight = score >= 70 ? 800 : score >= 40 ? 700 : 600;
  const opacity = 0.75 + normalized * 0.25; // 0.75 - 1.0
  const bgOpacity = 0.08 + normalized * 0.22;
  const borderOpacity = 0.16 + normalized * 0.3;

  return {
    fontSize: `${fontSize}px`,
    color: "var(--primary-dark)",
    fontWeight: fontWeight,
    opacity: opacity,
    padding: `${6 + normalized * 2}px ${10 + normalized * 4}px`,
    margin: `${4 + (1 - normalized) * 2}px`,
    backgroundColor: `rgba(15, 118, 110, ${bgOpacity.toFixed(3)})`,
    borderColor: `rgba(15, 118, 110, ${borderOpacity.toFixed(3)})`
  };
}

// 点击搜索词
function onSearchClick(term: string) {
  props.onSearch(term);
}

// 暴露方法给父组件
defineExpose({
  init,
  refresh,
});
</script>

<style scoped>
.hot-search-section {
  width: 100%;
}

.section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.section-title {
  font-size: 16px;
  font-weight: 800;
  color: var(--text-primary);
  margin: 0;
}

.section-subtitle {
  margin: 0;
  font-size: 12px;
  color: var(--text-tertiary);
}

.cloud-container {
  width: 100%;
}

/* 标签云容器 - 玻璃拟态风格 */
.tag-cloud {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 18px;
  background: rgba(255, 255, 255, 0.55);
  backdrop-filter: blur(8px);
  border: 1px solid var(--border-light);
  border-radius: 14px;
  min-height: 180px;
}

/* 标签样式 - 现代设计 */
.tag-item {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-medium);
  border-radius: 999px;
  cursor: pointer;
  transition: transform 200ms ease, box-shadow 200ms ease, filter 200ms ease,
    background-color 200ms ease;
  white-space: nowrap;
  text-align: center;
  line-height: 1.2;
  user-select: none;
  position: relative;
}

.tag-item:hover {
  transform: translateY(-2px);
  box-shadow: 0 7px 14px rgba(15, 118, 110, 0.18);
  filter: brightness(1.03);
  z-index: 10;
}

/* 加载状态 */
.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px 20px;
  color: var(--text-secondary);
  background: rgba(255, 255, 255, 0.55);
  backdrop-filter: blur(8px);
  border: 1px solid var(--border-light);
  border-radius: 14px;
}

.spinner {
  width: 28px;
  height: 28px;
  border: 3px solid rgba(15, 118, 110, 0.2);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

/* 动画 */
@keyframes spin {
  to { transform: rotate(360deg); }
}

/* 移动端优化 */
@media (max-width: 640px) {
  .section-head {
    flex-direction: column;
    gap: 4px;
  }

  .section-title {
    font-size: 15px;
  }

  .tag-cloud {
    padding: 14px;
    gap: 6px;
    min-height: 140px;
  }

  .loading-state {
    padding: 30px 16px;
  }
}

/* 深色模式 */
@media (prefers-color-scheme: dark) {
  .tag-cloud {
    background: rgba(17, 24, 39, 0.5);
    border-color: rgba(75, 85, 99, 0.4);
  }

  .loading-state {
    background: rgba(17, 24, 39, 0.5);
    border-color: rgba(75, 85, 99, 0.4);
  }

  .tag-item {
    color: #ccfbf1 !important;
  }

  .tag-item:hover {
    box-shadow: 0 7px 14px rgba(15, 118, 110, 0.28);
  }
}

/* 减少动画模式 */
@media (prefers-reduced-motion: reduce) {
  .tag-item,
  .spinner {
    animation: none;
    transition: none;
  }

  .tag-item:hover {
    transform: none;
  }
}

.hidden {
  display: none;
}
</style>
