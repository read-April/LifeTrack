-- 0001_init：全量建表（设计：仓库根 数据库设计.md §2）
-- 说明：
-- * 迁移由 tauri-plugin-sql 在 Database.load 时按版本执行，插件已包事务，
--   故此处不放 PRAGMA（journal_mode=WAL 需在事务外切换；foreign_keys 是连接级设置）。
-- * foreign_keys 在插件连接上不保证生效，级联删除由数据层显式执行，FK 声明仅作约束与文档。
-- * 时间戳统一 INTEGER 毫秒；date TEXT 是按天分组的派生冗余，写入层负责与 ts 同步。
-- * 列名用 descr 而非 desc，避开 SQL 关键字。

-- 目标 / 项目
CREATE TABLE IF NOT EXISTS goals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  descr       TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'active'
              CHECK (status IN ('active','paused','done','dropped')),
  inbox       INTEGER NOT NULL DEFAULT 0,
  progress    INTEGER NOT NULL DEFAULT 0,
  due         INTEGER,
  color       TEXT    NOT NULL DEFAULT '#17A17D',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
-- 目标名全局唯一（含内置「待办」）：NOCASE 避开纯大小写重复
CREATE UNIQUE INDEX IF NOT EXISTS idx_goals_name ON goals(name COLLATE NOCASE);
-- 内置「收件箱」至多一条：部分唯一索引库层兜底（数据层 ensureInbox 先查后插防不住意外双写）
CREATE UNIQUE INDEX IF NOT EXISTS idx_goals_inbox ON goals(inbox) WHERE inbox = 1;

-- 目标的版本记录（详情页手动维护，最新在前）
CREATE TABLE IF NOT EXISTS goal_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id    INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  title      TEXT    NOT NULL,
  descr      TEXT    NOT NULL DEFAULT '',
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goal_versions_goal ON goal_versions(goal_id, position DESC);

-- 待办（目标下的"子"，四态状态机）
CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id       INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  text          TEXT    NOT NULL,
  urgent        INTEGER NOT NULL DEFAULT 0,
  due           INTEGER,
  status        TEXT    NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','confirmed','done','dropped')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  completed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_goal   ON tasks(goal_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks(status, due);

-- 随记（时间轴基本单位）。kind=单选视觉分类；tags 在 entity_tags，互不替代
CREATE TABLE IF NOT EXISTS logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER REFERENCES goals(id) ON DELETE SET NULL,
  ts      INTEGER NOT NULL,
  date    TEXT    NOT NULL,
  text    TEXT    NOT NULL,
  kind    TEXT    NOT NULL DEFAULT '技术'
          CHECK (kind IN ('技术','项目','学习','回顾','问题','生活')),
  updated_at INTEGER NOT NULL                       -- 毫秒；创建时 = ts，编辑正文时刷新
);
CREATE INDEX IF NOT EXISTS idx_logs_date ON logs(date);
CREATE INDEX IF NOT EXISTS idx_logs_goal ON logs(goal_id);

-- 自由标签：目标与随记共用（不设固定枚举，用于筛选/聚合）
CREATE TABLE IF NOT EXISTS entity_tags (
  kind    TEXT    NOT NULL CHECK (kind IN ('goal','log')),
  ref_id  INTEGER NOT NULL,
  tag     TEXT    NOT NULL,
  PRIMARY KEY (kind, ref_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON entity_tags(tag);

-- 时间线脊梁：append-only。type 为封闭枚举，新增必须走新迁移
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT    NOT NULL CHECK (type IN (
    'log.created','log.updated','log.removed',
    'task.created','task.confirmed','task.completed','task.reopened','task.dropped','task.removed',
    'goal.created','goal.status_changed','goal.version_added','goal.version_removed','goal.removed',
    'report.saved',
    'milestone.marked','milestone.unmarked',
    'focus.completed'
  )),
  ts          INTEGER NOT NULL,
  date        TEXT    NOT NULL,
  summary     TEXT    NOT NULL,
  ref_id      INTEGER REFERENCES events(id) ON DELETE SET NULL,
  source_kind TEXT    CHECK (source_kind IS NULL OR source_kind IN ('log','task','goal','report')),
  source_id   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_ts   ON events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_ref  ON events(ref_id);

-- 报告正文（数字不落库，从 logs/tasks 实时聚合）
-- 整数代理键 id 供 events.source_id 引用（与其余实体统一整数口径）；period_key 仍是应用层唯一标识
CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  period_key  TEXT    NOT NULL UNIQUE,
  mode        TEXT    NOT NULL CHECK (mode IN ('week','month','year')),
  text        TEXT    NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL
);

-- 专注会话（托盘/浮窗计时器的落库点）：完成才写入，中途放弃不留记录；
-- minutes 由 end_ts-start_ts 派生（写入层负责），供报告聚合"实际投入时长"
CREATE TABLE IF NOT EXISTS focus_sessions (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id  INTEGER REFERENCES tasks(id) ON DELETE SET NULL,  -- 可选关联待办；删任务不断链（SET NULL）
  start_ts INTEGER NOT NULL,                                 -- 毫秒
  end_ts   INTEGER NOT NULL,
  minutes  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_focus_start ON focus_sessions(start_ts);

-- 偏好设置 KV（从 localStorage 搬进库；读取按 type 反序列化）
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  type  TEXT NOT NULL DEFAULT 'string' CHECK (type IN ('string','number','boolean','json')),
  value TEXT NOT NULL
);
