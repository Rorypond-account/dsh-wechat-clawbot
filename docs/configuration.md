# 配置参考

配置只有一处：`$DSH_HOME/wechat-clawbot/config.json`。设置页读写的就是它，重启 DSH 不会丢失。

## 保存机制

- **开关 / 下拉框**：一改就 `POST /api/wechat-clawbot/config` 立即保存。
- **文本框**：停止输入 0.8 秒后自动保存；也可点「保存设置」。
- 保存成功页面显示「已保存」；失败会红字显示错误，此时配置未落盘。

## 字段

| 字段 | 类型 | 默认 | 生效时机 | 说明 |
|---|---|---|---|---|
| `enabled` | boolean | `true` | 立即 | 总开关。关闭 = 停止桥接进程、不再接收微信消息 |
| `autoStart` | boolean | `true` | 下次启动 DSH | 启动时自动拉起桥接 |
| `replyEnabled` | boolean | `true` | 下一条消息 | 「接入本地插件/提示词」；关闭后只回 `replyDisabledText` |
| `replyDisabledText` | string | 见示例 | 下一条消息 | 上者关闭时的固定回复 |
| `useLocalPrompt` | boolean | `true` | 新建会话 | 是否注入 `systemPrompt`；已存在的会话不重建 |
| `systemPrompt` | string | 中文人设 | 新建会话 | 微信会话的提示词段落 |
| `cwd` | string | 空 | 新建会话 | 微信会话工作目录；必须是绝对路径。会话创建后不可更改 |
| `provider` | string | 空 | 新建会话 | 空 = 跟随 profile 默认 |
| `model` | string | 空 | 新建会话 | 空 = 跟随 profile 默认；微信里 `/model <id>` 修改同一个字段 |
| `reasoningEffort` | string | 空 | 新建会话 | 思考等级，空 = 模型默认；`/think <等级>` 修改同一个字段 |
| `workspaces` | string[] | `[]` | 即刻（供命令使用） | 已登记的工作区；`/ws add` 会追加并切换 |
| `permission` | enum | `workspace-write` | 新建会话 / 当前会话 | `read-only` / `workspace-write` / `danger-full-access` |
| `allowFrom` | string[] | `[]` | 重启桥接 | 允许的微信用户；空 = 仅扫码者本人 |
| `progressMessages` | boolean | `true` | 下一条消息 | 处理前先发「⏳ 正在处理」 |
| `announceSession` | boolean | `true` | 下一条消息 | 启动后首轮与新会话时播报「会话参数」卡（工作区/模型/思考等级/权限/人设/回复状态）；`/重置`、`/model` 等切换命令的回复也附带 |
| `messageMaxChars` | number | `2000` | 下一条回复 | 分片长度，200–8000 |
| `pythonPath` | string | 空 | 重启桥接 | Python 可执行文件；空 = `python` |
| `logLevel` | enum | `INFO` | 重启桥接 | `DEBUG` / `INFO` / `WARNING` / `ERROR` |
| `replyTimeoutS` | number | `1800` | 下一轮 | 单轮回复超时（30–86400） |
| `longPollTimeoutS` | number | `35` | 重启桥接 | iLink 长轮询超时（5–120） |

## 生效时机说明

- **新建会话**：`cwd`、`provider`、`model`、`reasoningEffort`、`permission`、`useLocalPrompt`、`systemPrompt` 在会话创建时写入。微信里用 `/model`、`/think`、`/cwd`、`/ws` 修改后会自动开启新会话；也可以手动发 `/重置`。
- **当前会话立即生效**：`/perm` 会同时更新配置并对正在运行的会话调用 `permissionPresets.set`。
- **重启桥接**：`allowFrom`、`logLevel`、`longPollTimeoutS`、`pythonPath` 作为启动参数传给 Python，保存后会自动重启桥接。
- 其余字段下一条消息即生效。

## 安全相关

- `permission=danger-full-access` 会让微信会话跳过审批直接改文件/执行命令，只在完全信任的私人环境中使用。
- `allowFrom` 留空时只接受扫码者本人；填入 ID 后变成白名单（群里发送者也会被过滤，群消息本身始终忽略）。
- `systemPrompt` 会作为一整段提示词注入微信会话，不要放密钥。

## 示例

见仓库根目录的 [config.example.json](../config.example.json)。首次启动会在 `$DSH_HOME/wechat-clawbot/config.json` 生成同样的默认值。
