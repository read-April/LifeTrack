import { createApp } from "vue";
import App from "./App.vue";
import router from "./router";
import "./styles/global.css";
import { applyTheme, loadTheme } from "./utils/theme";
import { initPrefs } from "./utils/prefs";
import { purgeLegacyKeys } from "./utils/legacy";

const app = createApp(App);
app.use(router);

// 主题广播监听（跨窗实时跟随）：与本窗初始化无关，尽早挂上
import("@tauri-apps/api/event").then(({ listen }) => {
  void listen<string>("lt:theme", (e) => {
    applyTheme(e.payload === "dark" ? "dark" : "light");
  }).catch(() => { /* 非 Tauri 环境 */ });
}).catch(() => { /* 非 Tauri 环境 */ });

// 偏好改为从文件异步读取：先灌满内存缓存，再贴主题、再挂载
// —— 保证首帧主题正确，且组件里 loadSettings()/loadTheme() 同步读时缓存必已就绪
void initPrefs().finally(() => {
  applyTheme(loadTheme());
  // 清掉 SQLite 迁移遗留的 localStorage 死键（需在 initPrefs 从旧键迁移完之后再做）
  purgeLegacyKeys();
  // 同步本窗系统标题栏颜色
  import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
    getCurrentWindow().setTheme(loadTheme());
  });
  // 首条路由解析完再挂载：浮窗以 #/quick-note、#/focus、#/ball、#/ball-dock 加载，避免闪一下主窗外壳
  router.isReady().then(() => app.mount("#app"));
});
