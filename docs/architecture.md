# 架构

## 组件

| 组件 | 文件 | 运行位置 |
|---|---|---|
| Host 插件 | `index.js` | DSH Host 进程内（Cordis 插件） |
| 设置页 | `client.js` | 浏览器（Harness Web UI） |
| iLink 传输层 | `bridge/host_bridge.py` | 独立 Python 子进程（stdlib） |
| 协议客户端 | `bridge/ilink_client.py` | 同上 |
| 二维码渲染 | `vendor/qrcode.mjs` | Host 进程 |

插件不引入任何 `@deepseek-ai/*` 模块：所有 Harness 能力通过 `ctx.get(service)` 获取，这样本地目录安装（符号链接）时也能正确解析。

## 数据流

```
微信手机 ⇄ 腾讯 iLink ⇄ host_bridge.py
                            │  NDJSON（stdout 事件 / stdin 命令）
                            ▼
                     index.js（Host 插件）
                            │  ctx.agents.create/resume + agent.followup()
                            ▼
                     DSH agent（当前 profile：插件/技能/提示词/工具）
                            │  session/event：assistant/message、turn/end
                            ▼
                     host_bridge.py → sendmessage → 微信
```

## NDJSON 协议

stdout 只输出 JSON（人读日志走 stderr），stdin 只接收 JSON。

### bridge → Host（事件）

| type | 字段 | 说明 |
|---|---|---|
| `phase` | `phase`、`message`、`qrcodeUrl`、`accountId` | 状态机变化 |
| `log` | `level`（info/warning/error）、`text` | 诊断行（已脱敏） |
| `inbound` | `peerId`、`text`、`contextToken`、`messageId` | 一条微信文本消息 |

`phase` 取值：`starting`、`waiting_qr`、`qr_ready`、`scaned`、`need_verify`、`confirmed`、`connected`、`expired`、`error`、`stopped`。Host 另外维护 `idle`、`disabled`。

### Host → bridge（命令）

| type | 字段 | 说明 |
|---|---|---|
| `verify-code` | `code` | 手机显示的配对码 |
| `reply` | `peerId`、`contextToken`、`text` | 发送一条文本（Host 已分片） |
| `typing` | `peerId`、`on` | 输入中指示开/关 |
| `logout` | — | 清除本机凭证并退出，由 Host 重启进入扫码 |
| `shutdown` | — | 优雅退出 |

## 会话模型

- 会话 id：`wechat-<peerId 清洗后>`，`/重置` 后追加 `__<generation>`（generation 只存在内存，重启后从 0 开始）。
- 重启即新会话：`activeSessions` 是内存表，重启后为空；`sessionFor()` 发现默认 id 在磁盘上已存在（上一次运行留下的）时**不再 resume**，改为 `newSession()` 开新会话，旧会话保留并可经 `/会话` 切回。首次使用的 peer 仍用干净的默认 id。
- 创建：`ctx.agents.create({ sessionId, agentOptions, meta: { cwd, agentPreset }, setup })`。
- 恢复：磁盘已有会话时改用 `ctx.agents.resume({ resumeSessionId, setup })`（判据为 `sessionPersistence.stat()`）。
- 工作区归属：`ensureGrouped()` 先建目录，再用 `workspaceRegistry.resolveByPath(cwd)` 找归属；找不到就 `workspaceRegistry.create(cwd, '微信 clawbot')` 自动登记，然后 `attachSession`。工作区外的会话只在 agent 活着时出现在 GUI，因此这一步是「会话常驻侧栏」的前提；登记失败只记 warn。
- `setup` 内：`agentPresets.mount(agentCtx, presetId)`；若开启「使用本机提示词」，再注册 `systemPrompt.section({ name: 'wechat-clawbot-persona', order: 90, text })`。
- 权限：创建后调用 `permissionPresets.set(session, config.permission)`，只影响微信会话，不改 profile 默认。
- 提交：`agent.followup(createUserMessage(...))`，消息形如 `{ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }`。
- 回复：监听 `ctx.on('session/event')`，同一 sessionId 的 `assistant/message` 累加文本，`turn/end` 时取最后一段非空文本；`reason.kind` 非 `completed` / `max-tokens` 时作为错误提示。
- 并发：同一 `peerId` 串行（Promise 链），不同用户并行。

## 生命周期

1. 插件激活 → 注册 `session/event` 监听、注册 `/api/wechat-clawbot/*` 路由。
2. `enabled && autoStart` → 1.2 秒后 `start()`，spawn Python（`--state <stateDir> --log-level … --allow-from …`）。
3. 桥接输出 `phase`：有凭证直接 `connected`，否则 `waiting_qr → qr_ready`。
4. 进程退出且非主动停止 → 退避重启（1/2/5/15/30 秒），第 6 次放弃并保持 `error`。
5. 插件卸载 / `enabled=false` → 发送 `shutdown`，3 秒后强制结束，并释放所有 agent handle。

## HTTP 路由（同源 `/api` 围栏内）

| 路由 | 方法 | 作用 |
|---|---|---|
| `/api/wechat-clawbot/status` | GET | 状态 + 配置摘要 + 尾部日志（账号已掩码） |
| `/api/wechat-clawbot/about` | GET | 名称、版本、许可证 |
| `/api/wechat-clawbot/qr.svg` | GET | 当前二维码（无二维码时 404） |
| `/api/wechat-clawbot/begin` | POST | 停止后重启桥接（重新走登录） |
| `/api/wechat-clawbot/restart` | POST | 重启桥接 |
| `/api/wechat-clawbot/verify-code` | POST | 提交配对码 |
| `/api/wechat-clawbot/logout` | POST | 停止桥接、删除 `state/ilink`、重新扫码 |
| `/api/wechat-clawbot/config` | GET / POST | 读取 / 保存配置 |
| `/api/wechat-clawbot/logs` | GET | 最近 N 行插件与桥接日志 |

## 本地命令

`routeCommand()` 在 Host 内处理以下命令，不产生模型调用。中文为主，英文为别名：

| 中文 | 英文别名 | 归一化名 |
|---|---|---|
| `/帮助` | `/help` | `help` |
| `/状态` | `/status` | `status` |
| `/重置` | `/reset`、`/new` | `reset` |
| `/模型` | `/model`、`/models` | `model` |
| `/思考` | `/think`、`/reasoning` | `think` |
| `/对话` | `/chat`、`/conversation` | `chat` |
| `/工作区` | `/ws`、`/workspace`、`/cwd`、`/pwd` | `workspace` |
| `/权限` | `/perm`、`/permission` | `permission` |

子命令同样中英兼容：`新增|添加|add|new`、`使用|切换|use|switch`、`列表|list`、`默认|default`；权限值支持 `只读|写入|完全`。

- 需要「下一轮用新参数」的命令（模型、思考等级、工作目录）会调用 `newSession(peerId)`：generation +1、释放旧 agent handle，下一条消息创建带新配置的会话。
- `/perm` 额外对当前 live agent 的 session 调用 `permissionPresets.set`，因此立即生效。
- `/ws add` 会用 `mkdirSync(recursive)` 创建目录，写入 `config.workspaces` 并切换 `config.cwd`。

### 编号选择

不带参数的命令（`/perm`、`/think`、`/model`、`/cwd`、`/ws`）会打印编号列表并写入 `pendingChoices`：

| 项 | 说明 |
|---|---|
| 存储 | `Map<peerId, { kind, items, createdAt }>`，内存态，按用户隔离，重启失效 |
| 有效期 | `CHOICE_TTL_MS = 5 分钟` |
| 回答 | 纯数字：`1..N` 选择，`0` 取消；越界提示范围并保留列表；非数字清除列表并回执「已取消上一条选择。」后继续处理原消息 |
| 回执 | `takeChoice()` 返回 `{ handled, text }`：`handled: true` 只回执；`handled: false` 先回执再继续走普通消息/命令 |
| 清除 | 选择成功后删除；非命令文本消息到达时删除；命令自带参数时也删除 |
| 优先级 | `takeChoice()` 在 `routeCommand()` 之前执行，因此纯数字在列表有效期内不进模型 |

### 工作区列表

`workspaceChoices()` 合并三处来源后去重：

1. `config.workspaces`（插件登记，`/工作区 新增` 写入）；
2. `workspaceRegistry.list()`（GUI 里创建的工作区，取 `workspace.path`）；
3. 当前 `cwd`——始终出现在列表里，即使尚未登记。

编号选择与 `/目录`、`/工作区` 都读取这份合并结果，因此 GUI 工作区可以直接在微信里切换。

### 会话参数播报

`announceSession`（默认 true）控制「🧭 会话参数」卡：工作区、模型、思考等级、权限、人设、本地回复状态。

- 新会话第一次进入 agent 时（`handleInbound` 拿到 sessionId 之后）单独发送一次，并记入 `greeted: Set<sessionId>`。
- `/重置`、`/model`、`/think`、`/cwd`、`/ws`、`/ws add`、`/perm` 的回复通过 `withCard()` 附带同一张卡；切换类命令同时把新 sessionId 标记为已播报，避免下一条消息重复。
- `greeted` 是内存集合：重启 DSH 后清空，所以每次启动的第一轮必播报；同一会话后续消息不再重复。

### 会话切换

`/会话` 列出的不是插件自己的代次，而是**当前工作区里的全部会话**：

1. `sessionPersistence.list()` 返回所有会话快照；
2. 按 `header.cwd` 归一化比较（统一 `\`、去尾部分隔符、忽略大小写）过滤出当前工作区；
3. 标题来自 `sessionQuery.readTitleSnapshots()`，没有标题时用「会话 N · MM-DD HH:mm」；
4. 按 `createdAt` 降序，最多 30 条。

切换通过 `activeSessions: Map<peerId, sessionId>` 记录，`sessionFor()` 优先使用它。恢复、创建或切换会话后会调用 `ensureGrouped()`（`resolveByPath` → 必要时 `create` → `attachSession`），让该会话出现在对应工作区分组里，而不是「未分组」。

- 目标会话已 live（GUI 打开）：直接复用 `agents.get(sessionId)`，包装成 `owned: false` 的 handle，切换时不会 dispose 别人的 agent。
- 目标未 live：`resume()`；不存在则 `create()`。
- 只有插件自己创建的 handle（`owned: true`）会在切换/重置时 dispose。

### 工作区列表

`workspaceChoices()` 合并三处来源后去重：

1. `config.workspaces`（插件登记，`/工作区 新增` 写入）；
2. `workspaceRegistry.list()`（GUI 里创建的工作区，取 `workspace.path`）；
3. 当前 `cwd`——始终出现在列表里，即使尚未登记。

编号选择与 `/工作区` 都读取这份合并结果，因此 GUI 工作区可以直接在微信里切换。

### 提问与计划审批桥接

`registerQuestionAnswerer()` 以前置方式（`prepend`）注册 `user-questions/request` 的 waterfall 监听——必须排在 `@deepseek-ai/dsh-api-remotes` 之前，否则请求会先被推给浏览器客户端并一直等它作答：

- 请求的 `agent.id` 能在 `handles` 里找到对应 peer、且桥接处于 `connected` 时，把**问题与带编号的选项**（不含 `detail`）发到微信，并**同时** `next()` 让 GUI 照旧弹卡片；两边先答先赢，输的一方收到「已作答」提示；
- 用户的下一条消息由 `handleInbound` 优先交给 `answerPendingQuestion()`：数字选选项、其他文字作为 `custom` 反馈、`0` 取消；10 分钟超时按「继续规划」结算；
- 结算后返回 `{ answers: [{ id, selected, custom? }] }`，plan-mode 据此判断是否批准；
- `request.signal` 中止（`askTimed` 到点或 turn 取消）时清理等待并 reject，交给 host 自己的超时语义；
- 非微信会话的请求、以及桥接未连接时直接 `next()`，GUI 行为不变。

## 脱敏

`index.js` 与 `host_bridge.py` 各有一份 `redact()`：掩码 `token`/`bot_token`/`context_token`/`typing_ticket`/`verify_code` 的值、`Bearer …`，以及 `xxxx@im.bot`、`xxxx@im.wechat` 形式的账号 id。日志写入前、接口返回前统一应用。
