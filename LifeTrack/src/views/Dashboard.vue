<script setup lang="ts">
/**
 * 仪表盘（首页）
 * 目标来自 utils/projects；待办统一读「待办」这个特殊目标（扁平模型）；里程碑取时间线上被标记的事件
 */
import { computed, nextTick, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { type LogItem, fmtRich, isoToday, loadLogs, daysBetween, parseIso, streakOf } from "../utils/logs";
import { type ProjectItem, type Task, type TaskStatus, loadProjects, ensureInbox, addTaskToGoal, setTaskStatus, TASK_RANK, isTodoActive, isTodoDone } from "../utils/projects";
import { addEvent, milestoneTargetEvents } from "../utils/timeline";
import { loadSettings } from "../utils/settings";

const settings = loadSettings();
const nickname = computed(() => settings.nickname || "朋友");

const router = useRouter();

// ---------- 问候与日期（动态） ----------
const now = new Date();
const hour = now.getHours();
const greeting = hour < 6 ? "夜深了" : hour < 12 ? "早上好" : hour < 18 ? "下午好" : "晚上好";
const dateText = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 · 星期${"日一二三四五六"[now.getDay()]}`;

// ---------- 人生里程碑：取时间线上被标记为里程碑的事件（SQLite，异步） ----------
type Milestone = { id: number; date: string; year: string; title: string };
const milestones = ref<Milestone[]>([]);
async function reloadMilestones() {
  const evs = await milestoneTargetEvents(); // ts 倒序：最新在前
  milestones.value = evs.map(e => ({ id: e.id, date: e.date, year: e.date.slice(0, 4), title: msTitle(e.summary) }));
}
/** 摘要取第一行、去 **加粗** 与 #标签，截断成一行短标题 */
function msTitle(s: string) {
  const first = s.split("\n")[0].replace(/\*\*/g, "").replace(/#\S+/g, "").trim();
  return first.length > 14 ? `${first.slice(0, 14)}…` : first;
}
/** 节点副标题：里程碑发生的具体日期 M月D日 */
function msMD(date: string) {
  const d = parseIso(date);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}
// 首页只展示最近 5 个（新→旧取 5，再翻回时间正序铺在横轴上），全部去时间线页看
const shownMilestones = computed(() => milestones.value.slice(0, 5).reverse());
const latestMsId = computed(() => shownMilestones.value[shownMilestones.value.length - 1]?.id ?? -1);
const msRangeText = computed(() => {
  const shown = shownMilestones.value;
  if (!shown.length) return "还没有标记里程碑";
  const lo = shown[0].year, hi = shown[shown.length - 1].year;
  return `${lo === hi ? lo : `${lo} — ${hi}`} · 最近 ${shown.length} 个`;
});

// ---------- 最近轨迹：读 SQLite 随记（今天前 6 条，今天还没记就回退最近一天） ----------
const allLogs = ref<LogItem[]>([]);
const recentDate = ref(isoToday());
onMounted(async () => {
  const loaded = await loadLogs();
  allLogs.value = loaded;
  const t = isoToday();
  recentDate.value = loaded.some(l => l.date === t) ? t : (loaded.map(l => l.date).sort().reverse()[0] ?? t);
  void reloadMilestones();
});
const recents = computed(() =>
  allLogs.value
    .filter(l => l.date === recentDate.value)
    .sort((a, b) => (a.time < b.time ? 1 : -1))
    .slice(0, 6)
    .map(l => ({ time: l.time, html: fmtRich(l.text), danger: l.kind === "问题" })),
);
const recentsEmpty = computed(() => !recents.value.length);
// 今天 / 昨天 / M 月 D 日 + 具体日期（回退到往日时不能写今天的日期）
const recentDayLabel = computed(() => {
  const d = parseIso(recentDate.value);
  const date = `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  const n = daysBetween(recentDate.value, isoToday());
  return n === 0 ? `今天 · ${date}` : n === 1 ? `昨天 · ${date}` : date;
});

// ---------- 顶部问候的统计数字：连续记录天数 + 本月日志数（从真实日志现算） ----------
const streak = computed(() => streakOf(allLogs.value.map(l => l.date)));
const monthLogs = computed(() => {
  const p = isoToday().slice(0, 7); // YYYY-MM
  return allLogs.value.filter(l => l.date.startsWith(p)).length;
});

// ---------- 目标数据源：统一走 utils/projects（SQLite；「待办」是特殊目标 inbox，其余为展示型目标） ----------
const projects = ref<ProjectItem[]>([]);
onMounted(async () => {
  await ensureInbox(); // 空库起步：先保证内置「待办」存在
  projects.value = await loadProjects();
});
// 「待办」目标不参与目标/活跃统计与目标墙展示
const wallGoals = computed(() => projects.value.filter(g => !g.inbox));

// ---------- 活跃目标：近 30 天有更新，按更新时间倒序 ----------
function relDay(iso: string) {
  const n = daysBetween(iso, isoToday()); // 距今几天
  return n <= 0 ? "今天更新" : n === 1 ? "昨天" : `${n} 天前`;
}
const activeGoals = computed(() =>
  wallGoals.value
    .filter(g => (g.status === "active" || g.status === "paused") && daysBetween(g.updatedAt, isoToday()) <= 30)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, 6)
    .map(g => ({ name: g.name, when: relDay(g.updatedAt), color: g.color })),
);

// ---------- 今日待办：只读「待办」这个特殊目标的 task（扁平模型，不再跨目标聚合）----------
const todoGoal = computed(() => projects.value.find(g => g.inbox));
function dueTime(t: Task) { return t.due ? new Date(t.due + "T00:00:00").getTime() : Number.MAX_SAFE_INTEGER; }
function dayDiff(due: string) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((new Date(due + "T00:00:00").getTime() - today.getTime()) / 86400000);
}
function dueLabel(due: string) {
  const n = dayDiff(due);
  return n < 0 ? `逾期 ${-n} 天` : n === 0 ? "今天" : n === 1 ? "明天" : `还剩 ${n} 天`;
}
// 排序：进行中 → 紧急 → 最近截止 → 已完成/已放弃置底
const sortedTasks = computed(() =>
  [...(todoGoal.value?.tasks ?? [])].sort((a, b) =>
    TASK_RANK[a.status] - TASK_RANK[b.status] || Number(b.urgent) - Number(a.urgent) || dueTime(a) - dueTime(b),
  ),
);
// 焦点卡「当前待办」三件套：进行中数 / 已完成数 / 完成占比（含已结束任务，反映累计完成度）
const todoActiveTotal = computed(() => sortedTasks.value.filter(isTodoActive).length);
const todoDoneTotal = computed(() => sortedTasks.value.filter(isTodoDone).length);
const focusPct = computed(() => {
  const n = todoActiveTotal.value + todoDoneTotal.value;
  return n ? Math.round((todoDoneTotal.value / n) * 100) : 0;
});
const todoLeft = computed(() => sortedTasks.value.filter(isTodoActive).length);
const todoDone = computed(() => sortedTasks.value.filter(isTodoDone).length);
// 最要紧：第一条进行中的紧急/带截止待办，没有则为空（焦点卡显示“暂无要紧事”）
const nextTodo = computed(() => sortedTasks.value.find(t => isTodoActive(t) && (t.urgent || !!t.due)));
const cardTodos = computed(() => sortedTasks.value.filter(isTodoActive).slice(0, 5));
function goTodoBoard() {
  const g = todoGoal.value;
  if (g) router.push({ name: "goal-detail", params: { id: g.id } });
}
// 首页快速勾选：完成 / 撤销完成 都落一条时间线事件（决策与反悔都留痕）
async function toggleTodo(t: Task) {
  const g = todoGoal.value; if (!g) return;
  const s = g.tasks.find(x => x.id === t.id);
  if (!s) return;
  const next: TaskStatus = isTodoDone(s) ? "confirmed" : "done";
  await setTaskStatus(s.id, next);
  s.status = next;
  if (next === "done") addEvent("task.completed", `完成任务「${s.text}」`);
  else addEvent("task.reopened", `重新打开待办「${s.text}」`);
}
function openPicker(e: MouseEvent) { (e.target as HTMLInputElement).showPicker?.(); }

// ---------- 新建待办：居中小弹窗，扁平模型——所有待办只进「待办」这个特殊目标 ----------
const tdOpen = ref(false);
const tdInput = ref<HTMLInputElement | null>(null);
const td = ref({ text: "", urgent: false, due: "" });
function openTodoModal() {
  td.value = { text: "", urgent: false, due: "" };
  tdOpen.value = true;
  nextTick(() => tdInput.value?.focus());
}
function closeTodoModal() { tdOpen.value = false; }
async function submitTodoModal() {
  const text = td.value.text.trim();
  if (!text) return;
  let home = projects.value.find(g => g.inbox);
  if (!home) {
    // 首帧可能还没加载完（或库刚清空）：确保「待办」存在并重拉一次
    await ensureInbox();
    projects.value = await loadProjects();
    home = projects.value.find(g => g.inbox);
    if (!home) return;
  }
  const task = await addTaskToGoal(home.id, { text, urgent: td.value.urgent, due: td.value.due });
  home.tasks.unshift(task);
  home.updatedAt = isoToday();
  addEvent("task.created", `添加任务「${text}」`);
  closeTodoModal();
}
</script>

<template>
  <div class="dash">
    <div class="hello">
      <h1>{{ greeting }}，{{ nickname }}</h1>
      <p>{{ dateText }} · <strong>已连续记录 {{ streak }} 天</strong> · 本月新增 {{ monthLogs }} 条日志</p>
    </div>

    <div class="grid">
      <!-- 首行：焦点 2/3 + 待办 1/3，等高并随行高撑开 -->
      <div class="row-top">
      <!-- 当前待办：今日完成度 + 最要紧一条 -->
      <div class="card hero">
        <div class="c-head">
          <div>
            <div class="c-title">当前待办</div>
            <div class="c-sub">未开始 {{ sortedTasks.filter(t => t.status === 'pending').length }} · 进行中 {{ sortedTasks.filter(t => t.status === 'confirmed').length }} · 已完成 {{ todoDoneTotal }} 项</div>
          </div>
        </div>
        <div class="hero-num">{{ todoDoneTotal }}<span>/{{ todoActiveTotal + todoDoneTotal }}</span></div>
        <div class="hero-desc">
          <template v-if="nextTodo">
            最要紧：<strong>{{ nextTodo.text }}</strong><template v-if="nextTodo.due"> · 截止{{ dueLabel(nextTodo.due) }}</template><template v-else-if="nextTodo.urgent"> · 紧急</template>
          </template>
          <template v-else>暂无要紧事 · 今天按自己的节奏来</template>
        </div>
        <div class="hero-bar"><div class="hero-bar-fill" :style="{ width: focusPct + '%' }"></div></div>
      </div>

      <!-- 今日待办（跨目标摘要，管理去目标详情页） -->
      <div class="card todo">
        <div class="c-head">
          <div>
            <div class="c-title">今日待办</div>
            <div class="c-sub">还剩 {{ todoLeft }} 项 · 已完成 {{ todoDone }} 项</div>
          </div>
          <div class="tag grey tl-all" @click="goTodoBoard">管理全部 ›</div>
        </div>
        <div class="todo-list">
          <div v-for="t in cardTodos" :key="t.id" class="todo-item" :class="{ done: isTodoDone(t) }">
            <span class="todo-box" @click="toggleTodo(t)">
              <svg v-if="isTodoDone(t)" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            </span>
            <span class="todo-text">{{ t.text }}</span>
            <span v-if="t.urgent" class="chip-urgent">紧急</span>
            <span v-if="t.due" class="todo-due" :class="{ late: dayDiff(t.due) < 0 && !isTodoDone(t) }">{{ dueLabel(t.due) }}</span>
          </div>
        </div>
        <button class="todo-add" @click="openTodoModal">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          新建待办
        </button>
      </div>
      </div>

      <!-- 人生里程碑 -->
      <div class="card timeline-card">
        <div class="c-head">
          <div>
            <div class="c-title">人生里程碑</div>
            <div class="c-sub">{{ msRangeText }}</div>
          </div>
          <div class="tag grey tl-all" @click="router.push({ name: 'timeline' })">查看全部 {{ milestones.length }} 个 ›</div>
        </div>
        <div v-if="shownMilestones.length" class="tl">
          <div v-for="m in shownMilestones" :key="m.id" class="tl-node" :class="{ now: m.id === latestMsId }">
            <div class="tl-dot"></div>
            <div class="tl-year">{{ m.year }}</div>
            <div class="tl-title">{{ m.title }}</div>
            <div class="tl-desc">{{ msMD(m.date) }}</div>
          </div>
        </div>
        <div v-else class="tl-empty" @click="router.push({ name: 'timeline' })">
          还没有标记里程碑 · 去时间线把重要的一天标出来 ›
        </div>
      </div>

      <!-- 活跃项目 -->
      <div class="card active-proj">
        <div class="c-head">
          <div>
            <div class="c-title">活跃目标</div>
            <div class="c-sub">近 30 天有动静</div>
          </div>
          <div class="tag grey tl-all" @click="router.push({ name: 'projects' })">查看全部 ›</div>
        </div>
        <div v-if="activeGoals.length" class="ap-list">
          <div v-for="p in activeGoals" :key="p.name" class="ap-item">
            <span class="ap-icon" :style="{ background: p.color }">{{ p.name.charAt(0) }}</span>
            <span class="ap-name">{{ p.name }}</span>
            <span class="ap-when">{{ p.when }}</span>
          </div>
        </div>
        <div v-else class="tl-empty" @click="router.push({ name: 'projects' })">
          近 30 天没有动静 · 去目标页看看 ›
        </div>
      </div>

      <!-- 最近轨迹 -->
      <div class="card recent-card">
        <div class="c-head">
          <div>
            <div class="c-title">最近轨迹</div>
            <div class="c-sub">{{ recentDayLabel }}</div>
          </div>
          <div class="tag grey tl-all" @click="router.push({ name: 'logs' })">查看全部 ›</div>
        </div>
        <div class="recent-list">
          <div v-for="r in recents" :key="r.time + r.html" class="recent-item">
            <div class="recent-t">{{ r.time }}</div>
            <div class="recent-c" :style="r.danger ? { color: '#FF6B7A' } : undefined" v-html="r.html"></div>
          </div>
          <div v-if="recentsEmpty" class="recent-empty" @click="router.push({ name: 'logs' })">
            还没有记录 · 去日志页记一条 ›
          </div>
        </div>
      </div>

    </div>

    <!-- 新建待办：居中弹窗 -->
    <Teleport to="body">
      <Transition name="td">
        <div v-if="tdOpen" class="td-back" @click.self="closeTodoModal">
          <div class="td-card" role="dialog" aria-modal="true" @keydown.esc="closeTodoModal">
            <div class="td-head">
              <span class="td-title">新建待办</span>
              <button class="td-x" title="关闭" @click="closeTodoModal">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>
              </button>
            </div>
            <input ref="tdInput" v-model="td.text" class="td-text" placeholder="要做什么…" @keydown.enter.prevent="submitTodoModal" />
            <div class="td-fields">
              <button class="td-chip" :class="{ on: td.urgent }" @click="td.urgent = !td.urgent">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="13"/><circle cx="12" cy="17.5" r="0.9" fill="currentColor" stroke="none"/></svg>
                紧急
              </button>
              <label class="td-chip cal">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><line x1="16" y1="3" x2="16" y2="7"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                {{ td.due || "截止日期" }}
                <input type="date" v-model="td.due" @click="openPicker" />
              </label>
            </div>
            <div class="td-foot">
              <button class="td-ghost" @click="closeTodoModal">取消</button>
              <span class="td-spacer"></span>
              <button class="td-main" :disabled="!td.text.trim()" @click="submitTodoModal">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                添加
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
/* ============ 首行布局：焦点 2/3 + 待办 1/3，行高随窗口拉伸 ============ */
/* 桌面端让整页撑满可视高，首行 minmax(224px,1fr) 吸收多余高度，两卡等高 */
.dash { display: flex; flex-direction: column; }
.row-top { display: grid; grid-template-columns: 2fr 1fr; gap: 16px; grid-column: 1 / -1; min-height: 224px; }
@media (min-width: 1024px) {
  .dash { min-height: calc(100vh - 104px); } /* 100vh - 状态栏 46 - content 上下内边距 22/36 */
  .dash .grid { flex: 1; grid-template-rows: minmax(224px, 1fr) auto auto; }
  .row-top { min-height: 0; }
}
@media (max-width: 1023px) {
  /* 平板以下：焦点/待办改为上下堆叠，各自整行 */
  .row-top { grid-template-columns: 1fr; }
}

/* ============ 新建待办弹窗（遮罩/动画/配色对齐 ConfirmDialog） ============ */
.td-back { position: fixed; inset: 0; z-index: 210; padding: 16px; display: grid; place-items: center; background: rgba(26, 29, 33, .32); backdrop-filter: blur(3px); }
.td-card { width: min(420px, 100%); box-sizing: border-box; background: var(--card); border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 18px 48px rgba(26, 29, 33, .18); padding: 16px 18px 14px; transition: transform .18s cubic-bezier(.22, .8, .3, 1); }
.td-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.td-title { font-size: 13.5px; font-weight: 700; color: var(--text-1); letter-spacing: -.2px; }
.td-x { border: none; background: none; color: var(--text-3); cursor: pointer; width: 24px; height: 24px; border-radius: 7px; display: grid; place-items: center; transition: background-color .15s ease, color .15s ease; }
.td-x:hover { background: var(--hover-2); color: var(--text-1); }
.td-text { width: 100%; box-sizing: border-box; border: 1px solid var(--line-2); border-radius: 10px; padding: 10px 12px; font-size: 13px; font-family: inherit; color: var(--text-1); outline: none; transition: border-color .15s ease; }
.td-text:focus { border-color: var(--accent); }
.td-text::placeholder { color: var(--text-3); }
.td-fields { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.td-chip { position: relative; border: 1px solid var(--line-2); background: var(--field); border-radius: 999px; font-size: 11.5px; font-weight: 600; font-family: inherit; color: var(--text-2); padding: 5px 11px; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; transition: all .15s ease; }
.td-chip:hover { border-color: var(--accent); color: var(--accent-dark); }
.td-chip.on { background: var(--red-soft); border-color: var(--red); color: var(--danger); }
.td-chip.cal input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.td-foot { display: flex; align-items: center; gap: 8px; margin-top: 16px; }
.td-spacer { flex: 1; }
.td-foot button { border: 1px solid transparent; border-radius: 10px; padding: 7px 14px; cursor: pointer; font-size: 12px; font-weight: 600; font-family: inherit; transition: background-color .15s ease, border-color .15s ease, color .15s ease; }
.td-ghost { background: none; color: var(--text-3); }
.td-ghost:hover { color: var(--text-2); }
.td-main { background: var(--accent); color: #fff; box-shadow: 0 2px 8px rgba(23, 161, 125, .28); display: inline-flex; align-items: center; gap: 6px; }
.td-main:hover:not(:disabled) { background: var(--accent-dark); }
.td-main:disabled { opacity: .4; cursor: default; box-shadow: none; }
.td-enter-active, .td-leave-active { transition: opacity .16s ease; }
.td-enter-from, .td-leave-to { opacity: 0; }
.td-enter-from .td-card { transform: translateY(10px) scale(.985); }
@media (max-width: 767px) {
  .td-back { padding: 20px 14px; align-items: flex-end; }
}

/* ============ Hero 人生进度 ============ */
.hero {
  min-height: 224px;
  background: linear-gradient(135deg, #17A17D 0%, #0A6B52 100%);
  border: none; color: #fff; padding: 26px 28px; position: relative; overflow: hidden;
  box-shadow: 0 12px 36px rgba(10, 107, 82, .25);
}
.hero::after {
  content: ''; position: absolute; width: 280px; height: 280px; border-radius: 50%;
  border: 1px solid rgba(255,255,255,.12); top: -120px; right: -80px;
}
.hero::before {
  content: ''; position: absolute; width: 180px; height: 180px; border-radius: 50%;
  border: 1px solid rgba(255,255,255,.1); bottom: -100px; right: 60px;
}
.hero .c-title { color: rgba(255,255,255,.8); font-size: 12.5px; }
.hero .c-sub { color: rgba(255,255,255,.6); font-size: 11px; }
.hero-num {
  font-size: 52px; font-weight: 800; letter-spacing: -2.5px; line-height: 1;
  margin: 20px 0 8px; font-variant-numeric: tabular-nums; position: relative; z-index: 1;
}
.hero-num span { font-size: 22px; font-weight: 600; opacity: .75; margin-left: 2px; letter-spacing: 0; }
.hero-desc {
  font-size: 12.5px; color: rgba(255,255,255,.75); margin-bottom: 24px;
  position: relative; z-index: 1; letter-spacing: 0;
}
.hero-desc strong { color: #fff; font-weight: 600; }
.hero-bar { height: 5px; background: rgba(255,255,255,.2); border-radius: 3px; position: relative; margin-top: auto; margin-bottom: 10px; z-index: 1; }
.hero-bar-fill {
  position: absolute; left: 0; top: 0; bottom: 0; background: #fff;
  border-radius: 3px; box-shadow: 0 0 16px rgba(255,255,255,.6);
  transition: width .5s ease;
}

/* ============ 活跃项目 ============ */
/* 末行两卡固定高：条目多少不撑卡，超出走列表内部滚动；窗口变高只拉伸首行 */
.active-proj { height: 320px; padding: 20px 22px; display: flex; flex-direction: column; }
.ap-list {
  display: flex; flex-direction: column; margin-top: 10px; flex: 1;
  min-height: 0; overflow-y: auto; padding-right: 4px;
}
.ap-list::-webkit-scrollbar { width: 4px; }
.ap-list::-webkit-scrollbar-thumb { background: var(--scroll); border-radius: 2px; }
.ap-list::-webkit-scrollbar-track { background: transparent; }
.ap-item {
  flex: 0 0 auto; padding: 11px 0; display: flex; align-items: center; gap: 9px;
  font-size: 12.5px; min-width: 0; border-bottom: 1px solid var(--line);
}
.ap-item:last-child { border-bottom: none; padding-bottom: 0; }
.ap-item:first-child { padding-top: 0; }
.ap-icon {
  width: 19px; height: 19px; border-radius: 6px; flex: 0 0 19px;
  display: grid; place-items: center; color: #fff; font-size: 11px; font-weight: 700;
}
.ap-name {
  flex: 1; min-width: 0; color: var(--text-1); font-weight: 600; letter-spacing: -.1px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ap-when { font-size: 11px; color: var(--text-3); flex: 0 0 auto; }

/* ============ 今日待办 ============ */
.todo { min-height: 224px; padding: 20px 22px; }
/* 卡片高度随行高拉伸：列表吃掉多余空间，「新建待办」始终贴底 */
.todo-list { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; flex: 1; min-height: 0; overflow-y: auto; padding-right: 4px; }
.todo-list::-webkit-scrollbar { width: 4px; }
.todo-list::-webkit-scrollbar-thumb { background: var(--scroll); border-radius: 2px; }
.todo-item { display: flex; align-items: center; gap: 9px; font-size: 12.5px; color: var(--text-2); min-width: 0; }
.todo-box {
  width: 14px; height: 14px; border-radius: 4px; border: 1.5px solid var(--line-2);
  flex: 0 0 14px; cursor: pointer; transition: all .15s ease;
  display: grid; place-items: center; position: relative;
}
.todo-box:hover { border-color: var(--accent); }
.todo-item.done .todo-box { background: var(--accent); border-color: var(--accent); }
.todo-item.done .todo-text { color: var(--text-3); text-decoration: line-through; }
.todo-text { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chip-urgent {
  background: var(--danger-soft); color: var(--danger); font-size: 10px; font-weight: 700;
  padding: 1.5px 6px; border-radius: 999px; flex: 0 0 auto; letter-spacing: .3px;
}
.todo-due { font-size: 10.5px; color: var(--text-3); flex: 0 0 auto; font-variant-numeric: tabular-nums; }
.todo-due.late { color: var(--danger); font-weight: 600; }
.todo-acts { display: flex; gap: 2px; opacity: 0; transition: opacity .12s ease; flex: 0 0 auto; }
.todo-item:hover .todo-acts { opacity: 1; }
.ta {
  position: relative; width: 20px; height: 20px; border: none; background: none;
  color: var(--text-3); display: grid; place-items: center; border-radius: 5px; cursor: pointer;
}
.ta:hover { color: var(--accent-dark); background: var(--hover-2); }
.ta.on { color: var(--danger); }
.ta.del:hover { color: var(--danger); background: var(--danger-soft); }
.cal input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.todo-add {
  margin-top: 12px; width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px;
  border: 1px dashed var(--line-2); background: none; border-radius: 9px; padding: 7px 0;
  font-size: 12px; color: var(--text-3); cursor: pointer; transition: all .15s ease; font-family: inherit;
}
.todo-add:hover { border-color: var(--accent); color: var(--accent-dark); background: var(--accent-soft); }

/* ============ 里程碑时间轴 ============ */
.timeline-card { grid-column: span 4; }
.tl { position: relative; display: flex; margin-top: 28px; padding: 0 12px; }
.tl::before { content: ''; position: absolute; top: 6px; left: 6%; right: 6%; height: 1px; background: var(--line); }
.tl-node { flex: 1; display: flex; flex-direction: column; align-items: center; text-align: center; position: relative; z-index: 1; }
.tl-dot {
  width: 12px; height: 12px; border-radius: 50%; background: var(--field);
  border: 2px solid var(--line-2); margin-bottom: 16px; transition: all .25s ease;
}
.tl-node.now .tl-dot { border-color: var(--accent); box-shadow: 0 0 0 5px var(--accent-soft); }
.tl-node:hover .tl-dot { border-color: var(--accent); }
.tl-year { font-size: 11.5px; font-weight: 700; color: var(--text-3); margin-bottom: 8px; font-variant-numeric: tabular-nums; letter-spacing: .3px; }
.tl-node.now .tl-year { color: var(--accent-dark); }
.tl-title { font-size: 12.5px; font-weight: 600; color: var(--text-1); margin-bottom: 3px; }
.tl-desc { font-size: 11px; color: var(--text-3); line-height: 1.5; max-width: 120px; }
.tl-empty { margin-top: 16px; padding: 20px 0 8px; font-size: 12px; color: var(--text-3); text-align: center; cursor: pointer; }
.tl-empty:hover { color: var(--accent-dark); }
.tl-all { cursor: pointer; transition: all .15s ease; }
.tl-all:hover { background: var(--accent-soft); color: var(--accent-dark); }

/* ============ 最近轨迹 ============ */
.recent-card { grid-column: span 3; height: 320px; }
/* 列表吃掉卡片固定高内的剩余空间，超出滚动（旧 max-height 282px 限高取消） */
.recent-list { display: flex; flex-direction: column; margin-top: 10px; flex: 1; min-height: 0; overflow-y: auto; padding-right: 6px; }
.recent-list::-webkit-scrollbar { width: 4px; }
.recent-list::-webkit-scrollbar-thumb { background: var(--scroll); border-radius: 2px; }
.recent-list::-webkit-scrollbar-track { background: transparent; }
.recent-empty { padding: 20px 0 8px; font-size: 12px; color: var(--text-3); cursor: pointer; text-align: center; }
.recent-empty:hover { color: var(--accent-dark); }
.recent-item { display: flex; gap: 14px; padding: 11px 0; border-bottom: 1px solid var(--line); }
.recent-item:last-child { border-bottom: none; padding-bottom: 0; }
.recent-item:first-child { padding-top: 0; }
.recent-t { font-size: 11px; color: var(--text-3); font-variant-numeric: tabular-nums; flex: 0 0 42px; padding-top: 2px; }
/* 首页只当预览：多行日志最多截到 2 行，全文去日志页看 */
.recent-c {
  flex: 1; min-width: 0;
  font-size: 12.5px; color: var(--text-2); line-height: 1.55; white-space: pre-wrap; word-break: break-word;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden;
}
.recent-c strong { color: var(--text-1); font-weight: 600; }

/* ============ 响应式（断点体系见 global.css：平板 ≤1023 / 手机 ≤767） ============ */
@media (max-width: 1300px) {
  .recent-card { grid-column: span 2; }
  .active-proj { grid-column: span 1; }
  .timeline-card { grid-column: span 3; }
}
@media (max-width: 1023px) {
  /* 两列：轨迹跨双列，里程碑与活跃项目并排占末行（焦点/待办在 .row-top 内堆叠） */
  .recent-card { grid-column: span 2; }
  .timeline-card { grid-column: span 1; }
  .active-proj { grid-column: span 1; }
}
@media (max-width: 767px) {
  /* 单列：全部卡片占满 */
  .timeline-card, .active-proj, .recent-card { grid-column: span 1; }
  .hero { padding: 22px; min-height: 0; }
  .todo { min-height: 0; }
  .hero-num { font-size: 42px; margin: 14px 0 6px; }
  /* 里程碑横轴改纵向时间轴，免横向挤压与滚动 */
  .tl { flex-direction: column; margin-top: 16px; padding: 0; }
  .tl::before { left: 6px; right: auto; top: 6px; bottom: 6px; width: 1px; height: auto; }
  .tl-node { flex: none; flex-direction: row; align-items: flex-start; text-align: left; gap: 12px; padding: 9px 0; }
  .tl-dot { margin-bottom: 0; flex: 0 0 12px; margin-top: 4px; }
  .tl-desc { max-width: none; }
  /* 待办面板窄屏全宽化 */
  .tp { width: 100%; max-width: 100%; padding: 18px 16px calc(18px + env(safe-area-inset-bottom)); }
  /* 小控件触控补足：扩大命中区不改视觉 */
  .todo-box::after { content: ''; position: absolute; inset: -8px; }
  .tl-all { padding: 8px 14px; }
}
</style>
