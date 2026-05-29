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
        return json({ user: { id, username: newName, role: newRole } });
      }
      // 删除
      if (segs.length === 2 && method === "DELETE") {
        if (isSuper) return bad("超级管理员不可删除", 403);
        if (id === me.id) return bad("不能删除当前登录账号", 403);
        await db.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }
    }
  }

  return bad("未知接口或方法不支持", 404);
}
