/**
 * 随记数据层：读写 SQLite 的 logs / entity_tags 表（设计：仓库根 数据库设计.md）
 * 全部访问参数化（? 绑定）；time 字段不再单独存，从 ts 派生供展示
 */
import { getDb } from "./db";

export type LogItem = {
  id: number;
  /** YYYY-MM-DD（库里由 ts 派生的冗余列） */
  date: string;
  /** HH:mm，展示用，从 ts 派生 */
  time: string;
  /** 正文，可多行（\n），**文字** 表示加粗 */
  text: string;
  /** 类别：技术 / 项目 / 学习 / 回顾 / 问题 / 生活（单选顶层视觉分类） */
  kind: string;
  /** 自由语义标签（存 entity_tags，与 kind 互不替代） */
  tags: string[];
  /** 可选关联目标：非空则进该目标的聚合视图 */
  goalId?: number;
  /** 最后修改时刻（毫秒）：创建时 = ts，编辑正文时刷新 */
  updatedAt: number;
};

/** 日志类别（颜色兼用于日志页与报告面板，与 global.css 软色板一致） */
export const LOG_KINDS = [
  { key: "技术", color: "#17A17D" },
  { key: "项目", color: "#8B7BF7" },
  { key: "学习", color: "#2F7AC7" },
  { key: "回顾", color: "#C2691C" },
  { key: "问题", color: "#FF6B7A" },
  { key: "生活", color: "#A1A7B3" },
];
export const LOG_KIND_LIGHT: Record<string, string> = {
  技术: "#E4F3EE", 项目: "#F1EFFE", 学习: "#E8F3FE", 回顾: "#FDEBDD", 问题: "#FEECF2", 生活: "#F1F3F6",
};
export function kindColor(k: string) {
  return LOG_KINDS.find(x => x.key === k)?.color ?? "#A1A7B3";
}

/** 今天的 YYYY-MM-DD（本地时区，避免 toISOString 的 UTC 偏移） */
export function isoToday() {
  return isoDate(new Date());
}
export function isoDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** n 天前的 YYYY-MM-DD */
export function dayOffset(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDate(d);
}
export function parseIso(s: string) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
/** 两个 YYYY-MM-DD 相差的天数（b - a） */
export function daysBetween(a: string, b: string) {
  return Math.round((parseIso(b).getTime() - parseIso(a).getTime()) / 86400000);
}

/** 正文渲染：先转义再还原 **加粗**，用户输入与演示数据同一套规则 */
export function fmtRich(s: string) {
  return s
    .replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

/** 从原始文本里抽 #标签，返回去掉标签后的正文（保留换行，只压缩行内多余空格） */
export function parseEntry(raw: string) {
  const tags = [...raw.matchAll(/#(\S+)/g)].map(m => m[1]);
  const text = raw
    .replace(/#\S+/g, "")
    .split("\n")
    .map(s => s.replace(/[ \t]+/g, " ").replace(/ $/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, tags };
}

/** 从日期集合算"连续记录天数"：今天没记也不断档，从昨天往前数 */
export function streakOf(dates: Iterable<string>) {
  const set = new Set(dates);
  if (!set.size) return 0;
  const today = isoToday();
  if (!set.has(today) && !set.has(dayOffset(1))) return 0;
  let n = 0;
  for (let i = set.has(today) ? 0 : 1; set.has(dayOffset(i)); i++) n++;
  return n;
}

// ---------- 读写（SQLite，全部异步） ----------
interface LogRow {
  id: number; goal_id: number | null; ts: number; date: string; text: string; kind: string; updated_at: number;
}
function hhmm(ts: number) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 读取全部随记（新→旧），标签一次性拼回 */
export async function loadLogs(): Promise<LogItem[]> {
  const db = await getDb();
  const rows = await db.select<LogRow[]>("SELECT id, goal_id, ts, date, text, kind, updated_at FROM logs ORDER BY ts DESC");
  const tagRows = await db.select<{ ref_id: number; tag: string }[]>("SELECT ref_id, tag FROM entity_tags WHERE kind = 'log'");
  const byId = new Map<number, string[]>();
  for (const t of tagRows) {
    const arr = byId.get(t.ref_id);
    if (arr) arr.push(t.tag); else byId.set(t.ref_id, [t.tag]);
  }
  return rows.map(r => ({
    id: r.id, date: r.date, time: hhmm(r.ts), text: r.text, kind: r.kind, updatedAt: r.updated_at,
    tags: byId.get(r.id) ?? [],
    ...(r.goal_id != null ? { goalId: r.goal_id } : {}),
  }));
}

/** 新增一条随记：ts=此刻，date 由 ts 派生；返回新建条目供页面直接上屏 */
export async function addLog(input: { text: string; kind: string; tags: string[]; goalId?: number }): Promise<LogItem> {
  const db = await getDb();
  const ts = Date.now();
  const date = isoDate(new Date(ts));
  const res = await db.execute(
    "INSERT INTO logs (goal_id, ts, date, text, kind, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    [input.goalId ?? null, ts, date, input.text, input.kind, ts],
  );
  const id = res.lastInsertId ?? ts;
  for (const tag of input.tags) {
    await db.execute("INSERT OR IGNORE INTO entity_tags (kind, ref_id, tag) VALUES ('log', ?, ?)", [id, tag]);
  }
  return { id, date, time: hhmm(ts), text: input.text, kind: input.kind, tags: input.tags, updatedAt: ts, ...(input.goalId != null ? { goalId: input.goalId } : {}) };
}

/** 编辑正文（行内编辑只改 text；kind/tags 维持不变）；顺带刷新 updated_at，返回新时间戳供本地同步 */
export async function updateLog(id: number, text: string): Promise<number> {
  const db = await getDb();
  const now = Date.now();
  await db.execute("UPDATE logs SET text = ?, updated_at = ? WHERE id = ?", [text, now, id]);
  return now;
}

/** 删除随记：显式清标签关联（插件连接上 foreign_keys 不可靠，级联在数据层做） */
export async function deleteLog(id: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM entity_tags WHERE kind = 'log' AND ref_id = ?", [id]);
  await db.execute("DELETE FROM logs WHERE id = ?", [id]);
}
