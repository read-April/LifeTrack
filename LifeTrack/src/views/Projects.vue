<script setup lang="ts">
/**
 * 目标页：把"在做的事"和"想达成的目标"统一成一个模型管理
 * 顶部状态筛选（全部 / 活跃 / 暂停 / 达成 / 放弃），下面目标卡片墙
 * 新建/编辑走同一张表单卡片，删除复用 utils/confirm 的二次确认
 * 数据走 utils/projects.ts（SQLite，全部异步）
 */
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import {
  type ProjectItem, type GoalStatus, GOAL_STATUS, GOAL_COLORS,
  loadProjects, createGoal, updateGoal, deleteGoal, statusMeta, parseTags, isTodoDone,
} from "../utils/projects";
import { daysBetween, isoToday } from "../utils/logs";
import { askDelete } from "../utils/confirm";
import { addEvent } from "../utils/timeline";

const goals = ref<ProjectItem[]>([]);
onMounted(async () => { goals.value = await loadProjects(); });
const router = useRouter();
function goDetail(g: ProjectItem) { router.push({ name: "goal-detail", params: { id: g.id } }); }
const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(n || 0)));

// ---------- 筛选 ----------
type Tab = GoalStatus | "all";
const TABS: { k: Tab; t: string }[] = [
  { k: "all", t: "全部" },
  ...GOAL_STATUS.map(s => ({ k: s.key as Tab, t: s.label })),
];
const tab = ref<Tab>("active"); // 默认进入「活跃」筛选
// 目标墙只展示真正的目标；「待办」是特殊目标（内部 inbox 标记），固定排在最前、不参与统计、不可删
const wall = computed(() => goals.value.filter(g => !g.inbox));
const counts = computed(() => {
  const c: Record<Tab, number> = { all: wall.value.length, active: 0, paused: 0, done: 0, dropped: 0 };
  for (const g of wall.value) c[g.status]++;
  return c;
});
const list = computed(() => {
  const real = wall.value
    .filter(g => tab.value === "all" || g.status === tab.value)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const todo = goals.value.find(g => g.inbox);
  // 「待办」常驻最前（默认视图或状态筛选命中时）
  if (todo && (tab.value === "all" || tab.value === todo.status)) return [todo, ...real];
  return real;
});

// ---------- 表单（新建 / 编辑共用） ----------
type Draft = { id: number; name: string; desc: string; status: GoalStatus; tagsRaw: string; progress: number; created: string; due: string; color: string };
function blankDraft(): Draft {
  // 创建时间自动填今天；截止日期默认留空（无截止概念，可在表单里手填）
  return { id: 0, name: "", desc: "", status: "active", tagsRaw: "", progress: 0, created: isoToday(), due: "", color: GOAL_COLORS[goals.value.length % GOAL_COLORS.length] };
}
const formOpen = ref(false);
const editing = ref(0); // 0 = 新建
const draft = ref<Draft>(blankDraft());
const nameErr = ref(""); // 重名行内提示：目标名全局唯一（接库后另有唯一索引兜底）
function openCreate() { editing.value = 0; draft.value = blankDraft(); nameErr.value = ""; formOpen.value = true; }
function startEdit(g: ProjectItem) {
  editing.value = g.id;
  draft.value = { id: g.id, name: g.name, desc: g.desc, status: g.status, tagsRaw: g.tags.map(t => `#${t}`).join(" "), progress: g.progress, created: g.createdAt, due: g.due, color: g.color };
  nameErr.value = "";
  formOpen.value = true;
}
function closeForm() { formOpen.value = false; editing.value = 0; draft.value = blankDraft(); }
async function submitGoal() {
  const name = draft.value.name.trim();
  if (!name) return;
  // 重名拦截：忽略大小写比较，编辑时排除自己（库里另有唯一索引兜底）
  if (goals.value.some(g => g.id !== editing.value && g.name.trim().toLowerCase() === name.toLowerCase())) {
    nameErr.value = `已存在同名目标「${name}」，换个名字或去编辑那一个`;
    return;
  }
  nameErr.value = "";
  const body = {
    name, desc: draft.value.desc.trim(), status: draft.value.status,
    tags: parseTags(draft.value.tagsRaw), progress: clampPct(draft.value.progress),
    due: draft.value.due, color: draft.value.color, createdAt: draft.value.created || isoToday(),
  };
  if (editing.value) {
    await updateGoal(editing.value, body);
    // 内存同步：updated_at 的毫秒与展示用 YYYY-MM-DD 有偏差，从库重拉该目标替换
    const fresh = (await loadProjects()).find(g => g.id === editing.value);
    if (fresh) goals.value = goals.value.map(g => (g.id === editing.value ? fresh : g));
  } else {
    const g = await createGoal(body);
    goals.value = [g, ...goals.value];
    addEvent("goal.created", `创建目标「${name}」`);
  }
  closeForm();
}
async function removeGoal(g: ProjectItem) {
  if (g.inbox) return; // 内置「待办」不可删
  const ok = await askDelete(`删除目标「${g.name}」？`, "删除后不可恢复；若只想收起来，去编辑里改成「放弃」更合适。");
  if (!ok) return;
  await deleteGoal(g.id);
  goals.value = goals.value.filter(x => x.id !== g.id);
  addEvent("goal.removed", `删除目标「${g.name}」`);
  if (editing.value === g.id) closeForm();
}

// ---------- 截止日展示 ----------
function dueInfo(g: ProjectItem): { text: string; tone: string } | null {
  if (!g.due) return null;
  if (g.status === "done") return { text: g.due, tone: "ok" };
  const n = daysBetween(isoToday(), g.due); // 正=还剩，负=逾期
  if (n < 0) return { text: `逾期 ${-n} 天`, tone: "late" };
  if (n === 0) return { text: "今天到期", tone: "soon" };
  return { text: `还剩 ${n} 天`, tone: n <= 3 ? "soon" : "normal" };
}

// 任务完成数（卡片上 ✓ done/total）
function taskDone(g: ProjectItem) { return g.tasks.filter(isTodoDone).length; }

const ongoingCount = computed(() => wall.value.filter(g => g.status === "active" || g.status === "paused").length);
const doneCount = computed(() => wall.value.filter(g => g.status === "done").length);
</script>

<template>
  <div>
    <div class="hello hello-row">
      <div class="hello-tx">
        <h1>目标</h1>
        <p>
          共 <strong>{{ wall.length }}</strong> 个 · 进行中 <strong>{{ ongoingCount }}</strong> 个 · 已达成
          <strong>{{ doneCount }}</strong> 个
        </p>
      </div>
      <button class="new-btn" @click="openCreate">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        新建目标
      </button>
    </div>

    <!-- 新建 / 编辑表单 -->
    <section v-if="formOpen" class="card form-card">
      <div class="form-head">
        <span class="c-title">{{ editing ? "编辑目标" : "新建目标" }}</span>
        <span class="form-cancel" @click="closeForm">取消</span>
      </div>
      <input v-model="draft.name" class="f-name" :class="{ bad: nameErr }" placeholder="给目标起个名字，如：ReadGlyph 发布 v1.2" @input="nameErr = ''" @keydown.enter.prevent="submitGoal" />
      <p v-if="nameErr" class="f-err">{{ nameErr }}</p>
      <input v-model="draft.desc" class="f-desc" placeholder="一句话说明（可空）" />
      <div class="f-fields">
        <div class="f-group">
          <label>状态</label>
          <div class="seg-row">
            <button
              v-for="s in GOAL_STATUS" :key="s.key" class="seg" :class="{ on: draft.status === s.key }"
              :style="draft.status === s.key ? { background: s.color, borderColor: s.color } : undefined"
              @click="draft.status = s.key"
            >{{ s.label }}</button>
          </div>
        </div>
        <div class="f-group">
          <label>创建时间</label>
          <input v-model="draft.created" type="date" class="f-date" />
        </div>
        <div class="f-group">
          <label>截止日期</label>
          <input v-model="draft.due" type="date" class="f-date" />
        </div>
        <div class="f-group">
          <label>颜色</label>
          <div class="sw-row">
            <button
              v-for="c in GOAL_COLORS" :key="c" class="sw" :class="{ on: draft.color === c }"
              :style="{ background: c }" @click="draft.color = c"
            ></button>
          </div>
        </div>
      </div>
      <input v-model="draft.tagsRaw" class="f-desc" placeholder="#标签 空格分隔，如 #硬件 #副业" />
      <button class="save-btn" :disabled="!draft.name.trim()" @click="submitGoal">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        {{ editing ? "保存修改" : "添加目标" }}
      </button>
    </section>

    <!-- 状态筛选 -->
    <div class="tabs">
      <button v-for="t in TABS" :key="t.k" class="tab" :class="{ on: tab === t.k }" @click="tab = t.k">
        {{ t.t }}<span class="tab-n">{{ counts[t.k] }}</span>
      </button>
    </div>

    <!-- 卡片墙 -->
    <div class="g-grid">
      <article v-for="g in list" :key="g.id" class="card g-card" @click="goDetail(g)">
        <div class="g-top">
          <span class="g-avatar" :style="{ background: g.color }">{{ g.name.charAt(0) }}</span>
          <div class="g-heads">
            <div class="g-name">{{ g.name }}</div>
            <div v-if="g.desc" class="g-desc">{{ g.desc }}</div>
          </div>
          <span class="g-status" :style="{ background: statusMeta(g.status).light, color: statusMeta(g.status).color }">{{ statusMeta(g.status).label }}</span>
        </div>
        <div class="g-meta">
          <span v-if="dueInfo(g)" class="g-due" :class="dueInfo(g)!.tone">{{ dueInfo(g)!.text }}</span>
          <span v-for="t in g.tags" :key="t" class="g-tag">{{ t }}</span>
          <span v-if="g.tasks.length" class="g-task">✓ {{ taskDone(g) }}/{{ g.tasks.length }}</span>
          <span class="g-acts">
            <span v-if="g.inbox" class="g-built">内置</span>
            <template v-else>
              <button class="g-act" @click.stop="startEdit(g)">编辑</button>
              <button class="g-act del" @click.stop="removeGoal(g)">删除</button>
            </template>
          </span>
        </div>
      </article>

      <div v-if="!list.length" class="empty">
        <div class="empty-title">{{ tab === "all" ? "还没有目标" : "这个状态下的目标是空的" }}</div>
        <div class="empty-sub">点右上角「新建目标」，写下你想推进的那件事</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hello-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.new-btn {
  border: none; border-radius: 10px; background: var(--accent); color: #fff;
  font-size: 12px; font-weight: 600; font-family: inherit; padding: 8px 14px; cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px; transition: background-color .16s ease;
}
.new-btn:hover { background: var(--accent-dark); }

/* ---------- 表单卡片 ---------- */
.form-card { gap: 10px; margin-bottom: 16px; }
.form-head { display: flex; align-items: center; justify-content: space-between; }
.form-cancel { font-size: 11.5px; color: var(--text-3); cursor: pointer; }
.form-cancel:hover { color: var(--text-1); }
.f-name, .f-desc {
  width: 100%; border: 1px solid var(--line-2); border-radius: 10px; background: var(--field);
  font-size: 13px; color: var(--text-1); font-family: inherit; padding: 9px 12px; outline: none;
  transition: border-color .15s ease;
}
.f-name { font-weight: 600; }
.f-name:focus, .f-desc:focus { border-color: var(--accent); }
.f-name.bad, .f-name.bad:focus { border-color: var(--danger); }
.f-err { font-size: 11px; color: var(--danger); }
.f-name::placeholder, .f-desc::placeholder { color: var(--text-3); font-weight: 400; }
.f-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 18px; }
.f-group { display: flex; flex-direction: column; gap: 6px; }
.f-group label { font-size: 11px; font-weight: 600; color: var(--text-3); }
.seg-row { display: flex; gap: 5px; flex-wrap: wrap; }
.seg {
  border: 1px solid var(--line-2); background: var(--field); border-radius: 999px;
  font-size: 11.5px; padding: 4px 12px; color: var(--text-2); cursor: pointer;
  font-family: inherit; transition: all .15s ease;
}
.seg:hover { border-color: var(--accent); color: var(--accent-dark); }
.seg.on { color: #fff; font-weight: 600; border-color: transparent; }
.f-range { width: 100%; accent-color: var(--accent); }
.f-date { border: 1px solid var(--line-2); border-radius: 9px; padding: 5px 8px; font-family: inherit; font-size: 12px; color: var(--text-1); background: var(--field); outline: none; }
.sw-row { display: flex; gap: 7px; }
.sw { width: 20px; height: 20px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; transition: transform .12s ease; }
.sw:hover { transform: scale(1.12); }
.sw.on { border-color: var(--text-1); }
.save-btn {
  align-self: flex-start; border: none; border-radius: 9px; background: var(--accent); color: #fff;
  font-size: 12px; font-weight: 600; font-family: inherit; padding: 7px 15px; cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px; transition: background-color .16s ease, opacity .16s ease;
}
.save-btn:hover:not(:disabled) { background: var(--accent-dark); }
.save-btn:disabled { opacity: .4; cursor: default; }

/* ---------- 状态筛选 ---------- */
.tabs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
.tab {
  border: 1px solid var(--line); background: var(--card); border-radius: 999px; cursor: pointer;
  font-family: inherit; font-size: 12px; font-weight: 600; color: var(--text-2); padding: 5px 12px;
  display: inline-flex; align-items: center; gap: 6px; transition: all .15s ease;
}
.tab:hover { border-color: var(--accent); color: var(--accent-dark); }
.tab.on { background: var(--accent-soft); border-color: transparent; color: var(--accent-dark); }
.tab-n { font-size: 10.5px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.tab.on .tab-n { color: var(--accent-dark); }

/* ---------- 卡片墙 ---------- */
/* 单卡下限 260→340px：同样窗口下列数更少、单卡更宽 */
.g-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; }
.g-card { gap: 12px; padding: 18px; cursor: pointer; transition: box-shadow .16s ease, transform .16s ease; }
.g-card:hover { box-shadow: 0 6px 20px rgba(26, 29, 33, .08); transform: translateY(-1px); }
.g-top { display: flex; align-items: flex-start; gap: 10px; }
.g-avatar { width: 32px; height: 32px; flex: 0 0 32px; border-radius: 9px; display: grid; place-items: center; color: #fff; font-size: 14px; font-weight: 700; }
.g-heads { min-width: 0; flex: 1; }
.g-name { font-size: 13.5px; font-weight: 700; color: var(--text-1); letter-spacing: -.1px; line-height: 1.35; }
.g-desc { font-size: 11.5px; color: var(--text-3); margin-top: 2px; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
.g-status { font-size: 10.5px; font-weight: 700; padding: 2px 8px; border-radius: 999px; flex: 0 0 auto; }
.g-bar { height: 5px; background: var(--track); border-radius: 3px; overflow: hidden; }
.g-bar i { display: block; height: 100%; border-radius: 3px; transition: width .3s ease; }
.g-meta { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin-top: auto; } /* 卡片被行高拉大时，meta 行始终贴底 */
.g-pct { font-size: 11px; font-weight: 700; color: var(--text-2); font-variant-numeric: tabular-nums; }
.g-due { font-size: 10.5px; padding: 1px 7px; border-radius: 999px; background: var(--chip); color: var(--text-2); }
.g-due.soon { background: var(--orange-soft); color: var(--warn); }
.g-due.late { background: var(--red-soft); color: var(--danger); }
.g-due.ok { background: var(--accent-soft); color: var(--accent-dark); }
.g-tag { font-size: 10px; padding: 1px 7px; border-radius: 999px; background: var(--chip); color: var(--text-2); }
.g-task { font-size: 10.5px; font-weight: 600; color: var(--text-3); font-variant-numeric: tabular-nums; }
.g-built { font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 999px; background: var(--chip); color: var(--text-3); }
.g-acts { margin-left: auto; display: flex; gap: 4px; }
.g-act {
  border: none; background: none; border-radius: 6px; cursor: pointer; font-family: inherit;
  font-size: 11px; color: var(--text-3); padding: 3px 7px; transition: background-color .15s ease, color .15s ease;
}
.g-act:hover { background: var(--hover-2); color: var(--text-1); }
.g-act.del:hover { background: var(--red-soft); color: var(--danger); }

.empty { grid-column: 1 / -1; padding: 44px 20px; text-align: center; }
.empty-title { font-size: 13px; font-weight: 600; color: var(--text-2); }
.empty-sub { font-size: 11.5px; color: var(--text-3); margin-top: 5px; }

/* 桌面端：卡片最小高按视口比例取值——窗口变高卡片跟着变高，
   但不会像 grid-auto-rows:1fr 那样让单独一行吃掉全部剩余高度 */
@media (min-width: 1024px) {
  .g-card { min-height: clamp(120px, 17vh, 210px); }
}

@media (max-width: 767px) {
  /* 窄屏单列，免 340px 下限时窄窗口溢出 */
  .g-grid { grid-template-columns: 1fr; }
  .f-fields { grid-template-columns: 1fr; }
  .g-act { padding: 6px 10px; }
}
</style>
