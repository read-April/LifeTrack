/**
 * 目标数据层：读写 SQLite 的 goals / tasks / goal_versions / entity_tags 表
 * （设计：仓库根 数据库设计.md；与 utils/logs.ts 同一套路，全部参数化 ? 绑定）
 * 库中 created_at/updated_at/due 为 INTEGER 毫秒，页面模型沿用 YYYY-MM-DD 字符串，
 * 在 dueMs ↔ isoLocal 边界换算；级联删除由数据层显式执行（插件连接不保证 foreign_keys 生效）。
 *
 * 关键取舍：状态用英文 key（active/paused/done/dropped）存进数据，中文 label 只用于显示。
 * 这样以后改措辞（如"放弃"→"搁置"）只动 label、不动 key，不会像随记 kind 那样
 * 显示名与存储值耦合、一改就与历史记录对不上。
 */
import { getDb } from "./db";
import { isoDate, parseIso } from "./logs";

export type GoalStatus = "active" | "paused" | "done" | "dropped";

/**
 * 待办状态机（决策轨迹）：pending(写下待确认) → confirmed(确认排上) → done(完成) | dropped(放弃)
 * 每次流转都在时间轴落一个点；pending 也可直接完成/放弃，确认只是中间的一个决策态
 */
export type TaskStatus = "pending" | "confirmed" | "done" | "dropped";

/** 目标下的待办任务（两级模型的"子"）：只带状态相关的轻字段 */
export type Task = {
  id: number;
  text: string;
  urgent: boolean;
  /** 截止日 YYYY-MM-DD，可空 */
  due: string;
  status: TaskStatus;
};

/** 状态元数据：label 给人看，color/light 供 chip 上色（色值沿用 global.css 软色板） */
export const TASK_STATUS: { key: TaskStatus; label: string; color: string; light: string }[] = [
  { key: "pending",   label: "待确认", color: "#A1A7B3", light: "#F1F3F6" },
  { key: "confirmed", label: "进行中", color: "#2F7AC7", light: "#E8F3FE" },
  { key: "done",      label: "完成",   color: "#17A17D", light: "#E4F3EE" },
  { key: "dropped",   label: "放弃",   color: "#A1A7B3", light: "#F1F3F6" },
];
export function taskStatusMeta(s: TaskStatus) {
  return TASK_STATUS.find(x => x.key === s) ?? TASK_STATUS[0];
}
/** 排序权重：进行中 → 待确认 → 完成 → 放弃 */
export const TASK_RANK: Record<TaskStatus, number> = { confirmed: 0, pending: 1, done: 2, dropped: 3 };

// 状态判定助手：页面用它替代原先的 done 布尔
export const isTodoActive = (t: Task) => t.status === "pending" || t.status === "confirmed";
export const isTodoDone = (t: Task) => t.status === "done";
export const isTodoFinished = (t: Task) => t.status === "done" || t.status === "dropped";

/** 版本记录一条：用户在目标详情页手动维护，标题（日期/版本号）+描述，最新在上 */
export type VersionEntry = {
  id: number;
  /** 标题，一般写日期或版本号 */
  title: string;
  /** 描述：这次做了什么，支持多行 */
  desc: string;
};

export type ProjectItem = {
  id: number;
  /** 目标名，必填；库里带唯一索引（忽略大小写），重名在表单层拦截 */
  name: string;
  /** 一句话说明，可空 */
  desc: string;
  status: GoalStatus;
  /** 自由标签（存 entity_tags kind='goal'，不设固定枚举） */
  tags: string[];
  /** 该目标下的待办任务 */
  tasks: Task[];
  /** 内置"收件箱"目标：收纳未归属的散待办，不在目标墙展示、不可删 */
  inbox?: boolean;
  /** 0–100 */
  progress: number;
  /** 截止日 YYYY-MM-DD，可空 */
  due: string;
  /** 头像/进度条取值色（软色板） */
  color: string;
  /** YYYY-MM-DD */
  createdAt: string;
  /** YYYY-MM-DD，列表按它倒序 */
  updatedAt: string;
  /** 功能要点（演示种子已删，库里无对应表；详情页第方判空，保留可选字段） */
  features?: string[];
  /** 版本记录（存 goal_versions，按 position/id 倒序，最新在上；「待办」目标不显示） */
  versions?: VersionEntry[];
};

/** 状态元数据：key 存数据，label 给人看，色值沿用 global.css 软色板 */
export const GOAL_STATUS: { key: GoalStatus; label: string; color: string; light: string }[] = [
  { key: "active", label: "活跃", color: "#17A17D", light: "#E4F3EE" },
  { key: "paused", label: "暂停", color: "#C2691C", light: "#FDEBDD" },
  { key: "done", label: "达成", color: "#2F7AC7", light: "#E8F3FE" },
  { key: "dropped", label: "放弃", color: "#A1A7B3", light: "#F1F3F6" },
];

/** 新建目标时按序分配的默认色 */
export const GOAL_COLORS = ["#17A17D", "#8B7BF7", "#2F7AC7", "#C2691C", "#FF6B7A", "#0A6B52"];

/** 内置「待办」收件箱的默认描述：语出《道德经》64 章「为之于未有」，取其未行先备之意 */
export const INBOX_DESC = "为之于未有 · 有感即录，未行先备";

export function statusMeta(s: GoalStatus) {
  return GOAL_STATUS.find(x => x.key === s) ?? GOAL_STATUS[0];
}

/** 从原始文本抽 #标签（与随记同规则） */
export function parseTags(raw: string): string[] {
  return [...raw.matchAll(/#(\S+)/g)].map(m => m[1]);
}

// ---------- 时间戳边界：库 INTEGER 毫秒 ↔ 页面 YYYY-MM-DD ----------
function isoLocal(ms: number) {
  return isoDate(new Date(ms));
}
/** 空串 → null（库里 due 可空）；非法串会得到 NaN，交给调用方保证格式 */
function dueMs(s: string): number | null {
  return s ? parseIso(s).getTime() : null;
}

// ---------- 行类型与映射 ----------
interface GoalRow {
  id: number; name: string; descr: string; status: GoalStatus; inbox: number;
  progress: number; due: number | null; color: string;
  created_at: number; updated_at: number;
}
interface TaskRow {
  id: number; goal_id: number; text: string; urgent: number;
  due: number | null; status: TaskStatus;
}
interface VersionRow { id: number; goal_id: number; title: string; descr: string }
interface TagRow { ref_id: number; tag: string }

function toTask(r: TaskRow): Task {
  return {
    id: r.id, text: r.text, urgent: r.urgent === 1,
    due: r.due != null ? isoLocal(r.due) : "", status: r.status,
  };
}

// ---------- 读写（SQLite，全部异步） ----------

/** 新建目标的字段包（ms 换算与 tag 写入都在 createGoal 里做） */
export type GoalBody = {
  name: string; desc: string; status: GoalStatus; tags: string[];
  progress: number; due: string; color: string; createdAt: string;
};
/** 编辑目标的载荷：全部可选，只更新给到的字段 */
export type GoalPatch = Partial<GoalBody>;

/**
 * 读取全部目标（含 inbox 与任务/版本/标签）。
 * 首次空库时先保证内置「待办」存在（设计 §2：inbox 目标不可删、页面靠它兜底）。
 */
export async function loadProjects(): Promise<ProjectItem[]> {
  const db = await getDb();
  // 每次读取都兼做一次 inbox 守护：空库建行、旧库回填默认描述（均已存在且非空则无写入）
  await ensureInbox();
  const [goalRows, taskRows, verRows, tagRows] = await Promise.all([
    db.select<GoalRow[]>("SELECT id, name, descr, status, inbox, progress, due, color, created_at, updated_at FROM goals ORDER BY updated_at DESC"),
    db.select<TaskRow[]>("SELECT id, goal_id, text, urgent, due, status FROM tasks ORDER BY id ASC"),
    db.select<VersionRow[]>("SELECT id, goal_id, title, descr FROM goal_versions ORDER BY goal_id, position DESC, id DESC"),
    db.select<TagRow[]>("SELECT ref_id, tag FROM entity_tags WHERE kind = 'goal'"),
  ]);
  const group = <T,>(rows: T[], key: (r: T) => number) => {
    const m = new Map<number, T[]>();
    for (const r of rows) {
      const arr = m.get(key(r));
      if (arr) arr.push(r); else m.set(key(r), [r]);
    }
    return m;
  };
  const tasksBy = group(taskRows, r => r.goal_id);
  const versBy = group(verRows, r => r.goal_id);
  const tagsBy = group(tagRows, r => r.ref_id);
  return goalRows.map(r => ({
    id: r.id,
    name: r.name,
    desc: r.descr,
    status: r.status,
    tags: (tagsBy.get(r.id) ?? []).map(t => t.tag),
    tasks: (tasksBy.get(r.id) ?? []).map(toTask),
    ...(r.inbox ? { inbox: true } : {}),
    progress: r.progress,
    due: r.due != null ? isoLocal(r.due) : "",
    color: r.color,
    createdAt: isoLocal(r.created_at),
    updatedAt: isoLocal(r.updated_at),
    versions: (versBy.get(r.id) ?? []).map(v => ({ id: v.id, title: v.title, desc: v.descr })),
  }));
}

/** 保证内置「待办」特殊目标存在，返回它的 id（名字同样占唯一索引，固定为「待办」） */
export async function ensureInbox(): Promise<number> {
  const db = await getDb();
  const hit = await db.select<{ id: number; descr: string; status: GoalStatus }[]>("SELECT id, descr, status FROM goals WHERE inbox = 1 LIMIT 1");
  if (hit.length) {
    const inbox = hit[0];
    // 旧库兜底：早期建的「待办」描述为空，此处补默认值（用户手动改过则不覆盖）
    if (!inbox.descr) {
      await db.execute("UPDATE goals SET descr = ? WHERE id = ?", [INBOX_DESC, inbox.id]);
    }
    // 「待办」是常驻收件箱，状态锁死 active；历史脏数据（曾被误改成暂停/达成/放弃）在此自愈，属数据修正、不记事件
    if (inbox.status !== "active") {
      await db.execute("UPDATE goals SET status = 'active' WHERE id = ?", [inbox.id]);
    }
    return inbox.id;
  }
  const now = Date.now();
  const res = await db.execute(
    "INSERT INTO goals (name, descr, status, inbox, progress, due, color, created_at, updated_at) VALUES (?, ?, 'active', 1, 0, NULL, '#A1A7B3', ?, ?)",
    ["待办", INBOX_DESC, now, now],
  );
  return res.lastInsertId ?? now;
}

/** 新建目标：写 goals + entity_tags，返回拼好的完整条目供页面直接上屏 */
export async function createGoal(body: GoalBody): Promise<ProjectItem> {
  const db = await getDb();
  const now = Date.now();
  const created = dueMs(body.createdAt) ?? now;
  const res = await db.execute(
    "INSERT INTO goals (name, descr, status, inbox, progress, due, color, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)",
    [body.name, body.desc, body.status, body.progress, dueMs(body.due), body.color, created, now],
  );
  const id = res.lastInsertId ?? now;
  for (const tag of body.tags) {
    await db.execute("INSERT OR IGNORE INTO entity_tags (kind, ref_id, tag) VALUES ('goal', ?, ?)", [id, tag]);
  }
  return {
    id, name: body.name, desc: body.desc, status: body.status, tags: [...body.tags], tasks: [],
    progress: body.progress, due: body.due, color: body.color,
    createdAt: body.createdAt, updatedAt: isoLocal(now), versions: [],
  };
}

/** 编辑目标：给到的字段才写，updated_at 一律刷新；tags 给了就整组替换 */
export async function updateGoal(id: number, patch: GoalPatch): Promise<void> {
  const db = await getDb();
  const cols: string[] = ["updated_at = ?"];
  const args: (string | number | null)[] = [Date.now()];
  const add = (col: string, val: string | number | null) => { cols.push(`${col} = ?`); args.push(val); };
  if (patch.name !== undefined) add("name", patch.name);
  if (patch.desc !== undefined) add("descr", patch.desc);
  if (patch.status !== undefined) add("status", patch.status);
  if (patch.progress !== undefined) add("progress", patch.progress);
  if (patch.due !== undefined) add("due", dueMs(patch.due));
  if (patch.color !== undefined) add("color", patch.color);
  if (patch.createdAt !== undefined) add("created_at", dueMs(patch.createdAt));
  args.push(id);
  await db.execute(`UPDATE goals SET ${cols.join(", ")} WHERE id = ?`, args);
  if (patch.tags) {
    await db.execute("DELETE FROM entity_tags WHERE kind = 'goal' AND ref_id = ?", [id]);
    for (const tag of patch.tags) {
      await db.execute("INSERT OR IGNORE INTO entity_tags (kind, ref_id, tag) VALUES ('goal', ?, ?)", [id, tag]);
    }
  }
}

/** 删除目标：数据层显式级联（tasks / goal_versions / 标签 / logs 解绑），不赌插件连接的 foreign_keys 是否生效 */
export async function deleteGoal(id: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM tasks WHERE goal_id = ?", [id]);
  await db.execute("DELETE FROM goal_versions WHERE goal_id = ?", [id]);
  await db.execute("DELETE FROM entity_tags WHERE kind = 'goal' AND ref_id = ?", [id]);
  await db.execute("UPDATE logs SET goal_id = NULL WHERE goal_id = ?", [id]);
  await db.execute("DELETE FROM goals WHERE id = ?", [id]);
}

// ---------- 待办任务 ----------

/** 加一条待办：status 固定 pending（后续流转走 setTaskStatus），返回新任务供上屏 */
export async function addTaskToGoal(
  goalId: number, input: { text: string; urgent: boolean; due: string },
): Promise<Task> {
  const db = await getDb();
  const now = Date.now();
  const res = await db.execute(
    "INSERT INTO tasks (goal_id, text, urgent, due, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
    [goalId, input.text, input.urgent ? 1 : 0, dueMs(input.due), now, now],
  );
  return { id: res.lastInsertId ?? now, text: input.text, urgent: input.urgent, due: input.due, status: "pending" };
}

/** 待办状态流转：done/dropped 写 completed_at，撤销回 pending/confirmed 清成 NULL，updated_at 一律刷新 */
export async function setTaskStatus(id: number, status: TaskStatus): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  const done = status === "done" || status === "dropped";
  await db.execute(
    done
      ? "UPDATE tasks SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?"
      : "UPDATE tasks SET status = ?, updated_at = ?, completed_at = NULL WHERE id = ?",
    done ? [status, now, now, id] : [status, now, id],
  );
}

export async function deleteTask(id: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM tasks WHERE id = ?", [id]);
}

/** 清除某目标下已结束（done/dropped）的待办 */
export async function deleteFinishedTasks(goalId: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM tasks WHERE goal_id = ? AND status IN ('done','dropped')", [goalId]);
}

// ---------- 版本记录 ----------

/** 新增版本记录：最新在上一律由 ORDER BY position DESC 保证，position 统一写 0 */
export async function addVersion(
  goalId: number, input: { title: string; desc: string },
): Promise<VersionEntry> {
  const db = await getDb();
  const res = await db.execute(
    "INSERT INTO goal_versions (goal_id, title, descr, position, created_at) VALUES (?, ?, ?, 0, ?)",
    [goalId, input.title, input.desc, Date.now()],
  );
  return { id: res.lastInsertId ?? Date.now(), title: input.title, desc: input.desc };
}

/** 删一条版本记录（标题页面本地已有，事件摘要由调用方拼） */
export async function removeVersion(id: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM goal_versions WHERE id = ?", [id]);
}

// 让 isoToday 在本模块显式可用（新建/更新时打时间戳）
export { isoToday as today } from "./logs";
