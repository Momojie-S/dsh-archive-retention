# @momojie-s/dsh-archive-retention

DSH 插件:**归档会话定期清理**——物理归档堆(`sessions-archive/`)、页面归档的会话记录、以及孤儿子 agent 目录,超过保留期(默认 **7 天**,页面可改,支持天/小时)自动物理删除。保留期即"宽限期":归档 ≠ 永久保存,到期即焚。

## 一句话作用

归档(页面归档或物理归档)只进不出,日积月累拖慢 Web GUI(实测 664 条会话列表 ≈ 1s/880KB)。本插件在宿主侧挂一个定时清扫:超过保留期的归档记录自动物理删除,每次落审计清单;保留期(数值+单位)、清扫节奏(cron)、范围开关都在 **Web 插件页(插件 → 已安装 → 本插件 → 配置)的表单里直接改,无需碰配置文件、无需重启。

## 环境要求

- DSH `>= 0.2.0-rc.2`(已验证至 `0.2.1-rc.5`;设置走 volatile Config + 插件页表单,需 web profile);Windows/Linux/macOS
- 宿主+客户端双半部 bundle 插件

## 用法

安装重启后无需任何操作:

- **清扫节奏**:每小时检查一次(可配,最小 15 分钟),超期即删
- **页面配置**:插件 → 已安装 → @momojie-s/dsh-archive-retention → 配置:总开关、三个范围开关、保留数值+单位(天/小时)、清扫 cron
- **审计**:每次删除在 `sessions-archive/_manifests/retention-<时间戳>.json` 落清单

**清理范围**(均可独立开关):

| 范围 | 对象 | 判据 |
|---|---|---|
| 物理归档堆 | `sessions-archive/<workspace>/<id>/` | 目录最新写入早于保留期 |
| 页面归档 | GUI 归档名单里的会话记录 | 同上,**且**会话不在内存(挂着的绝不删,重启后补删) |
| 孤儿子 agent | `sessions/` 里 `parentSession` 指向的父目录已不存在的子 agent 目录 | 同上(冷 + 不在内存);父目录还在(宽限期内)则等父目录先走,子目录下一轮跟随 |

**绝不触碰**:未归档的主会话、正在运行/在内存的会话、`_manifests` 目录、头部读取失败的目录(无法确认父子关系时宁可不动)。

## 安装

```powershell
dsh plugin --profile web add <本仓库路径>
# 或
dsh plugin --profile web add github:Momojie-S/dsh-archive-retention
```

安装后**重启 DSH** 生效。

## 配置

patch `config`(全部可选;页面改动存设置存储,优先级更高):

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `retentionValue` | `7` | 保留期数值 |
| `retentionUnit` | `days` | 保留期单位:`days` / `hours` |
| `cleanSessionsArchive` | `true` | 清理物理归档堆 |
| `cleanGuiArchived` | `true` | 清理页面归档的会话记录 |
| `cleanOrphanSubagents` | `true` | 清理孤儿子 agent(父会话目录已不存在的超期子 agent 目录) |
| `sweepCron` | `0 4 * * *` | 清扫节奏(5 段 cron,默认每天 04:00) |

## 验证

DSH 日志出现 `archive-retention: active (retention 7d, sweep every 60min, ...)`;设置页插件区出现"归档自动清理"卡片;把保留期临时调成 1 小时,小时内 `sessions-archive/_manifests/` 出现 `retention-*.json` 即闭环。

机制、安全边界与决策记录见 [docs/design/overview.md](docs/design/overview.md)。
