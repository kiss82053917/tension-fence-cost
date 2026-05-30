#!/usr/bin/env python3
"""综合后端测试（针对 http://127.0.0.1:8788）。运行前请先重置本地 D1。
用法：python3 test/api_test.py
"""
import json, sys, urllib.request, urllib.error, http.cookiejar

BASE = "http://127.0.0.1:8788/api"
PASS = 0; FAIL = 0; FAILS = []

def client():
    cj = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

def call(op, method, path, body=None):
    url = BASE + "/" + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None: req.add_header("content-type", "application/json")
    try:
        r = op.open(req)
        return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode() or "{}")
        except Exception: return e.code, {}

def check(desc, cond):
    global PASS, FAIL
    if cond: PASS += 1
    else: FAIL += 1; FAILS.append(desc); print("  ✗ FAIL:", desc)

def section(t): print("\n== " + t + " ==")

# ---------- 鉴权 ----------
section("鉴权与会话")
anon = client()
st, d = call(anon, "GET", "me"); check("未登录 /me -> user:null", st==200 and d.get("user") is None)
st, d = call(anon, "POST", "login", {"username":"admin","password":"wrong"}); check("错误密码 401", st==401)
admin = client()
st, d = call(admin, "POST", "login", {"username":"admin","password":"adminyy"}); check("admin 登录 200", st==200 and d["user"]["role"]=="admin")
st, d = call(admin, "GET", "me"); check("admin /me", st==200 and d["user"]["username"]=="admin")

# ---------- 用户 CRUD + 保护 ----------
section("用户管理")
st, d = call(admin, "GET", "users"); check("用户列表含 admin", st==200 and any(u["username"]=="admin" for u in d["users"]))
st, d = call(admin, "POST", "users", {"username":"alice","password":"alicepw","role":"user"}); check("建 alice", st==200)
alice_id = d["user"]["id"]
st, d = call(admin, "POST", "users", {"username":"alice","password":"x","role":"user"}); check("重名 alice 拒绝", st==400)
st, d = call(admin, "POST", "users", {"username":"bobby","password":"bobbypw","role":"user"}); check("建 bobby", st==200)
bobby_id = d["user"]["id"]
admin_id = [u["id"] for u in call(admin,"GET","users")[1]["users"] if u["username"]=="admin"][0]
st, d = call(admin, "PATCH", "users/"+admin_id, {"username":"x"}); check("改 admin 403", st==403)
st, d = call(admin, "DELETE", "users/"+admin_id); check("删 admin 403", st==403)
st, d = call(admin, "POST", "users/"+bobby_id+"/reset", {"password":"newbobby"}); check("重置 bobby 密码", st==200)
bobby = client()
st, d = call(bobby, "POST", "login", {"username":"bobby","password":"newbobby"}); check("bobby 新密码登录", st==200 and d["user"]["role"]=="user")
st, d = call(bobby, "GET", "users"); check("bobby 非 admin 访问用户列表 403", st==403)

# ---------- 项目 + 成员隔离 ----------
section("项目与成员隔离")
st, d = call(admin, "POST", "projects", {"name":"项目甲","customer":"客户A"}); check("admin 建 项目甲", st==200)
pA = d["project"]["id"]
st, d = call(bobby, "GET", "projects"); check("bobby 看不到项目甲(空)", st==200 and len(d["projects"])==0)
st, d = call(bobby, "POST", "projects", {"name":"项目乙"}); check("bobby 建 项目乙", st==200)
pB = d["project"]["id"]
st, d = call(bobby, "GET", "projects"); check("bobby 只见项目乙", st==200 and len(d["projects"])==1 and d["projects"][0]["name"]=="项目乙")
st, d = call(admin, "GET", "projects"); check("admin 见全部(2)", st==200 and len(d["projects"])==2)
st, d = call(bobby, "GET", "projects/"+pA); check("bobby 访问项目甲 403", st==403)
st, d = call(bobby, "GET", "projects/"+pA+"/equipment"); check("bobby 访问项目甲设备 403", st==403)
# 加 bobby 进项目甲
st, d = call(bobby, "POST", "projects/"+pA+"/members", {"userId":bobby_id}); check("bobby 自己加成员 403", st==403)
st, d = call(admin, "POST", "projects/"+pA+"/members", {"userId":bobby_id}); check("admin 把 bobby 加入项目甲", st==200)
st, d = call(bobby, "GET", "projects"); check("bobby 现见 2 项目", st==200 and len(d["projects"])==2)
st, d = call(bobby, "GET", "projects/"+pA); check("bobby 现可访问项目甲", st==200)
st, d = call(admin, "GET", "projects/"+pA+"/members"); check("项目甲成员含 admin+bobby", st==200 and {m["username"] for m in d["members"]}=={"admin","bobby"})

# ---------- 设备 / 自定义项 CRUD ----------
section("设备 / 自定义项")
st, d = call(admin, "POST", "projects/"+pA+"/equipment", {"id":"eqA","name":"设备X","sets":3,"mode":"single","zones":[{"name":"L","length":50}]}); check("建设备(客户端id)", st==200 and d["equipment"]["id"]=="eqA")
st, d = call(admin, "GET", "projects/"+pA+"/equipment"); check("设备列表 zones 还原为数组", st==200 and isinstance(d["equipment"][0]["zones"], list) and d["equipment"][0]["zones"][0]["length"]==50)
st, d = call(admin, "PATCH", "equipment/eqA", {"sets":8}); check("PATCH 设备 sets", st==200)
st, d = call(admin, "GET", "projects/"+pA+"/equipment"); check("sets 已更新为 8", d["equipment"][0]["sets"]==8)
st, d = call(bobby, "PATCH", "equipment/eqA", {"name":"成员也能改"}); check("成员可改设备", st==200)
st, d = call(admin, "POST", "projects/"+pA+"/custom", {"id":"cuA","sec":"其他自定义","name":"垫片","unit":"个","qty":10,"price":1.5}); check("建自定义项", st==200)
st, d = call(admin, "PATCH", "custom/cuA", {"price":2.0}); check("PATCH 自定义项 price", st==200)
st, d = call(admin, "DELETE", "custom/cuA"); check("删自定义项", st==200)
st, d = call(admin, "GET", "projects/"+pA+"/custom"); check("自定义项已删", len(d["custom"])==0)

# ---------- 全局设置 ----------
section("全局设置")
st, d = call(admin, "PUT", "settings/params", {"mainSpacing":3,"vertLines":21}); check("PUT params", st==200)
st, d = call(bobby, "PUT", "settings/prices", {"2":42}); check("成员也能写 settings", st==200)
st, d = call(admin, "GET", "settings"); check("GET settings 反映写入", st==200 and d["params"]["vertLines"]==21 and d["prices"]["2"]==42)

# ---------- bootstrap ----------
section("bootstrap")
st, d = call(admin, "GET", "bootstrap"); check("admin bootstrap 全量(2项目)", st==200 and len(d["projects"])==2)
st, d = call(bobby, "GET", "bootstrap"); check("bobby bootstrap 仅可见(2)", st==200 and len(d["projects"])==2 and any(e["id"]=="eqA" for e in d["equipment"]))

# ---------- 日志 ----------
section("操作日志")
st, d = call(admin, "GET", "logs"); check("admin 日志非空", st==200 and len(d["logs"])>0)
acts = [l["action"] for l in d["logs"]]
check("含 新建项目/新增设备/改单价", "新建项目" in acts and "新增设备" in acts and "改单价" in acts)
price_log = [l for l in d["logs"] if l["action"]=="改单价"]
check("改单价日志带 before/after", price_log and "before" in price_log[0]["detail"] and price_log[0]["detail"]["after"]==42)
st, d = call(bobby, "GET", "logs"); check("bobby 日志仅含其可见项目/自身", st==200 and all((l.get("project_id") in (pA,pB,None)) for l in d["logs"]))

# ---------- 快照 / 回滚 ----------
section("快照 / 回滚")
st, d = call(admin, "POST", "projects/"+pA+"/snapshots", {"label":"基线"}); check("存快照 基线", st==200)
snapid = d["id"]
call(admin, "PATCH", "equipment/eqA", {"name":"改动后","sets":1})
st, d = call(admin, "POST", "projects/"+pA+"/snapshots/"+snapid+"/rollback"); check("回滚 200", st==200)
st, d = call(admin, "GET", "projects/"+pA+"/equipment"); check("回滚恢复快照态(成员也能改/8)", d["equipment"][0]["name"]=="成员也能改" and d["equipment"][0]["sets"]==8)
st, d = call(admin, "GET", "projects/"+pA+"/snapshots"); check("出现 回滚前自动备份", any(s["kind"]=="prerollback" for s in d["snapshots"]))

# ---------- 模板（settings.templates + equipment.template_id） ----------
section("模板")
TPL = [
  {"id":"tpl_double","name":"双防区","mode":"double","params":{"vertLines":19,"slopeLines":5,"mainSpacing":3}},
  {"id":"tpl_single","name":"单防区","mode":"single","params":{"vertLines":19,"slopeLines":5,"mainSpacing":3}},
  {"id":"tpl_30","name":"30线双防区","mode":"double","params":{"vertLines":30,"slopeLines":5,"mainSpacing":3}},
]
st, d = call(admin, "PUT", "settings/templates", TPL); check("PUT templates 200", st==200)
st, d = call(admin, "GET", "settings"); check("GET settings 含3模板", st==200 and len(d.get("templates",[]))==3)
check("模板字段完整(name/mode/params)", all(("name" in t and "mode" in t and "params" in t) for t in d["templates"]))
st, d = call(admin, "POST", "projects", {"name":"模板项目"}); PT=d["project"]["id"]
st, d = call(admin, "POST", "projects/"+PT+"/equipment", {"id":"tEq","name":"围栏","templateId":"tpl_30","zones":[{"name":"z","length":40}]}); check("建带 templateId 的设备", st==200)
st, d = call(admin, "GET", "projects/"+PT+"/equipment"); check("设备返回 template_id", st==200 and d["equipment"][0].get("template_id")=="tpl_30")
st, d = call(admin, "PATCH", "equipment/tEq", {"templateId":"tpl_single"}); check("PATCH 切换模板", st==200)
st, d = call(admin, "GET", "projects/"+PT+"/equipment"); check("template_id 已切换", d["equipment"][0].get("template_id")=="tpl_single")
st, d = call(admin, "GET", "bootstrap");
_eq=[e for e in d.get("equipment",[]) if e["id"]=="tEq"]
check("bootstrap 含 template_id", bool(_eq) and _eq[0].get("template_id")=="tpl_single")
call(admin, "DELETE", "projects/"+PT)  # 清理

# ---------- 删除级联 ----------
section("删除级联")
st, d = call(admin, "DELETE", "projects/"+pA); check("删项目甲", st==200)
st, d = call(admin, "GET", "projects/"+pA+"/equipment"); check("项目甲删后访问 403", st==403)
st, d = call(admin, "GET", "projects"); check("admin 剩 1 项目", st==200 and len(d["projects"])==1)
st, d = call(bobby, "GET", "projects"); check("bobby 剩 1 项目(乙)", st==200 and len(d["projects"])==1)

# ---------- 注销 ----------
section("注销")
st, d = call(bobby, "POST", "logout"); check("bobby 注销", st==200)
st, d = call(bobby, "GET", "me"); check("注销后 /me null", st==200 and d.get("user") is None)
st, d = call(bobby, "GET", "projects"); check("注销后访问 projects 401", st==401)

print(f"\n==== 结果：PASS {PASS} / FAIL {FAIL} ====")
if FAIL: print("失败项：" + "; ".join(FAILS)); sys.exit(1)
print("全部通过 ✅")
