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

## 10. 未完成路线图（用户已确认要做，按阶段推进）

> 用户明确要求**一个阶段一个阶段地做**，每阶段做完先验证再继续，避免一次改动太大。

### 阶段二：后端 + 多人协同（未开始）
- Cloudflare D1（SQLite）数据库 + Cloudflare Pages Functions 作为后端 API
- Cloudflare Access 邮箱白名单登录（用户届时提供白名单邮箱）
- **按项目分配成员**
- 冲突策略：**后写为准**（last-write-wins）
- 首次登录时把本地 localStorage 数据**迁移到服务器**
- 自动同步（带防抖 debounce）+ 同步状态指示器
- 细粒度 PATCH 更新（不要每次全量覆盖）

### 阶段三：操作日志 + 版本回滚（未开始）
- 操作日志：记录**谁、何时、改了什么**；价格 / 公式改动要记录**改前改后**的值；用右侧抽屉展示
- 版本快照（按项目）：
  - 手动存档（带标签）
  - 自动检查点（每约 20 次改动，或每天首次访问时）
- 回滚：回滚前先自动存一份「回滚前」状态，可反悔

---

## 11. 给接手者的注意事项 / 坑

1. **保持单文件、零依赖**，除非进入阶段二需要后端，否则不要引框架/打包器。
2. 改数据结构时，**必须**同步更新对应的 `load*()` 迁移逻辑，否则老用户 localStorage 数据会读错或丢失。
3. 改 JS 后可先用 `node --check` 抽出 `<script>` 验证语法，再 commit。
4. `tf_equip` 是**跨项目**的全局设备表，靠 `projectId` 区分；筛选务必用 `currentEquipments()` 而不是直接遍历全表。
5. 单价 / 公式覆盖是**按行索引**存的（`tf_prices`/`tf_formulas`），如果将来增删 `BOM` 项导致索引错位，需要做迁移映射。建议阶段二改成按稳定 id 存。
6. 不要在代码或日志里明文打印任何 token；push 用 Keychain 凭证或临时 token。
7. 进入阶段二前，本工具是纯前端、数据只在本地浏览器；任何「多人能看到同一份数据」的预期都要等后端做完才成立。
