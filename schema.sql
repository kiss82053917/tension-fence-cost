-- =========================================================
--  张力围栏成本工具 · D1 数据库 schema
--  阶段 2.1：用户与会话（鉴权）。项目/设备等表在 2.2 加入。
--  幂等：可重复执行（IF NOT EXISTS）。
-- =========================================================

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  username   TEXT NOT NULL UNIQUE,
  pwd        TEXT NOT NULL,                 -- pbkdf2$<iters>$<saltHex>$<hashHex>
  role       TEXT NOT NULL DEFAULT 'user',  -- 'admin' | 'user'
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ----- 阶段 2.2：项目数据 -----
-- 项目；普通用户通过 project_members 关联访问，admin 可见全部。
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  customer    TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- 项目成员（多对多）
CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
);

-- 设备（隶属项目）
CREATE TABLE IF NOT EXISTS equipment (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '设备',
  sets       INTEGER NOT NULL DEFAULT 1,
  mode       TEXT NOT NULL DEFAULT 'double',  -- 'double' | 'single'
  zones      TEXT NOT NULL DEFAULT '[]',      -- JSON: [{name,length}]
  pos        INTEGER NOT NULL DEFAULT 0,       -- 列表排序
  updated_at INTEGER NOT NULL
);

-- 自定义子项（隶属项目）
CREATE TABLE IF NOT EXISTS custom_items (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  sec         TEXT NOT NULL DEFAULT '其他自定义',
  name        TEXT NOT NULL DEFAULT '',
  spec        TEXT NOT NULL DEFAULT '',
  unit        TEXT NOT NULL DEFAULT '个',
  qty         REAL NOT NULL DEFAULT 0,
  qty_formula TEXT,
  price       REAL NOT NULL DEFAULT 0,
  note        TEXT NOT NULL DEFAULT '',
  pos         INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

-- 全局共享设置：params（产品规格）/ prices（单价覆盖）/ formulas（公式覆盖）/ cparams（自定义参数）
-- 注：这些在阶段一即为全局共享，沿用此语义；按项目隔离的是项目/设备/自定义项。
CREATE TABLE IF NOT EXISTS settings (
  k          TEXT PRIMARY KEY,   -- 'params' | 'prices' | 'formulas' | 'cparams'
  v          TEXT NOT NULL,      -- JSON
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_members_user    ON project_members(user_id);
CREATE INDEX IF NOT EXISTS idx_equipment_proj  ON equipment(project_id);
CREATE INDEX IF NOT EXISTS idx_custom_proj      ON custom_items(project_id);

-- ----- 阶段三：操作日志 + 版本快照 -----
-- 操作日志：谁、何时、改了什么（价格/公式记改前改后）
CREATE TABLE IF NOT EXISTS logs (
  id         TEXT PRIMARY KEY,
  ts         INTEGER NOT NULL,
  user_id    TEXT,
  username   TEXT,
  action     TEXT NOT NULL,        -- 短动作文案，如「新建项目」「改单价」
  detail     TEXT,                 -- JSON：{text} 或 {row,before,after} 等
  project_id TEXT,                 -- 关联项目（全局设置类为空）
  target     TEXT                  -- 目标名（项目名/用户名/设备名等）
);
CREATE INDEX IF NOT EXISTS idx_logs_ts      ON logs(ts);
CREATE INDEX IF NOT EXISTS idx_logs_project ON logs(project_id);

-- 项目版本快照（手动存档 / 自动检查点 / 回滚前自动备份）
CREATE TABLE IF NOT EXISTS snapshots (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  label      TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'manual',  -- manual | auto | prerollback
  created_at INTEGER NOT NULL,
  created_by TEXT,
  username   TEXT,
  data       TEXT NOT NULL          -- JSON：{project:{...}, equipment:[...], custom:[...]}
);
CREATE INDEX IF NOT EXISTS idx_snap_project ON snapshots(project_id);
