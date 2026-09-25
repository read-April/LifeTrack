<script setup lang="ts">
/**
 * 日志页：顶部周期切换——日志 / 周报 / 月报 / 年度总结
 * 日志态：左栏月历 + 本月小结，右栏连续记录纸带
 * 报告态（周报/月报/年度总结）：无左栏，整宽一张 ReportPanel，周期切换在它的标题行里
 * 数据走 utils/logs.ts 与 utils/reports.ts（随记已接 SQLite，报告暂留 localStorage）
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import {
  type LogItem, addLog, daysBetween, deleteLog, fmtRich, isoDate, isoToday, kindColor,
  loadLogs, LOG_KINDS as KINDS, parseEntry, parseIso, streakOf, updateLog,
} from "../utils/logs";
import { type ReportMode, shiftPeriod } from "../utils/reports";
import { addEvent } from "../utils/timeline";
import ReportPanel from "../components/ReportPanel.vue";
import { readUi, writeUi } from "../utils/prefs";

// 行内编辑时自动聚焦
const vFocus = { mounted: (el: HTMLElement) => el.focus() };

const WEEK = ["一", "二", "三", "四", "五", "六", "日"];

const logs = ref<LogItem[]>([]);
onMounted(async () => { logs.value = await loadLogs(); });

// ---------- 周期切换（上次看的形态记下来，下次打开直接回到它） ----------
type ViewMode = "log" | ReportMode;
const SEGS: { k: ViewMode; t: string }[] = [
  { k: "log", t: "随记" }, { k: "week", t: "周报" }, { k: "month", t: "月报" }, { k: "year", t: "年度总结" },
];
const mode = ref<ViewMode>((["log", "week", "month", "year"] as ViewMode[]).includes(readUi().logMode as ViewMode)
  ? (readUi().logMode as ViewMode) : "log");
// 报告面板实例：弹窗文案由面板自己管（askLeave），这里只在动游标前问一句
const panel = ref<InstanceType<typeof ReportPanel> | null>(null);
async function setMode(m: ViewMode) {
  if (m === mode.value) return;
  if (panel.value && !(await panel.value.askLeave("切换视图"))) return;
  mode.value = m;
  writeUi({ logMode: m });
}
const isLog = computed(() => mode.value === "log");

// 报告态各自记住自己的游标（落在周期内任意一天即可）
const reportDate = ref<Record<ReportMode, Date>>({ week: new Date(), month: new Date(), year: new Date() });
const rMode = computed(() => mode.value as ReportMode);
const rDate = computed(() => reportDate.value[rMode.value]);
/** 上一期 / 下一期，由报告面板标题行的左右箭头触发 */
async function shiftReport(n: number) {
  if (panel.value && !(await panel.value.askLeave(n > 0 ? "切到下一期" : "切到上一期"))) return;
  const m = rMode.value;
  reportDate.value[m] = shiftPeriod(m, reportDate.value[m], n);
}
async function backReport() {
  if (panel.value && !(await panel.value.askLeave("回到本期"))) return;
  reportDate.value[rMode.value] = new Date();
}

// ---------- 日历 ----------
const today = isoToday();
const init = new Date();
const cursor = ref({ y: init.getFullYear(), m: init.getMonth() });
const activeDate = ref("");
const monthPrefix = computed(() => `${cursor.value.y}-${String(cursor.value.m + 1).padStart(2, "0")}`);
const dateSet = computed(() => new Set(logs.value.map(l => l.date)));

const calCells = computed(() => {
  const { y, m } = cursor.value;
  const lead = (new Date(y, m, 1).getDay() + 6) % 7; // 周一为首列
  const cells: { day: number; iso: string; dim: boolean; has: boolean; today: boolean }[] = [];
  const push = (d: Date, dim: boolean) => {
    const s = isoDate(d);
    cells.push({ day: d.getDate(), iso: s, dim, has: dateSet.value.has(s), today: s === today });
  };
  for (let i = lead; i > 0; i--) push(new Date(y, m, -i + 1), true);
  const total = new Date(y, m + 1, 0).getDate();
  for (let d = 1; d <= total; d++) push(new Date(y, m, d), false);
  for (let d = 1; cells.length % 7 !== 0 || cells.length === (lead + total); d++) push(new Date(y, m + 1, d), true);
  return cells;
});
function shiftMonth(n: number) {
  const d = new Date(cursor.value.y, cursor.value.m + n, 1);
  cursor.value = { y: d.getFullYear(), m: d.getMonth() };
}
function backToToday() {
  const d = new Date();
  cursor.value = { y: d.getFullYear(), m: d.getMonth() };
  activeDate.value = "";
}
// 已经停在当月、也没选具体日期时，“回到本月”无事可做，置灰而不是空响应
const atCalNow = computed(() => monthPrefix.value === today.slice(0, 7) && !activeDate.value);
function pickDay(c: { iso: string; dim: boolean }) {
  if (c.dim) {
    const d = parseIso(c.iso);
    cursor.value = { y: d.getFullYear(), m: d.getMonth() };
  }
  activeDate.value = activeDate.value === c.iso ? "" : c.iso;
}

// ---------- 筛选 ----------
const q = ref("");
const kind = ref("");
const filterOpen = ref(false);
const filtering = computed(() => !!q.value.trim() || !!kind.value || !!activeDate.value);

const filtered = computed(() => {
  const kw = q.value.trim().toLowerCase();
  return logs.value.filter(l => {
    if (kw && !(l.text.toLowerCase().includes(kw) || l.tags.some(t => t.toLowerCase().includes(kw)))) return false;
    if (kind.value && l.kind !== kind.value) return false;
    if (activeDate.value) return l.date === activeDate.value;
    return l.date.startsWith(monthPrefix.value);
  });
});
function clearFilters() {
  q.value = "";
  kind.value = "";
  activeDate.value = "";
}
// 生效中的筛选条件，收纳成一个小 pill
const filterLabel = computed(() => {
  const parts: string[] = [];
  if (activeDate.value) parts.push(`${parseIso(activeDate.value).getMonth() + 1}/${parseIso(activeDate.value).getDate()}`);
  if (kind.value) parts.push(kind.value);
  if (q.value.trim()) parts.push(`“${q.value.trim()}”`);
  return parts.join(" · ");
});

// ---------- 分组（连续纸带：按日分组 + 跳日插"隔 N 天"） ----------
function relLabel(d: string) {
  const n = daysBetween(d, today);
  if (n === 0) return "今天";
  if (n === 1) return "昨天";
  if (n > 0 && n <= 6) return `${n} 天前`;
  const x = parseIso(d);
  return `${x.getMonth() + 1} 月 ${x.getDate()} 日`;
}
const groups = computed(() => {
  const map = new Map<string, LogItem[]>();
  for (const l of filtered.value) {
    if (!map.has(l.date)) map.set(l.date, []);
    map.get(l.date)!.push(l);
  }
  const keys = [...map.keys()].sort((a, b) => (a < b ? 1 : -1));
  return keys.map((date, i) => {
    const d = parseIso(date);
    const prev = i > 0 ? keys[i - 1] : null;
    return {
      date,
      rel: relLabel(date),
      full: `${d.getMonth() + 1} 月 ${d.getDate()} 日`,
      week: `星期${WEEK[(d.getDay() + 6) % 7]}`,
      isToday: date === today,
      gap: prev ? daysBetween(prev, date) - 1 : 0, // 与上一组之间空了几天
      items: map.get(date)!.sort((a, b) => (a.time < b.time ? 1 : -1)),
    };
  });
});

// ---------- 统计（本月） ----------
const monthLogs = computed(() => logs.value.filter(l => l.date.startsWith(monthPrefix.value)));
const monthDays = computed(() => new Set(monthLogs.value.map(l => l.date)).size);
/** “本月”跟着游标走：停在当月说本月，翻到别的月份就报具体月份，不写死 */
const monthWord = computed(() => {
  const { y, m } = cursor.value;
  const now = parseIso(today);
  if (y === now.getFullYear() && m === now.getMonth()) return "本月";
  const short = `${m + 1} 月`;
  return y === now.getFullYear() ? short : `${y} 年 ${short}`;
});
const kindStats = computed(() => {
  const counts = new Map<string, number>();
  for (const l of monthLogs.value) counts.set(l.kind, (counts.get(l.kind) ?? 0) + 1);
  const max = Math.max(1, ...counts.values());
  return KINDS.filter(k => counts.has(k.key))
    .map(k => ({ ...k, n: counts.get(k.key)!, pct: Math.round(((counts.get(k.key) ?? 0) / max) * 100) }))
    .sort((a, b) => b.n - a.n);
});
const streak = computed(() => streakOf(logs.value.map(l => l.date)));
const viewTitle = computed(() => {
  if (activeDate.value) return `只看 ${relLabel(activeDate.value)}`;
  if (q.value.trim()) return "搜索结果";
  if (kind.value) return `${kind.value} · ${monthWord.value}`;
  return `${monthWord.value}的记录`;
});

// ---------- 录入（多行：回车换行，Ctrl + 回车或点“保存”才落库） ----------
const draftText = ref("");
const draftKind = ref("生活");
const draftEl = ref<HTMLTextAreaElement | null>(null);
/** 随内容长高，封顶 320px 后内部滚动 */
function autoGrow() {
  const el = draftEl.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(320, el.scrollHeight + 2)}px`;
}

// ---------- 录入卡与月历等高：以左栏月历为基准，右栏录入卡至少撑到同一高度 ----------
const calEl = ref<HTMLElement | null>(null);
const addCardEl = ref<HTMLElement | null>(null);
let calRo: ResizeObserver | null = null;
function syncCardHeight() {
  const cal = calEl.value, card = addCardEl.value;
  if (!cal || !card) return;
  card.style.minHeight = `${cal.offsetHeight}px`;
}
function watchCalendar() {
  calRo?.disconnect();
  calRo = null;
  if (!calEl.value) return;
  if (typeof ResizeObserver !== "undefined") {
    calRo = new ResizeObserver(syncCardHeight);
    calRo.observe(calEl.value);
  }
  syncCardHeight();
}
watch(isLog, () => nextTick(watchCalendar));
onMounted(() => nextTick(watchCalendar));
onUnmounted(() => calRo?.disconnect());
async function submitLog() {
  const raw = draftText.value.trim();
  if (!raw) return;
  const { text, tags } = parseEntry(raw);
  if (!text) return;
  const item = await addLog({ text, kind: draftKind.value, tags });
  logs.value = [item, ...logs.value];
  const brief = text.length > 30 ? text.slice(0, 30) + "\u2026" : text;
  await addEvent("log.created", `记录随记：${brief}`);
  draftText.value = "";
  if (draftEl.value) draftEl.value.style.height = "auto";
  draftEl.value?.focus();
  const d = new Date();
  cursor.value = { y: d.getFullYear(), m: d.getMonth() };
  clearFilters();
}
async function removeLog(l: LogItem) {
  await deleteLog(l.id);
  logs.value = logs.value.filter(x => x.id !== l.id);
  await addEvent("log.removed", "删除随记");
}

/** 长记录默认折行，展开全文不把整张纸带顶走 */
const expanded = ref<Record<number, boolean>>({});
const isLong = (t: string) => t.length > 96 || t.includes("\n");

// ---------- 行内编辑（同样多行：Ctrl + 回车或失焦保存，Esc 放弃） ----------
const editId = ref(0);
const editText = ref("");
function startEdit(l: LogItem) {
  editId.value = l.id;
  editText.value = l.text;
}
async function commitEdit(l: LogItem) {
  const v = editText.value.trim();
  if (v && v !== l.text) {
    l.text = v;
    l.updatedAt = await updateLog(l.id, v);
    await addEvent("log.updated", "编辑随记");
  }
  editId.value = 0;
}
</script>

<template>
  <div class="pg">
    <div class="hello hello-row">
      <div class="hello-tx">
        <h1>随记</h1>
        <p>
          {{ monthWord }} <strong>{{ monthLogs.length }}</strong> 条 · 共 <strong>{{ logs.length }}</strong> 条 · 已连续记录
          <strong>{{ streak }}</strong> 天
        </p>
      </div>
      <!-- 周期切换：日志是流水，周报/月报/年度总结是同一个本子的不同缩放 -->
      <div class="segs">
        <button v-for="s in SEGS" :key="s.k" class="seg" :class="{ on: mode === s.k }" @click="setMode(s.k)">
          {{ s.t }}
        </button>
      </div>
    </div>

    <div class="log-layout" :class="{ one: !isLog }">
      <!-- ============ 左栏：只有日志态需要月历 + 本月小结，报告态整宽一张纸 ============ -->
      <aside v-if="isLog" class="side">
        <section ref="calEl" class="calendar">
          <div class="cal-head">
            <div class="cal-month">{{ cursor.y }} 年 {{ cursor.m + 1 }} 月</div>
            <div class="cal-nav">
              <button title="上个月" @click="shiftMonth(-1)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
              </button>
              <button class="cal-today" :disabled="atCalNow" :title="atCalNow ? '已经在本月' : '回到本月并取消选中的日期'" @click="backToToday">回到本月</button>
              <button title="下个月" @click="shiftMonth(1)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
              </button>
            </div>
          </div>
          <div class="cal-grid">
            <div v-for="w in WEEK" :key="w" class="cal-day head">{{ w }}</div>
            <div
              v-for="(c, i) in calCells"
              :key="c.iso + i"
              class="cal-day"
              :class="{ dim: c.dim, today: c.today, 'has-dot': c.has, sel: c.iso === activeDate }"
              @click="pickDay(c)"
            >{{ c.day }}</div>
          </div>
          <div v-if="activeDate" class="cal-foot">
            <span class="cal-clear" @click="activeDate = ''">只看这一天 · 取消 ›</span>
          </div>
        </section>

        <section class="msum">
          <div class="side-title">{{ monthWord }}小结</div>
          <div class="ms-nums">
            <div class="ms-n"><b>{{ monthLogs.length }}</b><span>条记录</span></div>
            <div class="ms-n"><b>{{ monthDays }}</b><span>活跃天</span></div>
            <div class="ms-n"><b>{{ monthDays ? (monthLogs.length / monthDays).toFixed(1) : "0" }}</b><span>条 / 天</span></div>
          </div>
          <div class="ms-bars">
            <div v-for="k in kindStats" :key="k.key" class="ms-bar">
              <span class="ms-k">{{ k.key }}</span>
              <span class="ms-track"><i :style="{ width: k.pct + '%', background: k.color }"></i></span>
              <span class="ms-v">{{ k.n }}</span>
            </div>
            <div v-if="!kindStats.length" class="ms-empty">这个月还没有记录</div>
          </div>
        </section>
      </aside>

      <div class="log-main">
        <template v-if="isLog">
        <div ref="addCardEl" class="add-card">
          <div class="add-top">
            <span class="add-pen">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
            </span>
            <span class="add-cap">记一条</span>
            <span class="add-hint">回车换行 · Ctrl + 回车保存</span>
          </div>
          <textarea
            ref="draftEl"
            v-model="draftText"
            class="add-input"
            rows="3"
            spellcheck="false"
            placeholder="今天做了什么、想清楚了什么、卡在哪里…（#标签 归类，**文字** 加粗，可多行）"
            @input="autoGrow"
            @keydown.ctrl.enter.prevent="submitLog"
            @keydown.meta.enter.prevent="submitLog"
          ></textarea>
          <div class="add-foot">
            <div class="kinds">
              <button
                v-for="k in KINDS"
                :key="k.key"
                class="kind-btn"
                :class="{ on: draftKind === k.key }"
                :style="draftKind === k.key ? { background: k.color, borderColor: k.color } : undefined"
                @click="draftKind = k.key"
              >{{ k.key }}</button>
            </div>
            <button class="save-btn" :disabled="!draftText.trim()" @click="submitLog">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              保存
            </button>
          </div>
        </div>

        <!-- 工具条：视图说明 + 筛选收纳 -->
        <div class="stream-head">
          <div class="sh-left">
            <span class="sh-title">{{ viewTitle }}</span>
            <span class="sh-count">{{ filtered.length }} 条</span>
          </div>
          <div class="sh-right">
            <span v-if="filterLabel" class="f-pill" @click="clearFilters">{{ filterLabel }} ×</span>
            <button class="f-btn" :class="{ on: filterOpen }" @click="filterOpen = !filterOpen">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="10" y1="18" x2="14" y2="18"/></svg>
              筛选
            </button>
            <template v-if="filterOpen">
              <div class="f-back" @click="filterOpen = false"></div>
              <div class="f-pop">
                <div class="search">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg>
                  <input v-model="q" placeholder="搜索正文或标签" />
                </div>
                <div class="kinds wrap">
                  <button class="kind-btn" :class="{ on: kind === '' }" @click="kind = ''">全部类别</button>
                  <button
                    v-for="k in KINDS"
                    :key="k.key"
                    class="kind-btn"
                    :class="{ on: kind === k.key }"
                    :style="kind === k.key ? { background: k.color, borderColor: k.color } : undefined"
                    @click="kind = kind === k.key ? '' : k.key"
                  >{{ k.key }}</button>
                </div>
                <div class="f-reset" @click="clearFilters(); filterOpen = false">清空全部筛选</div>
              </div>
            </template>
          </div>
        </div>

        <!-- 连续纸带：一张白底到底，日期头粘性、条目只靠分隔线 -->
        <div class="paper">
          <section v-for="g in groups" :key="g.date" class="day-group">
            <div v-if="g.gap > 0" class="gap-line"><span>隔 {{ g.gap }} 天</span></div>
            <header class="ld-head" :class="{ 'is-today': g.isToday }">
              <div class="ld-date">{{ g.rel }} <span>{{ g.full }} · {{ g.week }}</span></div>
              <div class="ld-count">{{ g.items.length }} 条</div>
            </header>
            <article v-for="it in g.items" :key="it.id" class="entry" :class="{ editing: editId === it.id }">
              <div class="e-time">{{ it.time }}</div>
              <div class="e-body">
                <textarea
                  v-if="editId === it.id"
                  v-model="editText"
                  class="e-edit"
                  rows="5"
                  spellcheck="false"
                  v-focus
                  @keydown.ctrl.enter.prevent="commitEdit(it)"
                  @keydown.meta.enter.prevent="commitEdit(it)"
                  @keydown.esc="editId = 0"
                  @blur="commitEdit(it)"
                ></textarea>
                <div v-if="editId === it.id" class="e-tip">Ctrl + 回车保存 · Esc 取消</div>
                <div
                  v-else
                  class="e-text"
                  :class="{ warn: it.kind === '问题', clamped: isLong(it.text) && !expanded[it.id] }"
                  @click="isLong(it.text) && (expanded[it.id] = !expanded[it.id])"
                  v-html="fmtRich(it.text)"
                ></div>
                <button v-if="isLong(it.text) && editId !== it.id" class="e-more" @click="expanded[it.id] = !expanded[it.id]">
                  {{ expanded[it.id] ? "收起 ▴" : "展开全文 ▾" }}
                </button>
                <div class="e-meta">
                  <span class="e-cat"><i :style="{ background: kindColor(it.kind) }"></i>{{ it.kind }}</span>
                  <span v-for="t in it.tags" :key="t" class="e-tag">{{ t }}</span>
                </div>
              </div>
              <div class="e-acts">
                <button class="e-act" title="编辑" @click="startEdit(it)">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
                </button>
                <button class="e-act del" title="删除" @click="removeLog(it)">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                </button>
              </div>
            </article>
          </section>

          <div v-if="!groups.length" class="empty">
            <div class="empty-title">{{ filtering ? "没有符合条件的记录" : "这个月还是空的" }}</div>
            <div class="empty-sub">{{ filtering ? "换个关键字或类别，也可以记一条新的" : "在上方写下今天的第一条记录" }}</div>
          </div>
        </div>
        </template>

        <!-- 报告态：周报 / 月报 / 年度总结（周期切换在面板标题行里） -->
        <ReportPanel v-else ref="panel" :mode="rMode" :date="rDate" :logs="logs" @prev="shiftReport(-1)" @next="shiftReport(1)" @back="backReport" />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ============ 骨架 ============ */
.hello-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.segs {
  display: inline-flex; gap: 2px; padding: 3px; background: var(--track); border-radius: 11px;
}
.seg {
  border: none; background: none; border-radius: 8px; cursor: pointer; font-family: inherit;
  font-size: 11.5px; font-weight: 600; color: var(--text-3); padding: 5px 12px; white-space: nowrap;
  transition: background-color .16s ease, color .16s ease, box-shadow .16s ease;
}
.seg:hover { color: var(--text-1); }
.seg.on { background: var(--card); color: var(--accent-dark); box-shadow: 0 1px 3px rgba(16,24,40,.10); }

.log-layout { display: grid; grid-template-columns: 248px 1fr; gap: 16px; align-items: start; }
/* 报告态没有左栏，一张纸整宽 */
.log-layout.one { grid-template-columns: 1fr; }
.log-main { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.side { display: flex; flex-direction: column; gap: 14px; position: sticky; top: 0; }

/* ============ 月历 ============ */
.calendar, .msum {
  background: var(--card); border: 1px solid var(--line); border-radius: var(--r);
  box-shadow: var(--shadow-sm); padding: 16px 16px 14px;
}
.cal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.cal-month { font-size: 12.5px; font-weight: 700; color: var(--text-1); letter-spacing: -.2px; }
.cal-nav { display: flex; align-items: center; gap: 2px; }
.cal-nav button {
  width: 22px; height: 22px; border: none; background: none; border-radius: 6px;
  display: grid; place-items: center; color: var(--text-3); cursor: pointer;
  transition: background-color .15s ease, color .15s ease;
}
.cal-nav button:hover { background: var(--hover); color: var(--text-1); }
.cal-today { width: auto !important; padding: 0 6px; font-size: 10px; font-weight: 600; font-family: inherit; }
.cal-nav button:disabled { opacity: .38; cursor: default; }
.cal-nav button:disabled:hover { background: none; color: var(--text-3); }
.cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
.cal-day {
  height: 27px; border-radius: 7px; display: flex; align-items: center; justify-content: center;
  font-size: 11px; color: var(--text-2); cursor: pointer; position: relative;
  font-variant-numeric: tabular-nums; transition: background-color .15s ease, color .15s ease;
}
.cal-day:hover { background: var(--hover); }
.cal-day.head { font-size: 9.5px; color: var(--text-3); font-weight: 600; cursor: default; height: 20px; }
.cal-day.head:hover { background: none; }
.cal-day.dim { opacity: .38; }
.cal-day.today { background: var(--accent); color: #fff; font-weight: 700; }
.cal-day.today:hover { background: var(--accent-dark); }
.cal-day.sel { background: var(--accent-soft); color: var(--accent-dark); font-weight: 700; }
.cal-day.sel.today { background: var(--accent); color: #fff; }
.cal-day.has-dot::after {
  content: ''; position: absolute; bottom: 2px; left: 50%; transform: translateX(-50%);
  width: 3px; height: 3px; border-radius: 50%; background: var(--accent);
}
.cal-day.sel.has-dot::after, .cal-day.today.has-dot::after { background: #fff; }
.cal-foot { margin-top: 10px; padding-top: 9px; border-top: 1px solid var(--line); min-height: 15px; }
.cal-clear { font-size: 10.5px; color: var(--accent-dark); font-weight: 600; cursor: pointer; }
.cal-clear:hover { text-decoration: underline; }

/* ============ 本月小结 ============ */
.side-title { font-size: 11px; font-weight: 700; color: var(--text-2); letter-spacing: .2px; margin-bottom: 12px; }
.ms-nums { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-bottom: 14px; }
.ms-n { display: flex; flex-direction: column; }
.ms-n b { font-size: 19px; font-weight: 700; color: var(--text-1); letter-spacing: -.6px; line-height: 1.15; font-variant-numeric: tabular-nums; }
.ms-n span { font-size: 10px; color: var(--text-3); }
.ms-bars { display: flex; flex-direction: column; gap: 7px; }
.ms-bar { display: grid; grid-template-columns: 30px 1fr 18px; align-items: center; gap: 7px; }
.ms-k { font-size: 10.5px; color: var(--text-2); }
.ms-track { height: 4px; background: var(--track); border-radius: 2px; overflow: hidden; }
.ms-track i { display: block; height: 100%; border-radius: 2px; transition: width .3s ease; }
.ms-v { font-size: 10.5px; color: var(--text-3); text-align: right; font-variant-numeric: tabular-nums; }
.ms-empty { font-size: 11px; color: var(--text-3); }

/* ============ 录入 ============ */
.add-card {
  background: var(--card); border: 1px solid var(--line); border-radius: var(--r);
  box-shadow: var(--shadow-sm); padding: 0 16px 12px; transition: border-color .18s ease;
  display: flex; flex-direction: column;
}
.add-card:focus-within { border-color: var(--accent); }
.add-top { display: flex; align-items: center; gap: 9px; padding-top: 11px; }
.add-pen {
  width: 22px; height: 22px; border-radius: 7px; flex: 0 0 22px;
  background: var(--accent-soft); color: var(--accent-dark); display: grid; place-items: center;
}
.add-cap { font-size: 12px; font-weight: 700; color: var(--text-1); }
.add-hint { font-size: 10.5px; color: var(--text-3); margin-left: auto; white-space: nowrap; }
.add-input {
  width: 100%; border: none; outline: none; background: none; box-sizing: border-box;
  margin-top: 6px; padding: 0 0 0 31px; font-size: 13px; line-height: 1.8; color: var(--text-1);
  font-family: inherit; resize: none; overflow-y: auto; scrollbar-width: none; min-height: 58px; max-height: 320px;
}
.add-input::-webkit-scrollbar { display: none; }
.add-input::placeholder { color: var(--text-3); }
.add-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: auto; padding-top: 10px; }
.save-btn {
  border: none; border-radius: 9px; background: var(--accent); color: #fff;
  font-size: 11.5px; font-weight: 600; font-family: inherit; padding: 6px 14px; cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto;
  transition: background-color .16s ease, opacity .16s ease;
}
.save-btn:hover:not(:disabled) { background: var(--accent-dark); }
.save-btn:disabled { opacity: .4; cursor: default; }

/* ============ 类别与保存 ============ */
.kinds { display: flex; gap: 5px; flex-wrap: wrap; min-width: 0; }
.kinds.wrap { margin-top: 2px; }
.kind-btn {
  border: 1px solid var(--line); background: var(--field); border-radius: 999px;
  font-size: 11px; padding: 3px 10px; color: var(--text-2); cursor: pointer;
  font-family: inherit; transition: all .15s ease; white-space: nowrap;
}
.kind-btn:hover { border-color: var(--accent); color: var(--accent-dark); }
.kind-btn.on { color: #fff; font-weight: 600; border-color: transparent; }

/* ============ 工具条 + 筛选浮层 ============ */
.stream-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 0 2px; }
.sh-left { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.sh-title { font-size: 12.5px; font-weight: 700; color: var(--text-1); letter-spacing: -.1px; }
.sh-count { font-size: 11px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.sh-right { display: flex; align-items: center; gap: 8px; position: relative; flex: 0 0 auto; }
.f-btn {
  border: 1px solid var(--line); background: var(--card); border-radius: 9px;
  font-size: 11.5px; color: var(--text-2); cursor: pointer; font-family: inherit;
  padding: 4px 10px; display: inline-flex; align-items: center; gap: 5px; transition: all .15s ease;
}
.f-btn:hover, .f-btn.on { border-color: var(--accent); color: var(--accent-dark); }
.f-pill {
  font-size: 11px; font-weight: 600; color: var(--accent-dark); background: var(--accent-soft);
  border-radius: 999px; padding: 3px 9px; cursor: pointer; white-space: nowrap;
}
.f-back { position: fixed; inset: 0; z-index: 50; }
.f-pop {
  position: absolute; right: 0; top: calc(100% + 8px); z-index: 51; width: 288px;
  background: var(--card); border: 1px solid var(--line); border-radius: 14px;
  box-shadow: var(--shadow-md); padding: 12px; animation: pop-in .16s ease;
}
@keyframes pop-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
.search {
  display: flex; align-items: center; gap: 7px; background: var(--hover-2); border: 1px solid transparent;
  border-radius: 9px; padding: 6px 10px; color: var(--text-3); transition: border-color .15s ease;
}
.search:focus-within { border-color: var(--accent); background: var(--field); }
.search input { flex: 1; min-width: 0; border: none; outline: none; background: none; font-size: 12px; color: var(--text-1); font-family: inherit; }
.f-reset { margin-top: 10px; padding-top: 9px; border-top: 1px solid var(--line); font-size: 11px; color: var(--text-3); cursor: pointer; text-align: center; }
.f-reset:hover { color: var(--danger); }

/* ============ 连续纸带 ============ */
.paper {
  background: var(--card); border: 1px solid var(--line); border-radius: var(--r);
  box-shadow: var(--shadow-sm); padding: 0 20px 8px;
}
.day-group:last-child .entry:last-child { border-bottom: none; }
.ld-head {
  position: sticky; top: 0; z-index: 2;
  display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
  padding: 13px 0 8px; background: var(--card); border-bottom: 1px solid var(--line);
}
.ld-date { font-size: 13px; font-weight: 700; color: var(--text-1); letter-spacing: -.1px; display: flex; align-items: center; gap: 7px; }
.ld-date span { font-size: 10.5px; color: var(--text-3); font-weight: 500; }
.ld-head.is-today .ld-date::before {
  content: ''; width: 3px; height: 12px; border-radius: 2px; background: var(--accent); flex: 0 0 3px;
}
.ld-count { font-size: 10.5px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.gap-line { display: flex; align-items: center; gap: 10px; padding: 10px 0 2px; color: var(--text-3); font-size: 10px; }
.gap-line::before, .gap-line::after { content: ''; flex: 1; border-top: 1px dashed var(--line-2); }
.gap-line span { flex: 0 0 auto; letter-spacing: .3px; }

.entry {
  display: grid; grid-template-columns: 42px 1fr 44px; gap: 12px; align-items: start;
  padding: 11px 0; border-bottom: 1px solid var(--line);
}
.e-time { font-size: 11px; color: var(--text-3); font-variant-numeric: tabular-nums; padding-top: 3px; }
.e-body { min-width: 0; }
.e-text {
  font-size: 12.5px; color: var(--text-2); line-height: 1.75; white-space: pre-wrap; word-break: break-word;
}
.e-text.clamped {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4;
  overflow: hidden; cursor: pointer;
}
.e-text:hover { color: var(--text-1); }
.e-text :deep(strong) { color: var(--text-1); font-weight: 600; }
.e-text.warn { color: var(--red); }
.e-text.warn :deep(strong) { color: var(--danger); }
.e-more {
  border: none; background: none; padding: 3px 0 0; cursor: pointer; font-family: inherit;
  font-size: 10.5px; font-weight: 600; color: var(--accent-dark);
}
.e-more:hover { text-decoration: underline; }
.e-edit {
  width: 100%; border: 1px solid var(--accent); border-radius: 8px; background: var(--field);
  font-size: 12.5px; line-height: 1.75; color: var(--text-1); font-family: inherit;
  padding: 7px 9px; outline: none; box-sizing: border-box; resize: vertical; min-height: 96px;
}
.e-tip { font-size: 10px; color: var(--text-3); margin-top: 5px; }
.e-meta { display: flex; gap: 7px; margin-top: 6px; flex-wrap: wrap; align-items: center; }
.e-cat { font-size: 10.5px; color: var(--text-2); display: inline-flex; align-items: center; gap: 4px; }
.e-cat i { width: 5px; height: 5px; border-radius: 50%; display: block; }
.e-tag { font-size: 10px; padding: 1px 7px; border-radius: 999px; background: var(--chip); color: var(--text-2); }
/* 操作区固定占位，hover 才显形——不跳位；窄屏（触屏无 hover）常驻 */
.e-acts { display: flex; gap: 2px; justify-content: flex-end; padding-top: 1px; }
.e-act {
  width: 20px; height: 20px; border: none; background: none; border-radius: 5px;
  color: var(--text-3); cursor: pointer; display: grid; place-items: center;
  opacity: 0; transition: opacity .15s ease, background-color .15s ease, color .15s ease;
}
.entry:hover .e-act, .entry.editing .e-act { opacity: 1; }
.e-act:hover { background: var(--hover-2); color: var(--text-1); }
.e-act.del:hover { background: var(--red-soft); color: var(--danger); }

.empty { padding: 44px 20px; text-align: center; }
.empty-title { font-size: 13px; font-weight: 600; color: var(--text-2); }
.empty-sub { font-size: 11.5px; color: var(--text-3); margin-top: 5px; }

/* 桌面端：页面撑满可视高，纸带卡吸收多余高度——窗口越大纸带越长；记录多时自然往下排，整页照常滚动 */
@media (min-width: 1024px) {
  .pg { display: flex; flex-direction: column; min-height: calc(100vh - 104px); } /* 100vh - 状态栏 46 - content 上下内边距 22/36 */
  .log-layout { flex: 1; min-height: 0; align-items: stretch; }
  .side { align-self: start; } /* 左栏不被拉伸，粘性定位行为不变 */
  .paper { flex: 1; }
}

/* ============ 响应式（断点体系见 global.css） ============ */
@media (max-width: 1023px) {
  /* 左栏变横向两格放在流上方 */
  .log-layout { grid-template-columns: 1fr; }
  .side { position: static; flex-direction: row; align-items: stretch; }
  .side > * { flex: 1; min-width: 0; }
  .calendar { max-width: 380px; }
  .e-act { opacity: 1; }
}
@media (max-width: 767px) {
  .side { flex-direction: column; }
  .calendar { max-width: none; }
  .cal-day { height: 34px; }
  .cal-day.head { height: 20px; }
  .paper { padding: 0 14px 8px; }
  .entry { grid-template-columns: 40px 1fr 26px; gap: 9px; }
  .e-acts { flex-direction: column; }
  .add-foot { flex-direction: column; align-items: stretch; gap: 10px; }
  .save-btn { justify-content: center; padding: 9px 14px; }
  .add-input { padding-left: 0; }
  .kind-btn { padding: 6px 12px; }
  .f-pop { width: min(288px, calc(100vw - 32px)); }
  /* 周期切换成满宽横滑，不挤压标题 */
  .hello-row { align-items: stretch; }
  .segs { width: 100%; overflow-x: auto; }
  .seg { flex: 1; text-align: center; padding: 8px 10px; }
}
</style>
