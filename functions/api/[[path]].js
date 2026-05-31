/* =========================================================
 *  张力围栏成本工具 · 后端 API（Cloudflare Pages Functions + D1）
 *  阶段 2.1：鉴权与用户管理
 *
 *  路由（均挂在 /api 下，由本 catch-all 处理）：
 *    POST   /api/login            { username, password }      登录，发会话 cookie
 *    POST   /api/logout                                       注销
 *    GET    /api/me                                           当前登录用户（未登录返回 user:null）
 *    GET    /api/users                                        用户列表（仅 admin）
 *    POST   /api/users            { username, password, role} 新建用户（仅 admin）
 *    PATCH  /api/users/:id        { username, role }          编辑用户（仅 admin，admin 账号受保护）
 *    DELETE /api/users/:id                                    删除用户（仅 admin，禁删 admin 与自己）
 *    POST   /api/users/:id/reset  { password }                重置密码（仅 admin）
 *
 *  会话：登录成功在 sessions 表生成随机 token，写入 HttpOnly cookie `tf_sid`。
 *  密码：PBKDF2-SHA256（每用户随机 salt），存为 pbkdf2$<iters>$<saltHex>$<hashHex>。
 *  首次访问（users 表为空）自动种入超级管理员 admin / adminyy。
 * ========================================================= */

const ENC = new TextEncoder();
const PBKDF2_ITERS = 100000;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 天
const NAME_RE = /^[\w.@-]{1,40}$/;

/* ---------- 响应助手 ---------- */
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}
const bad = (msg, status = 400) => json({ error: msg }, status);
async function readJson(request) {
  try { return await request.json(); } catch (e) { return {}; }
}

/* ---------- 编码助手 ---------- */
function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(s) {
  const a = new Uint8Array(s.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(s.substr(i * 2, 2), 16);
  return a;
}

/* ---------- 密码哈希（PBKDF2-SHA256） ---------- */
async function hashPassword(password, saltBytes) {
  const salt = saltBytes || crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", ENC.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERS, hash: "SHA-256" }, key, 256);
  return `pbkdf2$${PBKDF2_ITERS}$${toHex(salt)}$${toHex(bits)}`;
}
async function verifyPassword(password, stored) {
  try {
    const [scheme, iters, saltHex, hashHex] = String(stored).split("$");
    if (scheme !== "pbkdf2") return false;
    const key = await crypto.subtle.importKey("raw", ENC.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: fromHex(saltHex), iterations: +iters, hash: "SHA-256" }, key, 256);
    return toHex(bits) === hashHex;
  } catch (e) { return false; }
}

/* ---------- Cookie / 会话 ---------- */
function getCookie(request, name) {
  const c = request.headers.get("Cookie") || "";
  const m = c.match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}
function sessionCookie(token, expires, secure) {
  const maxAge = Math.max(0, Math.floor((expires - Date.now()) / 1000));
  return `tf_sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}` + (secure ? "; Secure" : "");
}
function clearCookie(secure) {
  return `tf_sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0` + (secure ? "; Secure" : "");
}
async function createSession(db, userId) {
  const token = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
  const expires = Date.now() + SESSION_TTL_MS;
  await db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)")
    .bind(token, userId, expires).run();
  return { token, expires };
}
async function getSessionUser(db, request) {
  const token = getCookie(request, "tf_sid");
  if (!token) return null;
  const row = await db.prepare(
    "SELECT u.id, u.username, u.role, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?"
  ).bind(token).first();
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await db.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
    return null;
  }
  return { id: row.id, username: row.username, role: row.role };
}

/* ---------- 首次种入超级管理员 ---------- */
async function ensureSeed(db) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM users").first();
  if (row && row.n > 0) return;
  const pwd = await hashPassword("adminyy");
  await db.prepare("INSERT INTO users (id, username, pwd, role, created_at) VALUES (?,?,?,?,?)")
    .bind(crypto.randomUUID(), "admin", pwd, "admin", Date.now()).run();
}

/* ---------- 项目访问控制 ---------- */
// admin 可访问任意存在的项目；普通用户需为该项目成员
async function projectAccessible(db, me, projectId) {
  if (me.role === "admin") {
    return !!(await db.prepare("SELECT 1 FROM projects WHERE id = ?").bind(projectId).first());
  }
  return !!(await db.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?")
    .bind(projectId, me.id).first());
}
// 由设备 / 自定义项 id 找到其所属项目 id
async function ownerProjectId(db, table, id) {
  const r = await db.prepare(`SELECT project_id FROM ${table} WHERE id = ?`).bind(id).first();
  return r ? r.project_id : null;
}

/* ---------- 操作日志 ---------- */
async function logIt(db, me, action, opts = {}) {
  try {
    await db.prepare("INSERT INTO logs (id, ts, user_id, username, action, detail, project_id, target) VALUES (?,?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), Date.now(), me ? me.id : null, me ? me.username : null,
            action, opts.detail ? JSON.stringify(opts.detail) : null,
            opts.projectId || null, opts.target || null).run();
  } catch (e) { /* 日志失败不影响主流程 */ }
}

/* ---------- 项目快照：抓取当前项目的全部数据 ---------- */
async function captureProject(db, pid) {
  const project = await db.prepare("SELECT id, name, customer, description FROM projects WHERE id = ?").bind(pid).first();
  const equipment = (await db.prepare("SELECT id, name, sets, mode, template_id, zones, pos FROM equipment WHERE project_id = ? ORDER BY pos ASC").bind(pid).all()).results;
  const custom = (await db.prepare("SELECT id, sec, name, spec, unit, qty, qty_formula, price, note, pos FROM custom_items WHERE project_id = ? ORDER BY pos ASC").bind(pid).all()).results;
  return { project, equipment, custom };
}
async function makeSnapshot(db, me, pid, label, kind) {
  const data = await captureProject(db, pid);
  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO snapshots (id, project_id, label, kind, created_at, created_by, username, data) VALUES (?,?,?,?,?,?,?,?)")
    .bind(id, pid, label, kind || "manual", Date.now(), me ? me.id : null, me ? me.username : null, JSON.stringify(data)).run();
  return id;
}

/* ---------- 合同模块：建表 + 给成员补「可见金额」列（运行时自愈，免手动迁移） ---------- */
let _schemaReady = false;
async function ensureSchema(db) {
  if (_schemaReady) return;
  const stmts = [
    `CREATE TABLE IF NOT EXISTS contracts (
       id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'purchase',
       project_id TEXT, project_name TEXT NOT NULL DEFAULT '',
       name TEXT NOT NULL DEFAULT '', code TEXT NOT NULL DEFAULT '',
       party_a TEXT NOT NULL DEFAULT '', party_b TEXT NOT NULL DEFAULT '',
       amount REAL NOT NULL DEFAULT 0,
       pct_prepay REAL NOT NULL DEFAULT 0, pct_delivery REAL NOT NULL DEFAULT 0,
       pct_stage1 REAL NOT NULL DEFAULT 0, pct_stage2 REAL NOT NULL DEFAULT 0,
       pct_final REAL NOT NULL DEFAULT 0,
       start_date TEXT NOT NULL DEFAULT '', end_date TEXT NOT NULL DEFAULT '',
       status TEXT NOT NULL DEFAULT '', invoiced TEXT NOT NULL DEFAULT '', paid TEXT NOT NULL DEFAULT '',
       note TEXT NOT NULL DEFAULT '', pos INTEGER NOT NULL DEFAULT 0,
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL )`,
    `CREATE INDEX IF NOT EXISTS idx_contracts_project ON contracts(project_id)`,
    `CREATE TABLE IF NOT EXISTS contract_files (
       id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'contract',
       filename TEXT NOT NULL DEFAULT '', mimetype TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0,
       r2_key TEXT NOT NULL DEFAULT '', source_path TEXT NOT NULL DEFAULT '', pos INTEGER NOT NULL DEFAULT 0,
       created_at INTEGER NOT NULL )`,
    `CREATE INDEX IF NOT EXISTS idx_cfiles_contract ON contract_files(contract_id)`,
  ];
  for (const s of stmts) await db.prepare(s).run();
  try { await db.prepare("ALTER TABLE project_members ADD COLUMN can_view_amount INTEGER NOT NULL DEFAULT 1").run(); }
  catch (e) { /* 列已存在 */ }
  _schemaReady = true;
}
// 合同访问：admin 全可见；普通用户需为该项目成员，并按成员的 can_view_amount 决定能否看金额
async function contractAccess(db, me, projectId) {
  if (me.role === "admin") return { ok: true, amount: true };
  if (!projectId) return { ok: false, amount: false };
  const m = await db.prepare("SELECT can_view_amount FROM project_members WHERE project_id=? AND user_id=?")
    .bind(projectId, me.id).first();
  if (!m) return { ok: false, amount: false };
  return { ok: true, amount: m.can_view_amount !== 0 };
}
// 把一条合同行整理成前端对象；无金额权限则金额置空并打标
function shapeContract(row, canAmount) {
  const o = {
    id: row.id, kind: row.kind, projectId: row.project_id, projectName: row.project_name,
    name: row.name, code: row.code, partyA: row.party_a, partyB: row.party_b,
    pctPrepay: row.pct_prepay, pctDelivery: row.pct_delivery, pctStage1: row.pct_stage1,
    pctStage2: row.pct_stage2, pctFinal: row.pct_final,
    startDate: row.start_date, endDate: row.end_date, status: row.status,
    invoiced: row.invoiced, paid: row.paid, note: row.note, pos: row.pos,
    updatedAt: row.updated_at,
  };
  if (canAmount) { o.amount = row.amount; o.amountHidden = false; }
  else { o.amount = null; o.amountHidden = true; }
  return o;
}

/* =========================================================
 *  入口
 * ========================================================= */
export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;
  if (!db) return json({ error: '数据库未绑定：缺少 D1 binding "DB"' }, 500);

  const secure = new URL(request.url).protocol === "https:";
  const segs = context.params.path || [];   // /api 之后的路径段
  const method = request.method;

  try {
    await ensureSeed(db);
    await ensureSchema(db);
  } catch (e) {
    return json({ error: "数据库初始化失败：" + e.message + "（是否已执行 schema.sql？）" }, 500);
  }

  /* ---- 登录 ---- */
  if (segs[0] === "login" && method === "POST") {
    const body = await readJson(request);
    const username = (body.username || "").trim();
    const password = body.password || "";
    if (!username || !password) return bad("用户名或密码不能为空");
    const u = await db.prepare("SELECT * FROM users WHERE username = ?").bind(username).first();
    if (!u || !(await verifyPassword(password, u.pwd))) return bad("用户名或密码错误", 401);
    const { token, expires } = await createSession(db, u.id);
    return json({ user: { username: u.username, role: u.role } }, 200,
      { "Set-Cookie": sessionCookie(token, expires, secure) });
  }

  /* ---- 注销 ---- */
  if (segs[0] === "logout" && method === "POST") {
    const token = getCookie(request, "tf_sid");
    if (token) await db.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie(secure) });
  }

  const me = await getSessionUser(db, request);

  /* ---- 当前用户 ---- */
  if (segs[0] === "me" && method === "GET") {
    return json({ user: me ? { username: me.username, role: me.role } : null });
  }

  if (!me) return bad("未登录", 401);

  /* ---- 用户管理（仅 admin） ---- */
  if (segs[0] === "users") {
    if (me.role !== "admin") return bad("需要管理员权限", 403);

    // 列表
    if (segs.length === 1 && method === "GET") {
      const { results } = await db.prepare(
        "SELECT id, username, role, created_at FROM users ORDER BY created_at ASC").all();
      return json({ users: results });
    }
    // 新建
    if (segs.length === 1 && method === "POST") {
      const body = await readJson(request);
      const username = (body.username || "").trim();
      const role = body.role === "admin" ? "admin" : "user";
      const password = (body.password || "");
      if (!username) return bad("用户名不能为空");
      if (!NAME_RE.test(username)) return bad("用户名只能含字母、数字及 . _ - @，最多 40 字");
      if (!password.trim()) return bad("请设置初始密码");
      const exists = await db.prepare("SELECT 1 FROM users WHERE username = ?").bind(username).first();
      if (exists) return bad("用户名已存在");
      const id = crypto.randomUUID();
      const pwd = await hashPassword(password.trim());
      await db.prepare("INSERT INTO users (id, username, pwd, role, created_at) VALUES (?,?,?,?,?)")
        .bind(id, username, pwd, role, Date.now()).run();
      await logIt(db, me, "新建用户", { target: username });
      return json({ user: { id, username, role } });
    }

    const id = segs[1];
    if (id) {
      const target = await db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
      if (!target) return bad("用户不存在", 404);
      const isSuper = target.username === "admin";

      // 重置密码
      if (segs[2] === "reset" && method === "POST") {
        const body = await readJson(request);
        const np = (body.password || "").trim();
        if (!np) return bad("密码不能为空");
        const pwd = await hashPassword(np);
        await db.prepare("UPDATE users SET pwd = ? WHERE id = ?").bind(pwd, id).run();
        // 注销该用户的其他会话（保留当前管理员会话）
        const curToken = getCookie(request, "tf_sid") || "";
        await db.prepare("DELETE FROM sessions WHERE user_id = ? AND token <> ?").bind(id, curToken).run();
        await logIt(db, me, "重置密码", { target: target.username });
        return json({ ok: true });
      }
      // 编辑
      if (segs.length === 2 && method === "PATCH") {
        if (isSuper) return bad("超级管理员不可编辑", 403);
        const body = await readJson(request);
        const newName = (body.username || "").trim();
        const newRole = body.role === "admin" ? "admin" : "user";
        if (!newName) return bad("用户名不能为空");
        if (!NAME_RE.test(newName)) return bad("用户名格式不合法");
        if (newName !== target.username) {
          const dup = await db.prepare("SELECT 1 FROM users WHERE username = ? AND id <> ?").bind(newName, id).first();
          if (dup) return bad("用户名已存在");
        }
        await db.prepare("UPDATE users SET username = ?, role = ? WHERE id = ?").bind(newName, newRole, id).run();
        await logIt(db, me, "编辑用户", { target: newName });
        return json({ user: { id, username: newName, role: newRole } });
      }
      // 删除
      if (segs.length === 2 && method === "DELETE") {
        if (isSuper) return bad("超级管理员不可删除", 403);
        if (id === me.id) return bad("不能删除当前登录账号", 403);
        await db.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
        await logIt(db, me, "删除用户", { target: target.username });
        return json({ ok: true });
      }
    }
  }

  /* ---- 一次性拉取当前用户可见的全部数据（前端启动用） ---- */
  if (segs[0] === "bootstrap" && method === "GET") {
    let projects, equipment, custom;
    if (me.role === "admin") {
      projects  = (await db.prepare("SELECT * FROM projects ORDER BY created_at ASC").all()).results;
      equipment = (await db.prepare("SELECT * FROM equipment ORDER BY pos ASC, updated_at ASC").all()).results;
      custom    = (await db.prepare("SELECT * FROM custom_items ORDER BY pos ASC, updated_at ASC").all()).results;
    } else {
      projects  = (await db.prepare("SELECT p.* FROM projects p JOIN project_members m ON m.project_id=p.id WHERE m.user_id=? ORDER BY p.created_at ASC").bind(me.id).all()).results;
      equipment = (await db.prepare("SELECT e.* FROM equipment e JOIN project_members m ON m.project_id=e.project_id WHERE m.user_id=? ORDER BY e.pos ASC, e.updated_at ASC").bind(me.id).all()).results;
      custom    = (await db.prepare("SELECT c.* FROM custom_items c JOIN project_members m ON m.project_id=c.project_id WHERE m.user_id=? ORDER BY c.pos ASC, c.updated_at ASC").bind(me.id).all()).results;
    }
    equipment.forEach(e => { try { e.zones = JSON.parse(e.zones); } catch (x) { e.zones = []; } });
    const srows = (await db.prepare("SELECT k, v FROM settings").all()).results;
    const settings = { params: {}, prices: {}, specs: {}, materials: {}, labels: {}, formulas: {}, cparams: [], templates: [] };
    for (const r of srows) { try { settings[r.k] = JSON.parse(r.v); } catch (x) {} }
    return json({ projects, equipment, custom, settings });
  }

  /* ---- 操作日志 ---- */
  if (segs[0] === "logs" && method === "GET") {
    const limit = Math.min(500, +(new URL(request.url).searchParams.get("limit")) || 200);
    let rows;
    if (me.role === "admin") {
      rows = (await db.prepare("SELECT * FROM logs ORDER BY ts DESC LIMIT ?").bind(limit).all()).results;
    } else {
      rows = (await db.prepare(
        "SELECT l.* FROM logs l WHERE l.user_id = ? OR l.project_id IN " +
        "(SELECT project_id FROM project_members WHERE user_id = ?) ORDER BY l.ts DESC LIMIT ?")
        .bind(me.id, me.id, limit).all()).results;
    }
    rows.forEach(r => { if (r.detail) { try { r.detail = JSON.parse(r.detail); } catch (e) {} } });
    return json({ logs: rows });
  }

  /* ---- 全局共享设置（任何登录用户可读写，后写为准） ---- */
  if (segs[0] === "settings") {
    if (segs.length === 1 && method === "GET") {
      const { results } = await db.prepare("SELECT k, v FROM settings").all();
      const out = { params: {}, prices: {}, specs: {}, materials: {}, labels: {}, formulas: {}, cparams: [], templates: [] };
      for (const row of results) { try { out[row.k] = JSON.parse(row.v); } catch (e) {} }
      return json(out);
    }
    if (segs.length === 2 && method === "PUT") {
      const key = segs[1];
      if (!["params", "prices", "specs", "materials", "labels", "formulas", "cparams", "templates"].includes(key)) return bad("未知设置键");
      const value = await readJson(request);           // 请求体即为要保存的值（对象或数组）
      const oldRow = await db.prepare("SELECT v FROM settings WHERE k = ?").bind(key).first();
      let oldVal; try { oldVal = oldRow ? JSON.parse(oldRow.v) : undefined; } catch (e) { oldVal = undefined; }
      await db.prepare(
        "INSERT INTO settings (k, v, updated_at) VALUES (?,?,?) " +
        "ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at")
        .bind(key, JSON.stringify(value), Date.now()).run();
      // 改前改后日志
      if (key === "prices" || key === "formulas") {
        const action = key === "prices" ? "改单价" : "改公式";
        const ov = oldVal || {}, nv = value || {};
        for (const rk of new Set([...Object.keys(ov), ...Object.keys(nv)])) {
          if (JSON.stringify(ov[rk]) !== JSON.stringify(nv[rk]))
            await logIt(db, me, action, { detail: { row: +rk, before: ov[rk] === undefined ? null : ov[rk], after: nv[rk] === undefined ? null : nv[rk] } });
        }
      } else if (key === "params" && oldVal) {   // 仅对已有键的真实改动记日志（避免首次填充刷屏）
        const nv = value || {};
        for (const pk of Object.keys(oldVal)) {
          if (JSON.stringify(oldVal[pk]) !== JSON.stringify(nv[pk]))
            await logIt(db, me, "改参数", { detail: { param: pk, before: oldVal[pk], after: nv[pk] === undefined ? null : nv[pk] } });
        }
      }
      return json({ ok: true });
    }
  }

  /* ---- 项目 ---- */
  if (segs[0] === "projects") {
    // 列表（admin 全部；普通用户仅被分配的）
    if (segs.length === 1 && method === "GET") {
      const q = me.role === "admin"
        ? db.prepare("SELECT * FROM projects ORDER BY created_at ASC")
        : db.prepare("SELECT p.* FROM projects p JOIN project_members m ON m.project_id = p.id " +
                     "WHERE m.user_id = ? ORDER BY p.created_at ASC").bind(me.id);
      const { results } = await q.all();
      return json({ projects: results });
    }
    // 新建（创建者自动成为成员）
    if (segs.length === 1 && method === "POST") {
      const body = await readJson(request);
      const name = (body.name || "").trim();
      if (!name) return bad("项目名称不能为空");
      const id = (typeof body.id === "string" && body.id) ? body.id : crypto.randomUUID();
      const now = Date.now();
      await db.prepare("INSERT INTO projects (id, name, customer, description, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
        .bind(id, name, (body.customer || "").trim(), (body.description || "").trim(), me.id, now, now).run();
      await db.prepare("INSERT INTO project_members (project_id, user_id, added_at) VALUES (?,?,?)")
        .bind(id, me.id, now).run();
      await logIt(db, me, "新建项目", { projectId: id, target: name });
      return json({ project: { id, name, customer: (body.customer || "").trim(), description: (body.description || "").trim(), created_at: now, updated_at: now } });
    }

    const pid = segs[1];
    if (pid) {
      if (!(await projectAccessible(db, me, pid))) return bad("无权访问该项目或项目不存在", 403);

      /* 项目成员 */
      if (segs[2] === "members") {
        // 列表（成员/admin 可看）
        if (segs.length === 3 && method === "GET") {
          const { results } = await db.prepare(
            "SELECT u.id, u.username, u.role, m.added_at, m.can_view_amount FROM project_members m " +
            "JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY m.added_at ASC")
            .bind(pid).all();
          return json({ members: results });
        }
        // 添加成员（仅 admin）
        if (segs.length === 3 && method === "POST") {
          if (me.role !== "admin") return bad("需要管理员权限", 403);
          const body = await readJson(request);
          const userId = body.userId || "";
          const u = await db.prepare("SELECT id, username FROM users WHERE id = ?").bind(userId).first();
          if (!u) return bad("用户不存在", 404);
          const cva = body.canViewAmount === false ? 0 : 1;
          await db.prepare("INSERT OR IGNORE INTO project_members (project_id, user_id, added_at, can_view_amount) VALUES (?,?,?,?)")
            .bind(pid, userId, Date.now(), cva).run();
          await db.prepare("UPDATE project_members SET can_view_amount=? WHERE project_id=? AND user_id=?")
            .bind(cva, pid, userId).run();
          await logIt(db, me, "添加成员", { projectId: pid, target: u.username });
          return json({ ok: true });
        }
        // 改成员的「可见金额」权限（仅 admin）
        if (segs.length === 4 && method === "PATCH") {
          if (me.role !== "admin") return bad("需要管理员权限", 403);
          const body = await readJson(request);
          const cva = body.canViewAmount === false ? 0 : 1;
          await db.prepare("UPDATE project_members SET can_view_amount=? WHERE project_id=? AND user_id=?")
            .bind(cva, pid, segs[3]).run();
          return json({ ok: true });
        }
        // 移除成员（仅 admin）
        if (segs.length === 4 && method === "DELETE") {
          if (me.role !== "admin") return bad("需要管理员权限", 403);
          const rmU = await db.prepare("SELECT username FROM users WHERE id = ?").bind(segs[3]).first();
          await db.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?")
            .bind(pid, segs[3]).run();
          await logIt(db, me, "移除成员", { projectId: pid, target: rmU ? rmU.username : segs[3] });
          return json({ ok: true });
        }
      }

      /* 项目版本快照 / 回滚 */
      if (segs[2] === "snapshots") {
        if (segs.length === 3 && method === "GET") {
          const { results } = await db.prepare(
            "SELECT id, label, kind, created_at, username FROM snapshots WHERE project_id = ? ORDER BY created_at DESC")
            .bind(pid).all();
          return json({ snapshots: results });
        }
        if (segs.length === 3 && method === "POST") {
          const body = await readJson(request);
          const label = (body.label || "存档").trim() || "存档";
          const id = await makeSnapshot(db, me, pid, label, body.kind === "auto" ? "auto" : "manual");
          await logIt(db, me, "保存版本", { projectId: pid, target: label });
          return json({ id });
        }
        if (segs.length === 5 && segs[4] === "rollback" && method === "POST") {
          const snap = await db.prepare("SELECT * FROM snapshots WHERE id = ? AND project_id = ?").bind(segs[3], pid).first();
          if (!snap) return bad("快照不存在", 404);
          let data; try { data = JSON.parse(snap.data); } catch (e) { return bad("快照数据损坏", 500); }
          // 回滚前先自动存一份当前状态，可反悔
          await makeSnapshot(db, me, pid, "回滚前自动备份", "prerollback");
          const now = Date.now();
          const stmts = [
            db.prepare("DELETE FROM equipment WHERE project_id = ?").bind(pid),
            db.prepare("DELETE FROM custom_items WHERE project_id = ?").bind(pid),
          ];
          (data.equipment || []).forEach(e => stmts.push(
            db.prepare("INSERT INTO equipment (id, project_id, name, sets, mode, template_id, zones, pos, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
              .bind(e.id, pid, e.name, e.sets, e.mode, e.template_id || null, typeof e.zones === "string" ? e.zones : JSON.stringify(e.zones || []), e.pos || 0, now)));
          (data.custom || []).forEach(c => stmts.push(
            db.prepare("INSERT INTO custom_items (id, project_id, sec, name, spec, unit, qty, qty_formula, price, note, pos, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
              .bind(c.id, pid, c.sec, c.name, c.spec, c.unit, c.qty, c.qty_formula || null, c.price, c.note, c.pos || 0, now)));
          if (data.project) stmts.push(
            db.prepare("UPDATE projects SET name=?, customer=?, description=?, updated_at=? WHERE id=?")
              .bind(data.project.name, data.project.customer || "", data.project.description || "", now, pid));
          await db.batch(stmts);
          await logIt(db, me, "回滚版本", { projectId: pid, target: snap.label });
          return json({ ok: true });
        }
      }

      /* 项目下的设备 */
      if (segs[2] === "equipment") {
        if (segs.length === 3 && method === "GET") {
          const { results } = await db.prepare(
            "SELECT * FROM equipment WHERE project_id = ? ORDER BY pos ASC, updated_at ASC").bind(pid).all();
          results.forEach(r => { try { r.zones = JSON.parse(r.zones); } catch (e) { r.zones = []; } });
          return json({ equipment: results });
        }
        if (segs.length === 3 && method === "POST") {
          const body = await readJson(request);
          const id = (typeof body.id === "string" && body.id) ? body.id : crypto.randomUUID();
          const zones = Array.isArray(body.zones) ? body.zones : [];
          const now = Date.now();
          await db.prepare("INSERT INTO equipment (id, project_id, name, sets, mode, template_id, zones, pos, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
            .bind(id, pid, (body.name || "设备"), (+body.sets || 1),
                  body.mode === "single" ? "single" : "double", (body.templateId || null), JSON.stringify(zones),
                  (+body.pos || 0), now).run();
          await logIt(db, me, "新增设备", { projectId: pid, target: body.name || "设备" });
          return json({ equipment: { id, project_id: pid } });
        }
      }

      /* 项目下的自定义子项 */
      if (segs[2] === "custom") {
        if (segs.length === 3 && method === "GET") {
          const { results } = await db.prepare(
            "SELECT * FROM custom_items WHERE project_id = ? ORDER BY pos ASC, updated_at ASC").bind(pid).all();
          return json({ custom: results });
        }
        if (segs.length === 3 && method === "POST") {
          const body = await readJson(request);
          const id = (typeof body.id === "string" && body.id) ? body.id : crypto.randomUUID();
          const now = Date.now();
          await db.prepare("INSERT INTO custom_items (id, project_id, sec, name, spec, unit, qty, qty_formula, price, note, pos, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
            .bind(id, pid, body.sec || "其他自定义", body.name || "", body.spec || "", body.unit || "个",
                  +body.qty || 0, body.qtyFormula || null, +body.price || 0, body.note || "", +body.pos || 0, now).run();
          await logIt(db, me, "新增自定义项", { projectId: pid, target: body.name || "" });
          return json({ custom: { id, project_id: pid } });
        }
      }

      // GET / PATCH / DELETE 单个项目
      if (segs.length === 2 && method === "GET") {
        const p = await db.prepare("SELECT * FROM projects WHERE id = ?").bind(pid).first();
        return json({ project: p });
      }
      if (segs.length === 2 && method === "PATCH") {
        const body = await readJson(request);
        const name = (body.name || "").trim();
        if (!name) return bad("项目名称不能为空");
        await db.prepare("UPDATE projects SET name = ?, customer = ?, description = ?, updated_at = ? WHERE id = ?")
          .bind(name, (body.customer || "").trim(), (body.description || "").trim(), Date.now(), pid).run();
        await logIt(db, me, "编辑项目", { projectId: pid, target: name });
        return json({ ok: true });
      }
      if (segs.length === 2 && method === "DELETE") {
        const delP = await db.prepare("SELECT name FROM projects WHERE id = ?").bind(pid).first();
        // 手动级联删除（不依赖 D1 外键）
        await db.batch([
          db.prepare("DELETE FROM equipment WHERE project_id = ?").bind(pid),
          db.prepare("DELETE FROM custom_items WHERE project_id = ?").bind(pid),
          db.prepare("DELETE FROM project_members WHERE project_id = ?").bind(pid),
          db.prepare("DELETE FROM snapshots WHERE project_id = ?").bind(pid),
          db.prepare("DELETE FROM projects WHERE id = ?").bind(pid),
        ]);
        await logIt(db, me, "删除项目", { projectId: pid, target: delP ? delP.name : pid });
        return json({ ok: true });
      }
    }
  }

  /* ---- 设备：按自身 id 改/删（校验所属项目可访问） ---- */
  if (segs[0] === "equipment" && segs[1]) {
    const eid = segs[1];
    const projId = await ownerProjectId(db, "equipment", eid);
    if (!projId) return bad("设备不存在", 404);
    if (!(await projectAccessible(db, me, projId))) return bad("无权访问该设备", 403);
    if (segs.length === 2 && method === "PATCH") {
      const body = await readJson(request);
      const cur = await db.prepare("SELECT * FROM equipment WHERE id = ?").bind(eid).first();
      const name = body.name !== undefined ? body.name : cur.name;
      const sets = body.sets !== undefined ? (+body.sets || 1) : cur.sets;
      const mode = body.mode !== undefined ? (body.mode === "single" ? "single" : "double") : cur.mode;
      const zones = body.zones !== undefined ? JSON.stringify(Array.isArray(body.zones) ? body.zones : []) : cur.zones;
      const pos = body.pos !== undefined ? (+body.pos || 0) : cur.pos;
      const templateId = body.templateId !== undefined ? (body.templateId || null) : cur.template_id;
      await db.prepare("UPDATE equipment SET name = ?, sets = ?, mode = ?, template_id = ?, zones = ?, pos = ?, updated_at = ? WHERE id = ?")
        .bind(name, sets, mode, templateId, zones, pos, Date.now(), eid).run();
      await logIt(db, me, "修改设备", { projectId: projId, target: name });
      return json({ ok: true });
    }
    if (segs.length === 2 && method === "DELETE") {
      const delE = await db.prepare("SELECT name FROM equipment WHERE id = ?").bind(eid).first();
      await db.prepare("DELETE FROM equipment WHERE id = ?").bind(eid).run();
      await logIt(db, me, "删除设备", { projectId: projId, target: delE ? delE.name : eid });
      return json({ ok: true });
    }
  }

  /* ---- 自定义子项：按自身 id 改/删 ---- */
  if (segs[0] === "custom" && segs[1]) {
    const cid = segs[1];
    const projId = await ownerProjectId(db, "custom_items", cid);
    if (!projId) return bad("自定义项不存在", 404);
    if (!(await projectAccessible(db, me, projId))) return bad("无权访问该自定义项", 403);
    if (segs.length === 2 && method === "PATCH") {
      const body = await readJson(request);
      const cur = await db.prepare("SELECT * FROM custom_items WHERE id = ?").bind(cid).first();
      const f = (k, d) => (body[k] !== undefined ? body[k] : d);
      await db.prepare("UPDATE custom_items SET sec=?, name=?, spec=?, unit=?, qty=?, qty_formula=?, price=?, note=?, pos=?, updated_at=? WHERE id=?")
        .bind(f("sec", cur.sec), f("name", cur.name), f("spec", cur.spec), f("unit", cur.unit),
              body.qty !== undefined ? (+body.qty || 0) : cur.qty,
              body.qtyFormula !== undefined ? (body.qtyFormula || null) : cur.qty_formula,
              body.price !== undefined ? (+body.price || 0) : cur.price,
              f("note", cur.note), body.pos !== undefined ? (+body.pos || 0) : cur.pos,
              Date.now(), cid).run();
      await logIt(db, me, "修改自定义项", { projectId: projId, target: f("name", cur.name) });
      return json({ ok: true });
    }
    if (segs.length === 2 && method === "DELETE") {
      const delC = await db.prepare("SELECT name FROM custom_items WHERE id = ?").bind(cid).first();
      await db.prepare("DELETE FROM custom_items WHERE id = ?").bind(cid).run();
      await logIt(db, me, "删除自定义项", { projectId: projId, target: delC ? delC.name : cid });
      return json({ ok: true });
    }
  }

  /* ---- 合同管理 ---- */
  if (segs[0] === "contracts") {
    // 列表（访问过滤 + 金额打码）。可选 ?kind=purchase|sales
    if (segs.length === 1 && method === "GET") {
      const kind = new URL(request.url).searchParams.get("kind");
      let rows;
      if (me.role === "admin") {
        rows = (await db.prepare("SELECT *, 1 AS cva FROM contracts ORDER BY pos ASC, created_at ASC").all()).results;
      } else {
        rows = (await db.prepare(
          "SELECT c.*, m.can_view_amount AS cva FROM contracts c " +
          "JOIN project_members m ON m.project_id = c.project_id AND m.user_id = ? " +
          "ORDER BY c.pos ASC, c.created_at ASC").bind(me.id).all()).results;
      }
      let out = rows.map(r => shapeContract(r, r.cva !== 0));
      if (kind === "purchase" || kind === "sales") out = out.filter(c => c.kind === kind);
      return json({ contracts: out });
    }
    // 新建（仅 admin）
    if (segs.length === 1 && method === "POST") {
      if (me.role !== "admin") return bad("需要管理员权限", 403);
      const b = await readJson(request);
      const id = b.id || crypto.randomUUID();
      const now = Date.now();
      let pname = b.projectName || "";
      if (b.projectId) {
        const p = await db.prepare("SELECT name FROM projects WHERE id=?").bind(b.projectId).first();
        if (p) pname = p.name;
      }
      const num = (x) => (x === undefined || x === null || x === "" ? 0 : (+x || 0));
      await db.prepare(
        "INSERT INTO contracts (id,kind,project_id,project_name,name,code,party_a,party_b,amount," +
        "pct_prepay,pct_delivery,pct_stage1,pct_stage2,pct_final,start_date,end_date,status,invoiced,paid,note,pos,created_at,updated_at) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(id, b.kind === "sales" ? "sales" : "purchase", b.projectId || null, pname,
          b.name || "", b.code || "", b.partyA || "", b.partyB || "", num(b.amount),
          num(b.pctPrepay), num(b.pctDelivery), num(b.pctStage1), num(b.pctStage2), num(b.pctFinal),
          b.startDate || "", b.endDate || "", b.status || "", b.invoiced || "", b.paid || "",
          b.note || "", num(b.pos), now, now).run();
      if (Array.isArray(b.files)) {
        for (let i = 0; i < b.files.length; i++) {
          const f = b.files[i];
          await db.prepare("INSERT INTO contract_files (id,contract_id,category,filename,mimetype,size,r2_key,source_path,pos,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
            .bind(crypto.randomUUID(), id, f.category || "contract", f.filename || "", f.mimetype || "", +f.size || 0, f.r2Key || "", f.sourcePath || "", i, now).run();
        }
      }
      await logIt(db, me, "新建合同", { projectId: b.projectId || null, target: b.name || "" });
      return json({ contract: { id } });
    }
    // 附件列表 GET /contracts/:id/files（成员可看）
    if (segs.length === 3 && segs[2] === "files" && method === "GET") {
      const c = await db.prepare("SELECT project_id FROM contracts WHERE id=?").bind(segs[1]).first();
      if (!c) return bad("合同不存在", 404);
      if (!(await contractAccess(db, me, c.project_id)).ok) return bad("无权访问该合同", 403);
      const { results } = await db.prepare("SELECT id,category,filename,mimetype,size,r2_key,pos FROM contract_files WHERE contract_id=? ORDER BY pos ASC").bind(segs[1]).all();
      return json({ files: results.map(f => ({ id: f.id, category: f.category, filename: f.filename, mimetype: f.mimetype, size: f.size, ready: !!f.r2_key })) });
    }
    // 改 / 删（仅 admin）
    if (segs.length === 2 && segs[1] && (method === "PATCH" || method === "DELETE")) {
      if (me.role !== "admin") return bad("需要管理员权限", 403);
      const cid = segs[1];
      const cur = await db.prepare("SELECT * FROM contracts WHERE id=?").bind(cid).first();
      if (!cur) return bad("合同不存在", 404);
      if (method === "DELETE") {
        await db.batch([
          db.prepare("DELETE FROM contract_files WHERE contract_id=?").bind(cid),
          db.prepare("DELETE FROM contracts WHERE id=?").bind(cid),
        ]);
        await logIt(db, me, "删除合同", { projectId: cur.project_id, target: cur.name });
        return json({ ok: true });
      }
      const b = await readJson(request);
      const f = (k, col) => (b[k] !== undefined ? b[k] : cur[col]);
      const num = (k, col) => (b[k] !== undefined ? (+b[k] || 0) : cur[col]);
      let pid = cur.project_id, pname = cur.project_name;
      if (b.projectId !== undefined) {
        pid = b.projectId || null;
        const p = pid ? await db.prepare("SELECT name FROM projects WHERE id=?").bind(pid).first() : null;
        pname = p ? p.name : (b.projectName !== undefined ? b.projectName : "");
      }
      await db.prepare(
        "UPDATE contracts SET kind=?,project_id=?,project_name=?,name=?,code=?,party_a=?,party_b=?,amount=?," +
        "pct_prepay=?,pct_delivery=?,pct_stage1=?,pct_stage2=?,pct_final=?,start_date=?,end_date=?,status=?,invoiced=?,paid=?,note=?,updated_at=? WHERE id=?")
        .bind(b.kind !== undefined ? (b.kind === "sales" ? "sales" : "purchase") : cur.kind,
          pid, pname, f("name","name"), f("code","code"), f("partyA","party_a"), f("partyB","party_b"),
          num("amount","amount"), num("pctPrepay","pct_prepay"), num("pctDelivery","pct_delivery"),
          num("pctStage1","pct_stage1"), num("pctStage2","pct_stage2"), num("pctFinal","pct_final"),
          f("startDate","start_date"), f("endDate","end_date"), f("status","status"),
          f("invoiced","invoiced"), f("paid","paid"), f("note","note"), Date.now(), cid).run();
      await logIt(db, me, "修改合同", { projectId: pid, target: f("name","name") });
      return json({ ok: true });
    }
  }

  return bad("未知接口或方法不支持", 404);
}
