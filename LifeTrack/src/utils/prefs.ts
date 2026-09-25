/**
 * 轻量偏好统一数据层：所有偏好集中在一份 trackbook.json（由 Rust get_prefs/set_prefs 读写）
 * - 同步读：组件仍用 loadSettings()/loadTheme()/readUi() 这类同步接口，靠启动时一次性 await 灌满内存缓存
 * - 免迁移：新增配置只需在 DEFAULTS 加一行；磁盘缺的键由深合并兜底，永不改库/改文件结构
 * - 首启迁移：偏好文件不存在时，从旧 localStorage（lt-settings、lt-theme、lt-ball 系列等）读一次并写盘、清旧键
 * - 浏览器兜底：非 Tauri 环境（纯前端 dev）invoke 会失败，退回 localStorage 单键 trackbook
 */

export type Theme = "light" | "dark";
export type CloseBehavior = "ask" | "minimize" | "quit";
export type BallSide = "left" | "right";

/** 悬浮球几何（自由态球心坐标 / 贴边侧） */
export interface BallGeom {
  docked: boolean;
  side: BallSide;
  x: number;
  y: number;
}

/** 界面状态：自动记住的 UI 态，非设置页可见项 */
export interface UiState {
  ballSide: BallSide;
  ballGeom: BallGeom | null;
  focusSize: string;
  noteKind: string;
  logMode: string;
  railOpen: boolean;
}

/** 一份完整偏好（camelCase，须与 Rust Prefs 逐字段一致） */
export interface Prefs {
  nickname: string;
  theme: Theme;
  closeBehavior: CloseBehavior;
  ballEnabled: boolean;
  // 库文件绝对路径：由 Rust 侧独占读写（set_db_location），前端只镜像、不修改（写回时 Rust 会保留磁盘值）
  dbPath: string | null;
  ui: UiState;
}

const DEFAULTS: Prefs = {
  nickname: "朋友",
  theme: "light",
  closeBehavior: "quit",
  ballEnabled: false,
  dbPath: null,
  ui: { ballSide: "right", ballGeom: null, focusSize: "md", noteKind: "生活", logMode: "log", railOpen: false },
};

// 内存缓存：initPrefs 灌满后供各组件同步读取（写操作即时更新它 + 异步落盘）
let cache: Prefs = cloneDefaults();

const LS_KEY = "trackbook";
const LEGACY_KEYS = [
  "lt-settings", "lt-theme", "lt-ball-side", "lt-ball-geom",
  "lt-focus-size", "lt-qn-kind", "lt-log-mode", "lt-rail-open",
];

function cloneDefaults(): Prefs {
  return { ...DEFAULTS, ui: { ...DEFAULTS.ui } };
}

/** 深合并：顶层浅合并 + ui 子对象单独浅合并（避免存了部分 ui 时丢掉其余默认） */
function mergeStored(base: Prefs, patch: Partial<Prefs> | null | undefined): Prefs {
  if (!patch || typeof patch !== "object") return base;
  const { ui, ...rest } = patch;
  return { ...base, ...rest, ui: { ...base.ui, ...(ui || {}) } };
}

/** 从旧版分散的 localStorage 键里拼出一份偏好（迁移/浏览器兜底共用） */
function readLegacy(): Partial<Prefs> {
  const out: Partial<Prefs> = {};
  const ui: Partial<UiState> = {};
  try {
    const s = localStorage.getItem("lt-settings");
    if (s) {
      const v = JSON.parse(s);
      if (typeof v?.nickname === "string") out.nickname = v.nickname;
      if (v?.closeBehavior) out.closeBehavior = v.closeBehavior;
      if (typeof v?.ballEnabled === "boolean") out.ballEnabled = v.ballEnabled;
    }
    const t = localStorage.getItem("lt-theme");
    if (t === "dark" || t === "light") out.theme = t;

    const bs = localStorage.getItem("lt-ball-side");
    if (bs === "left" || bs === "right") ui.ballSide = bs;
    const bg = localStorage.getItem("lt-ball-geom");
    if (bg) {
      try {
        const g = JSON.parse(bg);
        if (g && typeof g === "object") {
          ui.ballGeom = { docked: !!g.docked, side: g.side === "left" ? "left" : "right", x: Number(g.x) || 0, y: Number(g.y) || 0 };
        }
      } catch { /* ignore */ }
    }
    const fs = localStorage.getItem("lt-focus-size");
    if (fs) ui.focusSize = fs;
    const nk = localStorage.getItem("lt-qn-kind");
    if (nk) ui.noteKind = nk;
    const lm = localStorage.getItem("lt-log-mode");
    if (lm) ui.logMode = lm;
    const ro = localStorage.getItem("lt-rail-open");
    if (ro === "0" || ro === "1") ui.railOpen = ro === "1";
  } catch { /* ignore */ }
  if (Object.keys(ui).length) out.ui = ui as UiState; // 只拼了部分字段，mergeStored 会用默认补齐其余
  return out;
}

function clearLegacy() {
  try { LEGACY_KEYS.forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
}

/** 启动时调用一次：优先读 Rust 偏好文件；首次则迁移旧 localStorage；非 Tauri 退回 localStorage */
export async function initPrefs(): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const stored = await invoke<Prefs | null>("get_prefs");
    if (stored) {
      cache = mergeStored(cloneDefaults(), stored);
      return;
    }
    // 文件不存在 = 新体系首启：把旧 localStorage 的选择搬进来并落盘，随后清旧键
    cache = mergeStored(cloneDefaults(), readLegacy());
    await invoke("set_prefs", { prefs: cache });
    clearLegacy();
  } catch {
    // 非 Tauri（纯浏览器 dev）：用 localStorage 单键维持可用
    try {
      const raw = localStorage.getItem(LS_KEY);
      cache = mergeStored(cloneDefaults(), raw ? JSON.parse(raw) : readLegacy());
    } catch {
      cache = cloneDefaults();
    }
  }
}

/** 同步取全量偏好（拷贝，防外部直接改缓存） */
export function readPrefs(): Prefs {
  return { ...cache, ui: { ...cache.ui } };
}

/** 局部更新顶层偏好：即时刷新缓存 + 异步落盘（fire-and-forget，UI 不阻塞） */
export function writePrefs(patch: Partial<Prefs>): void {
  cache = mergeStored(cache, patch);
  void persist();
}

/** 同步取界面状态 */
export function readUi(): UiState {
  return { ...cache.ui };
}

/** 局部更新界面状态：即时刷新缓存 + 异步落盘 */
export function writeUi(patch: Partial<UiState>): void {
  cache = { ...cache, ui: { ...cache.ui, ...patch } };
  void persist();
}

async function persist() {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_prefs", { prefs: cache });
  } catch {
    try { localStorage.setItem(LS_KEY, JSON.stringify(cache)); } catch { /* ignore */ }
  }
}
