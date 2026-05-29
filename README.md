# 张力围栏 · 多设备成本清单工具

一份单文件 HTML 工具，用于汇总多台"双防区/单防区张力围栏"设备的 BOM 物料与成本。

## 使用

- 在线访问：部署到 Cloudflare Pages 后访问 `https://<your-project>.pages.dev`
- 本地使用：双击 `index.html` 即可在浏览器中打开

## 功能

- **设备列表**：可任意新增/复制/删除/重命名设备；每台设备独立设置左右防区长度与套数
- **单/双防区切换**：单防区设备自动按 1 个传感器 / 1 个控制器 / 1 个防雷模块计；双防区按 2 个计
- **跨设备汇总**：顶部切换"全部设备汇总"或"单设备视图"，汇总模式下每行数量为所有设备求和
- **公式编辑器**：每行右侧 `ƒ` 按钮可改数量公式，支持引用左侧参数（含自定义参数、`zoneLen1..N`、`totalZoneLen`、`mainPoles`、`sets`、`zonesPerPillar` 等）
- **自定义参数与自定义子项**：左侧每个参数组可加自定义参数；BOM 每个组件下可加自定义子项
- **持久化**：所有改动存浏览器 `localStorage`（每个浏览器独立，不互通）
- **导出 CSV**：含设备清单、各设备防区明细、汇总 BOM（每台设备一列分解数量）

## 数据来源

基于"双防区张力围栏 BOM 清单 V5（30 线）"模板，价格与公式可在页面上覆盖修改。

## 登录与用户（阶段二 · 后端）

自 2.0 起接入 **Cloudflare Pages Functions + D1** 后端：

- 进应用需**登录**；账号与密码（PBKDF2 哈希）存在 D1，登录态用 HttpOnly 会话 cookie。
- 超级管理员 **admin / adminyy**（首次访问后端自动种入），可对用户增删改查与重置密码。
- 因为有后端，**不能再用 file:// 双击打开**；需通过部署后的网址，或本地 `npm run dev` 访问。

## 本地开发

```bash
npm install                 # 安装 wrangler
npm run db:local            # 建本地 D1 表（首次一次即可）
npm run dev                 # 启动 http://localhost:8788 （前端 + /api + 本地 D1）
```

## 部署（Cloudflare Pages + D1）

```bash
npx wrangler login                              # 登录你的 Cloudflare 账号
npx wrangler d1 create tension-fence-cost-db    # 建 D1，把返回的 database_id 填进 wrangler.toml
npm run db:remote                               # 给线上 D1 建表
git add -A && git commit -m "..." && git push   # 触发 Pages 自动构建（含 functions/）
```

> ⚠️ 若用 Cloudflare Pages 的 Git 自动部署：还需在 **Pages 项目 → Settings → Functions → D1 database bindings** 里加一个绑定，变量名必须是 **`DB`**，数据库选 `tension-fence-cost-db`。
> 详细步骤见 [`HANDOFF.md`](./HANDOFF.md) 第 13 节。

## 继续开发 / 交接

接手开发请先读 [`HANDOFF.md`](./HANDOFF.md)：内含数据模型、核心函数地图、BOM 与公式引擎说明、已完成功能清单、以及未完成的阶段二（后端 + 多人协同）/ 阶段三（操作日志 + 版本回滚）规格。
