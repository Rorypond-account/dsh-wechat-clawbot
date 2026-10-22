# 安全策略

## 支持版本

只有 `main` 分支上的最新版本会收到修复。

## 报告安全问题

请通过 GitHub 的 **Security → Report a vulnerability**（私有安全公告）报告，不要开公开 issue。

报告里请包含：

- 受影响的版本 / commit；
- 复现步骤与环境（OS、Node、Python、DSH 版本）；
- 影响评估。

**不要提交**：微信 bot token、context token、`.credentials.yaml`、完整日志、含二维码或账号 id 的截图。插件日志已经脱敏，但提交前仍建议自行检查。

## 威胁模型

这是一个运行在本机的 Harness 插件，与启动它的 DSH 进程同权限。它不做提权，也不对外开监听端口。

| 资产 | 位置 | 保护方式 |
|---|---|---|
| 微信 bot token、context token、消息游标 | `$DSH_HOME/wechat-clawbot/state/ilink/` | 仅本机；保存后尽力设 `0600`；不写日志、不回传页面 |
| 插件配置 | `$DSH_HOME/wechat-clawbot/config.json` | 仅本机；页面通过同源 `/api/wechat-clawbot/*` 读写 |
| 诊断日志 | `$DSH_HOME/wechat-clawbot/log/`、`state/log/` | 写入前脱敏；2 MB 轮转 |
| 微信会话内容 | DSH session log（`$DSH_HOME/sessions/…`） | 由 Harness 自身持久化 |

### 边界与已知限制

- **微信消息等于用户输入**：消息会作为真实 `user/message` 进入 agent，能触发工具调用。请用 `permission` 限制微信会话权限（默认 `workspace-write`），不要把 bot 借给他人或拉进群（群消息会被忽略）。
- **白名单**：`allowFrom` 为空时只接受扫码者本人的消息；填入 ID 后只接受列表内的发送者。
- **凭证生命周期**：iLink token 约 24 小时有效；「退出登录」会删除本机凭证。
- **协议非官方**：iLink 由腾讯提供并可能调整；本项目的错误处理不构成对服务可用性的保证。
- **Python 子进程**：桥接以本机 Python 运行，通过标准输入输出与本插件通信；插件不执行微信消息里的内容，消息只交给 agent。
- **页面鉴权**：设置页数据走 Harness 自己的 `/api` 同源围栏（需要 owner 身份），插件不额外开未鉴权端口。

## 加固建议

1. 微信会话权限保持 `workspace-write` 或 `read-only`，确认需要时再临时放宽。
2. `allowFrom` 只填自己的微信 ID。
3. 不把 `$DSH_HOME` 目录同步到网盘或提交进任何仓库。
4. 怀疑泄露时：页面「退出登录」→ 删除 `$DSH_HOME/wechat-clawbot/state/ilink` → 重新扫码。
