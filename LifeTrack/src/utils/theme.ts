/**
 * 主题数据层：浅色 / 深色，选择存进统一偏好层（trackbook.json），切换即时生效
 * 实现方式：只在 <html> 上打 data-theme 标记，具体配色全靠 global.css 里的 [data-theme="dark"] 覆盖
 * ——组件一律用 var(--token)，所以这里只管"翻牌"，不碰任何颜色值
 */
import { readPrefs, writePrefs, type Theme } from "./prefs";

export type { Theme };

export function loadTheme(): Theme {
  return readPrefs().theme;
}

/** 把主题写到根元素上（light 用 data-theme="light"，便于 CSS 需要时显式命中） */
export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  // 同步镜像一份到 localStorage：仅供 index.html 内联脚本下次开机首帧抢读防白闪（权威值仍以 trackbook.json 为准）
  try { localStorage.setItem("lt-theme-paint", t); } catch { /* 非浏览器环境忽略 */ }
}

export function setTheme(t: Theme) {
  writePrefs({ theme: t });
  applyTheme(t);
  // 同步本窗系统标题栏颜色（Tauri 2 DWM API）
  import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
    getCurrentWindow().setTheme(t);
  });
  // 广播给其它窗（随记/番茄钟/dock/球）：它们各自 listen("lt:theme") 后重贴 data-theme，实现跨窗实时跟随
  import("@tauri-apps/api/event")
    .then(({ emit }) => { void emit("lt:theme", t).catch(() => {}); })
    .catch(() => { /* 非 Tauri 环境 */ });
}
