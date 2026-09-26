<script setup lang="ts">
/**
 * 番茄钟计时浮窗（托盘「番茄钟」/ 悬浮球 dock 唤起，label: focus）
 * 自由时长计时（非 25/5 轮回）：开始→结束一次性落库，<1 分钟视为取消不记录；
 * 三档大小（小/中圆环、大卡片）右键切换并记忆，窗口尺寸经 setSize 调整、右下角锚定。
 * 两个入口都只负责开窗、不自动计时，全靠窗内按钮手动控制：未开始[开始]→计时中[暂停][结束]→已暂停[继续][结束]；
 * 暂停期不计入总时长，运行态（含暂停）经 set_focus_running 同步托盘菜单文本（番茄钟 ↔ 结束）。
 */
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize, LogicalPosition } from "@tauri-apps/api/window";
import { focusMinutesToday, activeTasks } from "../utils/focus";
import { setTaskStatus, ensureInbox, addTaskToGoal } from "../utils/projects";
import { readUi, writeUi } from "../utils/prefs";

type Level = "sm" | "md" | "lg";
/** 逻辑像素尺寸：小档宽度另由 dimsFor 随状态伸缩（此值不生效），中为正圆、大为圆角卡片 */
const DIMS: Record<Level, [number, number]> = { sm: [170, 56], md: [180, 180], lg: [320, 400] };
const LEVEL_LABEL: Record<Level, string> = { sm: "小", md: "中", lg: "大" };
/** 遍历用（模板不碰 DIMS 的值，避开未使用变量告警） */
const LEVELS: Level[] = ["sm", "md", "lg"];
/** 小档宽度随状态伸缩：未开始窄一些、开始计时后容纳「暂停/结束」两枚按钮（右下角锚定） */
const SM_IDLE_W = 170;
const SM_ACTIVE_W = 200;
const SM_H = 56;

const level = ref<Level>((readUi().focusSize as Level) || "md");
const running = ref(false);      // 会话进行中（含暂停）
const paused = ref(false);       // 计时被打断，暂停期不计入总时长
const startTs = ref(0);          // 本次会话最初开始时刻（供记录窗起止用）
const segStart = ref(0);         // 当前计时段开始时刻（恢复时刷新）
const accumMs = ref(0);          // 已结算的有效专注毫秒（不含暂停）
const elapsed = ref(0);          // 秒，运行中每秒刷新
const todayMin = ref(0);
const msg = ref("");              // 浮层轻提示
const menu = ref<{ x: number; y: number } | null>(null);
const tasks = ref<{ id: number; text: string; goalName: string; status: string }[]>([]);
const addText = ref("");

let tick = 0;
let msgTimer = 0;
let unlisten: (() => void) | null = null;

function fmt(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const hh = String(h).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function toast(text: string) {
  msg.value = text;
  window.clearTimeout(msgTimer);
  msgTimer = window.setTimeout(() => (msg.value = ""), 1800);
}

/** 环上进度：每分钟扫一圈（专注以分钟为意义单位，秒针感由数字承担） */
const ringFrac = ref(0);

/** 每秒刷新：净时长 = 已结算段 + 本段（暂停时本段已并入 accumMs，不再叠加） */
function refreshElapsed() {
  const active = accumMs.value + (paused.value ? 0 : Date.now() - segStart.value);
  elapsed.value = Math.floor(active / 1000);
  ringFrac.value = (elapsed.value % 60) / 60;
}

function startTick() {
  window.clearInterval(tick);
  tick = window.setInterval(refreshElapsed, 1000);
}

async function start() {
  if (running.value) return;
  const now = Date.now();
  startTs.value = now;
  segStart.value = now;
  accumMs.value = 0;
  running.value = true;
  paused.value = false;
  elapsed.value = 0;
  ringFrac.value = 0;
  startTick();
  void syncSmWidth(true);
  try { await invoke("set_focus_running", { running: true }); } catch { /* 浏览器调试无宿主 */ }
}

/** 暂停：结算本段并入累计、停表（托盘仍视为「进行中」） */
function pause() {
  if (!running.value || paused.value) return;
  accumMs.value += Date.now() - segStart.value;
  paused.value = true;
  window.clearInterval(tick);
}

/** 继续：重开一个新计时段 */
function resume() {
  if (!running.value || !paused.value) return;
  segStart.value = Date.now();
  paused.value = false;
  startTick();
}

async function finish(silentTooShort = false) {
  if (!running.value) return;
  window.clearInterval(tick);
  const end = Date.now();
  // 净时长：暂停态下本段已结算进 accumMs，不再叠加；计时中才补上当前段
  const durMs = paused.value ? accumMs.value : accumMs.value + (end - segStart.value);
  running.value = false;
  paused.value = false;
  void syncSmWidth(true);
  try { await invoke("set_focus_running", { running: false }); } catch { /* 同上 */ }
  if (durMs < 60_000) {
    // 太短不落库、也不弹记录窗（正常结束靠 focus:record-done 归零），故就地把时间/圆环归零
    elapsed.value = 0;
    ringFrac.value = 0;
    if (!silentTooShort) toast("不足 1 分钟，未记录");
    return;
  }
  const mins = Math.floor(durMs / 60_000);
  // 存入 localStorage 并弹出记录窗
  localStorage.setItem("focus-pending", JSON.stringify({ startTs: startTs.value, endTs: end, minutes: mins }));
  try { await invoke("open_focus_record"); } catch { /* 浏览器调试无宿主 */ }
}

async function toggleTask(id: number) {
  await setTaskStatus(id, "done");
  tasks.value = tasks.value.filter(t => t.id !== id);
}

async function addTask() {
  const text = addText.value.trim();
  if (!text) return;
  const inboxId = await ensureInbox();
  const t = await addTaskToGoal(inboxId, { text, urgent: false, due: "" });
  tasks.value.push({ id: t.id, text: t.text, goalName: "待办", status: t.status });
  addText.value = "";
}

/** 主按钮：未开始→开始；计时中→暂停；已暂停→继续（结束由独立红按钮触发） */
function primary() {
  if (!running.value) { void start(); return; }
  if (paused.value) resume(); else pause();
}
const primaryLabel = computed(() => (!running.value ? "开始" : paused.value ? "继续" : "暂停"));

/** 取某档位当前尺寸：小档按运行态给宽（170/200），中/大档固定 */
function dimsFor(lv: Level): [number, number] {
  if (lv === 'sm') return [running.value ? SM_ACTIVE_W : SM_IDLE_W, SM_H];
  return DIMS[lv];
}

/** 改窗口尺寸：右下角保持锚定（向左上生长/收缩）；animated=true 时用 rAF 逐帧过渡 */
async function resizeTo(w: number, h: number, animated: boolean) {
  try {
    const win = getCurrentWindow();
    const sf = await win.scaleFactor();
    const pos = await win.outerPosition();
    const size = await win.innerSize();
    const curW = size.width / sf, curH = size.height / sf;
    const right = pos.x / sf + curW, bottom = pos.y / sf + curH;   // 锚住的右下角
    if (!animated) {
      await win.setSize(new LogicalSize(w, h));
      await win.setPosition(new LogicalPosition(Math.max(0, right - w), Math.max(0, bottom - h)));
      return;
    }
    const dur = 180, t0 = performance.now();
    await new Promise<void>((res) => {
      const step = (now: number) => {
        const k = Math.min(1, (now - t0) / dur);
        const e = 1 - Math.pow(1 - k, 3);                       // easeOutCubic
        const cw = curW + (w - curW) * e, ch = curH + (h - curH) * e;
        void win.setSize(new LogicalSize(cw, ch));
        void win.setPosition(new LogicalPosition(Math.max(0, right - cw), Math.max(0, bottom - ch)));
        if (k < 1) requestAnimationFrame(step); else res();
      };
      requestAnimationFrame(step);
    });
  } catch { /* 非 Tauri 环境只换样式 */ }
}

/** 小档宽度随状态伸缩（仅小档生效） */
async function syncSmWidth(animated: boolean) {
  if (level.value !== 'sm') return;
  const [w, h] = dimsFor('sm');
  await resizeTo(w, h, animated);
}

/** 切档：右下角锚定即时改尺寸，并持久化偏好 */
async function applyLevel(lv: Level) {
  const [w, h] = dimsFor(lv);
  await resizeTo(w, h, false);
  level.value = lv;
  writeUi({ focusSize: lv });
  menu.value = null;
}

async function hideSelf() {
  menu.value = null;
  try { await getCurrentWindow().hide(); } catch { /* 同上 */ }
}

function openMenu(e: MouseEvent) {
  if (menu.value) { closeMenu(); return; }  // 再次右键 = 关闭
  menu.value = { x: Math.min(e.clientX, window.innerWidth - 110), y: Math.max(4, e.clientY) };
}

function closeMenu() {
  menu.value = null;
}

/** 整窗随意拖动：除交互控件与右键菜单外，任意按下都发起窗口拖拽（大档下拉/备注输入不受影响） */
function dragOn(e: MouseEvent) {
  if (e.button !== 0) return;
  if ((e.target as Element).closest("button, input, select, a, .fx-menu, .fx-backdrop")) return;
  getCurrentWindow().startDragging().catch(() => { /* 非 Tauri 环境无窗口可拖 */ });
}

onMounted(async () => {
  // 挂载即与已存偏好对齐（Rust 建窗固定中档尺寸，记忆的是别的档时静默校正）
  if (level.value !== "md") await applyLevel(level.value);
  todayMin.value = await focusMinutesToday();
  tasks.value = await activeTasks();
  // 记录窗关闭后归零圆环 + 时间
  unlisten = await listen("focus:record-done", () => {
    elapsed.value = 0;
    ringFrac.value = 0;
    void focusMinutesToday().then(v => { todayMin.value = v; });
  });
});

onBeforeUnmount(() => {
  window.clearInterval(tick);
  window.clearTimeout(msgTimer);
  unlisten?.();
});
</script>

<template>
  <div class="fx" :class="`lv-${level}`" @contextmenu.prevent="openMenu" @mousedown="dragOn">
    <!-- ===== 小档：横向胶囊 ===== -->
    <div v-if="level === 'sm'" class="fx-pill" @click.self="closeMenu">
      <template v-if="menu">
        <button
          v-for="lv in LEVELS" :key="lv" class="fx-pill-item" :class="{ on: level === lv }"
          @click="applyLevel(lv)"
        >{{ LEVEL_LABEL[lv] }}</button>
        <span class="fx-pill-sep"></span>
        <button class="fx-pill-item" @click="hideSelf">隐藏</button>
      </template>
      <template v-else>
        <span class="fx-pill-time" :class="{ live: running && !paused, paused }">{{ fmt(elapsed) }}</span>
        <span class="fx-pill-actions">
          <button class="fx-pill-btn" @click.stop="primary">{{ primaryLabel }}</button>
          <button v-if="running" class="fx-pill-btn stop" @click.stop="finish()">结束</button>
        </span>
      </template>
    </div>

    <!-- ===== 中档：正圆环 ===== -->
    <div v-else-if="level === 'md'" class="fx-circle" :class="{ 'menu-open': menu }" @click.self="closeMenu">
      <template v-if="menu">
        <button
          v-for="lv in LEVELS" :key="lv" class="fx-circle-item" :class="{ on: level === lv }"
          @click="applyLevel(lv)"
        >{{ LEVEL_LABEL[lv] }}</button>
        <button class="fx-circle-item hide" @click="hideSelf">隐藏</button>
      </template>
      <template v-else>
        <svg class="fx-ring" viewBox="0 0 100 100">
          <circle class="fx-ring-track" cx="50" cy="50" r="45" />
          <circle
            class="fx-ring-bar" cx="50" cy="50" r="45"
            :style="{ strokeDashoffset: 282.74 * (1 - ringFrac) }"
          />
        </svg>
        <div class="fx-core">
          <div class="fx-time" :class="{ live: running && !paused, paused }">{{ fmt(elapsed) }}</div>
          <div class="fx-core-actions">
            <button class="fx-btn" @click.stop="primary">{{ primaryLabel }}</button>
            <button v-if="running" class="fx-btn stop" @click.stop="finish()">结束</button>
          </div>
        </div>
      </template>
    </div>

    <!-- ===== 大档：圆角卡片 ===== -->
    <div v-else class="fx-card">
      <div class="fx-head">
        <span class="fx-head-title">番茄钟</span>
        <div class="fx-levels">
          <button
            v-for="lv in LEVELS" :key="lv" class="fx-lv-btn" :class="{ on: level === lv }"
            :title="`切换到${LEVEL_LABEL[lv]}档`" @click.stop="applyLevel(lv)"
          >{{ LEVEL_LABEL[lv] }}</button>
        </div>
        <button class="fx-x" title="隐藏" @click.stop="hideSelf">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
            <path d="M6 6l12 12M18 6L6 18"/>
          </svg>
        </button>
      </div>

      <div class="fx-display" :class="{ flow: running && !paused }">
        <div class="fx-time big" :class="{ live: running && !paused, paused }">{{ fmt(elapsed) }}</div>
      </div>

      <!-- 待办列表 -->
      <div class="fx-tasks">
        <div class="fx-tasks-head">还有哪些要做</div>
        <div class="fx-tasks-list">
          <div v-for="t in tasks" :key="t.id" class="fx-task">
            <span class="fx-task-box" @click.stop="toggleTask(t.id)">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            </span>
            <span class="fx-task-text">{{ t.text }}</span>
          </div>
          <div v-if="!tasks.length" class="fx-task-empty">暂无待办</div>
        </div>
        <input
          v-model="addText" class="fx-task-add"
          placeholder="加一条，回车添加…" maxlength="60"
          @keydown.enter.prevent="addTask" @mousedown.stop
        />
      </div>

      <div class="fx-foot">
        <span class="fx-today">今日番茄 {{ todayMin }} 分钟</span>
        <span class="fx-foot-actions">
          <button class="fx-btn" @click="primary">{{ primaryLabel }}</button>
          <button v-if="running" class="fx-btn stop" @click="finish()">结束</button>
        </span>
      </div>
    </div>

    <!-- 右键档位菜单（仅大档用浮层，小/中档内联） -->
    <div v-if="menu && level === 'lg'" class="fx-backdrop" @click="closeMenu" @contextmenu.prevent="closeMenu"></div>
    <div v-if="menu && level === 'lg'" class="fx-menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }">
      <button
        v-for="lv in LEVELS" :key="lv" class="fx-menu-item" :class="{ on: level === lv }"
        @click="applyLevel(lv)"
      >{{ LEVEL_LABEL[lv] }}档</button>
      <div class="fx-menu-sep"></div>
      <button class="fx-menu-item" @click="hideSelf">隐藏窗口</button>
    </div>

    <transition name="fade"><div v-if="msg" class="fx-toast">{{ msg }}</div></transition>
  </div>
</template>

<style>
/* 浮窗整窗透出桌面：盖掉 global.css 的 body 底色（不 scoped，只在本页加载） */
html, body { background: transparent !important; }
@property --angle { syntax: '<angle>'; initial-value: 0deg; inherits: false; }
</style>

<style scoped>
.fx { position: fixed; inset: 0; font-size: 13px; }

/* ---------- 小档胶囊 ---------- */
.fx-pill {
  position: absolute; inset: 0; border-radius: 28px;
  background: var(--card); border: 1px solid var(--line-2);
  display: flex; align-items: center; gap: 5px; padding: 0 12px; cursor: move;
}
.fx-pill-time {
  font-size: 18px; font-weight: 700; color: var(--text-1);
  font-variant-numeric: tabular-nums; letter-spacing: -.5px;
}
.fx-pill-time.live { color: var(--accent-dark); animation: pulse 2s ease-in-out infinite; }
.fx-pill-time.paused { color: var(--text-3); animation: none; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .6; } }
.fx-pill-today { display: none; }
.fx-pill-item {
  border: none; background: transparent; color: var(--text-2); font-size: 12px;
  padding: 4px 8px; border-radius: 14px; cursor: pointer; font-family: inherit; font-weight: 500;
  white-space: nowrap; flex: none;
}
.fx-pill-item:hover { background: var(--hover); color: var(--text-1); }
.fx-pill-item.on { background: var(--accent-soft); color: var(--accent-dark); font-weight: 600; }
.fx-pill-sep { width: 1px; height: 16px; background: var(--line); flex: none; }
.fx-pill-actions { margin-left: auto; display: flex; align-items: center; gap: 5px; flex: none; }
.fx-pill-btn {
  border: none; border-radius: 14px; cursor: pointer; padding: 4px 10px;
  background: var(--accent); color: #fff; font-size: 11px; font-weight: 600;
  font-family: inherit; flex: none;
}
.fx-pill-btn:hover { background: var(--accent-dark); }
.fx-pill-btn.stop { background: var(--red); }
.fx-pill-btn.stop:hover { filter: brightness(.92); }

/* ---------- 圆档（中） ---------- */
.fx-circle {
  position: absolute; inset: 0; border-radius: 50%;
  background: var(--card); border: 1px solid var(--line-2);
  display: flex; align-items: center; justify-content: center; cursor: move;
}
.fx-circle.menu-open { flex-direction: column; gap: 4px; }

.fx-circle-item {
  border: none; background: transparent; color: var(--text-2);
  font-size: 14px; font-weight: 500; font-family: inherit; cursor: pointer;
  padding: 4px 16px; border-radius: 16px; white-space: nowrap;
}
.fx-circle-item:hover { background: var(--hover); color: var(--text-1); }
.fx-circle-item.on { background: var(--accent-soft); color: var(--accent-dark); font-weight: 600; }
.fx-circle-item.hide { font-size: 12px; color: var(--text-3); margin-top: 2px; }
.fx-ring { position: absolute; inset: 5px; width: calc(100% - 10px); height: calc(100% - 10px); transform: rotate(-90deg); }
.fx-ring-track { fill: none; stroke: var(--track); stroke-width: 4; }
.fx-ring-bar {
  fill: none; stroke: var(--accent); stroke-width: 4; stroke-linecap: round;
  stroke-dasharray: 282.74; transition: stroke-dashoffset 1s linear;
}
/* 运行中的呼吸光圈：用时间数字的 live 标记反向命中环条 */
.fx-circle:has(.fx-time.live) .fx-ring-bar { animation: breathe 2.4s ease-in-out infinite; }
@keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }
.fx-core { position: relative; text-align: center; pointer-events: none; }
.fx-core-actions { display: flex; gap: 6px; justify-content: center; margin-top: 6px; pointer-events: auto; }
.fx-core .fx-btn { pointer-events: auto; padding: 4px 12px; font-size: 12px; }
.fx-time { font-size: 26px; font-weight: 700; color: var(--text-1); font-variant-numeric: tabular-nums; letter-spacing: -.5px; }
.fx-time.big { font-size: 48px; letter-spacing: -1px; }
.fx-time.live { color: var(--accent-dark); }
.fx-time.paused { color: var(--text-3); }

/* ---------- 大档卡片 ---------- */
.fx-card {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  background: var(--card); border: 1px solid var(--line-2); border-radius: 16px;
  overflow: hidden;
}
.fx-head {
  display: flex; align-items: center; gap: 8px; flex: none;
  padding: 7px 8px 5px 12px; cursor: move; user-select: none;
}
.fx-head-title { font-size: 11.5px; font-weight: 600; color: var(--text-3); letter-spacing: .5px; flex: none; }
.fx-levels { display: flex; gap: 3px; margin-left: auto; }
.fx-lv-btn {
  border: none; background: transparent; color: var(--text-3); font-size: 11px;
  padding: 2px 7px; border-radius: 6px; cursor: pointer;
}
.fx-lv-btn.on { background: var(--accent-soft); color: var(--accent-dark); font-weight: 600; }
.fx-x {
  border: none; background: transparent; color: var(--text-3); cursor: pointer;
  width: 20px; height: 20px; border-radius: 6px; display: grid; place-items: center; padding: 0;
}
.fx-x:hover { background: var(--hover); color: var(--text-1); }
.fx-display {
  position: relative; margin: 12px 16px 0; padding: 32px 16px; border-radius: 14px;
  background: var(--field); text-align: center;
}
.fx-display::before {
  content: ''; position: absolute; inset: 0; border-radius: inherit;
  background: conic-gradient(from var(--angle, 0deg), var(--accent) 0deg, transparent 90deg, transparent 360deg);
  padding: 1.5px;
  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  mask-composite: exclude;
  opacity: 0; transition: opacity .3s;
}
.fx-display.flow::before { opacity: 1; animation: border-flow 60s linear infinite; }
@keyframes border-flow { to { --angle: 360deg; } }
.fx-tasks {
  flex: 1; min-height: 0; display: flex; flex-direction: column;
  padding: 8px 16px 4px; overflow: hidden;
}
.fx-tasks-head { font-size: 11px; color: var(--text-3); margin-bottom: 6px; flex: none; }
.fx-tasks-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
.fx-task { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
.fx-task-box {
  width: 16px; height: 16px; border-radius: 4px; border: 1.5px solid var(--line-2);
  display: grid; place-items: center; cursor: pointer; flex: none; transition: all .15s;
}
.fx-task-box:hover { border-color: var(--accent); background: var(--accent-soft); }
.fx-task-text { font-size: 12px; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fx-task-empty { font-size: 11px; color: var(--text-3); padding: 8px 0; }
.fx-task-add {
  width: 100%; border: 1px solid var(--line-2); border-radius: 8px; margin-top: 6px;
  background: var(--field); color: var(--text-1); font-size: 12px;
  padding: 5px 10px; outline: none; font-family: inherit; flex: none;
}
.fx-task-add:focus { border-color: var(--accent); }

.fx-foot { display: flex; align-items: center; justify-content: space-between; padding: 8px 16px 12px; flex: none; }
.fx-today { font-size: 11px; color: var(--text-3); }
.fx-foot-actions { display: flex; align-items: center; gap: 8px; flex: none; }

/* ---------- 通用控件 ---------- */
.fx-btn {
  border: none; border-radius: 9px; cursor: pointer; padding: 5px 16px;
  background: var(--accent); color: #fff; font-size: 12.5px; font-weight: 600; font-family: inherit;
}
.fx-btn:hover { background: var(--accent-dark); }
.fx-btn.stop { background: var(--red); }
.fx-btn.stop:hover { filter: brightness(.92); }

/* ---------- 右键菜单 / 提示 ---------- */
.fx-backdrop { position: fixed; inset: 0; z-index: 40; }
.fx-menu {
  position: fixed; z-index: 41; min-width: 96px; padding: 4px;
  background: var(--card); border: 1px solid var(--line-2); border-radius: 10px;
}
.fx-menu-item {
  display: block; width: 100%; text-align: left; border: none; background: transparent;
  color: var(--text-1); font-size: 12px; padding: 5px 9px; border-radius: 7px; cursor: pointer; font-family: inherit;
}
.fx-menu-item:hover { background: var(--hover); }
.fx-menu-item.on { color: var(--accent-dark); font-weight: 600; }
.fx-menu-sep { height: 1px; margin: 4px 6px; background: var(--line); }
.fx-toast {
  position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%);
  background: #1F2937; color: #fff; font-size: 11.5px; padding: 5px 11px; border-radius: 8px;
  white-space: nowrap; pointer-events: none; z-index: 42;
}
.lv-sm .fx-toast { bottom: 4px; font-size: 11px; }
.fade-enter-active, .fade-leave-active { transition: opacity .25s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
