<script setup lang="ts">
/**
 * 时间线：append-only 事件流，年/月/日三级折叠
 * 只读视图——所有写入由其他页面触发 addEvent
 * 支持分页懒加载（IntersectionObserver）、搜索、日期范围筛选
 */
import { computed, ref, onMounted, onBeforeUnmount, nextTick } from "vue";
import { type TimelineEvent, loadTimeline, timelineCount, EVENT_GROUP, activeMilestoneIds, setMilestone } from "../utils/timeline";

// ---------- 分页（SQLite 异步读，首屏在 setup 里异步拉一次） ----------
const PAGE_SIZE = 100;
const allEvents = ref<TimelineEvent[]>([]);
const totalCount = ref(0);
const offset = ref(PAGE_SIZE);
const loadingMore = ref(false);
const hasMore = computed(() => offset.value < totalCount.value);

// ---------- 里程碑：派生态（标记动作引用目标 id，不复制内容） ----------
const msIds = ref<Set<number>>(new Set());
const isMs = (id: number) => msIds.value.has(id);
const isMarkEvent = (it: TimelineEvent) => it.type === "milestone.marked" || it.type === "milestone.unmarked";
async function refreshMilestones() { msIds.value = await activeMilestoneIds(); }
/** 写入事件后按当前已加载窗口重拉，并刷新派生的里程碑集合 */
async function reloadStream() {
  allEvents.value = await loadTimeline(0, offset.value);
  totalCount.value = await timelineCount();
  await refreshMilestones();
}
void reloadStream();
async function toggleMilestone(it: TimelineEvent) { await setMilestone(it, !isMs(it.id)); await reloadStream(); }
/** 点标记动作 → 展开目标所在三级折叠并滚动定位回原记录 */
async function jumpToTarget(refId: number) {
  if (!allEvents.value.some(e => e.id === refId)) {
    const n = await timelineCount();
    allEvents.value = await loadTimeline(0, n);
    totalCount.value = n;
    await refreshMilestones();
  }
  const t = allEvents.value.find(e => e.id === refId);
  if (!t) return;
  const [y, m] = t.date.split("-");
  collapsedYears.value.delete(y);
  collapsedMonths.value.delete(`${y}-${m}`);
  collapsedDays.value.delete(t.date);
  nextTick(() => document.getElementById(`tlev-${refId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
}

async function loadMore() {
  if (!hasMore.value || loadingMore.value) return;
  loadingMore.value = true;
  const batch = await loadTimeline(offset.value, PAGE_SIZE);
  allEvents.value = [...allEvents.value, ...batch];
  offset.value += PAGE_SIZE;
  totalCount.value = await timelineCount();
  loadingMore.value = false;
}

// ---------- 搜索 ----------
const searchQuery = ref("");

// ---------- 日期范围 ----------
const DATE_RANGES = [
  { key: "all", label: "全部" },
  { key: "7d", label: "近 7 天" },
  { key: "30d", label: "近 30 天" },
] as const;
type DateRangeKey = (typeof DATE_RANGES)[number]["key"];
const dateRange = ref<DateRangeKey>("all");

function getRangeCutoff(): number {
  if (dateRange.value === "7d") return Date.now() - 7 * 86400_000;
  if (dateRange.value === "30d") return Date.now() - 30 * 86400_000;
  return 0;
}

// ---------- 类型筛选 ----------
const FILTERS = [
  { key: "all", label: "全部" },
  { key: "task", label: "待办" },
  { key: "goal", label: "目标" },
  { key: "log", label: "随记" },
  { key: "report", label: "报告" },
  { key: "milestone", label: "里程碑" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];
const activeFilter = ref<FilterKey>("all");

// ---------- 综合筛选 ----------
const filteredEvents = computed(() => {
  const kw = searchQuery.value.trim().toLowerCase();
  const cutoff = getRangeCutoff();
  return allEvents.value.filter((e) => {
    if (activeFilter.value !== "all" && !e.type.startsWith(activeFilter.value)) return false;
    if (kw && !e.summary.toLowerCase().includes(kw)) return false;
    if (cutoff && e.ts < cutoff) return false;
    return true;
  });
});

// ---------- 事件图标颜色类 ----------
const ICON_CLASS: Record<string, string> = {
  "task.created": "green",
  "task.confirmed": "green",
  "task.completed": "green",
  "task.reopened": "grey",
  "task.dropped": "grey",
  "task.removed": "green",
  "goal.created": "purple",
  "goal.removed": "purple",
  "goal.status_changed": "purple",
  "goal.version_added": "purple",
  "goal.version_removed": "purple",
  "log.created": "blue",
  "log.updated": "blue",
  "log.removed": "blue",
  "report.saved": "orange",
  "milestone.marked": "ms",
  "milestone.unmarked": "grey",
};

function getIconClass(it: TimelineEvent) {
  if (isMs(it.id)) return "ms";
  return ICON_CLASS[it.type] ?? "green";
}

// ---------- SVG 图标路径 ----------
const ICON_PATHS: Record<string, string> = {
  task: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  goal: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  log: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>',
  report: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  milestone: '<polygon points="12 2 22 12 12 22 2 12"/>',
};

function getIconPath(it: TimelineEvent) {
  if (isMs(it.id)) return ICON_PATHS.milestone;
  const prefix = it.type.split(".")[0];
  return ICON_PATHS[prefix] ?? ICON_PATHS.task;
}

// ---------- 日期格式 ----------
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
const MONTH_NAMES = ["1 月", "2 月", "3 月", "4 月", "5 月", "6 月", "7 月", "8 月", "9 月", "10 月", "11 月", "12 月"];

function fmtTime(ts: number) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ---------- 三级折叠状态 ----------
const collapsedYears = ref(new Set<string>());
const collapsedMonths = ref(new Set<string>());
const collapsedDays = ref(new Set<string>());

function toggleYear(y: string) { collapsedYears.value.has(y) ? collapsedYears.value.delete(y) : collapsedYears.value.add(y); }
function toggleMonth(ym: string) { collapsedMonths.value.has(ym) ? collapsedMonths.value.delete(ym) : collapsedMonths.value.add(ym); }
function toggleDay(d: string) { collapsedDays.value.has(d) ? collapsedDays.value.delete(d) : collapsedDays.value.add(d); }

// ---------- 三级分组：年 → 月 → 日 → 事件 ----------
interface DayGroup { date: string; weekday: string; items: TimelineEvent[] }
interface MonthGroup { ym: string; label: string; count: number; days: DayGroup[]; msItems: TimelineEvent[] }
interface YearGroup { year: string; label: string; count: number; months: MonthGroup[]; msItems: TimelineEvent[] }

const yearGroups = computed<YearGroup[]>(() => {
  const now = new Date();
  const curY = String(now.getFullYear());
  const curM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  // 年 → 月 → 日 三级桶
  const yearMap = new Map<string, Map<string, Map<string, TimelineEvent[]>>>();
  for (const e of filteredEvents.value) {
    const [y, m, d] = e.date.split("-");
    const yKey = y;
    const ymKey = `${y}-${m}`;
    if (!yearMap.has(yKey)) yearMap.set(yKey, new Map());
    const monthMap = yearMap.get(yKey)!;
    if (!monthMap.has(ymKey)) monthMap.set(ymKey, new Map());
    const dayMap = monthMap.get(ymKey)!;
    if (!dayMap.has(d)) dayMap.set(d, []);
    dayMap.get(d)!.push(e);
  }

  // 默认展开：当前年、当前月
  for (const [y] of yearMap) {
    if (y !== curY) collapsedYears.value.add(y);
  }
  for (const [, monthMap] of yearMap) {
    for (const [ym] of monthMap) {
      if (ym !== curM) collapsedMonths.value.add(ym);
    }
  }

  const yKeys = [...yearMap.keys()].sort((a, b) => (a < b ? 1 : -1));
  return yKeys.map((y) => {
    const monthMap = yearMap.get(y)!;
    const ymKeys = [...monthMap.keys()].sort((a, b) => (a < b ? 1 : -1));
    let totalCount = 0;
    const months = ymKeys.map((ym) => {
      const [mm] = ym.split("-")[1].split("-");
      const dayMap = monthMap.get(ym)!;
      const dKeys = [...dayMap.keys()].sort((a, b) => (a < b ? 1 : -1));
      const days = dKeys.map((d) => {
        const items = dayMap.get(d)!;
        totalCount += items.length;
        const dt = new Date(+y, +mm - 1, +d);
        return {
          date: `${y}-${mm}-${d}`,
          weekday: `周${WEEK[dt.getDay()]}`,
          items,
        };
      });
      return {
        ym,
        label: `${y} 年 ${MONTH_NAMES[+mm - 1]}`,
        count: dayMap.size > 0 ? days.reduce((s, dg) => s + dg.items.length, 0) : 0,
        days,
        msItems: days.flatMap(dg => dg.items.filter(e => isMs(e.id))).sort((a, b) => b.ts - a.ts),
      };
    });
    return { year: y, label: `${y} 年`, count: totalCount, months, msItems: months.flatMap(mg => mg.msItems).sort((a, b) => b.ts - a.ts) };
  });
});

// ---------- IntersectionObserver 懒加载 ----------
let observer: IntersectionObserver | null = null;
const sentinel = ref<HTMLElement | null>(null);

onMounted(() => {
  // 确保当前月展开
  const now = new Date();
  const curM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  collapsedMonths.value.delete(curM);

  // 建立哨兵观察
  nextTick(() => {
    if (!sentinel.value) return;
    observer = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) loadMore(); },
      { rootMargin: "200px" },
    );
    observer.observe(sentinel.value);
  });
});

onBeforeUnmount(() => { observer?.disconnect(); });
</script>

<template>
  <div>
    <div class="hello">
      <h1>时间线</h1>
      <p>共 <strong>{{ filteredEvents.length }}</strong> 条记录，按时间倒序</p>
    </div>

    <!-- 搜索框 -->
    <div class="tl-search">
      <svg class="tl-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      <input v-model="searchQuery" class="tl-search-input" placeholder="搜索事件…" />
      <span v-if="searchQuery" class="tl-search-clear" @click="searchQuery = ''">&times;</span>
    </div>

    <!-- 筛选药丸 -->
    <div class="tl-filters">
      <button
        v-for="f in FILTERS"
        :key="f.key"
        class="f-chip"
        :class="{ on: activeFilter === f.key }"
        @click="activeFilter = f.key"
      >{{ f.label }}</button>
      <span class="tl-filter-sep"></span>
      <button
        v-for="dr in DATE_RANGES"
        :key="dr.key"
        class="f-chip date-chip"
        :class="{ on: dateRange === dr.key }"
        @click="dateRange = dr.key"
      >{{ dr.label }}</button>
    </div>

    <!-- 事件流 -->
    <div class="tl-feed">
      <template v-for="yg in yearGroups" :key="yg.year">
        <!-- 年级头 -->
        <div class="tl-year-label" @click="toggleYear(yg.year)">
          <svg class="chevron" :class="{ collapsed: collapsedYears.has(yg.year) }"
            width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
          {{ yg.label }}
          <span>{{ yg.count }} 条</span>
        </div>

        <!-- 折到年：该年的里程碑拎出来，一眼回看人生大事 -->
        <div v-if="collapsedYears.has(yg.year) && yg.msItems.length" class="tl-ms-lane">
          <div v-for="m in yg.msItems" :key="m.id" class="tl-ms-item" @click="jumpToTarget(m.id)">
            <span class="tl-ms-diamond">◆</span>
            <span class="tl-ms-date">{{ m.date }}</span>
            <span class="tl-ms-sum">{{ m.summary }}</span>
          </div>
        </div>

        <template v-if="!collapsedYears.has(yg.year)">
          <template v-for="mg in yg.months" :key="mg.ym">
            <!-- 月级头 -->
            <div class="tl-month-label" @click="toggleMonth(mg.ym)">
              <svg class="chevron" :class="{ collapsed: collapsedMonths.has(mg.ym) }"
                width="12" height="12" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
              {{ mg.label }}
              <span>{{ mg.count }} 条</span>
            </div>

            <!-- 年展开、月折叠：该月里程碑拎到月级头下 -->
            <div v-if="collapsedMonths.has(mg.ym) && mg.msItems.length" class="tl-ms-lane month">
              <div v-for="m in mg.msItems" :key="m.id" class="tl-ms-item" @click="jumpToTarget(m.id)">
                <span class="tl-ms-diamond">◆</span>
                <span class="tl-ms-date">{{ m.date.slice(5) }}</span>
                <span class="tl-ms-sum">{{ m.summary }}</span>
              </div>
            </div>

            <template v-if="!collapsedMonths.has(mg.ym)">
              <template v-for="dg in mg.days" :key="dg.date">
                <!-- 多条日期折叠头 -->
                <div v-if="dg.items.length > 1" class="tl-day-label" @click="toggleDay(dg.date)">
                  <svg class="chevron" :class="{ collapsed: collapsedDays.has(dg.date) }"
                    width="10" height="10" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                  {{ dg.date.slice(5) }} {{ dg.weekday }}
                  <span>{{ dg.items.length }} 条</span>
                </div>

                <!-- 单条日期内联星期 -->
                <div v-if="dg.items.length === 1" class="tl-day-inline">
                  <span class="tl-day-inline-date">{{ dg.date.slice(5) }}</span>
                  <span class="tl-day-inline-week">{{ dg.weekday }}</span>
                </div>

                <!-- 事件列表：里程碑不参与当天折叠（始终高亮），其余跟随日折叠 -->
                <div
                  v-for="it in dg.items"
                  :id="'tlev-' + it.id"
                  :key="it.id"
                  class="tl-event"
                  :class="{ 'is-milestone': isMs(it.id), 'is-mark': isMarkEvent(it) }"
                  v-show="dg.items.length <= 1 || !collapsedDays.has(dg.date) || isMs(it.id)"
                >
                  <div class="tl-event-time">{{ fmtTime(it.ts) }}</div>
                  <div class="tl-event-icon" :class="getIconClass(it)">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" stroke-width="2.2"
                      stroke-linecap="round" stroke-linejoin="round"
                      v-html="getIconPath(it)" />
                  </div>
                  <div class="tl-event-body">
                    <div class="tl-event-title">{{ it.summary }}</div>
                    <button v-if="isMarkEvent(it) && it.refId != null" class="tl-jump" @click="jumpToTarget(it.refId!)">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 5 5 5 5 0 0 1-5 5h-5"/></svg>
                      定位原记录
                    </button>
                  </div>
                  <span class="tag" :class="getIconClass(it)">
                    {{ isMs(it.id) ? "◆ 里程碑" : EVENT_GROUP[it.type]?.label }}
                  </span>
                  <div class="tl-event-acts">
                    <button
                      v-if="!isMarkEvent(it)"
                      class="tl-msbtn"
                      :class="{ on: isMs(it.id) }"
                      :title="isMs(it.id) ? '取消里程碑标记' : '标记为里程碑'"
                      @click="toggleMilestone(it)"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><polygon points="12 2 22 12 12 22 2 12"/></svg>
                    </button>
                  </div>
                </div>
              </template>
            </template>
          </template>
        </template>
      </template>

      <div v-if="!yearGroups.length" class="empty">
        <div class="empty-title">{{ searchQuery ? "没有匹配的事件" : "还没有事件记录" }}</div>
        <div class="empty-sub">{{ searchQuery ? "换个关键字试试" : "创建一个目标或待办，时间线会从这里开始" }}</div>
      </div>

      <!-- 滚动加载哨兵 -->
      <div ref="sentinel" class="tl-sentinel">
        <span v-if="loadingMore" class="tl-loading">加载中…</span>
        <span v-else-if="!hasMore && yearGroups.length" class="tl-end">— 已经到底了 —</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ---- 搜索框 ---- */
.tl-search {
  display: flex; align-items: center; gap: 8px; margin-bottom: 14px;
  background: var(--card); border: 1px solid var(--line); border-radius: 10px;
  padding: 8px 12px; transition: border-color .15s ease;
}
.tl-search:focus-within { border-color: var(--accent); }
.tl-search-icon { color: var(--text-3); flex: 0 0 auto; }
.tl-search-input {
  flex: 1; min-width: 0; border: none; outline: none; background: none;
  font-size: 12.5px; color: var(--text-1); font-family: inherit;
}
.tl-search-input::placeholder { color: var(--text-3); }
.tl-search-clear {
  flex: 0 0 auto; width: 18px; height: 18px; border-radius: 50%;
  display: grid; place-items: center; font-size: 14px; color: var(--text-3);
  cursor: pointer; transition: all .15s ease;
}
.tl-search-clear:hover { background: var(--hover-2); color: var(--text-1); }

/* ---- 筛选药丸 ---- */
.tl-filters { display: flex; gap: 6px; margin-bottom: 20px; flex-wrap: wrap; align-items: center; }
.f-chip {
  padding: 6px 13px; border-radius: 999px; font-size: 12px; color: var(--text-2);
  background: var(--card); border: 1px solid var(--line); cursor: pointer;
  transition: all .18s ease; font-weight: 500;
}
.f-chip:hover { color: var(--text-1); }
.f-chip.on { background: #1A1D21; color: #fff; border-color: #1A1D21; font-weight: 600; }
.tl-filter-sep { width: 1px; height: 18px; background: var(--line); margin: 0 4px; flex: 0 0 auto; }
.date-chip { font-size: 11px; padding: 5px 10px; }

/* ---- 事件流 ---- */
.tl-feed { display: flex; flex-direction: column; gap: 0; }

/* ---- 年级头 ---- */
.tl-year-label {
  display: flex; align-items: center; gap: 6px;
  font-size: 14px; font-weight: 800; color: var(--text-1);
  letter-spacing: .3px; padding: 20px 0 10px; cursor: pointer;
  user-select: none; position: sticky; top: 0; background: var(--bg); z-index: 3;
}
.tl-year-label span { color: var(--text-3); font-weight: 500; margin-left: 8px; font-size: 11px; }
.tl-year-label:first-child { padding-top: 0; }

/* ---- 月级头 ---- */
.tl-month-label {
  display: flex; align-items: center; gap: 5px;
  font-size: 12.5px; font-weight: 700; color: var(--text-1);
  letter-spacing: .3px; padding: 14px 0 8px 20px; cursor: pointer;
  user-select: none; position: sticky; top: 30px; background: var(--bg); z-index: 2;
}
.tl-month-label span { color: var(--text-3); font-weight: 500; margin-left: 8px; font-size: 11px; }

/* ---- 日级头（多条折叠） ---- */
.tl-day-label {
  display: flex; align-items: center; gap: 5px;
  font-size: 11.5px; font-weight: 600; color: var(--text-2);
  padding: 8px 0 4px 40px; cursor: pointer; user-select: none;
}
.tl-day-label span { color: var(--text-3); font-weight: 500; margin-left: 6px; font-size: 10px; }

/* ---- 日级内联（单条不折叠） ---- */
.tl-day-inline {
  display: flex; align-items: baseline; gap: 6px;
  padding: 8px 0 2px 40px;
}
.tl-day-inline-date { font-size: 11.5px; font-weight: 600; color: var(--text-3); font-variant-numeric: tabular-nums; }
.tl-day-inline-week { font-size: 10px; color: var(--text-3); }

/* ---- chevron 箭头 ---- */
.chevron {
  flex: 0 0 auto; transition: transform .2s ease; color: var(--text-3);
}
.chevron.collapsed { transform: rotate(-90deg); }

/* ---- 单条事件 ---- */
.tl-event {
  display: grid; grid-template-columns: 48px 24px 1fr auto auto;
  gap: 12px; align-items: flex-start; padding: 10px 0 10px 40px;
  position: relative;
}
.tl-event-time {
  font-size: 11px; color: var(--text-3); font-variant-numeric: tabular-nums;
  padding-top: 2px; text-align: right;
}
.tl-event-icon {
  width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center;
  background: var(--accent-soft); color: var(--accent-dark); flex: 0 0 24px;
  position: relative; z-index: 1;
}
.tl-event-icon.purple { background: var(--purple-soft); color: var(--purple); }
.tl-event-icon.orange { background: var(--orange-soft); color: var(--orange); }
.tl-event-icon.blue { background: var(--blue-soft); color: var(--blue); }
.tl-event-icon.red { background: var(--red-soft); color: var(--red); }
/* 里程碑：跟随主题色，用实底强调区别于浅绿的普通事件 */
.tl-event-icon.ms { background: var(--accent); color: #fff; }
.tl-event-icon.ms svg { transform: rotate(0deg); }
.tl-event-icon.grey { background: #F4F6F9; color: var(--text-3); }
/* 里程碑：不参与折叠、始终高亮（主题色淡底标出“这是轴上的一个大事点”） */
.tl-event.is-milestone { background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 14%, transparent), transparent 70%); border-radius: 10px; }
/* 标记动作本身：弱化标题，配“定位原记录”回跳过去那一格 */
.tl-event.is-mark .tl-event-title { color: var(--text-2); font-weight: 500; }
.tl-jump {
  margin-top: 4px; display: inline-flex; align-items: center; gap: 4px;
  font-size: 11px; color: var(--text-3); background: none; border: none;
  cursor: pointer; padding: 0; font-family: inherit; transition: color .15s ease;
}
.tl-jump:hover { color: var(--accent-dark); }
/* 里程碑开关：hover 才浮现，已标记时常驻主题色实底 */
.tl-event-acts { display: flex; align-items: flex-start; gap: 4px; padding-top: 1px; }
.tl-msbtn {
  width: 24px; height: 24px; border-radius: 7px; border: 1px solid transparent;
  display: grid; place-items: center; cursor: pointer; color: var(--text-3);
  background: none; opacity: 0; transition: opacity .15s ease, color .15s ease, background .15s ease;
}
.tl-event:hover .tl-msbtn { opacity: 1; }
.tl-msbtn:hover { color: var(--accent-dark); background: var(--accent-soft); }
.tl-msbtn.on { opacity: 1; color: #fff; background: var(--accent); }
/* 拎到年/月头的里程碑轨道：折叠时也看得到，点一下展开并定位回原行 */
.tl-ms-lane { display: flex; flex-direction: column; gap: 1px; padding: 2px 0 6px 40px; }
.tl-ms-lane.month { padding-left: 60px; }
.tl-ms-item {
  display: flex; align-items: center; gap: 8px; cursor: pointer; min-width: 0;
  font-size: 12px; padding: 4px 8px; border-radius: 8px; transition: background .15s ease;
}
.tl-ms-item:hover { background: var(--accent-soft); }
.tl-ms-diamond { color: var(--accent); font-size: 9px; flex: 0 0 auto; }
.tl-ms-date { color: var(--accent-dark); font-weight: 600; font-variant-numeric: tabular-nums; flex: 0 0 auto; }
.tl-ms-sum { color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.tl-event::before {
  content: ''; position: absolute; left: 90px; top: 36px; bottom: -10px;
  width: 1px; background: var(--line);
}
.tl-event:last-child::before { display: none; }
.tl-event-body { padding-top: 1px; }
.tl-event-title { font-size: 13px; font-weight: 600; color: var(--text-1); letter-spacing: -.1px; }

/* ---- 标签颜色 ---- */
.tag {
  font-size: 10.5px; font-weight: 600; padding: 3px 9px; border-radius: 999px;
  white-space: nowrap; display: inline-flex; align-items: center; gap: 4px;
}
.tag.green { background: var(--accent-soft); color: var(--accent-dark); }
.tag.purple { background: var(--purple-soft); color: var(--purple); }
.tag.orange { background: var(--orange-soft); color: var(--orange); }
.tag.blue { background: var(--blue-soft); color: var(--blue); }
.tag.red { background: var(--red-soft); color: var(--red); }
.tag.gold { background: var(--accent-soft); color: var(--accent-dark); }
.tag.ms { background: var(--accent); color: #fff; }
.tag.grey { background: #F4F6F9; color: var(--text-3); }

/* ---- 哨兵 / 加载 ---- */
.tl-sentinel { padding: 16px 0 8px; text-align: center; }
.tl-loading {
  font-size: 11.5px; color: var(--text-3); font-weight: 500;
  animation: pulse 1.2s ease-in-out infinite;
}
@keyframes pulse { 0%,100% { opacity: .5; } 50% { opacity: 1; } }
.tl-end { font-size: 11px; color: var(--text-3); letter-spacing: .3px; }

/* ---- 空状态 ---- */
.empty { padding: 44px 20px; text-align: center; }
.empty-title { font-size: 13px; font-weight: 600; color: var(--text-2); }
.empty-sub { font-size: 11.5px; color: var(--text-3); margin-top: 5px; }

@media (max-width: 767px) {
  .tl-event { grid-template-columns: 40px 24px 1fr auto auto; padding-left: 32px; gap: 8px; }
  .tl-month-label { padding-left: 12px; }
  .tl-day-label, .tl-day-inline { padding-left: 28px; }
  .tl-ms-lane { padding-left: 28px; }
  .tl-ms-lane.month { padding-left: 40px; }
  /* 触屏无 hover：里程碑开关常驻显示 */
  .tl-msbtn { opacity: 1; }
}
</style>
