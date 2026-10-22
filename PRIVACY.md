# 隐私说明

## 数据流向

```
微信手机 → 腾讯 iLink 服务器 → 本机 bridge/host_bridge.py → 本机 DSH agent → 模型 provider
                                        ↑                                        │
                                        └──────────── 回复 ←─────────────────────┘
```

- 你在微信里发的消息会经过腾讯 iLink 服务（这是微信自身的通道），再进入本机。
- 消息内容会作为一轮对话交给本机 agent；真正的模型请求发给你在 Harness 里配置的 provider（例如 DeepSeek）。使用哪个 provider、是否开思考、发多少上下文，由该 profile 的配置决定。
- 插件本身**不向作者或任何第三方服务器发送数据**，不含遥测、统计或崩溃上报。

## 本机存储

| 内容 | 路径 | 说明 |
|---|---|---|
| 配置 | `$DSH_HOME/wechat-clawbot/config.json` | 开关、提示词、白名单、模型等 |
| 运行状态 | `$DSH_HOME/wechat-clawbot/status.json` | 当前 phase、账号 id、二维码链接 |
| 登录凭证 | `$DSH_HOME/wechat-clawbot/state/ilink/` | bot token、context token、消息游标 |
| 诊断日志 | `$DSH_HOME/wechat-clawbot/log/plugin.log`、`state/log/bridge.log` | 已脱敏，超过 2 MB 轮转 |
| 微信会话工作目录 | `$DSH_HOME/wechat-clawbot/workspace` | agent 的文件工具根目录（可改） |
| 会话记录 | `$DSH_HOME/sessions/…/wechat-<id>/` | 由 Harness 持久化，可用 Harness 的方式删除 |

`$DSH_HOME` 在 Windows 上通常是 `%USERPROFILE%\.dsh`。

## 脱敏

- 日志、`/api/wechat-clawbot/status`、`/logs` 的输出会对 `token`、`bot_token`、`context_token`、`typing_ticket`、`verify_code`、`Bearer …` 以及 `xxxx@im.bot` / `xxxx@im.wechat` 形式的账号 id 做掩码（保留前 4 位）。
- Windows 用户目录（`C:\Users\<你的用户名>\…`）在日志中显示为 `C:\Users\<user>\…`。
- 页面只显示掩码后的账号；`status.json` 落盘时也只保存掩码后的账号 id。
- 仓库与打包产物中不含任何凭证；`config.json`、`state/`、`log/` 均在 `.gitignore` 中。

## 保留期与清理

- 日志：单文件 2 MB 上限，保留一份轮转文件。
- 凭证：直到 token 过期或你手动退出登录。
- 彻底清理：页面点「退出登录」，然后删除 `$DSH_HOME/wechat-clawbot` 整个目录；如需连会话记录一起删除，再清理 `$DSH_HOME/sessions` 下对应的 `wechat-*` 目录。

## 你的责任

把 bot 借给他人、拉进群、或用 `danger-full-access` 跑不可信消息，都会扩大消息内容与工具执行的影响面。默认配置（仅扫码者、`workspace-write`、群消息忽略）是有意收紧的。
