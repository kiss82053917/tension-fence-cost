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
