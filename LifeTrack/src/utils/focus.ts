/**
 * 专注会话数据层：SQLite focus_sessions 表 + 时间线 focus.completed 事件
 * （托盘/浮窗计时器的落库点；设计：仓库根 数据库设计.md §2）
 * 完成才写入：中途放弃（<1 分钟或窗内取消）不落库、不留悬挂事件；
 * minutes 由 end_ts - start_ts 派生（四舍五入），写入层负责与两列同步
 */
import { getDb } from "./db";
import { isoToday } from "./logs";
import { addEvent } from "./timeline";

/** 结束一次专注：落 focus_sessions 行 + 时间线事件，返回派生的分钟数 */
export async function recordFocus(input: {
  startTs: number;
  endTs: number;
  taskId?: number;
  /** 事件摘要里「做什么」的文案：任务名优先，否则备注，否则泛称 */
  label: string;
}): Promise<number> {
  const db = await getDb();
  const minutes = Math.max(1, Math.floor((input.endTs - input.startTs) / 60000));
  await db.execute(
    "INSERT INTO focus_sessions (task_id, start_ts, end_ts, minutes) VALUES (?, ?, ?, ?)",
    [input.taskId ?? null, input.startTs, input.endTs, minutes],
  );
  const brief = input.label.length > 30 ? input.label.slice(0, 30) + "\u2026" : input.label;
  await addEvent("focus.completed", `番茄钟 ${minutes} 分钟：${brief}`);
  return minutes;
}

/** 今日累计专注分钟数（大档展示；后续周报聚合同源） */
export async function focusMinutesToday(): Promise<number> {
  const db = await getDb();
  // start_ts 落在哪一天由写入层保证与本地时区一致，这里按毫秒区间筛今日
  const dayStart = new Date(`${isoToday()}T00:00:00`).getTime();
  const dayEnd = dayStart + 86400000;
  const rows = await db.select<{ n: number | null }[]>(
    "SELECT SUM(minutes) AS n FROM focus_sessions WHERE start_ts >= ? AND start_ts < ?",
    [dayStart, dayEnd],
  );
  return rows[0]?.n ?? 0;
}

/** 专注窗的关联待办下拉：全部活跃任务（pending/confirmed）+ 所属目标名 */
export async function activeTasks(): Promise<{ id: number; text: string; goalName: string; status: string }[]> {
  const db = await getDb();
  return db.select(
    `SELECT t.id, t.text, g.name AS goalName, t.status
       FROM tasks t JOIN goals g ON g.id = t.goal_id
      WHERE t.status IN ('pending','confirmed')
      ORDER BY t.status = 'confirmed' DESC, t.id ASC`,
  );
}
