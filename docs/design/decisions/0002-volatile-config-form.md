# 0002 — 设置接面迁移到 volatile Config + 插件页表单

## 状态

accepted（2026-10-10，DSH 0.2.0-rc.2）

## 背景

DSH 0.2.0 整体移除了 settings 服务的 `installSection` 方法（全官方树零调用零定义），连带旧的「宿主注册命名空间 + 客户端 keyed-slot 卡片」双半部机制作废。插件停留在 0.1.x 接面上会在新版下抛错并阻断 DSH 启动。官方新机制：Config 字段声明 `.volatile()`，设置服务按 profile 条目 id 投影表单；页面编辑由插件页（`plugins.row.config` slot）承载。

## 备选

1. 只改 host 半部、删掉客户端卡片（配置只能改 patch 文件）——页面可编辑性丢失，与「无需碰配置文件」的产品目标冲突。
2. 保留双半部、仿官方伴生包用 `ctx.configForms.get` + `SettingsFormModel` 自建整套表单——功能最全，但要求 client 引入 ui-primitives/locale 整链，对一个 7 字段表单过重。
3. 客户端注册 `plugins.row.config` slot，直接消费页面 owner 递进来的 `props.form.state` + `props.form.mutate`，自绘轻量暂存表单。

## 决策

选 3。宿主半部只做字段 volatile 化 + 每次清扫/滴答现读 `.get()`（无缓存副本，无 installSection）；客户端半部从页面 owner 拿表单句柄，7 个字段（4 布尔 + 数值 + 单位下拉 + cron 文本）自绘，保存走一次原子 `mutate(ops, revision)`。`dsh.client.inject` 声明 `@deepseek-ai/dsh-client-ui-plugin-manager` 保证 slot 声明先于注册加载。

## 后果

- 依赖面收窄：peer 去掉 `dsh-settings`，新增对插件页 slot 契约（`plugins.row.config`、`ConfigPageForm`）的依赖——后者是页面 owner 递的 props，无运行时 import，升级破坏面小。
- `ctx.slots.register` 在 slot 未声明时抛错：若未来插件页改名 slot，客户端半部会失败——闸门④浏览器冒烟能拦住。
- 旧 `archive-retention` 设置命名空间里的用户层值不会迁移（本地无历史用户层写入，无损）。
