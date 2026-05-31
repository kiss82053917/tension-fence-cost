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

-- 项目成员（多对多）。can_view_amount：是否可见合同金额（0=金额打码）
CREATE TABLE IF NOT EXISTS project_members (
  project_id      TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  added_at        INTEGER NOT NULL,
  can_view_amount INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (project_id, user_id)
);

-- 设备（隶属项目）
CREATE TABLE IF NOT EXISTS equipment (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '设备',
  sets        INTEGER NOT NULL DEFAULT 1,
  mode        TEXT NOT NULL DEFAULT 'double',  -- 'double' | 'single'（旧字段，模板上线后由模板决定）
  template_id TEXT,                            -- 所用模板 id（模板存于 settings.templates）
  zones       TEXT NOT NULL DEFAULT '[]',      -- JSON: [{name,length}]
  pos         INTEGER NOT NULL DEFAULT 0,       -- 列表排序
  updated_at  INTEGER NOT NULL
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

-- ----- 合同管理（采购 + 销售合一，按 kind 区分） -----
-- 采购付款：预付款/发货款/尾款；销售付款：预付款/阶段一/阶段二/尾款。比例存通用列。
CREATE TABLE IF NOT EXISTS contracts (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL DEFAULT 'purchase',  -- 'purchase' | 'sales'
  project_id   TEXT,                              -- 所属项目（FK projects.id）
  project_name TEXT NOT NULL DEFAULT '',          -- 冗余项目名（显示/迁移用）
  name         TEXT NOT NULL DEFAULT '',          -- 合同名称
  code         TEXT NOT NULL DEFAULT '',          -- 合同编号
  party_a      TEXT NOT NULL DEFAULT '',          -- 采购方 / 客户公司
  party_b      TEXT NOT NULL DEFAULT '',          -- 供应商 / 签订公司
  amount       REAL NOT NULL DEFAULT 0,           -- 合同总金额（元）
  pct_prepay   REAL NOT NULL DEFAULT 0,           -- 预付款比例
  pct_delivery REAL NOT NULL DEFAULT 0,           -- 发货款比例（采购）
  pct_stage1   REAL NOT NULL DEFAULT 0,           -- 阶段一验收款比例（销售）
  pct_stage2   REAL NOT NULL DEFAULT 0,           -- 阶段二验收款比例（销售）
  pct_final    REAL NOT NULL DEFAULT 0,           -- 尾款比例
  start_date   TEXT NOT NULL DEFAULT '',
  end_date     TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT '',          -- 合同状态
  invoiced     TEXT NOT NULL DEFAULT '',          -- 开票情况（逗号分隔）
  paid         TEXT NOT NULL DEFAULT '',          -- 付款情况（逗号分隔）
  note         TEXT NOT NULL DEFAULT '',
  pos          INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contracts_project ON contracts(project_id);

-- 合同附件（合同/发票/支付凭证）。r2_key 在 R2 迁移后填入
CREATE TABLE IF NOT EXISTS contract_files (
  id          TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'contract',   -- 'contract' | 'invoice' | 'payment'
  filename    TEXT NOT NULL DEFAULT '',
  mimetype    TEXT NOT NULL DEFAULT '',
  size        INTEGER NOT NULL DEFAULT 0,
  r2_key      TEXT NOT NULL DEFAULT '',            -- R2 对象键（空=未迁移）
  source_path TEXT NOT NULL DEFAULT '',            -- NocoDB 永久路径（备用）
  pos         INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cfiles_contract ON contract_files(contract_id);
