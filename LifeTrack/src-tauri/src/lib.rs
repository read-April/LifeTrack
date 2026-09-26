// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_sql::{Builder, Migration, MigrationKind};

/// 指针文件：单行纯文本，存自定义库文件的绝对路径；缺失即用默认 <config_dir>/lifetrack.db
const POINTER_FILE: &str = "db_location.txt";
/// 默认库文件名（无指针时落在 app config 目录下）
const DEFAULT_DB_NAME: &str = "lifetrack.db";
/// 偏好设置文件名：一份 JSON 装下全部轻量偏好（与库路径指针分开，因它必须先于开库被读到）
const PREFS_FILE: &str = "trackbook.json";

/// 启动时解析出的路径状态，供各命令复用（config 目录 + 迁移注册键所用的连接串）
struct AppPaths {
    config_dir: PathBuf,
    conn: String,
}
static APP_PATHS: OnceLock<AppPaths> = OnceLock::new();

/// 计算 app config 目录，与 Tauri app_config_dir 对齐（Windows: %APPDATA%\<identifier>）
fn config_dir_for(identifier: &str) -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(identifier)
}

/// 解析当前库文件绝对路径：优先 trackbook.json 的 dbPath；其次旧 db_location.txt（迁移兜底、不写回）；再默认目录下的 lifetrack.db
fn resolve_db_file(config_dir: &Path) -> PathBuf {
    if let Some(p) = load_prefs_sync(config_dir).db_path {
        let t = p.trim();
        if !t.is_empty() {
            return PathBuf::from(t);
        }
    }
    if let Ok(raw) = std::fs::read_to_string(config_dir.join(POINTER_FILE)) {
        let p = raw.trim();
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    config_dir.join(DEFAULT_DB_NAME)
}

/// 由库文件绝对路径拼连接串：sqlite:<绝对路径>
/// 插件 path_mapper 用 PathBuf::push，Windows 下绝对路径会整体替换 config 目录，故能指向任意位置
fn conn_for(db_file: &Path) -> String {
    format!("sqlite:{}", db_file.display())
}

/// 返回当前连接串：JS 侧 Database.load 必须用它，与 Rust 注册迁移的键逐字一致
#[tauri::command]
fn get_db_conn() -> Result<String, String> {
    APP_PATHS
        .get()
        .map(|s| s.conn.clone())
        .ok_or_else(|| "数据库路径尚未初始化".to_string())
}

/// 返回当前库文件所在目录（供文件选择框 defaultPath 默认定位）
#[tauri::command]
fn get_db_dir() -> Result<String, String> {
    let paths = APP_PATHS.get().ok_or_else(|| "数据库路径尚未初始化".to_string())?;
    let db_file = resolve_db_file(&paths.config_dir);
    let dir = db_file
        .parent()
        .map(|d| d.display().to_string())
        .unwrap_or_else(|| paths.config_dir.display().to_string());
    Ok(dir)
}

/// 写入新的库文件绝对路径指针；仅落盘，需重启方生效（不复制/搬迁任何数据）。
/// 返回 false 表示选中的就是当前在用文件（规范化比较），未写指针，前端据此跳过重启提示。
#[tauri::command]
fn set_db_location(path: String) -> Result<bool, String> {
    let paths = APP_PATHS.get().ok_or_else(|| "数据库路径尚未初始化".to_string())?;
    let trimmed = path.trim();
    let candidate = PathBuf::from(trimmed);

    // 校验一：扩展名必须是常见 sqlite 库文件，避免误指向无关文件
    let ext_ok = candidate
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| matches!(e.to_ascii_lowercase().as_str(), "db" | "sqlite" | "sqlite3"))
        .unwrap_or(false);
    if !ext_ok {
        return Err(format!("请选择 .db / .sqlite 数据库文件：{trimmed}"));
    }

    // 校验二：父目录必须已存在（不替你建目录，避免选错地方却静默成功）
    let parent = candidate
        .parent()
        .ok_or_else(|| "无法解析目标所在目录".to_string())?;
    if !parent.exists() {
        return Err(format!("目标目录不存在：{}", parent.display()));
    }

    // 选的就是当前在用文件 → 什么都不做（canonicalize 统一大小写/分隔符/相对绝对写法差异）
    if same_file(&resolve_db_file(&paths.config_dir), &candidate) {
        return Ok(false);
    }

    std::fs::create_dir_all(&paths.config_dir).map_err(|e| e.to_string())?;
    // 库路径并入 trackbook.json 的 dbPath（读-改-写，保留其余偏好）；顺带删除旧指针文件，退役单文件方案
    let mut p = load_prefs_sync(&paths.config_dir);
    p.db_path = Some(trimmed.to_string());
    let s = serde_json::to_string_pretty(&p).map_err(|e| e.to_string())?;
    std::fs::write(prefs_path(&paths.config_dir), s.as_bytes()).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(paths.config_dir.join(POINTER_FILE));
    Ok(true)
}

/// 规范化比较两个路径是否指向同一文件；任一不存在（无法 canonicalize）则视为不同
fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

/// 重启应用（AppHandle::restart 返回 !，进程被替换，JS 侧 invoke 不会 resolve）
#[tauri::command]
fn restart_app(app: AppHandle) {
    app.restart();
}

/// 「退出应用」确认后真正结束进程（app.exit 不经关闭拦截，托盘/确认框两条路都走它）
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// 轻量偏好：全部字段有默认值；JSON 用 camelCase 与前端对齐。
/// `#[serde(default)]` 使“磁盘缺哪个键就用默认”→ 新增配置无需任何迁移，旧文件照用。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    pub nickname: String,
    pub theme: String,
    pub close_behavior: String,
    pub ball_enabled: bool,
    pub db_path: Option<String>,
    pub ui: UiState,
}

/// 界面状态（自动记住的 UI 态，非设置页可见项）：与偏好同存一份 trackbook.json，但单独成组便于日后区分同步
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct UiState {
    pub ball_side: String,
    pub ball_geom: Option<BallGeom>,
    pub focus_size: String,
    pub note_kind: String,
    pub log_mode: String,
    pub rail_open: bool,
}

/// 悬浮球几何：是否贴边 / 贴哪侧 / 自由态球心坐标
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BallGeom {
    pub docked: bool,
    pub side: String,
    pub x: f64,
    pub y: f64,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs {
            nickname: "朋友".into(),
            theme: "light".into(),
            close_behavior: "minimize".into(),
            ball_enabled: false,
            db_path: None,
            ui: UiState::default(),
        }
    }
}

impl Default for UiState {
    fn default() -> Self {
        UiState {
            ball_side: "right".into(),
            ball_geom: None,
            focus_size: "md".into(),
            note_kind: "生活".into(),
            log_mode: "log".into(),
            rail_open: false,
        }
    }
}

fn prefs_path(dir: &Path) -> PathBuf {
    dir.join(PREFS_FILE)
}

/// 同步读偏好（启动解析/内部命令用）：文件缺失或解析失败 → 全默认。与 get_prefs 命令的区别是这里返回兜底值而非 Option
fn load_prefs_sync(dir: &Path) -> Prefs {
    if let Ok(raw) = std::fs::read_to_string(prefs_path(dir)) {
        if let Ok(p) = serde_json::from_str::<Prefs>(&raw) {
            return p;
        }
    }
    Prefs::default()
}

/// 读偏好文件；不存在/解析失败 → None（前端据此判断是否首次、要不要从旧 localStorage 迁移）
#[tauri::command]
fn get_prefs() -> Option<Prefs> {
    let paths = APP_PATHS.get()?;
    let raw = std::fs::read_to_string(prefs_path(&paths.config_dir)).ok()?;
    serde_json::from_str::<Prefs>(&raw).ok()
}

/// 整份写回偏好文件（pretty 便于人读）；建目录兜底
#[tauri::command]
fn set_prefs(prefs: Prefs) -> Result<(), String> {
    let paths = APP_PATHS.get().ok_or_else(|| "路径未初始化".to_string())?;
    std::fs::create_dir_all(&paths.config_dir).map_err(|e| e.to_string())?;
    // dbPath 由 Rust 独占（set_db_location 写）：前端整份写回时保留磁盘既有值，杜绝被前端默认清掉
    let mut prefs = prefs;
    prefs.db_path = load_prefs_sync(&paths.config_dir).db_path;
    let s = serde_json::to_string_pretty(&prefs).map_err(|e| e.to_string())?;
    std::fs::write(prefs_path(&paths.config_dir), s.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

/// 桌面专属的系统层能力：托盘菜单、悬浮球、两个无边框浮窗、番茄钟状态同步。
/// 整模块 cfg(desktop) 门控，与跨平台依赖表里的插件收口配套。
#[cfg(desktop)]
mod desk {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::TrayIconBuilder;
    use tauri::window::Color;
    use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
    use tauri_plugin_notification::NotificationExt;

    /// 浮窗 / 悬浮球 label：与 capabilities/default.json 的 windows 列表逐字一致
    const NOTE_LABEL: &str = "quick-note";
    const FOCUS_LABEL: &str = "focus";
    const FOCUS_RECORD_LABEL: &str = "focus-record";
    const BALL_LABEL: &str = "ball";
    const DOCK_LABEL: &str = "ball-dock";
    /// 快速随记卡片尺寸（逻辑像素）；专注窗默认中档，三档切换由 JS setSize 完成
    const NOTE_W: f64 = 460.0;
    const NOTE_H: f64 = 250.0;
    const FOCUS_W: f64 = 180.0;
    const FOCUS_H: f64 = 180.0;
    /// 番茄钟结束记录窗尺寸
    const FR_W: f64 = 400.0;
    const FR_H: f64 = 260.0;
    /// 悬浮球初始边长（逻辑像素，含透明阴影留白）；贴边/拖动定位由球页 JS 负责（尺寸恒定，不再 resize）
    const BALL_WIN: f64 = 76.0;
    /// dock 小窗尺寸 = 胶囊 132×56 + 四周 16px 透明留白×2（与球窗同构：可见体比窗小一圈，四周透明边容圆角/阴影）；
    /// 与 BallDock.vue 的 .pill 尺寸 + DOCK_PAD 一致。绝不对它 resize，避免透明窗重绘矩形残影
    const DOCK_W: f64 = 164.0;
    const DOCK_H: f64 = 88.0;

    /// 专注会话是否进行中（与托盘菜单文本同步，见 set_focus_running）
    static FOCUS_RUNNING: AtomicBool = AtomicBool::new(false);
    /// 托盘「番茄钟」菜单项，建托盘时存入，供 set_text 改文本（运行态指示：番茄钟 ↔ 结束）
    static FOCUS_MENU_ITEM: OnceLock<MenuItem<tauri::Wry>> = OnceLock::new();

    pub fn show_main(app: &AppHandle) {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    }

    /// 唤起浮窗：已存在则显示+聚焦（草稿/计时状态不丢），否则按主屏工作区定位新建。
    /// 无边框 + 透明底（圆角由 CSS 画）+ 置顶 + 不进任务栏，关闭钮由页面调 hide 实现。
    fn popup(app: &AppHandle, label: &str, route: &str, width: f64, height: f64, bottom_right: bool) {
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.show();
            let _ = win.set_focus();
            return;
        }
        // 主屏工作区（物理像素 ÷ scale_factor 换逻辑像素）；取不到显示器信息时退化为 1280×800 原点
        let (ax, ay, aw, ah) = match app.primary_monitor() {
            Ok(Some(m)) => {
                let sf = m.scale_factor();
                let r = m.work_area();
                (
                    r.position.x as f64 / sf,
                    r.position.y as f64 / sf,
                    r.size.width as f64 / sf,
                    r.size.height as f64 / sf,
                )
            }
            _ => (0.0, 0.0, 1280.0, 800.0),
        };
        // 专注窗锚右下（远离任务栏时钟），随记窗居中略偏下（视线下落处）
        let (x, y) = if bottom_right {
            (ax + aw - width - 24.0, ay + ah - height - 24.0)
        } else {
            (ax + (aw - width) / 2.0, ay + (ah - height) / 2.0 + 60.0)
        };
        let built = WebviewWindowBuilder::new(app, label, WebviewUrl::App(route.into()))
            .title("LifeTrack")
            .inner_size(width, height)
            .position(x, y)
            .decorations(false)
            .transparent(true)
            .background_color(Color(0, 0, 0, 0))
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            .focused(true)
            .build();
        if let Err(e) = built {
            eprintln!("创建浮窗失败 {label}: {e}");
        }
    }

    /// 建悬浮球窗（启动时一次性创建，常驻置顶）：透明无边框、不进任务栏、
    /// 初始贴主屏右边缘偏下；之后的拖动 / 贴边吸附 / 展开 dock 全部由球页 JS 接管。
    pub fn make_ball(app: &AppHandle) -> tauri::Result<()> {
        if app.get_webview_window(BALL_LABEL).is_some() {
            return Ok(());
        }
        let (ax, ay, aw, ah) = match app.primary_monitor() {
            Ok(Some(m)) => {
                let sf = m.scale_factor();
                let r = m.work_area();
                (
                    r.position.x as f64 / sf,
                    r.position.y as f64 / sf,
                    r.size.width as f64 / sf,
                    r.size.height as f64 / sf,
                )
            }
            _ => (0.0, 0.0, 1280.0, 800.0),
        };
        // 半个球探出右边缘（球心贴屏幕右沿），垂直偏下不挡视线
        let x = ax + aw - BALL_WIN / 2.0;
        let y = ay + ah - BALL_WIN * 3.0;
        WebviewWindowBuilder::new(app, BALL_LABEL, WebviewUrl::App("index.html#/ball".into()))
            .title("LifeTrack")
            .inner_size(BALL_WIN, BALL_WIN)
            .position(x, y)
            .decorations(false)
            .transparent(true)
            .background_color(Color(0, 0, 0, 0))
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            .focused(false)
            .build()?;
        // 双保险：建完显式 show 一次（部分 Windows 环境建窗首帧不自显，避免球“隐身”）
        if let Some(w) = app.get_webview_window(BALL_LABEL) {
            let _ = w.show();
        }
        Ok(())
    }

    /// 悬浮球开关：设置页切换时实时显示/隐藏球窗。球窗由 setup 启动就建好（主线程），这里只 show/hide——
    /// 绝不在命令里 build 新窗（异步命令里建透明窗显示不稳定，会“打不开”）
    #[tauri::command]
    pub async fn set_ball_visible(app: AppHandle, visible: bool) {
        if let Some(w) = app.get_webview_window(BALL_LABEL) {
            if visible {
                let _ = w.show();
            } else {
                let _ = w.hide();
            }
        }
        // 球隐藏时顺带收起 dock，避免留下一个悬空的胶囊
        if !visible {
            if let Some(d) = app.get_webview_window(DOCK_LABEL) {
                let _ = d.hide();
            }
        }
    }

    /// 建（或复用）球 + dock 两扇窗：仅在 setup 主线程调用一次（唯一安全的建窗时机）；已存在则跳过（幂等）
    pub fn ensure_ball_windows(app: &AppHandle) -> tauri::Result<()> {
        if app.get_webview_window(BALL_LABEL).is_none() {
            make_ball(app)?;
        }
        if app.get_webview_window(DOCK_LABEL).is_none() {
            make_ball_dock(app)?;
        }
        Ok(())
    }

    /// 建 dock 独立小窗（启动时在 setup 里建，与建球同一安全上下文）：建在屏幕内且可见，
    /// 因为透明窗必须在屏内做过一次有效首绘才能挂上分层透明表面；内容由 CSS 初始 opacity:0 画成不可见，
    /// 挂载后自行 hide（见 BallDock.vue），之后开合只走 show/hide + 定位。绝不在命令里 build（同步命令占主线程会自锁）。
    pub fn make_ball_dock(app: &AppHandle) -> tauri::Result<()> {
        if app.get_webview_window(DOCK_LABEL).is_some() {
            return Ok(());
        }
        let (cx, cy) = match app.primary_monitor() {
            Ok(Some(m)) => {
                let sf = m.scale_factor();
                let r = m.work_area();
                (
                    r.position.x as f64 / sf + r.size.width as f64 / sf / 2.0,
                    r.position.y as f64 / sf + r.size.height as f64 / sf / 2.0,
                )
            }
            _ => (640.0, 360.0),
        };
        WebviewWindowBuilder::new(app, DOCK_LABEL, WebviewUrl::App("index.html#/ball-dock".into()))
            .title("LifeTrack")
            .inner_size(DOCK_W, DOCK_H)
            .position(cx - DOCK_W / 2.0, cy - DOCK_H / 2.0)
            .decorations(false)
            .transparent(true)
            .background_color(Color(0, 0, 0, 0))
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            .focused(false)
            .build()?;
        Ok(())
    }

    /// 球页 hover 时弹出 dock：只对启动时已建好的窗做 setPosition + show（异步命令：避免窗口操作占死主线程）
    #[tauri::command]
    pub async fn show_ball_dock(app: AppHandle, x: f64, y: f64) {
        if let Some(d) = app.get_webview_window(DOCK_LABEL) {
            let _ = d.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
            let _ = d.show();
        }
    }

    /// 收起 dock：hide 即可（异步命令，同上）
    #[tauri::command]
    pub async fn hide_ball_dock(app: AppHandle) {
        if let Some(d) = app.get_webview_window(DOCK_LABEL) {
            let _ = d.hide();
        }
    }

    /// 悬浮球 dock「随记」入口：等价于托盘「随记」，唤起/聚焦快速随记浮窗（异步：popup 首次会建窗，不能占主线程）
    #[tauri::command]
    pub async fn open_note(app: AppHandle) {
        popup(&app, NOTE_LABEL, "index.html#/quick-note", NOTE_W, NOTE_H, false);
    }

    /// 悬浮球 dock「番茄钟」入口：只打开窗口（不触发计时），开始/结束由窗内按钮控制
    #[tauri::command]
    pub async fn open_focus(app: AppHandle) {
        popup(&app, FOCUS_LABEL, "index.html#/focus", FOCUS_W, FOCUS_H, true);
    }

    /// 番茄钟结束后弹出记录窗
    #[tauri::command]
    pub async fn open_focus_record(app: AppHandle) {
        popup(&app, FOCUS_RECORD_LABEL, "index.html#/focus-record", FR_W, FR_H, false);
    }

    pub fn make_tray(app: &AppHandle) -> tauri::Result<()> {
        let m_show = MenuItem::with_id(app, "show", "主界面", true, None::<&str>)?;
        let m_note = MenuItem::with_id(app, "quick_note", "随记", true, None::<&str>)?;
        let m_focus = MenuItem::with_id(app, "focus_toggle", "番茄钟", true, None::<&str>)?;
        let m_settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
        let m_quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
        let _ = FOCUS_MENU_ITEM.set(m_focus.clone());
        let sep1 = PredefinedMenuItem::separator(app)?;
        let sep2 = PredefinedMenuItem::separator(app)?;
        let menu = Menu::with_items(app, &[&m_show, &m_note, &m_focus, &sep1, &m_settings, &sep2, &m_quit])?;
        let mut tray = TrayIconBuilder::with_id("main-tray")
            .menu(&menu)
            .show_menu_on_left_click(true)
            .tooltip("LifeTrack")
            .on_menu_event(|app, event| match event.id.as_ref() {
                "show" => show_main(app),
                "quick_note" => popup(app, NOTE_LABEL, "index.html#/quick-note", NOTE_W, NOTE_H, false),
                "focus_toggle" => popup(app, FOCUS_LABEL, "index.html#/focus", FOCUS_W, FOCUS_H, true),
                "settings" => {
                    show_main(app);
                    let _ = app.emit_to("main", "tray:navigate", "settings");
                }
                "quit" => app.exit(0),
                _ => {}
            });
        if let Some(icon) = app.default_window_icon() {
            tray = tray.icon(icon.clone());
        }
        tray.build(app)?;
        Ok(())
    }

    /// 番茄钟窗同步运行态：改托盘菜单文本（未运行显「番茄钟」、运行中显「结束」）
    #[tauri::command]
    pub fn set_focus_running(running: bool) {
        FOCUS_RUNNING.store(running, Ordering::SeqCst);
        if let Some(item) = FOCUS_MENU_ITEM.get() {
            let _ = item.set_text(if running { "结束" } else { "番茄钟" });
        }
    }

    /// 系统通知（Rust 侧发，免给浮窗开 notification 权限）
    #[tauri::command]
    pub fn notify_done(app: AppHandle, title: String, body: String) -> Result<(), String> {
        app.notification()
            .builder()
            .title(&title)
            .body(&body)
            .show()
            .map_err(|e| e.to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 版本化迁移：只前进、每个迁移由插件包在事务里执行；失败整体回滚。
    // 新增迁移 = 在这里追加一条 + 新建 migrations/000X_*.sql（勿手改已发布的历史迁移）。
    let migrations = vec![Migration {
        version: 1,
        description: "0001_init",
        sql: include_str!("../migrations/0001_init.sql"),
        kind: MigrationKind::Up,
    }];

    // 迁移注册键必须在启动时确定（早于 JS 运行），故这里读指针文件解析出连接串；
    // 自定义库路径 = 写指针 + 重启，重启后此处读到绝对路径 → 迁移注册与 JS 打开两端一致。
    let context = tauri::generate_context!();
    let identifier = context.config().identifier.clone();
    let config_dir = config_dir_for(&identifier);
    std::fs::create_dir_all(&config_dir).ok();
    let conn = conn_for(&resolve_db_file(&config_dir));
    let _ = APP_PATHS.set(AppPaths {
        config_dir,
        conn: conn.clone(),
    });

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // 在线更新：前端 check() 经此插件在 Rust 侧拉取/验签/安装（配置见 tauri.conf.json plugins.updater）
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            Builder::default()
                .add_migrations(&conn, migrations)
                .build(),
        );

    // 双开会同时开两个库连接，禁掉；二次启动改为聚焦已有主窗口。以下均为桌面专属插件。
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _, _| {
                desk::show_main(app);
            }))
            .plugin(tauri_plugin_notification::init())
            // 托盘 + 球/dock 窗启动就在主线程建好（唯一安全的建窗时机）：透明窗需先上一次屏内有效绘制才挂得住透明表面，
            // 不能“按偏好不建、开球时在命令里补建”（实测建出的球窗显示不稳定 = 悬浮球打不开）。关闭态靠 Ball.vue 首绘后自隐。
            .setup(|app| {
                // 开机防白闪：config 底色已设为深色（适配深色主题），浅色用户在此翻回浅色
                if let Some(paths) = APP_PATHS.get() {
                    let theme = load_prefs_sync(&paths.config_dir).theme;
                    if theme == "light" {
                        if let Some(w) = app.handle().get_webview_window("main") {
                            let _ = w.set_background_color(Some(tauri::window::Color(250, 251, 252, 255)));
                        }
                    }
                }
                desk::make_tray(app.handle())?;
                desk::ensure_ball_windows(app.handle())?;
                // ballEnabled=false 时立即隐球：与建窗同处 setup（事件循环未启动），show+hide 同帧完成 → 不会闪现
                if let Some(paths) = APP_PATHS.get() {
                    if !load_prefs_sync(&paths.config_dir).ball_enabled {
                        if let Some(b) = app.handle().get_webview_window("ball") { let _ = b.hide(); }
                        if let Some(d) = app.handle().get_webview_window("ball-dock") { let _ = d.hide(); }
                    }
                }
                Ok(())
            });
    }

    // 托盘/悬浮球/专注/通知命令仅桌面存在，invoke_handler 按平台分叉
    #[cfg(desktop)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        get_db_conn,
        get_db_dir,
        set_db_location,
        get_prefs,
        set_prefs,
        restart_app,
        quit_app,
        desk::set_focus_running,
        desk::notify_done,
        desk::open_note,
        desk::open_focus,
        desk::open_focus_record,
        desk::set_ball_visible,
        desk::show_ball_dock,
        desk::hide_ball_dock
    ]);
    #[cfg(not(desktop))]
    let builder =
        builder.invoke_handler(tauri::generate_handler![get_db_conn, get_db_dir, set_db_location, get_prefs, set_prefs, restart_app, quit_app]);

    builder.run(context).expect("error while running tauri application");
}
