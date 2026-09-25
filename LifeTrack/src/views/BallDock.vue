<script setup lang="ts">
/**
 * 悬浮球 dock（独立固定尺寸透明窗，label: ball-dock，尺寸 132×56，启动即建、常驻隐藏）
 * 由球页 hover 驱动：球 invoke(show_ball_dock) 把本窗摆到球旁并显形，再 emit("btd:open") 触发进场动画。
 * 本窗只被 show/hide + 定位，永不 resize —— 透明窗改尺寸会在 Windows 上重绘出矩形残影/抖动，规避之。
 * 交互：鼠标在本窗上 → emit("btd:enter")（球取消收起计时）；离开 → emit("btd:leave")（球续排收起）。
 * 两枚入口等价于托盘「随记 / 番茄钟」；点击后 invoke 对应命令并就地收起本窗。
 * 进/出场用 CSS 关键帧重启（transform-origin 按 dock 相对球的方位设定，从球那侧长出来）。
 */
import { ref, onMounted, onBeforeUnmount } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

const pill = ref<HTMLElement | null>(null);
const OUT_MS = 150;                 // 出场动画时长，跑完即收起
const FIRST_PAINT_MS = 300;         // 建窗初期留一次屏内透明首绘的时间，过了再自隐
const unlistenFns: Array<() => void> = [];
let hideTimer = 0;
let startupHideTimer = 0;
let openedOnce = false;

/** 重启一次性关键帧动画：先摘类、强制重排、再挂类 */
function restart(cls: "anim-in" | "anim-out") {
  const el = pill.value;
  if (!el) return;
  el.classList.remove("anim-in", "anim-out");
  void el.offsetWidth;
  el.classList.add(cls);
}
function playIn(side: "left" | "right") {
  openedOnce = true;
  window.clearTimeout(startupHideTimer);            // 首绘期内已被打开 → 不再自隐
  const el = pill.value;
  if (el) el.style.transformOrigin = side === "right" ? "right center" : "left center"; // 朝球那侧缩放
  window.clearTimeout(hideTimer);
  restart("anim-in");
}
function playOut() {
  restart("anim-out");
  window.clearTimeout(hideTimer);
  // 出场动画跑完 → 收起（hide；窗保留供复用）
  hideTimer = window.setTimeout(() => { void invoke("hide_ball_dock").catch(() => {}); }, OUT_MS);
}

async function act(cmd: string) {
  await invoke(cmd).catch(() => {});
  void emit("btd:leave").catch(() => {}); // 同步球：把它当作「已离开」走收起流程
  playOut();
}

onMounted(() => {
  void (async () => {
    try {
      unlistenFns.push(
        await listen<{ side: "left" | "right" }>("btd:open", (e) => playIn(e.payload?.side ?? "right")),
        await listen("btd:close", () => playOut()),
      );
    } catch { /* 非 Tauri 环境 */ }
  })();
  // 建窗时为屏幕内可见（只为拿一次透明首绘）；若这段时间内没被打开，就自行 hide 收起来
  startupHideTimer = window.setTimeout(() => {
    if (!openedOnce) void getCurrentWindow().hide().catch(() => {});
  }, FIRST_PAINT_MS);
});
onBeforeUnmount(() => {
  window.clearTimeout(hideTimer);
  window.clearTimeout(startupHideTimer);
  unlistenFns.forEach((f) => f());
});
</script>

<template>
  <div
    class="dock-root"
    @mouseenter="() => emit('btd:enter')"
    @mouseleave="() => emit('btd:leave')"
  >
    <div ref="pill" class="pill">
      <button class="btn" title="随记" @click="act('open_note')">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2.5 14 8 19.5 8" /><line x1="8.5" y1="13" x2="15.5" y2="13" /><line x1="8.5" y1="16.5" x2="13" y2="16.5" />
        </svg>
      </button>
      <span class="sep"></span>
      <button class="btn" title="番茄钟" @click="act('open_focus')">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="13" r="8" /><path d="M12 13V9" /><path d="M9 2.5h6" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style>
/* dock 整窗透出桌面：只保留胶囊本体，四角随圆角透明（不 scoped，只在本页加载） */
html, body { background: transparent !important; }
</style>

<style scoped>
.dock-root {
  position: fixed; inset: 0; display: grid; place-items: center;
  overflow: hidden; user-select: none;
}
/* 胶囊定尺寸 132×56 居中，四周留 16px 透明边（与球窗同构）：圆角/阴影都在窗内，不再贴窗边显矩形 */
/* 初始 opacity:0 作为兼容兼顾——未首次弹出前不可见；anim-in 的 fill 会接管为 1 */
.pill {
  width: 132px; height: 56px; opacity: 0;
  display: flex; align-items: center; justify-content: center; gap: 4px;
  background: color-mix(in srgb, var(--card) 90%, transparent); /* 与悬浮球环同款半透卡片，随主题变色，不至于一块死白 */
  border: 1px solid var(--line-2); border-radius: 999px;
}
.btn {
  width: 42px; height: 42px; border: none; border-radius: 50%; cursor: pointer;
  display: grid; place-items: center; padding: 0;
  background: transparent; color: var(--text-2);
  transition: background .15s ease, color .15s ease;
}
.btn:hover { background: var(--hover); color: var(--accent); }
.sep { width: 1px; height: 22px; background: var(--line-2); }

@keyframes dkin { from { opacity: 0; transform: scale(.62); } to { opacity: 1; transform: none; } }
@keyframes dkout { from { opacity: 1; transform: none; } to { opacity: 0; transform: scale(.62); } }
.pill.anim-in { animation: dkin .17s cubic-bezier(.2, .8, .3, 1) both; }
.pill.anim-out { animation: dkout .15s ease-in both; }
</style>
