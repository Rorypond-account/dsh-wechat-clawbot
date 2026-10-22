# dsh-wechat-clawbot

[English](./README.en.md) | 中文

把微信（腾讯 iLink / ClawBot）接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的通道插件。一个 bundle = Host 桥接 + 浏览器设置页，扫码登录、启动自动连接、回复交给本机 agent。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#许可证与声明)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](#前置条件)
[![Python](https://img.shields.io/badge/python-3.10%2B%20stdlib-3776AB?logo=python&logoColor=white)](#前置条件)

## 功能

- **设置里扫码登录**：设置 → 微信 ClawBot，页面显示二维码、可复制链接、配对码输入框。
- **启动即连接**：DSH 启动时自动拉起桥接并复用已保存的登录；token 过期自动回到扫码。
- **回复走本地 DSH agent**：微信消息进入当前 profile 的 agent，用它已安装的插件、技能和提示词生成回复。
- **可关的「接入本地插件/提示词」**：关掉后桥接仍保持连接，但只回固定文案，不调用模型、不产生 token 消耗。
- **微信内命令**：`/帮助`、`/状态`、`/重置` 等全部由插件本地处理，不进模型。
- **隐私可控**：日志与页面输出自动脱敏，凭证只存在本机 `$DSH_HOME` 下，仓库不含任何密钥。

> 页面截图待补充：`docs/images/` 预留（不要提交含二维码、微信号、bot id 的截图）。

## 架构

```
微信手机 ⇄ 腾讯 iLink 服务器 ⇄ bridge/host_bridge.py
                                     │  NDJSON (stdin/stdout)
                                     ▼
                          index.js（Host 插件）
                                     │  ctx.agents.create/resume + followup
                                     ▼
                          本机 DSH agent（当前 profile）
                                     │  session/event: assistant/message · turn/end
                                     ▼
                          bridge → sendmessage → 微信
```

细节见 [docs/architecture.md](./docs/architecture.md)。

## 前置条件

| 组件 | 要求 |
|---|---|
| Node.js | ≥ 22（Harness 自带） |
| Python | ≥ 3.10，只用标准库，无需 pip 安装 |
| DeepSeek Harness | ≥ 0.2.0，profile 需要 `connection`、`agents`、`agentDefaultModel` 服务（desktop / web profile 默认具备） |
| 微信 | 手机端支持 ClawBot / 龙虾，并在微信里开启该能力 |

## 安装

```bash
git clone https://github.com/Rorypond-account/dsh-wechat-clawbot.git
dsh plugin --profile <你的 profile> add <克隆下来的目录绝对路径>
```

也可以在 Harness 会话里用插件管理器安装该目录（`install_bundle`，target = 目录路径）。

安装后**完全退出并重新打开 DSH**，设置页才会出现（浏览器端模块在启动时加载）。

## 首次登录

1. 打开 设置 → **微信 ClawBot**（或 设置 → 插件 → `dsh-wechat-clawbot`）。
2. 点「登录 / 重新登录」，页面出现二维码。
3. 手机微信扫码；若手机显示数字配对码，填到页面的「配对码」里提交。
4. 状态变成「已连接」后，在微信里给这个 bot 发一条消息即可对话。

之后每次启动 DSH 都会自动连接，不需要重新扫码，直到 token 过期（约 24 小时）或你点「退出登录」。

## 设置项

页面上的改动**立即生效并保存**：开关即时保存，文本框停止输入后自动保存。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；关闭即停止桥接进程 |
| `autoStart` | `true` | DSH 启动时自动连接 |
| `replyEnabled` | `true` | 「接入本地插件/提示词」；关闭后只回固定文案，不调用模型 |
| `replyDisabledText` | 见页面 | 上者关闭时的固定回复 |
| `useLocalPrompt` | `true` | 是否把 `systemPrompt` 注入微信会话 |
| `systemPrompt` | 中文人设 | 微信会话的提示词段落 |
| `cwd` | 空（默认 workspace） | **默认**工作目录，只有客户端设置页能改；微信 `/工作区` 只影响当前运行期 |
| `provider` / `model` | 空 | 空 = 跟随 profile 默认模型 |
| `reasoningEffort` | 空 | 思考等级（如 `low` / `medium` / `high` / `max`），空 = 模型默认 |
| `workspaces` | `[]` | 已登记的工作区路径，供 `/ws` 命令与页面管理 |
| `permission` | `workspace-write` | 微信会话权限预设 |
| `allowFrom` | `[]` | 允许的微信用户；空 = 仅允许扫码者本人 |
| `progressMessages` | `true` | 处理前先发「⏳ 正在处理」 |
| `announceSession` | `true` | 启动后首轮与新会话时播报「会话参数」卡 |
| `messageMaxChars` | `2000` | 单条微信消息的字符上限，超长自动分片 |
| `pythonPath` | 空 | Python 可执行文件；空则用 `python` |
| `logLevel` | `INFO` | 桥接日志级别 |
| `replyTimeoutS` | `1800` | 单轮回复超时 |
| `longPollTimeoutS` | `35` | iLink 长轮询超时 |

完整说明见 [docs/configuration.md](./docs/configuration.md)；示例见 [config.example.json](./config.example.json)。

## 微信内命令

全部由插件在本地处理，不进模型。**不带参数时列出编号选项，直接回复 `1` `2` `3`… 选择，`0` 取消**（列表 5 分钟内有效）；发送其他内容会先收到「已取消上一条选择。」，然后按普通消息继续。

> `/帮助` 只列主命令（列表 + 编号选择）；下表里的直接参数写法仍然可用，只是不在帮助里显示。`/cwd`、`/pwd` 是 `/工作区` 的别名；`/chat`、`/conversation`、`/对话` 是 `/会话` 的别名。

### 计划模式与提问

agent 在微信会话里调用 `exit_plan_mode`（计划审批）或 `ask_user_question` 时，插件会把**问题与选项**发到微信。用 `/计划 开` / `/计划 关` 可以直接切换当前会话的 plan 模式。

> 计划模式在 Web profile 里由 **agent preset** 提供（`isolate: { planMode: true }`），不在 Host 平面上，所以插件按 agent 取：`/计划` 走 `agentPresets.serviceFor(agent, 'planMode')` 读状态，切换则执行 `/plan` / `/plan off` 命令（与 GUI 顶栏计划徽标同一路径，会写进会话日志）。会话用的 preset 没装 planning 时（例如 `unrestricted`），命令会直接说明这一点。

```
📋 待确认
【Plan review】
Approve this plan and leave plan mode?

1. Approve plan（Leave plan mode.）
2. Keep planning（Stay in plan mode.）

回复数字选择，0 取消。
```

- 回复 `1`/`2`… 选择对应选项；
- 回复其他文字 → 作为反馈（等价「继续规划」）；
- `0` → 取消，继续规划；
- 10 分钟未回复 → 按「继续规划」处理（`ask_user_question` 自己带更短的期限，到点按 host 的超时语义返回）；
- 等待期间的下一条消息优先作为答案，不会进入 agent；只拦截微信会话，GUI 不受影响。

> 两边都能看到、也都能答，**先答先赢**：插件把 `user-questions/request` 监听前置（`prepend`，否则 DSH 会先把请求推给浏览器客户端并一直等它作答，微信永远收不到），拿到后既发微信、又调用 `next()` 让 GUI 照旧弹卡片。微信先答 → 生效，GUI 卡片本轮结束消失；GUI 先答 → 微信收到「已在客户端作答」并停止等待。**微信只发问题与选项，完整计划只留在 GUI 卡片里。**

| 命令（中文 / 英文别名） | 作用 |
|---|---|
| `/帮助` · `/help` | 帮助 |
| `/状态` · `/status` | 连接状态、账号、模型、思考等级、工作区、权限 |
| `/重置` · `/reset` · `/new` | 开启全新对话（换一个会话代次） |
| `/模型` · `/model` | 列出模型，回复编号切换 |
| `/模型 <模型id>` | 直接切换（自动开启新会话） |
| `/模型 <provider>/<模型id>` | 跨 provider 切换 |
| `/模型 列表` · `/model list` | 同无参，列出模型 |
| `/思考` · `/think` | 列出当前模型支持的思考等级，回复编号切换 |
| `/思考 <等级>` | 直接切换（自动开启新会话） |
| `/思考 默认` · `/think default` | 恢复模型默认 |
| `/会话` · `/sessions` | 列出**当前工作区下的全部会话**（含 GUI 创建），回复编号切换 |
| `/会话 新增` · `/sessions new` | 开启新会话（旧会话仍可切回） |
| `/工作区` · `/ws` | 列出已登记工作区（标注当前） |

> **重启即新会话**：插件每次加载（DSH 重启或插件重载）后，微信的第一条消息都会开一个新会话，不会接上上一次那个；旧会话仍在，可用 `/会话` 切回。
>
> **会话归属工作区**：插件的聊天目录（默认 `$DSH_HOME\wechat-clawbot\workspace`，或设置里的「微信会话工作目录」）若还不是 GUI 工作区，会在第一次用到时自动登记为「微信 clawbot」。否则会话不属于任何工作区，只会以「活动会话」形式短暂出现，agent 一空闲就从侧栏消失。
| `/工作区 新增 <绝对路径>` · `/ws add <路径>` | 新建目录、登记并切换 |
| `/工作区 使用 <编号\|路径>` · `/ws use <…>` | 切换工作区 |
| `/权限` · `/perm` | 列出权限预设，回复编号切换 |
| `/权限 <名称>` | 直接切换（`只读` / `写入` / `完全`，或 `read-only` / `workspace-write` / `danger-full-access`），当前会话立即生效 |

> 有编号列表待选时，纯数字消息会被当作选择；想给模型发数字，先发任意其他文字即可清除列表。
>
> `/目录` 与 `/工作区` 列出的是三者的合并结果：插件登记的路径、Harness 里已创建的工作区（`workspaceRegistry`）、当前微信会话的工作目录——所以 GUI 里建过的工作区在微信里也能直接切换。
>
> DSH 启动后的第一条普通消息、以及每次开新会话（`/重置`、切换模型/思考等级/工作区）后，会先收到一张「会话参数」卡：工作区、模型、思考等级、权限、人设、本地回复状态。切换类命令的回复也直接附带这张卡；可在设置里用 `announceSession` 关闭。

## 数据与隐私

插件只在本机写数据，位置在 `$DSH_HOME/wechat-clawbot/`：

| 内容 | 路径 |
|---|---|
| 配置 | `$DSH_HOME/wechat-clawbot/config.json` |
| 状态 | `$DSH_HOME/wechat-clawbot/status.json` |
| 微信登录凭证、游标、context token | `$DSH_HOME/wechat-clawbot/state/ilink/` |
| 诊断日志（已脱敏、自动轮转） | `$DSH_HOME/wechat-clawbot/log/plugin.log`、`state/log/bridge.log` |
| 微信会话工作目录 | `$DSH_HOME/wechat-clawbot/workspace` |

- 消息内容会发给微信（iLink 服务端）与你配置的模型 provider；这是通道本身的工作方式。
- 插件**不收集遥测**，不上传任何数据到作者服务器。
- 日志与设置页输出会对 `token`、`bot_token`、`context_token`、`Bearer …` 和账号 id 做掩码。
- 想彻底清除：页面点「退出登录」，再删除整个 `$DSH_HOME/wechat-clawbot` 目录。

详见 [PRIVACY.md](./PRIVACY.md)。

## 排障

| 现象 | 处理 |
|---|---|
| 设置页一直「未启动」 | 看页面「诊断日志」；确认 Python 在 PATH，或在设置里填 `pythonPath` |
| 二维码不出现 | 点「重启桥接」；日志里出现网络错误时检查代理 |
| 消息没有回复 | 确认「接入本地插件/提示词」为开启；微信发 `/status` 查看 |
| 桥接反复退出 | 连续退出 5 次后自动重启会停止；修好后点「重启桥接」 |
| 想换微信账号 | 点「退出登录」，会清掉本机凭证并重新出二维码 |

完整排查流程见 [docs/troubleshooting.md](./docs/troubleshooting.md)。

## 开发

```bash
npm run check          # 语法 + 密钥扫描 + client 模块冒烟 + Python 编译
npm test               # 离线测试（node:test）
```

本地改动后，用插件管理器把该 bundle 关闭再打开即可热重载 Host 侧；`client.js` 的改动需要刷新页面（或重启客户端）。

实现细节：`index.js`（Host）、`client.js`（设置页）、`bridge/host_bridge.py`（iLink 传输）、`bridge/ilink_client.py`（协议客户端）。开发说明见 [docs/development.md](./docs/development.md)。

要接手维护、或想知道「现在到哪一步、坑在哪、下一步做什么」，先看 [docs/HANDOVER.md](./docs/HANDOVER.md)。

## 致谢

- 构建于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（deepseek-ai）之上。
- 代码与文档由 RoryPond 与 DeepSeek Harness 的编程 agent（`deepseek-flash`）结对完成；需求、设计取舍、验收与发布由 RoryPond 负责。

## 许可证与声明

- 代码：[MIT](./LICENSE)。
- 第三方：`vendor/qrcode.mjs` 为 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 2.0.4（MIT），详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
- iLink / ClawBot 是腾讯提供的官方能力，本项目不是腾讯官方项目；协议可能随时调整，使用需遵守《微信 ClawBot 功能使用条款》。
- 本项目与 DeepSeek 官方无隶属关系，DeepSeek Harness 的许可以其仓库为准。
