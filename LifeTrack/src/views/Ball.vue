<script setup lang="ts">
/**
 * 常驻悬浮球（启动即建的独立置顶透明窗，label: ball，尺寸恒定 76×76）
 * 交互：可拖到屏幕任意处，松手靠近左/右边缘则吸附半隐、否则原地自由悬浮；悬停满 300ms 或点击球
 * → 弹出一个「分离的」胶囊 dock 窗（label: ball-dock，随记 / 番茄钟两枚入口）。
 * dock 是独立固定尺寸窗，只 show/hide + 定位、绝不 resize —— 从根本上消除透明窗 resize 的抖动与矩形残影。
 * 两窗靠事件协同（emit/listen）：球 hover → invoke(show_ball_dock) 定位显示 + emit("btd:open")；
 * 球或 dock 任一鼠标离开 → 400ms 后 emit("btd:close")，由 dock 播完收起动画后自隐。
 * 拖动用 e.screenX/Y（绝对屏幕坐标，不受窗口跟随移动影响）。
 */
import { ref, onMounted, onBeforeUnmount } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, currentMonitor, primaryMonitor, LogicalPosition } from "@tauri-apps/api/window";
import { loadSettings } from "../utils/settings";
import { readUi, writeUi } from "../utils/prefs";

// ===== 逻辑像素尺寸：球 56 + 透明阴影留白 10×2 = 76 见方（运行期恒定，不再改窗宽） =====
const WIN = 76;      // 球窗边长（须与 Rust BALL_WIN 一致）
const BALL = 56;     // 球可见直径
const PILL_W = 132;  // dock 胶囊可见尺寸（= BallDock.vue 里的 .pill）
const PILL_H = 56;
const DOCK_PAD = 16; // 胶囊四周的透明留白（给圆角/阴影留气口，避免胶囊贴窗边显成矩形）
const DOCK_W = PILL_W + DOCK_PAD * 2;  // dock 窗宽（须与 Rust DOCK_W 一致）
const DOCK_H = PILL_H + DOCK_PAD * 2;  // dock 窗高（须与 Rust DOCK_H 一致）
const DOCK_PEEK = 16;  // 贴边吸附时探出屏幕被藏起的量（px）：只藏这么多、露出约 3/4 个球，避免“看着像消失了”

const side = ref<"left" | "right">(readUi().ballSide);
const docked = ref(true);   // true=吸附左右边缘（半隐），false=自由悬浮在桌面任意处
const freeX = ref(0);        // 自由态下球心的逻辑 X（贴边态用不到）
const cy = ref(0);           // 球心的逻辑 Y
const dockOpen = ref(false); // dock 当前是否已弹出（本地镜像，避免重复 show）
const EDGE_SNAP = 48;        // 距左/右边缘小于此阈值才自动吸边，否则就地自由悬浮

let hoverTimer = 0;
let closeTimer = 0;
const unlistenFns: Array<() => void> = [];

/** 取当前显示器工作区（逻辑像素）。多屏只跟球所在那块屏走。 */
async function workArea() {
  const mon = (await currentMonitor().catch(() => null)) ?? (await primaryMonitor().catch(() => null));
  if (!mon) return { left: 0, top: 0, right: 1280, bottom: 720 };
  const sf = mon.scaleFactor || 1;
  // 优先用 workArea（避开任务栏），旧版无此字段时退化为整屏
  const wa = (mon as unknown as { workArea?: { position: { x: number; y: number }; size: { width: number; height: number } } }).workArea;
  const src = wa ?? { position: mon.position, size: mon.size };
  const left = src.position.x / sf;
  const top = src.position.y / sf;
  const right = left + src.size.width / sf;
  const bottom = top + src.size.height / sf;
  return { left, top, right, bottom };
}

/** 只摆位置（尺寸恒定）：球心钉在目标处（贴边=边缘半隐，自由=落点） */
async function applyGeom() {
  try {
    const win = getCurrentWindow();
    const { left, top, right, bottom } = await workArea();
    let cx = docked.value ? (side.value === "right" ? right - DOCK_PEEK : left + DOCK_PEEK) : freeX.value;
    // 自由态横向钳回屏内（贴边态 cx=边缘本就合法）：防止上次被拖出界存了越界坐标 → 球“隐身”
    if (!docked.value) {
      cx = Math.min(Math.max(cx, left + BALL / 2), right - BALL / 2);
      freeX.value = cx;
    }
    cy.value = Math.min(Math.max(cy.value, top + BALL / 2), bottom - BALL / 2);
    await win.setPosition(new LogicalPosition(cx - WIN / 2, cy.value - WIN / 2));
    // 几何变更即持久化，下次冷启恢复原位（已钳正）
    writeUi({ ballGeom: { docked: docked.value, side: side.value, x: freeX.value, y: cy.value }, ballSide: side.value });
  } catch { /* 非 Tauri 环境（纯浏览器调试）没有真窗可摆 */ }
}

// ===== dock 弹出 / 收起（驱动独立的 ball-dock 窗） =====
async function openDock() {
  const { left, top, right, bottom } = await workArea();
  const cx = docked.value ? (side.value === "right" ? right - DOCK_PEEK : left + DOCK_PEEK) : freeX.value;
  // 先算「胶囊」左上角：贴右/处右半 → 胶囊开在球左侧（向屏幕内），反之右侧；紧贴球可见边缘 +2px 间距
  const pillX = side.value === "right" ? cx - BALL / 2 - PILL_W - 2 : cx + BALL / 2 + 2;
  const pillY = cy.value - PILL_H / 2;
  // 窗 = 胶囊 + 2×留白，胶囊居中 → 窗左上 = 胶囊左上 − 留白；再把整窗钳进工作区
  const ox = Math.min(Math.max(pillX - DOCK_PAD, left + 4), right - DOCK_W - 4);
  const oy = Math.min(Math.max(pillY - DOCK_PAD, top + 4), bottom - DOCK_H - 4);
  dockOpen.value = true;
  try {
    await invoke("show_ball_dock", { x: ox, y: oy });
    await emit("btd:open", { side: side.value });
  } catch { /* 非 Tauri 环境 */ }
}
function closeDock() {
  if (!dockOpen.value) return;
  dockOpen.value = false;
  window.clearTimeout(closeTimer);
  void emit("btd:close").catch(() => {}); // dock 收到后播收起动画再自隐
}
function scheduleClose(delay = 400) {
  window.clearTimeout(closeTimer);
  closeTimer = window.setTimeout(() => closeDock(), delay);
}

// ===== 悬停 / 离开 =====
function onEnter() {
  if (dragging) return;               // 拖动中不响应悬停
  window.clearTimeout(closeTimer);
  window.clearTimeout(hoverTimer);
  hoverTimer = window.setTimeout(() => { if (!dragging && !dockOpen.value) void openDock(); }, 300);
}
function onLeave() {
  window.clearTimeout(hoverTimer);
  scheduleClose(400);                 // 离开球 400ms 内若滑入 dock，会被 dock 的 btd:enter 取消
}

// ===== 拖动 + 点击判定 =====
let dragging = false;
let moved = false;
let wasOpen = false;
let downScreenX = 0, downScreenY = 0, baseX = 0, baseY = 0;

async function currentOrigin() {
  const win = getCurrentWindow();
  const sf = await win.scaleFactor();
  const pos = await win.outerPosition();
  return { x: pos.x / sf, y: pos.y / sf };
}

async function onBallDown(e: MouseEvent) {
  if (e.button !== 0) return;
  window.clearTimeout(hoverTimer);
  window.clearTimeout(closeTimer);
  wasOpen = dockOpen.value;
  if (dockOpen.value) {               // 一按下先利落地收起 dock（拖动不该带个胶囊）
    dockOpen.value = false;
    try { await invoke("hide_ball_dock"); } catch { /* 非 Tauri 环境 */ }
  }
  dragging = true; moved = false;
  downScreenX = e.screenX; downScreenY = e.screenY;
  const o = await currentOrigin();
  baseX = o.x; baseY = o.y;
  window.addEventListener("mousemove", onDragMove);
  window.addEventListener("mouseup", onDragUp);
}
async function onDragMove(e: MouseEvent) {
  if (!dragging) return;
  const dx = e.screenX - downScreenX;
  const dy = e.screenY - downScreenY;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
  if (!moved) return;
  try {
    await getCurrentWindow().setPosition(new LogicalPosition(baseX + dx, baseY + dy));
  } catch { /* 同上 */ }
}
async function onDragUp() {
  if (!dragging) return;
  dragging = false;
  window.removeEventListener("mousemove", onDragMove);
  window.removeEventListener("mouseup", onDragUp);
  if (!moved) {
    // 视作点击：开 → 关；关 → 开
    if (wasOpen) closeDock();
    else void openDock();
    return;
  }
  // 拖拽结束：靠近左/右边缘才吸边（半隐），否则就地自由悬浮在落点
  const { left, top, right, bottom } = await workArea();
  const o = await currentOrigin();
  const centerX = o.x + WIN / 2;   // 球恒居窗中，球心 X = 窗口左上 X + 半边长
  const centerY = o.y + WIN / 2;
  cy.value = Math.min(Math.max(centerY, top + BALL / 2), bottom - BALL / 2);
  const nearEdge = centerX - left <= EDGE_SNAP || right - centerX <= EDGE_SNAP;
  if (nearEdge) {
    docked.value = true;
    side.value = centerX - left <= right - centerX ? "left" : "right";
  } else {
    docked.value = false;
    side.value = centerX < (left + right) / 2 ? "left" : "right"; // 自由态：dock 朝屏幕内侧开
    freeX.value = centerX;
  }
  await applyGeom();
}

onMounted(() => {
  void (async () => {
    const { left, top, right, bottom } = await workArea();
    const g = readUi().ballGeom;
    if (g) {
      docked.value = g.docked;
      side.value = g.side;
      if (g.x) freeX.value = g.x;
      if (g.y) cy.value = g.y;
    }
    if (!cy.value) cy.value = (top + bottom) / 2;
    if (!docked.value && !freeX.value) freeX.value = (left + right) / 2;
    await applyGeom();
    // dock 报告鼠标进/出它自身 → 取消/续排收起（让光标能在球与 dock 间自由穿行）
    try {
      unlistenFns.push(await listen("btd:enter", () => window.clearTimeout(closeTimer)));
      unlistenFns.push(await listen("btd:leave", () => scheduleClose(400)));
    } catch { /* 非 Tauri 环境 */ }
    // 关闭态：先让透明窗真实上屏绘制一次（约 300ms）把分层透明表面挂稳，再自隐。
    // 若在建窗当帧就 hide，透明表面从未建立 → 之后 set_ball_visible(true) 的 show() 只会显出“看不见的空窗”（球“打不开”）。
    // 与 dock 的 startupHideTimer 同一套已验证机制；开球走 Rust 命令 show()，不再跑这段，故不会被误关。
    if (!loadSettings().ballEnabled) {
      window.setTimeout(() => {
        // 仅当仍为关闭态才自隐（本窗缓存不会随主窗开关而变，故 300ms 内用户来不及在别处开启，安全）
        if (!loadSettings().ballEnabled) {
          void getCurrentWindow().hide().catch(() => { /* 非 Tauri 环境 */ });
        }
      }, 300);
    }
  })();
});
onBeforeUnmount(() => {
  window.clearTimeout(hoverTimer);
  window.clearTimeout(closeTimer);
  window.removeEventListener("mousemove", onDragMove);
  window.removeEventListener("mouseup", onDragUp);
  unlistenFns.forEach((f) => f());
});
</script>

<template>
  <div class="ball-root" @mouseenter="onEnter" @mouseleave="onLeave">
    <!-- 悬浮球本体：可拖动 / 点击开合 dock；dock 是独立窗，不在这里画 -->
    <div class="ball" @mousedown="onBallDown">
      <img src="/logo.svg" alt="LifeTrack" draggable="false" />
    </div>
  </div>
</template>

<style>
/* 悬浮球整窗透出桌面：盖掉 global.css 给 body 铺的主题底色（不 scoped，只在本页加载） */
html, body { background: transparent !important; }
</style>

<style scoped>
.ball-root {
  position: fixed; inset: 0; display: grid; place-items: center;
  overflow: hidden; user-select: none;
}
.ball {
  width: 76px; height: 76px;
  display: grid; place-items: center; cursor: grab;
}
.ball:active { cursor: grabbing; }
.ball img {
  width: 56px; height: 56px; border-radius: 50%;
  background: var(--card);
  border: 1px solid var(--line-2);
  padding: 4px; opacity: .95; object-fit: contain;
  transition: opacity .18s ease, transform .18s ease;
}
.ball-root:hover .ball img { opacity: 1; transform: scale(1.06); }
</style>
