<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { invoke } from "@tauri-apps/api/core";
import FootprintCard from "./components/FootprintCard.vue";
import ConfirmDialog from "./components/ConfirmDialog.vue";
import AboutDialog from "./components/AboutDialog.vue";
import SplashLogo from "./components/SplashLogo.vue";
import { askConfirm } from "./utils/confirm";
import { loadSettings } from "./utils/settings";
import { readUi, writeUi } from "./utils/prefs";

const route = useRoute();
const router = useRouter();

// 浮窗路由（meta.bare）：只渲染内容本体，侧栏/状态栏/开屏层全部跳过；
// main.ts 等 router.isReady 再挂载，首帧 meta 必准，不会闪一下主窗外壳
const bare = computed(() => !!route.meta.bare);

// 开屏覆盖层（学 MQTTX：单窗 + 一屏不透明底盖住整个界面，演完淡出）
// booting：层是否在场；bootFade：退场淡出中。冷启动即为 true，从首帧就遮住侧栏/顶栏/内容。
const booting = ref(true);
const bootFade = ref(false);

// "我的足迹"个人卡片浮层（点击状态栏头像弹出）
const footprintOpen = ref(false);
// 关于对话框
const aboutOpen = ref(false);

// 侧栏展开/折叠：默认折叠（仅图标，悬停显示文字），用户选择持久化
const railOpen = ref(readUi().railOpen);
function toggleRail() {
  railOpen.value = !railOpen.value;
  writeUi({ railOpen: railOpen.value });
}

function go(name: string) {
  router.push({ name });
}

// 托盘事件监听器，卸载时逐一注销
let unlistenFns: (() => void)[] = [];

onMounted(async () => {
  // 浮窗不挂开屏层、也不听主窗专属事件（专注/随记窗自己处理自己的）
  if (bare.value) return;
  // 覆盖层停留时长需盖住 SplashLogo 整段编舞（入场+流光+字标揭示约 2.3s）；降级偏好下缩短
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const hold = reduced ? 900 : 2600;        // 开始淡出
  window.setTimeout(() => (bootFade.value = true), hold);
  window.setTimeout(() => (booting.value = false), hold + 500); // 淡出 500ms 后摘除

  // Tauri API 延迟加载：纯浏览器 dev 下没有宿主，失败不影响页面主体
  try {
    const [{ listen }, { getCurrentWindow }] = await Promise.all([
      import("@tauri-apps/api/event"),
      import("@tauri-apps/api/window"),
    ]);
    const win = getCurrentWindow();
    // 托盘「设置」：唤主窗后由这里补路由跳转（窗口刚显示时监听器已就绪，无竞态）
    unlistenFns.push(await listen("tray:navigate", (e) => {
      if (e.payload === "settings") router.push({ name: "settings" });
    }));
    // 点 X 的行为读设置页单选（永久记忆）：最小化/退出直接执行；「每次询问」弹三选框（自绘 ConfirmDialog，禁原生弹窗）；退出走 quit_app 命令绕开关窗拦截
    unlistenFns.push(await win.onCloseRequested(async (ev) => {
      ev.preventDefault();
      const behavior = loadSettings().closeBehavior;
      if (behavior === "minimize") { await win.hide(); return; }
      if (behavior === "quit") { await invoke("quit_app"); return; }
      const r = await askConfirm({
        title: "关闭主窗口？",
        message: "最小化后应用常驻系统托盘，悬浮球与快捷唤起仍可用。",
        ok: "最小化到托盘",
        also: "退出应用",
        cancel: "取消",
      });
      if (r === "ok") await getCurrentWindow().hide();
      else if (r === "also") await invoke("quit_app");
    }));
  } catch { /* 非 Tauri 环境：无托盘/关闭拦截可用 */ }
});

onUnmounted(() => unlistenFns.forEach(fn => fn()));
</script>

<template>
  <!-- 浮窗路由：无边框小窗只要一个裸 router-view，壳层全部不走 -->
  <router-view v-if="bare" />
  <div v-else class="app" :class="{ 'rail-open': railOpen }">
    <!-- ============ 侧边导航栏 ============ -->
    <aside class="rail">
      <div class="rail-logo" title="LifeTrack" @click="go('dashboard')">
        <img src="/logo.svg" alt="LifeTrack logo" />
        <span class="rail-brand">LifeTrack</span>
      </div>

      <nav class="rail-nav">
        <button class="rail-btn" :class="{ on: route.name === 'dashboard' }" data-tip="仪表盘" @click="go('dashboard')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3.5" y="3.5" width="7" height="7" rx="2"/>
            <rect x="13.5" y="3.5" width="7" height="7" rx="2"/>
            <rect x="3.5" y="13.5" width="7" height="7" rx="2"/>
            <rect x="13.5" y="13.5" width="7" height="7" rx="2"/>
          </svg>
          <span class="rail-txt">仪表盘</span>
        </button>
        <button class="rail-btn" :class="{ on: route.name === 'timeline' }" data-tip="时间线" @click="go('timeline')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/>
          </svg>
          <span class="rail-txt">时间线</span>
        </button>
        <button class="rail-btn" :class="{ on: route.name === 'projects' }" data-tip="目标" @click="go('projects')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
          </svg>
          <span class="rail-txt">目标</span>
        </button>
        <button class="rail-btn" :class="{ on: route.name === 'logs' }" data-tip="随记" @click="go('logs')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2.5 14 8 19.5 8"/>
          </svg>
          <span class="rail-txt">随记</span>
        </button>
      </nav>

      <div class="rail-foot">
        <button class="rail-btn" :class="{ on: route.name === 'settings' }" data-tip="设置" @click="go('settings')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
          <span class="rail-txt">设置</span>
        </button>
        <button class="rail-btn" :data-tip="railOpen ? '折叠侧栏' : '展开侧栏'" @click="toggleRail">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3.5" y="3.5" width="17" height="17" rx="3"/><line x1="9.5" y1="3.5" x2="9.5" y2="20.5"/>
          </svg>
          <span class="rail-txt">{{ railOpen ? "折叠侧栏" : "展开侧栏" }}</span>
        </button>
      </div>
    </aside>

    <!-- ============ 主区（顶部状态栏 + 内容） ============ -->
    <div class="main">
      <!-- 状态栏：原生标题栏下方，右侧为关于入口 + 头像 -->
      <div class="statusbar">
        <button class="statusbar-info" title="关于" @click="aboutOpen = true">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
          </svg>
        </button>
        <div class="fp-wrap">
          <button class="rail-avatar" title="我的足迹" @click="footprintOpen = !footprintOpen">
            <svg width="24" height="24" viewBox="0 0 20 20" fill="currentColor">
              <rect x="1" y="1" width="5" height="5" rx="1" opacity=".15"/>
              <rect x="7" y="1" width="5" height="5" rx="1" opacity=".35"/>
              <rect x="13" y="1" width="5" height="5" rx="1" opacity=".55"/>
              <rect x="1" y="7" width="5" height="5" rx="1" opacity=".25"/>
              <rect x="7" y="7" width="5" height="5" rx="1" opacity=".65"/>
              <rect x="13" y="7" width="5" height="5" rx="1" opacity=".85"/>
              <rect x="1" y="13" width="5" height="5" rx="1" opacity=".4"/>
              <rect x="7" y="13" width="5" height="5" rx="1" opacity=".7"/>
              <rect x="13" y="13" width="5" height="5" rx="1"/>
            </svg>
          </button>
          <template v-if="footprintOpen">
            <div class="fp-backdrop" @click="footprintOpen = false"></div>
            <div class="fp-pop"><FootprintCard @close="footprintOpen = false" /></div>
          </template>
        </div>
      </div>
      <main class="content">
        <router-view />
      </main>
    </div>

    <!-- 全局确认框：代替浏览器原生 confirm，主题色自绘 -->
    <ConfirmDialog />
    <!-- 关于对话框 -->
    <AboutDialog :open="aboutOpen" @close="aboutOpen = false" />

    <!-- 开屏覆盖层：不透明铺满整窗，遮住侧栏/顶栏/内容；演完淡出后从 DOM 摘除 -->
    <div v-if="booting" class="lt-boot" :class="{ 'lt-boot-out': bootFade }">
      <SplashLogo />
    </div>
  </div>
</template>

<style scoped>
/* 开屏覆盖层：铺满视口、主题底色、最高层级，把整个应用盖住；退场只改透明度 */
.lt-boot {
  position: fixed; inset: 0; z-index: 9999;
  display: grid; place-items: center;
  background: var(--bg);
  transition: opacity .5s ease;
}
.lt-boot-out { opacity: 0; pointer-events: none; }

.fp-wrap { position: relative; }
.rail-avatar { border: none; }
.fp-backdrop { position: fixed; inset: 0; z-index: 40; }
/* 头像已迁到右上角状态栏：浮层改为向下、右对齐弹出（原侧栏底部是向左上弹出） */
.fp-pop {
  position: absolute; right: 0; top: calc(100% + 10px); z-index: 41;
  animation: fp-in .18s ease;
}
@keyframes fp-in {
  from { opacity: 0; transform: translateY(-6px); }
  to { opacity: 1; transform: translateY(0); }
}

/* 窄屏（平板/手机）：浮层改居中弹窗形态。!important 压过默认态的左缘定位（scoped 同特异度靠后者优先） */
@media (max-width: 1023px) {
  .fp-pop {
    position: fixed !important; left: 50% !important; top: 50% !important; bottom: auto !important;
    transform: translate(-50%, -50%);
  }
}

/* 品牌名（展开态显示）：几何恒定——宽度由 flex 自动压缩到 0，图标位置由 .rail-logo 的固定 padding-left 决定，
   所以展开/折叠只有透明度变化，不会带动 logo 图标 */
.rail-brand {
  font-size: 14.5px; font-weight: 700; color: var(--text-1); letter-spacing: -.3px;
  white-space: nowrap; overflow: hidden; min-width: 0; opacity: 0;
  transition: opacity .15s ease .05s;
}
.app.rail-open .rail-brand { opacity: 1; }
/* 窄屏强制折叠：品牌名随 rail-txt 一起隐藏 */
@media (max-width: 1023px) {
  .app.rail-open .rail-brand { opacity: 0; }
}

/* 折叠态：悬停出现右侧文字气泡 */
.app:not(.rail-open) .rail-btn[data-tip]:hover::after,
.app:not(.rail-open) .rail-avatar[data-tip]:hover::after {
  content: attr(data-tip);
  position: absolute; left: calc(100% + 14px); top: 50%; transform: translateY(-50%);
  background: #1F2937; color: #fff; font-size: 11.5px; font-weight: 500; letter-spacing: .3px;
  padding: 5px 10px; border-radius: 7px; white-space: nowrap;
  pointer-events: none; z-index: 60;
  animation: tip-in .15s ease .25s both;
}
@keyframes tip-in {
  from { opacity: 0; transform: translateY(-50%) translateX(-4px); }
  to { opacity: 1; transform: translateY(-50%) translateX(0); }
}
</style>
