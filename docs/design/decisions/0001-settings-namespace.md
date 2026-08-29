# ADR-0001:页面配置走设置命名空间而非 patch 文件

状态:accepted(2026-08-28)

## 背景

保留期参数要"在页面能配置"。候选:① 让用户手改 patch 文件(HMR 热生效但不是页面操作);② 插件自带设置存储文件 + 卡片读写;③ 注册 DSH 设置命名空间(`installSettingsSection`),页面改动走设置 RPC 落设置存储。

## 决策

选 ③。宿主半部 `installSettingsSection` 注册 `archive-retention` 命名空间(Config 模式即页面校验),客户端半部在 `settings.plugin.item` 坐席渲染卡片,经 `settingsScope` 服务(set/unset)写用户层。

分层语义天然成立:组合层(patch config)= 部署者默认,设置存储用户层 = 页面改动,优先级由设置系统统一裁决;`scope.watch` 回流后清扫即用新值,无需重启。

## 后果

- 正面:页面原生体验(暂存编辑/保存/放弃,只读模式自动禁用);与官方 bash/agent-loop 卡同机制
- 正面:patch 仍是部署基线,重置页面改动即回到 patch 默认
- 代价:插件必须是宿主+客户端双半部 bundle(构建/门禁/发布复杂度上升);卡片 UI 为自绘(官方卡片套件只导出类型,不可复用实现)
- 已知取舍:卡片文案硬编码中文(官方 locale 字典不收第三方 key);设置页只读态(LAN 访问)下卡片自动禁用
