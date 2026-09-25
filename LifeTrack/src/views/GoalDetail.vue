<script setup lang="ts">
/**
 * 目标详情页：一个目标的落点
 * 头部（目标名+描述只此一份）+ 功能特点 + 版本记录（手动增删：标题=日期/版本号 + 描述）
 * 功能特点/版本记录只对展示型目标显示；「待办」这个特殊目标不显它们，只显任务清单
 * 版本记录初始可从真实项目种子带出，之后用户自行添加/删除，最新在上
 * 状态在这里就地改，改完写回 utils/projects（SQLite，全部异步）
 */
import { computed, nextTick, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  type ProjectItem, type Task, type GoalStatus, type TaskStatus, type VersionEntry, GOAL_STATUS,
  loadProjects, updateGoal, setTaskStatus as dbSetTaskStatus, deleteTask, deleteFinishedTasks,
  addTaskToGoal, addVersion, removeVersion as dbRemoveVersion,
  statusMeta, TASK_RANK, taskStatusMeta, isTodoActive, isTodoDone, isTodoFinished,
} from "../utils/projects";
import { daysBetween, isoToday } from "../utils/logs";
import { addEvent } from "../utils/timeline";

const route = useRoute();
const router = useRouter();
const goalId = Number(route.params.id);

const projects = ref<ProjectItem[]>([]);
const goal = computed(() => projects.value.find(g => g.id === goalId) ?? null);
onMounted(async () => { projects.value = await loadProjects(); });
/** 库写完后的内存同步：只动这一个目标（updated_at 一律从库重拉，毫秒↔日期不自己凑） */
async function syncGoal(fields: Partial<ProjectItem>) {
  const g = goal.value; if (!g) return;
  Object.assign(g, fields);
  const fresh = (await loadProjects()).find(x => x.id === goalId);
  if (fresh) projects.value = projects.value.map(x => (x.id === goalId ? fresh : x));
}

function goBack() { router.push({ name: "projects" }); }
// 「待办」特殊目标：额外提供一个回到首页待办清单的入口
function goTodoHome() { router.push({ name: "dashboard" }); }

// ---------- 状态：就地快改 ----------
async function setStatus(s: GoalStatus) {
  // 「待办」是常驻收件箱，状态恒为 active，不允许切换（模板也已隐藏入口，这里再兜一道）
  const g = goal.value; if (!g || g.inbox || g.status === s) return;
  const from = statusMeta(g.status).label;
  await updateGoal(g.id, { status: s });
  await syncGoal({});
  addEvent("goal.status_changed", `「${g.name}」: ${from} → ${statusMeta(s).label}`);
}

// ---------- 任务清单 ----------
const nt = ref({ text: "", urgent: false, due: "" });
const ntInput = ref<HTMLInputElement | null>(null);
function dueLabel(due: string) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const n = Math.round((new Date(due + "T00:00:00").getTime() - today.getTime()) / 86400000);
  return n < 0 ? `逾期 ${-n} 天` : n === 0 ? "今天" : n === 1 ? "明天" : `还剩 ${n} 天`;
}
function dueLate(due: string) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return new Date(due + "T00:00:00").getTime() < today.getTime();
}
// 排序：进行中 → 紧急 → 最近截止 → 已完成/已放弃置底
const dueTime = (t: Task) => (t.due ? new Date(t.due + "T00:00:00").getTime() : Number.MAX_SAFE_INTEGER);
const tasks = computed(() => {
  const g = goal.value; if (!g) return [];
  return [...g.tasks].sort((a, b) =>
    TASK_RANK[a.status] - TASK_RANK[b.status] || Number(b.urgent) - Number(a.urgent) || dueTime(a) - dueTime(b),
  );
});
const activeTasks = computed(() => tasks.value.filter(isTodoActive));
const finishedTasks = computed(() => tasks.value.filter(isTodoFinished));
async function addTask() {
  const g = goal.value; const text = nt.value.text.trim();
  if (!g || !text) return;
  const task = await addTaskToGoal(g.id, { text, urgent: nt.value.urgent, due: nt.value.due });
  await syncGoal({ tasks: [task, ...g.tasks] });
  addEvent("task.created", `添加任务「${text}」`);
  nt.value = { text: "", urgent: false, due: "" };
  nextTick(() => ntInput.value?.focus());
}
/** 状态流转 = 时间轴上的一个决策点：确认 / 完成 / 放弃 / 重新打开（撤回）各落一条事件 */
async function setTaskStatus(t: Task, next: TaskStatus) {
  const g = goal.value; if (!g) return;
  const s = g.tasks.find(x => x.id === t.id); if (!s || s.status === next) return;
  await dbSetTaskStatus(t.id, next);
  const tasks = g.tasks.map(x => (x.id === t.id ? { ...x, status: next } : x));
  await syncGoal({ tasks });
  if (next === "confirmed") addEvent("task.confirmed", `确认待办「${s.text}」`);
  else if (next === "done") addEvent("task.completed", `完成任务「${s.text}」`);
  else if (next === "dropped") addEvent("task.dropped", `放弃待办「${s.text}」`);
  else if (next === "pending") addEvent("task.reopened", `重新打开待办「${s.text}」`);
}
function toggleDone(t: Task) { void setTaskStatus(t, isTodoDone(t) ? "pending" : "done"); }
async function removeTask(t: Task) {
  const g = goal.value; if (!g) return;
  await deleteTask(t.id);
  await syncGoal({ tasks: g.tasks.filter(x => x.id !== t.id) });
  addEvent("task.removed", `删除任务「${t.text}」`);
}
async function clearFinished() {
  const g = goal.value; if (!g) return;
  await deleteFinishedTasks(g.id);
  await syncGoal({ tasks: g.tasks.filter(x => !isTodoFinished(x)) });
}
function openPicker(e: MouseEvent) { (e.target as HTMLInputElement).showPicker?.(); }

// ---------- 版本记录：手动增删（标题写日期/版本号，描述写做了什么），最新在上 ----------
const vFormOpen = ref(false);
const vTitleInput = ref<HTMLInputElement | null>(null);
const nv = ref({ title: "", desc: "" });
function toggleVersionForm() {
  vFormOpen.value = !vFormOpen.value;
  if (vFormOpen.value) nextTick(() => vTitleInput.value?.focus());
}
async function saveVersion() {
  const g = goal.value; const title = nv.value.title.trim();
  if (!g || !title) return;
  const v = await addVersion(g.id, { title, desc: nv.value.desc.trim() });
  await syncGoal({ versions: [v, ...(g.versions ?? [])] });
  addEvent("goal.version_added", `「${g.name}」添加版本 ${title}`);
  nv.value = { title: "", desc: "" };
  vFormOpen.value = false;
}
async function removeVersion(v: VersionEntry) {
  const g = goal.value; if (!g || !g.versions) return;
  await dbRemoveVersion(v.id);
  await syncGoal({ versions: g.versions.filter(x => x.id !== v.id) });
  addEvent("goal.version_removed", `「${g.name}」删除版本 ${v.title}`);
}

// ---------- 头部展示 ----------
const dueInfo = computed(() => {
  const g = goal.value; if (!g || !g.due) return null;
  if (g.status === "done") return { text: `截止 ${g.due}`, tone: "ok" };
  const n = daysBetween(isoToday(), g.due);
  if (n < 0) return { text: `已逾期 ${-n} 天`, tone: "late" };
  if (n === 0) return { text: "今天到期", tone: "soon" };
  return { text: `还剩 ${n} 天`, tone: n <= 3 ? "soon" : "normal" };
});
</script>

<template>
  <div>
    <div class="back-row">
      <div v-if="goal && goal.inbox" class="back" @click="goTodoHome">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" y1="6" x2="20" y2="6"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="10" y1="18" x2="20" y2="18"/><polyline points="3 5.5 4.2 6.7 6.4 4.5"/><polyline points="3 11.5 4.2 12.7 6.4 10.5"/><polyline points="3 17.5 4.2 18.7 6.4 16.5"/></svg>
        返回待办清单
      </div>
      <div class="back" @click="goBack">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        返回目标
      </div>
    </div>

    <!-- 目标不存在 -->
    <div v-if="!goal" class="card nf">
      <div class="nf-title">找不到这个目标</div>
      <div class="nf-sub">它可能已被删除，返回列表看看</div>
    </div>

    <template v-else>
      <!-- 头部 -->
      <section class="card g-head">
        <div class="gh-top">
          <span class="gh-avatar" :style="{ background: goal.color }">{{ goal.name.charAt(0) }}</span>
          <div class="gh-title">
            <h1>{{ goal.name }}</h1>
            <p v-if="goal.desc">{{ goal.desc }}</p>
          </div>
          <span class="gh-status" :style="{ background: statusMeta(goal.status).light, color: statusMeta(goal.status).color }">{{ statusMeta(goal.status).label }}</span>
        </div>

        <div class="gh-meta">
          <span v-if="dueInfo" class="m-chip" :class="dueInfo.tone">{{ dueInfo.text }}</span>
          <span v-for="t in goal.tags" :key="t" class="m-chip">{{ t }}</span>
          <span class="m-note">创建 {{ goal.createdAt }} · 更新 {{ goal.updatedAt }}</span>
        </div>

        <!-- 「待办」是常驻收件箱，状态恒为活跃，不提供切换入口 -->
        <div v-if="!goal.inbox" class="gh-ctrl">
          <div class="seg-row">
            <button
              v-for="s in GOAL_STATUS" :key="s.key" class="seg" :class="{ on: goal.status === s.key }"
              :style="goal.status === s.key ? { background: s.color, borderColor: s.color } : undefined"
              @click="setStatus(s.key)"
            >{{ s.label }}</button>
          </div>
        </div>
      </section>

      <!-- 功能特点（来自真实项目；用户自建目标无此字段则不显示） -->
      <section v-if="goal.features && goal.features.length" class="card feat-card">
        <div class="c-title">功能特点</div>
        <ul class="feat-list">
          <li v-for="(f, i) in goal.features" :key="i">
            <svg class="feat-tick" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            <span>{{ f }}</span>
          </li>
        </ul>
      </section>

      <!-- 待办清单：只在「待办」这个特殊目标里显示，项目类目标不挂待办 -->
      <section v-if="goal.inbox" class="card task-card">
        <div class="tc-head">
          <span class="c-title">待办清单</span>
          <span class="tc-sub">{{ activeTasks.length }} 项进行中 · 已结束 {{ finishedTasks.length }} 项</span>
        </div>
        <div class="tc-add">
          <input ref="ntInput" v-model="nt.text" class="tc-input" placeholder="加一条任务，回车添加…" @keydown.enter.prevent="addTask" />
          <button class="tc-chip" :class="{ on: nt.urgent }" @click="nt.urgent = !nt.urgent">紧急</button>
          <label class="tc-chip cal">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><line x1="16" y1="3" x2="16" y2="7"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            {{ nt.due || "截止" }}
            <input type="date" v-model="nt.due" @click="openPicker" />
          </label>
          <button class="tc-ok" :disabled="!nt.text.trim()" @click="addTask">添加</button>
        </div>
        <div class="tc-list">
          <div v-for="t in activeTasks" :key="t.id" class="tk" :class="'st-' + t.status">
            <span class="tk-box" title="标记完成" @click="toggleDone(t)"></span>
            <span class="tk-text">{{ t.text }}</span>
            <span v-if="t.status === 'confirmed'" class="tk-state doing">进行中</span>
            <span v-if="t.urgent" class="tk-urgent">紧急</span>
            <span v-if="t.due" class="tk-due" :class="{ late: dueLate(t.due) }">{{ dueLabel(t.due) }}</span>
            <span class="tk-acts">
              <button v-if="t.status === 'pending'" class="tk-act" title="确认，排上日程" @click="setTaskStatus(t, 'confirmed')">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              </button>
              <button class="tk-act drop" title="放弃" @click="setTaskStatus(t, 'dropped')">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
              </button>
              <button class="tk-del" title="删除任务" @click="removeTask(t)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
              </button>
            </span>
          </div>
          <div v-if="!activeTasks.length" class="tc-empty">还没有待办 · 上面加一条，或去首页「新建待办」</div>
        </div>

        <!-- 已结束：完成或放弃，都是一条决策；手动清（不自动删） -->
        <div v-if="finishedTasks.length" class="tc-done">
          <div class="tc-done-head">
            <span class="tc-done-title">已结束 {{ finishedTasks.length }}</span>
            <button class="tc-clear" @click="clearFinished">清除已结束</button>
          </div>
          <div class="tc-list">
            <div v-for="t in finishedTasks" :key="t.id" class="tk" :class="'st-' + t.status">
              <span class="tk-box" :title="t.status === 'done' ? '已完成' : '已放弃'">
                <svg v-if="t.status === 'done'" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                <svg v-else width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>
              </span>
              <span class="tk-text">{{ t.text }}</span>
              <span class="tk-state" :class="t.status === 'done' ? 'done' : 'drop'">{{ taskStatusMeta(t.status).label }}</span>
              <span class="tk-acts">
                <button class="tk-act" title="恢复到待办" @click="setTaskStatus(t, 'pending')">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                </button>
                <button class="tk-del" title="删除任务" @click="removeTask(t)">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
                </button>
              </span>
            </div>
          </div>
        </div>
      </section>

      <!-- 版本记录：手动维护，标题写日期/版本号 + 描述；「待办」特殊目标不显示 -->
      <section v-if="!goal.inbox" class="card ver-card">
        <div class="vc-head">
          <span class="c-title">版本记录</span>
          <button class="vc-add" @click="toggleVersionForm">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            添加记录
          </button>
        </div>

        <div v-if="vFormOpen" class="vf">
          <input ref="vTitleInput" v-model="nv.title" class="vf-title" placeholder="标题 如：v1.0.0 · 2026-09-23" @keydown.enter.prevent="saveVersion" />
          <textarea v-model="nv.desc" class="vf-desc" rows="3" placeholder="这次做了什么…（描述，可空）"></textarea>
          <div class="vf-foot">
            <span class="vf-cancel" @click="vFormOpen = false">取消</span>
            <button class="vf-save" :disabled="!nv.title.trim()" @click="saveVersion">保存</button>
          </div>
        </div>

        <div class="ver-list">
          <div v-for="v in goal.versions" :key="v.id" class="ver-item">
            <span class="ver-dot"></span>
            <div class="ver-body">
              <div class="ver-head">
                <span class="ver-title">{{ v.title }}</span>
                <button class="ver-del" title="删除记录" @click="removeVersion(v)">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
                </button>
              </div>
              <p v-if="v.desc" class="ver-desc">{{ v.desc }}</p>
            </div>
          </div>
          <div v-if="!goal.versions || !goal.versions.length" class="ver-empty">还没有版本记录 · 点右上「添加记录」，写下第一条（标题写日期/版本号，描述写做了什么）</div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.back-row { display: flex; align-items: center; gap: 18px; margin-bottom: 12px; }
.back {
  display: inline-flex; align-items: center; gap: 4px; cursor: pointer;
  font-size: 12px; color: var(--text-3); transition: color .15s ease;
}
.back:hover { color: var(--accent-dark); }

.nf { text-align: center; padding: 40px 20px; }
.nf-title { font-size: 14px; font-weight: 600; color: var(--text-1); }
.nf-sub { font-size: 12px; color: var(--text-3); margin-top: 6px; }

/* ---------- 头部 ---------- */
.g-head { display: flex; flex-direction: column; gap: 16px; padding: 22px 24px; }
.gh-top { display: flex; align-items: flex-start; gap: 12px; }
.gh-avatar { width: 44px; height: 44px; flex: 0 0 44px; border-radius: 12px; display: grid; place-items: center; color: #fff; font-size: 19px; font-weight: 700; }
.gh-title { min-width: 0; flex: 1; }
.gh-title h1 { font-size: 18px; font-weight: 700; color: var(--text-1); letter-spacing: -.3px; }
.gh-title p { font-size: 12.5px; color: var(--text-3); margin-top: 3px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.gh-status { font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 999px; flex: 0 0 auto; }
.gh-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.m-chip { font-size: 11px; padding: 2px 9px; border-radius: 999px; background: var(--chip); color: var(--text-2); }
.m-chip.soon { background: var(--orange-soft); color: var(--warn); }
.m-chip.late { background: var(--red-soft); color: var(--danger); }
.m-chip.ok { background: var(--accent-soft); color: var(--accent-dark); }
.m-note { font-size: 11px; color: var(--text-3); margin-left: auto; }
.gh-ctrl { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; padding-top: 4px; border-top: 1px solid var(--line); }
.seg-row { display: flex; gap: 5px; flex-wrap: wrap; }
.seg { border: 1px solid var(--line-2); background: var(--field); border-radius: 999px; font-size: 11.5px; padding: 4px 12px; color: var(--text-2); cursor: pointer; font-family: inherit; transition: all .15s ease; }
.seg:hover { border-color: var(--accent); color: var(--accent-dark); }
.seg.on { color: #fff; font-weight: 600; border-color: transparent; }

/* ---------- 任务清单 ---------- */
.task-card { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; padding: 20px 24px; }
.tc-head { display: flex; align-items: baseline; justify-content: space-between; }
.tc-sub { font-size: 11.5px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.tc-add { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tc-input { flex: 1; min-width: 180px; box-sizing: border-box; border: 1px solid var(--line-2); border-radius: 10px; padding: 8px 12px; font-size: 12.5px; font-family: inherit; color: var(--text-1); outline: none; transition: border-color .15s ease; }
.tc-input:focus { border-color: var(--accent); }
.tc-input::placeholder { color: var(--text-3); }
.tc-chip { position: relative; border: 1px solid var(--line-2); background: var(--field); border-radius: 999px; font-size: 11.5px; font-weight: 600; font-family: inherit; color: var(--text-2); padding: 5px 11px; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; transition: all .15s ease; }
.tc-chip:hover { border-color: var(--accent); color: var(--accent-dark); }
.tc-chip.on { background: var(--red-soft); border-color: var(--red); color: var(--danger); }
.tc-chip.cal input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.tc-ok { border: none; background: var(--accent); color: #fff; border-radius: 9px; font-size: 12px; font-weight: 600; font-family: inherit; padding: 7px 14px; cursor: pointer; transition: background-color .15s ease, opacity .15s ease; }
.tc-ok:hover:not(:disabled) { background: var(--accent-dark); }
.tc-ok:disabled { opacity: .4; cursor: default; }
.tc-list { display: flex; flex-direction: column; }
.tk { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--text-2); padding: 11px 0; border-bottom: 1px solid var(--line); min-width: 0; }
.tk:last-child { border-bottom: none; }
.tk-box { width: 15px; height: 15px; border-radius: 4px; border: 1.5px solid var(--line-2); flex: 0 0 15px; cursor: pointer; display: grid; place-items: center; transition: all .15s ease; }
.tk-box:hover { border-color: var(--accent); }
.tk.st-done .tk-box { background: var(--accent); border-color: var(--accent); }
.tk.st-dropped .tk-box { background: var(--text-3); border-color: var(--text-3); }
.tk.st-done .tk-text, .tk.st-dropped .tk-text { color: var(--text-3); text-decoration: line-through; }
.tk-text { flex: 1; min-width: 0; word-break: break-word; }
.tk-urgent { background: var(--danger-soft); color: var(--danger); font-size: 10px; font-weight: 700; padding: 1.5px 6px; border-radius: 999px; flex: 0 0 auto; }
.tk-due { font-size: 11px; color: var(--text-3); flex: 0 0 auto; font-variant-numeric: tabular-nums; }
.tk-due.late { color: var(--danger); font-weight: 600; }
.tk-del { border: none; background: none; color: var(--text-3); cursor: pointer; width: 24px; height: 24px; border-radius: 6px; display: grid; place-items: center; flex: 0 0 auto; transition: background-color .15s ease, color .15s ease; }
.tk-del:hover { background: var(--red-soft); color: var(--danger); }
/* 悬停成组浮现的操作区（确认/放弃/恢复 + 删除），不跳位 */
.tk-acts { display: flex; align-items: center; gap: 2px; flex: 0 0 auto; opacity: 0; transition: opacity .12s ease; }
.tk:hover .tk-acts { opacity: 1; }
.tk-act { border: none; background: none; color: var(--text-3); cursor: pointer; width: 24px; height: 24px; border-radius: 6px; display: grid; place-items: center; flex: 0 0 auto; transition: background-color .15s ease, color .15s ease; }
.tk-act:hover { background: var(--accent-soft); color: var(--accent-dark); }
.tk-act.drop:hover { background: var(--red-soft); color: var(--danger); }
.tk-state { font-size: 10px; font-weight: 600; padding: 1.5px 6px; border-radius: 999px; flex: 0 0 auto; }
.tk-state.doing { background: var(--blue-soft); color: var(--blue); }
.tk-state.done { background: var(--accent-soft); color: var(--accent-dark); }
.tk-state.drop { background: var(--chip); color: var(--text-3); }
.tc-empty { padding: 18px 0 4px; font-size: 12px; color: var(--text-3); text-align: center; }
.tc-clear { align-self: flex-start; border: 1px solid var(--line); background: none; border-radius: 9px; padding: 6px 12px; font-size: 11.5px; color: var(--text-3); cursor: pointer; font-family: inherit; transition: all .15s ease; }
.tc-clear:hover { border-color: var(--danger-line); color: var(--danger); background: var(--danger-soft); }
.tc-done { margin-top: 6px; padding-top: 14px; border-top: 1px solid var(--line); }
.tc-done-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px; }
.tc-done-title { font-size: 11.5px; font-weight: 600; color: var(--text-3); }

/* ---------- 功能特点 ---------- */
.feat-card { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; padding: 20px 24px; }
.feat-list { list-style: none; display: flex; flex-direction: column; gap: 9px; }
.feat-list li { display: flex; align-items: flex-start; gap: 8px; font-size: 12.5px; line-height: 1.55; color: var(--text-2); }
.feat-tick { flex: 0 0 auto; margin-top: 3px; color: var(--accent); }

/* ---------- 版本记录（可编辑时间轴） ---------- */
.ver-card { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; padding: 20px 24px; }
.vc-head { display: flex; align-items: center; justify-content: space-between; }
.vc-add { border: 1px solid var(--line-2); background: var(--field); border-radius: 999px; font-size: 11.5px; font-weight: 600; font-family: inherit; color: var(--text-2); padding: 5px 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; transition: all .15s ease; }
.vc-add:hover { border-color: var(--accent); color: var(--accent-dark); background: var(--accent-soft); }
.vf { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; background: var(--hover); border: 1px solid var(--line); border-radius: 12px; }
.vf-title { box-sizing: border-box; width: 100%; border: 1px solid var(--line-2); border-radius: 9px; padding: 7px 11px; font-size: 12.5px; font-family: inherit; color: var(--text-1); outline: none; background: var(--field); transition: border-color .15s ease; }
.vf-title:focus { border-color: var(--accent); }
.vf-desc { box-sizing: border-box; width: 100%; border: 1px solid var(--line-2); border-radius: 9px; padding: 7px 11px; font-size: 12.5px; font-family: inherit; color: var(--text-1); outline: none; background: var(--field); resize: vertical; line-height: 1.55; transition: border-color .15s ease; }
.vf-desc:focus { border-color: var(--accent); }
.vf-title::placeholder, .vf-desc::placeholder { color: var(--text-3); }
.vf-foot { display: flex; align-items: center; justify-content: flex-end; gap: 14px; }
.vf-cancel { font-size: 11.5px; color: var(--text-3); cursor: pointer; }
.vf-cancel:hover { color: var(--text-1); }
.vf-save { border: none; background: var(--accent); color: #fff; border-radius: 9px; font-size: 12px; font-weight: 600; font-family: inherit; padding: 6px 14px; cursor: pointer; transition: background-color .15s ease, opacity .15s ease; }
.vf-save:hover:not(:disabled) { background: var(--accent-dark); }
.vf-save:disabled { opacity: .4; cursor: default; }
.ver-list { display: flex; flex-direction: column; gap: 18px; }
.ver-item { position: relative; display: flex; gap: 12px; }
.ver-item::before { content: ""; position: absolute; left: 4px; top: 18px; bottom: -18px; width: 1.5px; background: var(--line-2); }
.ver-item:last-child::before { display: none; }
.ver-dot { position: relative; z-index: 1; flex: 0 0 9px; width: 9px; height: 9px; margin-top: 5px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
.ver-body { flex: 1; min-width: 0; }
.ver-head { display: flex; align-items: center; gap: 10px; }
.ver-title { font-size: 13px; font-weight: 700; color: var(--text-1); letter-spacing: -.1px; flex: 1; min-width: 0; word-break: break-word; }
.ver-del { border: none; background: none; color: var(--text-3); cursor: pointer; width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center; flex: 0 0 auto; opacity: 0; transition: all .12s ease; }
.ver-item:hover .ver-del { opacity: 1; }
.ver-del:hover { background: var(--red-soft); color: var(--danger); }
.ver-desc { margin-top: 4px; font-size: 12px; line-height: 1.6; color: var(--text-2); white-space: pre-wrap; word-break: break-word; }
.ver-empty { padding: 14px 0 2px; font-size: 12px; color: var(--text-3); text-align: center; line-height: 1.6; }

@media (max-width: 767px) {
  .m-note { margin-left: 0; width: 100%; }
  .gh-ctrl { flex-direction: column; align-items: flex-start; }
}
</style>
