/**
 * 连接口（唯一开库点）——设计见仓库根 数据库设计.md §1/§7
 * - 连接串由 Rust 启动时解析（get_db_conn 命令），与迁移注册键逐字一致；JS 不再硬编码路径
 * - 自定义库路径：用户在设置页选文件 → 写指针 → 重启 → 此处取到新的绝对路径连接串
 * - 迁移由插件在 load() 时于 Rust 侧按版本自动执行，JS 不需要参与建表
 * - 加密预留（chokepoint）：未来启用 SQLCipher 只改本文件的打开逻辑，领域函数零改动
 * - 一切访问经 getDb() + 参数化 select/execute：值永远走 ? 绑定，不拼字符串
 *
 * 注意：仅 Tauri 运行时可用（纯浏览器里 vite dev 打开会失败），开发请用 npm run tauri dev
 */
import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";

let dbPromise: Promise<Database> | null = null;

/** 获取全局唯一数据库句柄（懒加载；失败不缓存 rejected promise，允许下次重试） */
export function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = (async () => {
      // 连接串必须与 Rust 侧注册迁移的键一致，故运行时向 Rust 索取，勿在此拼路径
      const conn = await invoke<string>("get_db_conn");
      return Database.load(conn);
    })().catch((e) => {
      dbPromise = null;
      throw e;
    });
  }
  return dbPromise;
}
