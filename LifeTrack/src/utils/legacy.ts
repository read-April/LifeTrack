/**
 * 遗留 localStorage 键清理：SQLite 迁移前，随记/目标/待办/报告正文曾存浏览器存储。
 * 现在这些数据一律入库（空库起步、不回读旧值），这里只负责把老设备上残留的死键抹掉，
 * 避免占用空间与造成“数据还在 localStorage”的误解。
 * 轻量偏好（主题/昵称/关窗行为/球位置/尺寸档等）已改存 trackbook.json，旧 localStorage 键由 prefs.ts 首启时迁移并清掉，不在此列。
 */
const LEGACY_DATA_KEYS = ["lt-logs", "lt-projects", "lt-todos", "lt-reports"];

/** 删除迁移遗留的数据键，返回实际清掉的条数（幂等，可每次启动无脑调用） */
export function purgeLegacyKeys(): number {
  let n = 0;
  for (const k of LEGACY_DATA_KEYS) {
    if (localStorage.getItem(k) !== null) {
      localStorage.removeItem(k);
      n++;
    }
  }
  return n;
}
