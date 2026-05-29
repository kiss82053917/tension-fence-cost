# 项目交接说明（张力围栏多设备成本工具）

> 本文件写给「接手继续开发的人 / AI」。读完这一篇就能上手，不需要翻聊天记录。
> 配套阅读：`README.md`（面向最终用户的功能说明）。

---

## 1. 这是什么

一个**单文件 HTML 工具**，用于汇总多台「双防区 / 单防区张力围栏」设备的 BOM 物料与成本。

业务背景：用户卖的是一套套张力围栏设备。比如一个项目里要卖 23 套，每套左右防区长度都不同。
工具帮他按每套的实际参数，自动算出每个零件的数量、单价、合计，并跨设备汇总出整个项目的真实物料清单和总成本。

层级模型：**项目（project） → 设备（equipment） → 防区（zone）**。

---

## 2. 线上地址与仓库

| 项 | 值 |
|---|---|
| 线上（Cloudflare Pages） | https://tension-fence-cost.pages.dev/ |
| GitHub 仓库 | https://github.com/kiss82053917/tension-fence-cost.git |
| git 用户名 | kiss82053917 |
| 部署方式 | push 到 `main` 分支后，Cloudflare Pages 自动部署（约 30–60 秒） |

> ⚠️ **Token 注意**：之前用过的 GitHub Personal Access Token 已被删除。
> 若你需要 push 且本机没有缓存凭证，请**自己新建** fine-grained token（权限 Contents: Read and write），不要复用旧的。
> 本机 macOS Keychain 里可能已存有凭证，正常 `git push` 即可。

---

## 3. 本地运行与部署

**本地预览**：直接双击 `index.html` 用浏览器打开即可，没有任何构建步骤、没有依赖、没有后端。

**改完后发布**：
```bash
cd /Users/milkmiracle/Downloads/tension-fence-cost
# 改 index.html ...
node --check <(awk '/<script>/{f=1;next}/<\/script>/{f=0}f' index.html)  # 可选：先验证 JS 语法
git add index.html
git commit -m "你的说明"
git push          # 触发 Cloudflare 自动部署
```

---

## 4. 技术栈与设计原则

- **纯原生** HTML + CSS + JS，全部塞在一个 `index.html`（约 1900 行）。没有框架、没有打包、没有 npm 依赖。
- **持久化**：浏览器 `localStorage`（目前是纯前端，每个浏览器各存各的，不互通）。
- **公式引擎**：用 `new Function()` 在受控作用域里求值，让用户能自定义每行的数量公式。
- 设计原则：**保持单文件、零依赖、可双击打开**。除非进入阶段二（加后端），否则不要引入构建工具或外部库。

---

## 5. 数据模型（localStorage 键）

> 所有读写集中在 `lsGet/lsSet`（约 566–569 行）和 `saveAll()`（约 658 行）。
> 改数据结构时，务必同步更新对应的 `load*()` 迁移函数，避免老用户数据炸掉。

| localStorage 键 | 含义 | 结构 |
|---|---|---|
| `tf_projects` | 项目列表 | `[{id, name, customer, description, createdAt, updatedAt}]` |
| `tf_activePrj` | 当前选中项目 id | string |
| `tf_viewName` | 顶层视图 | `"projects"`（项目卡片页）\| `"project"`（项目内详情页） |
| `tf_equip` | 设备列表（**跨所有项目**，用 projectId 区分） | `[{id, projectId, name, sets, mode, zones:[{name,length}]}]` |
| `tf_active` | 当前选中设备 id | string |
| `tf_view` | 项目内 BOM 视图 | `"aggregate"`（全部设备汇总）\| `"single"`（单设备） |
| `tf_custom` | 自定义子项（带 projectId） | `[{projectId, sec, name, spec, unit, qty, qtyFormula?, price, note}]` |
| `tf_cparams` | 左侧自定义参数 | `[{key, label, unit, value, group}]` |
| `tf_params` | 共享产品规格参数 | 见下 |
| `tf_prices` | 单价覆盖 | `{行索引: price}` |
| `tf_formulas` | 公式覆盖 | `{行索引: 公式字符串}` |
| `tf_zones` | **旧版遗留键**，仅用于首次迁移 | 老的防区数组 |

`tf_params` 字段（产品规格，所有设备共享）：
`mainSpacing, mainULocks, vertSupports, slopeSupports, squareSupports, auxULocks, vertLines, slopeLines, lineRedundancy, pillarsPerZone, pillarULocks, pillarULockBush, pillarVertSlope, pillarSlopeSlope, horizCorners, slopeCorners, anchorPosts`

**迁移逻辑**：`loadProjects()`（约 634 行）首次运行时建一个「默认项目」，并给所有还没有 `projectId` 的旧设备/自定义子项打上默认项目 id。这保证老用户升级后数据不丢。

---

## 6. 代码结构与核心函数地图

`index.html` 顺序：`<style>`（CSS）→ HTML 骨架 → `<script>`（全部逻辑）。

脚本里的状态变量（约 617–645 行）是全局 `let`，所有渲染都从它们出发。

核心函数（行号为大致位置，以实际为准）：

| 函数 | 作用 |
|---|---|
| `lsGet / lsSet` (566) | localStorage 读写封装 |
| `loadParams / loadCustom / loadCustomParams / loadEquipmentList / loadProjects` | 各数据的加载 + 迁移 |
| `saveAll()` (658) | 一次性把所有状态写回 localStorage |
| `activeProject()` (673) | 当前项目对象 |
| `currentEquipments()` (674) | 当前项目下的设备（按 projectId 过滤） |
| `currentCustomItems()` (675) | 当前项目下的自定义子项 |
| `activeEquip()` (676) | 当前选中设备 |
| `projectStats(pid)` (682) | 算一个项目的卡片统计：设备数、防区数、总长、套数、成本 |
| `zonePoles(z, spacing)` (710) | 单个防区的主螺旋柱根数 = ceil(长度/间距)-1 |
| `derivedFor(equip)` (713) | 算单台设备的衍生量：totalLen / totalLines / mainPoles / totalZoneLen / zoneCount / sets |
| `buildScope(equip)` (723) | 拼出公式可引用的全部变量（params + 衍生量 + zoneLen1..N + 自定义参数 + zonesPerPillar） |
| `evalFormula(src, scope)` (736) | **公式求值引擎**（new Function + Math 助手） |
| `sysRowQty / sysRowAggregate / sysRowBreakdown` (768–778) | 系统 BOM 行的单设备数量 / 汇总数量 / 各设备分解 |
| `cusRowQty(c)` (778) | 自定义子项数量（支持公式或固定值） |
| `equipCost(equip)` (1096) | 单台设备总成本 |
| `renderEquipmentList()` (813) | 左侧设备列表渲染（含单/双防区下拉、套数） |
| `renderActiveZones()` (848) | 当前设备的防区编辑 |
| `renderParams()` (878) | 左侧参数面板（含自定义参数） |
| `renderProjectsView()` (1144) | 项目卡片页 |
| `projectCardHTML(p)` (1110) | 单个项目卡片 HTML |
| `openNewProject / duplicateProject / deleteProject / enterProject / backToProjects / openProjectEditor / closeProjectEditor` (1211–1310) | 项目 CRUD 与导航 |
| `rerender()` (1338) | 总调度：根据 viewName 决定渲染哪套视图 |
| `renderBOM()` (1356) | 右侧 BOM 表（核心） |
| `renderSummary()` (1530) | 底部成本汇总 |
| `openFx / renderFxVars / updateFxResult` (1585–1651) | 公式编辑器弹窗 |
| `exportCSV()` (1718) | 导出 CSV |

---

## 7. BOM 数据与公式引擎

- `const BOM = [...]`（约 472 行起）是 **77 项**物料的数组，每项：
  ```js
  { sec:"一、探测器柱组件", type:"std"|"opt", name, spec, unit, formula, price, note }
  ```
  - `sec`：所属分组（探测器柱组件 / 主螺旋柱 / 设备箱及控制器 …）
  - `type`：`"std"` 标准件 / `"opt"` 可选件
  - `formula`：数量公式字符串，引用 `buildScope` 里的变量
- `DEFAULT_PRICES` / `DEFAULT_FORMULAS`（560–561 行）是 `BOM.map` 出来的原始快照，用于「恢复默认」。
- 用户在页面上改的单价 / 公式存进 `tf_prices` / `tf_formulas`（按行索引覆盖），不改动 `BOM` 本身。

**公式里可用的变量**（`DERIVED_VARS` + params + 自定义参数 + 每防区长度）：
- 衍生量：`totalLen, totalLines, mainPoles, totalZoneLen, zoneCount, sets, zonesPerPillar`
- 规格参数：`mainSpacing, pillarsPerZone, lineRedundancy, ...`（即 `tf_params` 全部字段）
- 防区长度：`zoneLen1, zoneLen2, ...`（按当前设备防区数动态生成）
- 自定义参数：用户在左侧加的 `key`
- Math 助手：`ceil, floor, round, max, min` 等（在 `evalFormula` 里注入）

---

## 8. 单防区 / 双防区机制（重要）

每台设备有 `mode` 字段：`"single"` 或 `"double"`。
`zonesPerPillarOf(equip)`（467 行）：单防区返回 1，双防区返回 2，并以 `zonesPerPillar` 暴露进公式作用域。

按防区数量缩放的零件，公式里都乘了 `zonesPerPillar`，例如：
- 触发器、拉力传感器、蜂鸣器、V型导轮：`pillarsPerZone * zonesPerPillar * sets`
- 主控制器板、控制器壳体、杜邦线、SMT：`zonesPerPillar * sets`
- HX711、钢丝绳锁扣等带倍数的：`... * N * zonesPerPillar * sets`

**而配电箱、防雷模块**等「每套一个」的件用 `1 * sets`，不随单/双防区变化。
（这条机制已验证生效，改公式时注意别破坏这层缩放。）

---

## 9. 已完成功能（截至当前）

- ✅ 项目管理页：新增 / 重命名 / 编辑信息 / 复制（连设备一起）/ 删除 / 搜索过滤；卡片展示防区、设备数、总长、总成本
- ✅ 设备列表：每台独立设左右（多）防区长度、套数；单/双防区切换
- ✅ 跨设备汇总 / 单设备视图切换
- ✅ 每行数量公式编辑器（`ƒ` 按钮），可引用左侧参数
- ✅ 自定义参数（左侧）与自定义子项（每个 BOM 分组下）
- ✅ 单价覆盖、公式覆盖、恢复默认
- ✅ 导出 CSV（项目内导出 / 项目页全局导出）
- ✅ localStorage 持久化 + 老数据迁移
- ✅ 已部署上线（GitHub + Cloudflare Pages 自动部署）

**数据正确性已验证**：默认 40+40 防区可复现 V5 模板总价（标准件 ¥11,161.42、可选件 ¥1,984.26、合计 ¥13,145.69）。

---

## 10. 验证清单（阶段一自测用）

> 进入阶段二之前，先按此清单回归一遍，确认阶段一功能没被改坏。
> 测试建议用一个**干净浏览器配置**或先「导出 CSV 备份 → 清 localStorage」，避免脏数据干扰。

### A. 启动与老数据迁移
- [ ] 打开页面默认落在**项目卡片页**（`viewName === "projects"`）
- [ ] 老用户数据自动归入「**默认项目**」，进入后能看到原有设备与防区
- [ ] 刷新页面后所有数据仍在（localStorage 持久化生效）

### B. 项目管理
- [ ] **新建**项目，出现新卡片
- [ ] **重命名 / 编辑信息**（客户、描述）后卡片同步更新
- [ ] **复制**项目：设备一并复制；改动副本不影响原项目（深拷贝，非引用）
- [ ] **删除**项目：有二次确认，删完回到卡片页
- [ ] **搜索**：按名称/客户过滤卡片
- [ ] 卡片统计正确：设备数、防区数、总长度、套数、总成本

### C. 设备管理（项目内）
- [ ] 新增 / 复制 / 删除 / 重命名设备
- [ ] 设置左右（多）防区长度与套数，数量随之变化
- [ ] **单/双防区切换**：切到「单防区」后，传感器/触发器/主控制器板等数量减半（×1 而非 ×2）；配电箱、防雷模块**不变**（仍按每套 1 个）

### D. BOM 与公式
- [ ] **汇总视图** = 所有设备求和；**单设备视图**只显示选中那台
- [ ] 改单价 → 合计实时更新；改公式 → 数量实时更新
- [ ] 公式编辑器（`ƒ`）能引用 `params`、`zoneLen1..N`、自定义参数、`zonesPerPillar`
- [ ] 新增自定义参数 / 自定义子项后能参与计算
- [ ] 「恢复默认」能还原单价与公式

### E. 导出
- [ ] 项目内「导出 CSV」只导当前项目，文件名含项目名 + 时间戳
- [ ] 项目页「导出 CSV」导出全部项目汇总
- [ ] CSV 用 Excel / 表格软件打开中文不乱码（带 BOM 头）

### F. 数据正确性回归（关键基准）
- [ ] 单台设备、左右各 40m、双防区，应复现 V5 模板：
  - 标准件合计 **¥11,161.42**
  - 可选件合计 **¥1,984.26**
  - 总计 **¥13,145.69**
- [ ] 多设备不同防区长度时，汇总数量 = 各设备数量之和（可拿 2–3 台手算抽查）

---

## 11. 未完成路线图（用户已确认要做，按阶段推进）

> 用户明确要求**一个阶段一个阶段地做**，每阶段做完先验证再继续，避免一次改动太大。

### 阶段二：后端 + 多人协同（进行中）

> **鉴权方案变更**：原计划用 Cloudflare Access 邮箱白名单；现已改为**沿用第一阶段的自定义账号体系**（用户名+密码），搬到后端。Cloudflare Access 不再使用。

按小步推进，每个子阶段做完先验证：

- ✅ **2.1 鉴权与用户后端**（已完成并验证）：Cloudflare Pages Functions + D1；用户/会话表；登录/注销/会话/用户增删改查/重置密码 API；PBKDF2 密码哈希；首登种入 admin/adminyy；前端登录与用户管理改调后端。详见下方第 13 节。
- ⬜ **2.2 项目/设备/自定义项后端 API + 按项目成员鉴权**（普通用户只见被分配的项目，admin 管全部并分配）
- ⬜ **2.3 前端数据层切到 API**（localStorage 转离线缓存）+ 首登把本地数据迁移上云
- ✅ **2.4 自动同步（防抖 debounce）+ 同步状态指示器 + 后写为准（last-write-wins）+ 细粒度 PATCH**
- ✅ **2.5 admin 的项目成员分配 UI**

### 阶段三：操作日志 + 版本回滚（已完成）
- ✅ 操作日志：记录**谁、何时、改了什么**；价格 / 公式改动记**改前改后**；右侧抽屉展示（价格行映射 BOM 名称）
- ✅ 版本快照（按项目）：手动存档（带标签）+ 自动检查点（每约 20 次同步 或 每日首访）
- ✅ 回滚：回滚前先自动存一份「回滚前自动备份」，可反悔

> **全部阶段已完成并通过 3 轮全面测试**（后端自动化 54 项 + 浏览器端到端 + 多用户/隔离/后写为准/数据正确性回归）。详见第 14 节。

---

## 12. 给接手者的注意事项 / 坑

1. **保持单文件、零依赖**，除非进入阶段二需要后端，否则不要引框架/打包器。
2. 改数据结构时，**必须**同步更新对应的 `load*()` 迁移逻辑，否则老用户 localStorage 数据会读错或丢失。
3. 改 JS 后可先用 `node --check` 抽出 `<script>` 验证语法，再 commit。
4. `tf_equip` 是**跨项目**的全局设备表，靠 `projectId` 区分；筛选务必用 `currentEquipments()` 而不是直接遍历全表。
5. 单价 / 公式覆盖是**按行索引**存的（`tf_prices`/`tf_formulas`），如果将来增删 `BOM` 项导致索引错位，需要做迁移映射。建议阶段二改成按稳定 id 存。
6. 不要在代码或日志里明文打印任何 token；push 用 Keychain 凭证或临时 token。
7. 进入阶段二前，本工具是纯前端、数据只在本地浏览器；任何「多人能看到同一份数据」的预期都要等后端做完才成立。

---

## 13. 阶段二后端（2.1 已落地）

### 13.1 技术与结构
- 后端 = **Cloudflare Pages Functions**（`functions/api/[[path]].js`，一个 catch-all 路由）+ **D1**（SQLite）。
- 数据库 schema：`schema.sql`（幂等，可重复执行）。当前只有 `users` / `sessions` 两张表，2.2 会加项目/设备等表。
- 配置：`wrangler.toml`（绑定名 **`DB`**）、`package.json`（dev 依赖 wrangler + 脚本）。
- `node_modules/`、`.wrangler/`、`.dev.vars` 已在 `.gitignore`。

### 13.2 鉴权设计
- 密码：PBKDF2-SHA256（每用户随机 salt，10 万次迭代），存为 `pbkdf2$<iters>$<saltHex>$<hashHex>`。
- 会话：登录在 `sessions` 表生成随机 token，写入 **HttpOnly cookie `tf_sid`**（30 天）；中间件按 cookie 取用户。
- 首次访问（`users` 表为空）自动种入超级管理员 **admin / adminyy**。
- `admin` 账号受保护：不可编辑、不可删除；任何人不能删自己。重置密码会注销该用户的其它会话。

### 13.3 API 一览（均在 `/api` 下）
| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | /api/login | 公开 | `{username,password}` → 发会话 cookie |
| POST | /api/logout | 公开 | 注销当前会话 |
| GET | /api/me | 公开 | 当前用户（未登录 `user:null`） |
| GET | /api/users | admin | 用户列表 |
| POST | /api/users | admin | `{username,password,role}` 新建 |
| PATCH | /api/users/:id | admin | `{username,role}` 编辑（admin 账号 403） |
| DELETE | /api/users/:id | admin | 删除（admin / 自己 403） |
| POST | /api/users/:id/reset | admin | `{password}` 重置密码 |

前端通过 `api(path,{method,body})` 调用（`credentials:"include"`）；`boot()` 改为先问 `/api/me`。

### 13.4 本地开发
```bash
npm install          # 装 wrangler
npm run db:local     # 本地 D1 建表（首次）
npm run dev          # http://localhost:8788
```
本地 D1 状态在 `.wrangler/`（已 gitignore）；`db:local` 与 `dev` 共享同一本地库。

### 13.5 上线部署
1. `npx wrangler login`
2. `npx wrangler d1 create tension-fence-cost-db` → 把返回的 `database_id` 填进 `wrangler.toml`
3. `npm run db:remote`（给线上 D1 建表）
4. 部署二选一：
   - **Git 自动部署（推荐，沿用现有方式）**：`git push` 后 Pages 会自动构建并带上 `functions/`。**必须**在 Pages 项目 → Settings → Functions → **D1 database bindings** 里加绑定：变量名 `DB`，库选 `tension-fence-cost-db`。
   - **CLI 部署**：`npm run deploy`（`wrangler pages deploy .`）。
5. 首次上线后访问网址，后端会自动种入 admin/adminyy。

> ⚠️ 坑：Git 自动部署时，`wrangler.toml` 里的 `database_id` 只对 CLI 生效；**Dashboard 的 D1 绑定才是 Pages 构建用的**，别忘了配，否则 `/api/*` 会报「数据库未绑定」。

---

## 14. 阶段 2.2–3 + 测试（全部已落地）

### 14.1 数据模型（D1 表，见 `schema.sql`）
`users` `sessions` `projects` `project_members` `equipment` `custom_items` `settings`（全局 params/prices/formulas/cparams）`logs` `snapshots`。
- 项目/设备/自定义项**按项目隔离**；params/prices/formulas/cparams 为**全局共享**（沿用阶段一语义）。
- 成员模型：普通用户只见 `project_members` 关联的项目，admin 见全部；创建者自动入组。

### 14.2 完整 API（`functions/api/[[path]].js` 单路由）
鉴权/用户见第 13 节。数据相关：
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/bootstrap | 一次拉当前用户可见的 projects+equipment+custom+settings |
| GET/POST | /api/projects | 列表（按成员过滤）/ 新建（接受客户端 id，创建者入组） |
| GET/PATCH/DELETE | /api/projects/:id | 取/改/删（删级联设备/自定义/成员/快照） |
| GET/POST | /api/projects/:id/members | 列成员 / 加成员（admin） |
| DELETE | /api/projects/:id/members/:uid | 移除成员（admin） |
| GET/POST | /api/projects/:id/equipment | 列 / 建设备 |
| PATCH/DELETE | /api/equipment/:id | 改 / 删设备 |
| GET/POST | /api/projects/:id/custom | 列 / 建自定义项 |
| PATCH/DELETE | /api/custom/:id | 改 / 删自定义项 |
| GET | /api/settings ; PUT /api/settings/:key | 读全部 / 写一类（params\|prices\|formulas\|cparams） |
| GET | /api/logs?limit= | 操作日志（admin 全量；用户=自己项目+自身） |
| GET/POST | /api/projects/:id/snapshots | 列 / 存快照 |
| POST | /api/projects/:id/snapshots/:sid/rollback | 回滚（先自动备份当前态） |

### 14.3 前端同步层（`index.html` 末尾「同步层」段）
- `saveAll()` = `cacheToLocal()`（localStorage 离线缓存）+ `scheduleSync()`（防抖 700ms）。
- `flushSync()`：`diffToCalls(serverSnapshot, snapshotNow())` 产出细粒度 POST/PATCH/DELETE + 变更的 settings PUT；成功后更新 `serverSnapshot`。
- 登录后 `mountApp → bootstrapData()`：正常拉服务端覆盖内存；**服务端空或本地有未同步改动**则以本地为准推上去（首登迁移 / 断网恢复，后写为准）。
- 客户端与服务端 **id 一致**（创建接口接受客户端 id），diff 才能按 id 精确比对。
- 离线：缓存本地、置 `tf_unsynced`、显示「离线」、每 12s 重试。
- 顶部 `.sync-ind` 显示：同步中 / 已保存 / 离线。
- **坑**：回滚后必须 `serverSnapshot=null` 再 `bootstrapData()` 重置同步基准，否则旧 diff 会把已删数据重新创建。

### 14.4 测试
- 后端自动化：`python3 test/api_test.py`（需先重置本地 D1）。覆盖鉴权/用户/项目隔离/成员/设备/自定义/设置/bootstrap/日志/快照回滚/级联/401-403，共 54 项。
- 重置本地 D1：对 9 张表 `DROP TABLE` 后 `npm run db:local`。
- 数据正确性回归锚点：新项目默认设备（左右各 40m、双防区、1 套）经后端全链路仍复现 **标准件 ¥11,161.42 / 可选件 ¥1,984.26 / 合计 ¥13,145.69**。
- 已完成 3 轮：① 后端 54 项全过；② 浏览器端到端（基准值/单双防区缩放/公式引擎/多设备汇总/自定义项/CSV/持久化）；③ 多用户隔离 + 后写为准 + 成员增删即时生效 + 普通用户受限视图 + 日志范围隔离。

### 14.5 阶段一旧坑的现状
- 「单价/公式按行索引存」的隐患仍在（`prices`/`formulas` 仍以 BOM 行索引为 key，存进全局 `settings`）。增删 `BOM` 项仍需迁移映射。
