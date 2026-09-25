<script setup lang="ts">
/**
 * 设置页：一行式「左标题+说明 / 右控件」的专业布局，按通用 / 关于与更新 / 系统集成 / 数据库分组
 * - 通用：昵称、主题（下拉）、桌面悬浮球（开关）
 * - 关于与更新：检查更新（从更新服务器检测新版本）
 * - 系统集成：关闭主窗口行为（下拉，即选即存）
 * - 数据库：当前库文件绝对路径（Rust get_db_conn 解析），浏览可改指任意 .db，写指针后重启生效
 * 悬浮球开关：saveSettings 后 invoke set_ball_visible 实时显隐球窗（无需重启）
 */
import { computed, onMounted, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { askConfirm } from "../utils/confirm";
import { type Theme, loadTheme, setTheme } from "../utils/theme";
import { type CloseBehavior, loadSettings, saveSettings } from "../utils/settings";

const settings = ref(loadSettings());
const theme = ref<Theme>(loadTheme());

/** 关窗行为选项：与 App.vue 关窗拦截读的 closeBehavior 同一套 key */
const CLOSE_OPTIONS: { value: CloseBehavior; label: string; desc: string }[] = [
  { value: "ask", label: "每次询问", desc: "弹三选框，由你决定最小化还是退出" },
  { value: "minimize", label: "最小化到托盘", desc: "点 X 直接收进托盘，应用后台运行，悬浮球仍可用" },
  { value: "quit", label: "退出应用", desc: "点 X 直接结束进程，托盘图标一并消失" },
];
/** 关窗行副标题随当前选项动态展示，信息不丢失 */
const closeDesc = computed(
  () => CLOSE_OPTIONS.find((o) => o.value === settings.value.closeBehavior)?.desc ?? "",
);

// 数据库真实路径：运行时向 Rust 索取连接串（sqlite:<绝对路径>），去掉前缀仅展示文件路径
const realPath = ref("正在定位数据库文件…");
const browsing = ref(false);
onMounted(async () => {
  try {
    const conn = await invoke<string>("get_db_conn");
    realPath.value = conn.split(":").slice(1).join(":") || conn;
  } catch {
    // 非 Tauri 运行时（纯浏览器 dev）无法解析，命令会 reject
    realPath.value = "应用数据目录下的 lifetrack.db（需桌面运行时才能解析绝对路径）";
  }
});

// 浏览选择数据库文件：默认定位当前库目录 → 写指针 → 确认后重启（不搬迁数据）
async function browseDb() {
  if (browsing.value) return;
  browsing.value = true;
  try {
    let defaultPath: string | undefined;
    try {
      defaultPath = await invoke<string>("get_db_dir");
    } catch {
      defaultPath = undefined;
    }
    const selected = await open({
      multiple: false,
      directory: false,
      defaultPath,
      filters: [{ name: "SQLite 数据库", extensions: ["db", "sqlite", "sqlite3"] }],
    });
    // 取消选择：open 返回 null，什么都不做
    if (!selected || typeof selected !== "string") return;

    try {
      // 返回 false = 选中的就是当前在用文件，Rust 未写指针，这里静默跳过即可
      const changed = await invoke<boolean>("set_db_location", { path: selected });
      if (!changed) return;
    } catch (e) {
      await askConfirm({ title: "切换失败", message: `无法切换到该位置：\n${String(e)}`, ok: "知道了", cancel: "关闭", danger: true });
      return;
    }

    const result = await askConfirm({
      title: "需要重启",
      message: `数据库位置已设为：\n${selected}\n\n切换需重启应用后生效，是否立即重启？`,
      ok: "立即重启",
      cancel: "稍后手动重启",
    });
    if (result === "ok") {
      // restart 会替换进程，invoke 不会 resolve，属预期
      await invoke("restart_app");
    } else {
      realPath.value = selected; // 未重启，先就地回显待生效的新路径
    }
  } finally {
    browsing.value = false;
  }
}

// 昵称变化自动保存（去首尾空格）
watch(() => settings.value.nickname, (v) => {
  settings.value.nickname = v.trim();
  saveSettings(settings.value);
});
// 关窗行为即选即存
watch(() => settings.value.closeBehavior, () => saveSettings(settings.value));
// 悬浮球开关：持久化 + 实时显隐球窗（非 Tauri 环境命令不存在，忽略即可）
watch(() => settings.value.ballEnabled, (v) => {
  saveSettings(settings.value);
  invoke("set_ball_visible", { visible: v }).catch(() => { /* 浏览器预览无宿主 */ });
});

function onThemeChange(e: Event) {
  const val = (e.target as HTMLSelectElement).value as Theme;
  theme.value = val;
  setTheme(val);
}

// ---------- 检查更新 ----------
// 插件已在 Rust 侧注册、npm 包已装；懒加载避免首屏多打一块 bundle，非打包环境失败回落提示
// 发现新版本时弹对话框展示版本对比与更新记录；已是最新 / 失败仍走行内提示，不打扰
type UpdateStatus = "idle" | "checking" | "found" | "latest" | "error";
const updateStatus = ref<UpdateStatus>("idle");
const updateMsg = ref("");

const upOpen = ref(false);          // 更新对话框开关
const upInfo = ref({ current: "", latest: "", notes: "" });
const upPhase = ref<"idle" | "download" | "install">("idle");  // Windows 下装完 MSI 会自动重启，无需手动 relaunch
const upPct = ref(0);               // 下载百分比（-1 = 服务端未报总长）
const upDoneBytes = ref(0);

// 只声明用到的字段，避开动态 import 的类型解析噪声
type UpdateHandle = {
  version: string;
  currentVersion: string;
  body?: string;
  downloadAndInstall: (cb?: (e: UpEvent) => void) => Promise<void>;
};
type UpEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

async function checkUpdate() {
  updateStatus.value = "checking";
  updateMsg.value = "";
  try {
    const mod = await import("@tauri-apps/plugin-updater");
    const update = (await mod.check()) as UpdateHandle | null;
    if (update) {
      updateStatus.value = "found";
      upInfo.value = { current: `v${update.currentVersion}`, latest: `v${update.version}`, notes: update.body || "" };
      upPhase.value = "idle";
      upPct.value = 0;
      upDoneBytes.value = 0;
      upOpen.value = true;
    } else {
      updateStatus.value = "latest";
      updateMsg.value = "已是最新版本";
    }
  } catch (e) {
    // 非 Tauri 环境、未发过 Release（404）或网络不通，把真实原因带出来便于区分
    updateStatus.value = "error";
    updateMsg.value = `检查失败：${String(e).slice(0, 60)}`;
  }
}

// 没写 notes 时兜底跳 Release 页看完整更新记录
async function openReleasePage() {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl("https://github.com/read-April/LifeTrack/releases/latest");
  } catch { /* 浏览器预览环境或插件异常，静默 */ }
}

// 下载并安装：passive 模式下 MSI 静默替换，Windows 下装完会自动退出并重启应用
async function doUpdate() {
  if (upPhase.value !== "idle") return;
  try {
    const mod = await import("@tauri-apps/plugin-updater");
    const update = (await mod.check()) as UpdateHandle | null;
    if (!update) { updateMsg.value = "版本已变化，请重新检查"; return; }
    let total = -1;
    upPhase.value = "download";
    await update.downloadAndInstall((e: UpEvent) => {
      if (e.event === "Started") total = e.data.contentLength ?? -1;
      else if (e.event === "Progress") {
        upDoneBytes.value += e.data.chunkLength;
        upPct.value = total > 0 ? Math.min(99, Math.floor((upDoneBytes.value / total) * 100)) : -1;
      }
      else if (e.event === "Finished") { upPct.value = 100; upPhase.value = "install"; }
    });
  } catch (e) {
    upPhase.value = "idle";
    updateMsg.value = `更新失败：${String(e).slice(0, 60)}`;
  }
}
</script>

<template>
  <div>
    <div class="hello">
      <h1>设置</h1>
      <p>外观偏好与数据库位置在这里。</p>
    </div>

    <!-- ============ 通用 ============ -->
    <section class="set-group">
      <div class="grp-title">通用</div>

      <div class="set-row">
        <div class="set-main">
          <div class="set-name">昵称</div>
          <div class="set-desc">用于首页问候语和头像显示</div>
        </div>
        <div class="set-aside">
          <input class="text-input" v-model="settings.nickname" type="text" placeholder="你的名字" maxlength="20" />
        </div>
      </div>

      <div class="set-row">
        <div class="set-main">
          <div class="set-name">主题</div>
          <div class="set-desc">浅色 / 深色，即时生效并记住选择</div>
        </div>
        <div class="set-aside">
          <select class="sel" :value="theme" @change="onThemeChange">
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </div>
      </div>

      <div class="set-row">
        <div class="set-main">
          <div class="set-name">桌面悬浮球</div>
          <div class="set-desc">在桌面显示可拖动的快捷球，一键唤起随记与番茄钟</div>
        </div>
        <div class="set-aside">
          <label class="switch" :title="settings.ballEnabled ? '已开启' : '已关闭'">
            <input type="checkbox" v-model="settings.ballEnabled" />
            <span class="track"></span>
          </label>
        </div>
      </div>
    </section>

    <!-- ============ 关于与更新 ============ -->
    <section class="set-group">
      <div class="grp-title">关于与更新</div>

      <div class="set-row">
        <div class="set-main">
          <div class="set-name">检查更新</div>
          <div class="set-desc">从更新服务器检测是否有新版本可用</div>
        </div>
        <div class="set-aside update-aside">
          <span v-if="updateMsg" class="update-msg" :class="updateStatus">{{ updateMsg }}</span>
          <button class="update-btn" :disabled="updateStatus === 'checking'" @click="checkUpdate">
            <svg v-if="updateStatus !== 'checking'" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
            </svg>
            <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" class="spin">
              <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>
            {{ updateStatus === "checking" ? "检查中…" : "检查更新" }}
          </button>
        </div>
      </div>
    </section>

    <!-- ============ 系统集成 ============ -->
    <section class="set-group">
      <div class="grp-title">系统集成</div>

      <div class="set-row">
        <div class="set-main">
          <div class="set-name">关闭主窗口时</div>
          <div class="set-desc">{{ closeDesc }}</div>
        </div>
        <div class="set-aside">
          <select class="sel" v-model="settings.closeBehavior">
            <option v-for="opt in CLOSE_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </div>
      </div>
    </section>

    <!-- ============ 数据库 ============ -->
    <section class="set-group">
      <div class="grp-title">数据库</div>

      <div class="set-row stack">
        <div class="set-main">
          <div class="set-name">数据文件位置</div>
          <div class="set-desc">数据已存入本地 SQLite 单文件，完全离线；备份或换机直接复制该文件即可</div>
        </div>
        <div class="path-line">
          <input class="path-input" :value="realPath" type="text" readonly :title="realPath" />
          <button class="browse-btn" type="button" title="浏览选择数据库文件" :disabled="browsing" @click="browseDb">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3l1.2 1.4h4.3A1.5 1.5 0 0 1 13 5.9v5.6A1.5 1.5 0 0 1 11.5 13h-8A1.5 1.5 0 0 1 2 11.5V4.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
        <p class="note">点右侧浏览可选择任意位置的 <code>.db</code> 文件；切换后需重启生效，应用不会自动搬迁数据，请自行移动文件。</p>
      </div>
    </section>
  </div>

  <!-- 更新对话框：版本对比 + 更新记录 + 下载进度（passive 静默安装） -->
  <Teleport to="body">
    <Transition name="ud">
      <div v-if="upOpen" class="ud-back" @click.self="upPhase === 'idle' && (upOpen = false)">
        <div class="ud-card" role="dialog" aria-modal="true">
          <div class="ud-head">
            <span class="ud-ico">↑</span>
            <div class="ud-title">发现新版本</div>
          </div>
          <div class="ud-ver">
            <span class="ud-cur">{{ upInfo.current }}</span>
            <span class="ud-arrow">→</span>
            <span class="ud-new">{{ upInfo.latest }}</span>
          </div>
          <div class="ud-notes">
            <div class="ud-notes-title">更新内容</div>
            <p v-if="upInfo.notes" class="ud-notes-body">{{ upInfo.notes }}</p>
            <p v-else class="ud-notes-empty">本次更新暂无内嵌说明，<a class="ud-link" @click="openReleasePage">查看 Release 页面 →</a></p>
          </div>
          <div v-if="upPhase !== 'idle'" class="ud-prog">
            <div class="ud-bar"><div class="ud-bar-fill" :class="{ pulse: upPct < 0 }" :style="{ width: (upPct >= 0 ? upPct : 60) + '%' }"></div></div>
            <div class="ud-prog-tx">{{ upPhase === 'download' ? (upPct >= 0 ? `下载中 ${upPct}%` : "下载中…") : "安装中，应用即将重启…" }}</div>
          </div>
          <div class="ud-foot">
            <button class="ud-ghost" :disabled="upPhase !== 'idle'" @click="upOpen = false">稍后再说</button>
            <button class="ud-main" :disabled="upPhase !== 'idle'" @click="doUpdate">
              {{ upPhase === 'idle' ? "立即更新" : upPhase === 'download' ? "下载中…" : "安装中…" }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 分组卡片：一个小标题 + 若干行，行间以细分隔线，右缘留控件位 */
.set-group {
  background: var(--card); border: 1px solid var(--line); border-radius: 12px;
  padding: 4px 18px 8px; margin-bottom: 16px;
}
.grp-title {
  font-size: 11.5px; font-weight: 700; letter-spacing: .5px; color: var(--text-3);
  padding: 12px 0 2px;
}

/* 一行：左标题+说明，右控件；垂直居中，栅格天然对齐 */
.set-row {
  display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 16px;
  padding: 14px 0; border-top: 1px solid var(--line);
}
.set-row.stack { grid-template-columns: 1fr; gap: 10px; }

.set-name { font-size: 13px; font-weight: 600; color: var(--text-1); }
.set-desc { font-size: 12px; color: var(--text-3); margin-top: 3px; line-height: 1.5; }
.set-aside { display: flex; align-items: center; justify-content: flex-end; }

.text-input,
.path-input {
  border: 1px solid var(--line-2); border-radius: 8px; background: var(--field);
  padding: 7px 12px; font-size: 12.5px; font-family: inherit; color: var(--text-1);
  outline: none; transition: border-color .15s ease;
}
.text-input { width: 200px; max-width: 50vw; }
.text-input:focus { border-color: var(--accent); }
.text-input::placeholder { color: var(--text-3); }
.path-input[readonly] { color: var(--text-2); cursor: default; }

.sel {
  border: 1px solid var(--line-2); background: var(--field); border-radius: 8px;
  font-size: 12.5px; padding: 7px 28px 7px 12px; color: var(--text-1); cursor: pointer;
  font-family: inherit; outline: none; appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%238C93A3' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 10px center;
}
.sel:focus { border-color: var(--accent); }

/* 开关：隐藏原生 checkbox，自绘滑轨跟随主题色 */
.switch { position: relative; display: inline-block; width: 40px; height: 22px; flex: none; }
.switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.track {
  position: absolute; inset: 0; cursor: pointer; border-radius: 999px;
  background: var(--line-2); transition: background .18s ease;
}
.track::before {
  content: ""; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px;
  background: #fff; border-radius: 50%; box-shadow: 0 1px 2px rgba(0, 0, 0, .25);
  transition: transform .18s ease;
}
.switch input:checked + .track { background: var(--accent); }
.switch input:checked + .track::before { transform: translateX(18px); }

.path-line { display: flex; align-items: center; gap: 8px; }
.path-input { flex: 1; min-width: 0; }
.browse-btn {
  flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
  width: 34px; height: 32px; border: 1px solid var(--line-2); border-radius: 8px;
  background: var(--field); color: var(--text-2); cursor: pointer;
  transition: border-color .15s ease, color .15s ease;
}
.browse-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.browse-btn:disabled { opacity: .55; cursor: default; }

.note { font-size: 11.5px; color: var(--text-3); line-height: 1.6; }
.note code { background: var(--hover); padding: 1px 5px; border-radius: 4px; font-size: 11px; }

/* 检查更新：状态文案 + 按钮，靠右对齐 */
.update-aside { gap: 10px; }
.update-msg { font-size: 11.5px; color: var(--text-3); }
.update-msg.found { color: var(--accent-dark); font-weight: 600; }
.update-msg.latest { color: var(--accent-dark); }
.update-btn {
  border: 1px solid var(--line-2); background: var(--field); border-radius: 8px;
  font-size: 12px; font-weight: 600; font-family: inherit; color: var(--text-2);
  padding: 7px 14px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
  transition: border-color .15s ease, color .15s ease;
}
.update-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.update-btn:disabled { opacity: .5; cursor: default; }
.spin { animation: spin .8s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

/* 更新对话框 */
.ud-back { position: fixed; inset: 0; z-index: 200; padding: 16px; display: grid; place-items: center; background: rgba(26,29,33,.32); backdrop-filter: blur(3px); }
.ud-card { width: min(420px, 100%); box-sizing: border-box; background: var(--card); border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 18px 48px rgba(26,29,33,.18); padding: 20px 20px 16px; }
.ud-head { display: flex; align-items: center; gap: 10px; }
.ud-ico { width: 28px; height: 28px; border-radius: 9px; background: var(--accent-soft); color: var(--accent-dark); display: grid; place-items: center; font-size: 15px; font-weight: 700; line-height: 1; }
.ud-title { font-size: 14px; font-weight: 700; color: var(--text-1); letter-spacing: -.2px; }
.ud-ver { display: flex; align-items: baseline; gap: 10px; margin: 16px 0 2px; font-variant-numeric: tabular-nums; }
.ud-cur { font-size: 13px; color: var(--text-3); }
.ud-arrow { color: var(--text-3); font-size: 13px; }
.ud-new { font-size: 17px; font-weight: 700; color: var(--accent-dark); }
.ud-notes { margin-top: 12px; }
.ud-notes-title { font-size: 12px; font-weight: 600; color: var(--text-2); margin-bottom: 6px; }
.ud-notes-body { margin: 0; font-size: 12px; line-height: 1.75; color: var(--text-2); white-space: pre-line; word-break: break-word; max-height: 180px; overflow: auto; }
.ud-notes-empty { margin: 0; font-size: 12px; line-height: 1.7; color: var(--text-3); }
.ud-link { color: var(--accent-dark); cursor: pointer; font-weight: 600; }
.ud-link:hover { text-decoration: underline; }
.ud-prog { margin-top: 14px; }
.ud-bar { height: 6px; border-radius: 999px; background: var(--hover); overflow: hidden; }
.ud-bar-fill { height: 100%; border-radius: 999px; background: var(--accent); transition: width .25s ease; }
.ud-bar-fill.pulse { animation: udp 1.1s ease-in-out infinite; }
@keyframes udp { 0% { transform: translateX(-100%); } 100% { transform: translateX(267%); } }
.ud-prog-tx { margin-top: 6px; font-size: 11.5px; color: var(--text-3); }
.ud-foot { display: flex; gap: 10px; margin-top: 18px; }
.ud-foot button { flex: 1; border: 1px solid transparent; border-radius: 10px; padding: 9px 14px; cursor: pointer; font-size: 12.5px; font-weight: 600; font-family: inherit; transition: background-color .15s ease, color .15s ease; }
.ud-ghost { background: none; color: var(--text-3); }
.ud-ghost:hover:not(:disabled) { color: var(--text-2); }
.ud-main { background: var(--accent); color: #fff; box-shadow: 0 2px 8px rgba(23,161,125,.28); }
.ud-main:hover:not(:disabled) { background: var(--accent-dark); }
.ud-foot button:disabled { opacity: .5; cursor: default; }
.ud-enter-active, .ud-leave-active { transition: opacity .16s ease; }
.ud-enter-from, .ud-leave-to { opacity: 0; }
</style>
