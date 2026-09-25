/**
 * 时间线数据层：SQLite events 表，append-only 脊梁（设计：仓库根 数据库设计.md）
 * 现有页面在 persist 位置追加 addEvent()，时间线页纯展示
 * 全部访问参数化（? 绑定）；type 是库内 CHECK 封闭枚举，新增类型必须先走迁移
 */
import { isoToday } from "./logs";
import { getDb } from "./db";

export type TimelineEventType =
  | "task.created" | "task.confirmed" | "task.completed" | "task.reopened" | "task.dropped" | "task.removed"
  | "goal.created" | "goal.removed"
  | "goal.status_changed" | "goal.version_added" | "goal.version_removed"
  | "log.created" | "log.updated" | "log.removed"
  | "report.saved"
  | "milestone.marked" | "milestone.unmarked"
  | "focus.completed";

export interface TimelineEvent {
  id: number;
  type: TimelineEventType;
  /** 毫秒时间戳，用于精确排序 */
  ts: number;
  /** YYYY-MM-DD，ts 的派生冗余列，按天分组用 */
  date: string;
  /** 人可读摘要 */
  summary: string;
  /** 里程碑标记动作（milestone.marked/unmarked）指向被标记的那条事件 id；标记发生在"现在"，引用过去的点 */
  refId?: number;
}

/** 事件类型→分组标签（给时间线页面用） */
export const EVENT_GROUP: Record<string, { label: string; color: string }> = {
  "task.created":   { label: "待办", color: "#17A17D" },
  "task.confirmed": { label: "待办", color: "#17A17D" },
  "task.completed": { label: "待办", color: "#17A17D" },
  "task.reopened":  { label: "待办", color: "#A1A7B3" },
  "task.dropped":   { label: "待办", color: "#17A17D" },
  "task.removed":   { label: "待办", color: "#17A17D" },
  "goal.created":   { label: "目标", color: "#8B7BF7" },
  "goal.removed":   { label: "目标", color: "#8B7BF7" },
  "goal.status_changed": { label: "目标", color: "#8B7BF7" },
  "goal.version_added":  { label: "目标", color: "#8B7BF7" },
  "goal.version_removed": { label: "目标", color: "#8B7BF7" },
  "log.created":    { label: "随记", color: "#2F7AC7" },
  "log.updated":    { label: "随记", color: "#2F7AC7" },
  "log.removed":    { label: "随记", color: "#2F7AC7" },
  "report.saved":   { label: "报告", color: "#C2691C" },
  "milestone.marked":   { label: "里程碑", color: "#17A17D" },
  "milestone.unmarked": { label: "里程碑", color: "#A1A7B3" },
  "focus.completed":    { label: "番茄钟", color: "#D97706" },
};

// ---------- 读写（SQLite，全部异步） ----------
interface EventRow {
  id: number; type: TimelineEventType; ts: number; date: string; summary: string; ref_id: number | null;
}
const EVENT_COLS = "id, type, ts, date, summary, ref_id";
function toEvent(r: EventRow): TimelineEvent {
  return { id: r.id, type: r.type, ts: r.ts, date: r.date, summary: r.summary, ...(r.ref_id != null ? { refId: r.ref_id } : {}) };
}

/** 全量事件（ts 倒序）；里程碑派生等需要整体视角时用 */
export async function loadTimelineRaw(): Promise<TimelineEvent[]> {
  const db = await getDb();
  const rows = await db.select<EventRow[]>(`SELECT ${EVENT_COLS} FROM events ORDER BY ts DESC`);
  return rows.map(toEvent);
}

/** 分页加载：offset 起始位置，limit 每页条数，按 ts 倒序 */
export async function loadTimeline(offset = 0, limit = 100): Promise<TimelineEvent[]> {
  const db = await getDb();
  const rows = await db.select<EventRow[]>(
    `SELECT ${EVENT_COLS} FROM events ORDER BY ts DESC LIMIT ? OFFSET ?`,
    [limit, offset],
  );
  return rows.map(toEvent);
}

/** 事件总数 */
export async function timelineCount(): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ n: number }[]>("SELECT COUNT(*) AS n FROM events");
  return rows[0]?.n ?? 0;
}

/** 追加一条事件，ts=此刻、date 由 ts 派生；返回新建事件（带库分配的行 id，便于里程碑引用） */
export async function addEvent(type: TimelineEventType, summary: string, opts?: { refId?: number }): Promise<TimelineEvent> {
  const db = await getDb();
  const now = Date.now();
  const date = isoToday();
  const res = await db.execute(
    "INSERT INTO events (type, ts, date, summary, ref_id) VALUES (?, ?, ?, ?, ?)",
    [type, now, date, summary, opts?.refId ?? null],
  );
  return { id: res.lastInsertId ?? now, type, ts: now, date, summary, ...(opts?.refId != null ? { refId: opts.refId } : {}) };
}

/** 派生"当前仍是里程碑"的目标 id 集合：只查标记动作，同一目标最新一次说了算（成对留痕，不复制内容） */
export async function activeMilestoneIds(): Promise<Set<number>> {
  const db = await getDb();
  const marks = await db.select<{ type: TimelineEventType; ts: number; ref_id: number }[]>(
    "SELECT type, ts, ref_id FROM events WHERE type IN ('milestone.marked','milestone.unmarked') AND ref_id IS NOT NULL",
  );
  const last = new Map<number, { ts: number; on: boolean }>();
  for (const m of marks) {
    const cur = last.get(m.ref_id);
    if (!cur || m.ts >= cur.ts) last.set(m.ref_id, { ts: m.ts, on: m.type === "milestone.marked" });
  }
  const on = new Set<number>();
  for (const [id, v] of last) if (v.on) on.add(id);
  return on;
}

/** 当前被标记为里程碑的目标事件（供报告等按时间窗二次投影） */
export async function milestoneTargetEvents(): Promise<TimelineEvent[]> {
  const ids = [...(await activeMilestoneIds())];
  if (!ids.length) return [];
  const db = await getDb();
  // 占位符按 id 个数生成，id 值仍走 ? 绑定（不拼用户输入）
  const rows = await db.select<EventRow[]>(
    `SELECT ${EVENT_COLS} FROM events WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY ts DESC`,
    ids,
  );
  return rows.map(toEvent);
}

/** 切换某条事件的里程碑标记：标记 / 撤销本身作为新的时间点写入时间线 */
export async function setMilestone(target: TimelineEvent, on: boolean): Promise<void> {
  const brief = target.summary.length > 30 ? target.summary.slice(0, 30) + "\u2026" : target.summary;
  await addEvent(
    on ? "milestone.marked" : "milestone.unmarked",
    on ? `标记里程碑：${brief}` : `取消里程碑标记：${brief}`,
    { refId: target.id },
  );
}
