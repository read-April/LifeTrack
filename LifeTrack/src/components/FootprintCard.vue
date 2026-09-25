<script setup lang="ts">
/**
 * 我的足迹：个人卡片浮层（近 6 个月记录热力图）
 * 格子由真实 logs 聚合（浮层每次打开都重新挂载 → onMounted 现拉一次）
 */
import { onMounted, ref } from "vue";
import { isoDate, loadLogs } from "../utils/logs";

const emit = defineEmits<{ close: [] }>();

type Cell = { date: string; count: number; level: number };
const cells = ref<Cell[]>([]);
const activeDays = ref(0);

/** 当日记录数 → 5 档深浅（阈值固定，空库全 0 档=全灰） */
function levelOf(n: number): number {
  if (n <= 0) return 0;
  if (n >= 7) return 5;
  if (n >= 5) return 4;
  if (n >= 3) return 3;
  if (n >= 2) return 2;
  return 1;
}

async function reload() {
  const counts = new Map<string, number>();
  for (const l of await loadLogs()) counts.set(l.date, (counts.get(l.date) ?? 0) + 1);

  // 窗口：起于 25 周前的周一，止于本周日，共 26×7 天；列主序填充，第一行为周一
  const WEEKS = 26;
  const today = new Date();
  const dow = (today.getDay() + 6) % 7; // 周一=0 … 周日=6
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - dow - (WEEKS - 1) * 7);

  const out: Cell[] = [];
  let active = 0;
  for (let i = 0; i < WEEKS * 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const date = isoDate(d);
    const count = counts.get(date) ?? 0;
    if (count > 0) active++;
    out.push({ date, count, level: levelOf(count) });
  }
  cells.value = out;
  activeDays.value = active;
}
onMounted(reload);

// 月份标签：最近 6 个月（动态计算）
const hmMonths = (() => {
  const now = new Date();
  const arr: string[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    arr.push(`${d.getMonth() + 1}月`);
  }
  return arr;
})();
</script>

<template>
  <section class="footprint">
    <header class="fp-top">
      <div class="fp-sub">近 6 个月活跃 <strong>{{ activeDays }}</strong> 天</div>
    </header>

    <div class="heatmap-wrap">
      <div class="hm-days"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>
      <div class="hm-main">
        <div class="hm-grid">
          <div v-for="c in cells" :key="c.date" class="hm-cell" :class="c.level > 0 ? 'l' + c.level : ''" :title="c.count ? `${c.date} · ${c.count} 条记录` : `${c.date} 无记录`"></div>
        </div>
        <div class="hm-months"><span v-for="m in hmMonths" :key="m">{{ m }}</span></div>
      </div>
    </div>

    <div class="hm-legend">
      <span>少</span><i style="background:var(--track)"></i><i style="background:#D9EFE8"></i><i style="background:#AFDFD1"></i><i style="background:#7CCBB0"></i><i style="background:#3FB48D"></i><i style="background:#0A6B52"></i><span>多</span>
    </div>
  </section>
</template>

<style scoped>
.footprint {
  background: var(--card); border: 1px solid var(--line); border-radius: var(--r);
  box-shadow: var(--shadow-md); padding: 20px 22px; width: 480px; max-width: calc(100vw - 110px);
}
@supports (width: 100dvw) {
  .footprint { max-width: calc(100dvw - 110px); }
}

.fp-top { display: flex; align-items: center; margin-bottom: 18px; }
.fp-sub { font-size: 11.5px; color: var(--text-3); }
.fp-sub strong { color: var(--accent-dark); font-weight: 600; }

.heatmap-wrap { display: flex; gap: 12px; overflow-x: auto; padding-bottom: 6px; }
.heatmap-wrap::-webkit-scrollbar { height: 0; }
.hm-days {
  display: flex; flex-direction: column; gap: 3px; padding-top: 0;
  font-size: 9.5px; color: var(--text-3); flex: 0 0 auto;
}
.hm-days span { height: 12px; line-height: 12px; }
.hm-main { flex: 0 0 auto; }
/* 固定 12px 格子：7 行（星期）× 26 列（周），窄屏靠 .heatmap-wrap 横向滚动，不参与响应式缩放 */
.hm-grid { display: grid; grid-auto-flow: column; grid-template-rows: repeat(7, 12px); gap: 3px; width: max-content; }
.hm-cell { width: 12px; height: 12px; border-radius: 3px; background: var(--track); transition: all .15s ease; cursor: pointer; }
.hm-cell:hover { transform: scale(1.2); }
.hm-cell.l1 { background: #D9EFE8; }
.hm-cell.l2 { background: #AFDFD1; }
.hm-cell.l3 { background: #7CCBB0; }
.hm-cell.l4 { background: #3FB48D; }
.hm-cell.l5 { background: #0A6B52; }
.hm-months {
  display: flex; justify-content: space-between; font-size: 9.5px;
  color: var(--text-3); padding: 0 2px; margin-top: 6px; font-variant-numeric: tabular-nums;
  /* 与热力图同宽（26 列 × 12px + 25 个间距 × 3px），保证月份标签对得上格子 */
  width: calc(26 * 12px + 25 * 3px);
}
.hm-legend {
  display: flex; align-items: center; gap: 6px; font-size: 10.5px; color: var(--text-3);
  margin-top: 12px; justify-content: flex-end;
}
.hm-legend i { width: 10px; height: 10px; border-radius: 2px; display: block; }
</style>
