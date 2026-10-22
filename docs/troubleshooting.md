# 排障

## 先看哪里

| 文件 | 内容 |
|---|---|
| `$DSH_HOME/wechat-clawbot/log/plugin.log` | Host 侧：启动、phase 变化、agent 会话、HTTP 错误 |
| `$DSH_HOME/wechat-clawbot/state/log/bridge.log` | Python 侧：登录、长轮询、发送失败 |
| `$DSH_HOME/wechat-clawbot/status.json` | 最近一次 phase / 账号（掩码前原始值在内，勿外发） |

页面上的「诊断日志」是两者的合并视图，已经脱敏。

## 症状对照

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 页面一直「未启动」 | Python 不在 PATH / `pythonPath` 错 | 终端跑 `python --version`；设置里填绝对路径后点「重启桥接」 |
| 日志有 `Python 启动失败` | 同上，或权限不足 | 看 `plugin.log` 的 ENOENT/EACCES |
| 二维码不出现，phase 停在 `starting` | 网络/代理访问不到 `ilinkai.weixin.qq.com` | 检查代理；点「重启桥接」 |
| `登录失败：` + 网络错误 | 同上 | 同上 |
| 二维码反复 `expired` | 长时间未扫 | 页面会刷新二维码；超过 3 次自动中止，点「登录 / 重新登录」 |
| 扫码后停在 `need_verify` | 需要数字配对码 | 在页面「配对码」里输入手机显示的数字 |
| 扫码后 `error` | 配对码多次错误 / token 被拒 | 稍后重试；必要时「退出登录」重来 |
| 微信发消息没反应 | `replyEnabled` 关闭 / 发送者不在白名单 | 发 `/状态` 查看；检查设置页开关与 `allowFrom` |
| 回复 `⚠️ 本地 agent 不可用` | agent 创建失败、没有模型、profile 缺服务 | 看 `plugin.log` 里的具体异常；确认 profile 有 `agents` 与可用模型 |
| 回复 `⚠️ 本轮没有生成回复` | 模型返回空 / 轮次被中断 | 换模型或重试；`reason` 会写在括号里 |
| 回复 `⚠️ 本轮被会话状态拦截` / `blocked` | 微信会话被 GUI 归档，`agent/pre-step` 直接拒绝 | 插件会自动解除归档，再发一条即可；仍不行发 `/重置` 换新会话 |
| 桥接反复退出 | 账号被限流（errcode `-14`）或 Python 崩溃 | 看 `bridge.log`；等退避重试，连续 5 次失败后点「重启桥接」 |
| 重启 DSH 后要重新扫码 | token 过期（约 24h）或被别处登出 | 正常现象，扫码即可 |
| 设置页 401 / 无法加载 | 不是在 Harness 页面里打开，或用了无凭证的 curl | 通过 DSH 的 Web UI 打开设置页 |

## 常见错误码

- **`-14`**：iLink 的会话冷却/限流信号，桥接会退避 45 秒继续用同一 token；连续 20 次才要求重新登录。
- **HTTP 401**：`/api/wechat-clawbot/*` 只对 Harness owner 会话开放，命令行直接请求会被拒绝。

## 手动重置

1. 设置页「退出登录」（等价于删除 `state/ilink` 并重新获取二维码）。
2. 仍不行：关闭 DSH → 删除 `$DSH_HOME/wechat-clawbot/state` → 重新打开。
3. 连配置一起重置：删除 `$DSH_HOME/wechat-clawbot/config.json`（下次启动重建默认值）。

## 收集诊断信息

```text
1. DSH 版本（关于页面）
2. Node / Python 版本
3. 设置页「诊断日志」最近 50 行
4. status.json 里的 phase / message（先把账号 id 掩码）
```

发送前请确认没有 token、二维码链接、完整账号 id。
