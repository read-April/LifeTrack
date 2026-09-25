/**
 * 报告数据层：周报 / 月报 / 年度总结的周期算法与正文存储
 * 手写正文落 SQLite reports 表（整数 id 代理主键，period_key 为应用层唯一键）；数字部分一律从日志实时聚合，不存快照
 */
import { getDb } from "./db";
import { isoDate } from "./logs";

export type ReportMode = "week" | "month" | "year";

export type ReportDoc = { text: string; updatedAt: number };

/** 由周期 key 反推 mode：2026-W38→week、2026-09→month、2026→year（三种格式互不冲突） */
function modeOfKey(key: string): ReportMode {
  if (key.includes("-W")) return "week";
  return key.includes("-") ? "month" : "year";
}

/** 读某一期的手写正文；无记录返回 null */
export async function loadReport(key: string): Promise<ReportDoc | null> {
  const db = await getDb();
  const rows = await db.select<{ text: string; updated_at: number }[]>(
    "SELECT text, updated_at FROM reports WHERE period_key = ?",
    [key],
  );
  const r = rows[0];
  return r ? { text: r.text, updatedAt: r.updated_at } : null;
}

/** 已写过总结的周期 key（列表行用来打小圆点） */
export async function reportKeys(): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.select<{ period_key: string }[]>("SELECT period_key FROM reports");
  return new Set(rows.map(r => r.period_key));
}

/** 正文为空时删记录，避免空壳；否则按 period_key upsert */
export async function saveReport(key: string, text: string): Promise<void> {
  const db = await getDb();
  if (!text.trim()) {
    await db.execute("DELETE FROM reports WHERE period_key = ?", [key]);
    return;
  }
  await db.execute(
    `INSERT INTO reports (period_key, mode, text, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(period_key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
    [key, modeOfKey(key), text, Date.now()],
  );
}

// ---------- 周期算法 ----------
/** 周一为一周起点 */
export function mondayOf(d: Date) {
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  x.setHours(0, 0, 0, 0);
  return x;
}

/** ISO 8601 周号（跨年那一周归到周四所在的年份） */
export function isoWeek(d: Date) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3);
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  return {
    year: t.getUTCFullYear(),
    week: 1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * 86400000)),
  };
}

/** 周期唯一 key：2026-W38 / 2026-09 / 2026 */
export function periodKey(mode: ReportMode, d: Date) {
  if (mode === "week") {
    const w = isoWeek(d);
    return `${w.year}-W${String(w.week).padStart(2, "0")}`;
  }
  if (mode === "month") return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  return `${d.getFullYear()}`;
}

/** 在同一周期内前后移动 n 个周期，返回落在目标周期里的一天 */
export function shiftPeriod(mode: ReportMode, d: Date, n: number) {
  const x = new Date(d);
  if (mode === "week") x.setDate(x.getDate() + n * 7);
  else if (mode === "month") x.setMonth(x.getMonth() + n, 1);
  else x.setFullYear(x.getFullYear() + n, 0, 1);
  return x;
}

/** 周期的首末（含），返回 YYYY-MM-DD 便于和日志的 date 字段直接比较 */
export function rangeOf(mode: ReportMode, d: Date) {
  if (mode === "week") {
    const start = mondayOf(d);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    return { from: isoDate(start), to: isoDate(end), days: 7, start, end };
  }
  if (mode === "month") {
    const start = new Date(d.getFullYear(), d.getMonth(), 1);
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return { from: isoDate(start), to: isoDate(end), days: end.getDate(), start, end };
  }
  const start = new Date(d.getFullYear(), 0, 1);
  const end = new Date(d.getFullYear(), 11, 31);
  // 用日期差而非耗时，避开夏令时导致的 364.96 这类小数
  const days = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  return { from: isoDate(start), to: isoDate(end), days, start, end };
}

function md(s: string) {
  const d = new Date(s + "T00:00:00");
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/** 报告标题：主标题 + 说明行 */
export function titleOf(mode: ReportMode, d: Date) {
  const r = rangeOf(mode, d);
  if (mode === "week") {
    const w = isoWeek(d);
    return { main: `${md(r.from)} – ${md(r.to)}`, sub: `${w.year} 年 · 第 ${w.week} 周 · 共 7 天` };
  }
  if (mode === "month") {
    return { main: `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`, sub: `全月 ${r.days} 天` };
  }
  return { main: `${d.getFullYear()} 年`, sub: `全年 ${rangeOf("year", d).days} 天` };
}

/** 手写区的名称（按周期称呼，不叫"我的总结"） */
export function writeLabel(mode: ReportMode) {
  return mode === "week" ? "本周总结" : mode === "month" ? "本月总结" : "年度总结";
}

/** 侧栏列表项的标题 */
export function listLabel(mode: ReportMode, d: Date) {
  if (mode === "week") {
    const r = rangeOf("week", d);
    const s = new Date(r.from + "T00:00:00");
    const e = new Date(r.to + "T00:00:00");
    const f = (x: Date) => `${x.getMonth() + 1}/${x.getDate()}`;
    return `${f(s)} – ${f(e)}`;
  }
  if (mode === "month") return `${d.getMonth() + 1} 月`;
  return `${d.getFullYear()} 年`;
}

export function isCurrentPeriod(mode: ReportMode, d: Date) {
  return periodKey(mode, d) === periodKey(mode, new Date());
}

/**
 * 待办只读引用：从 tasks 表查（首页/目标页写库，报告只拿它统计“本期到期/已清/逾期未清”）
 * due 由库内 INTEGER 毫秒换算成 YYYY-MM-DD 以便和周期区间直接比；done 含 done/dropped（都算已清，不再计逾期）
 */
export type TodoLite = { id: number; text: string; proj: string; urgent: boolean; due: string; done: boolean };
export async function loadTodos(): Promise<TodoLite[]> {
  const db = await getDb();
  const rows = await db.select<
    { id: number; text: string; proj: string; urgent: number; due: number | null; status: string }[]
  >(
    `SELECT t.id AS id, t.text AS text, g.name AS proj, t.urgent AS urgent, t.due AS due, t.status AS status
       FROM tasks t JOIN goals g ON g.id = t.goal_id`,
  );
  return rows.map(r => ({
    id: r.id, text: r.text, proj: r.proj, urgent: !!r.urgent,
    due: r.due != null ? isoDate(new Date(r.due)) : "",
    done: r.status === "done" || r.status === "dropped",
  }));
}
