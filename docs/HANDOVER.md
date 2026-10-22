# 交接文档

> 面向接手维护的人（或未来的自己）：这个仓库是什么、现在到哪一步、坑在哪、下一步该做什么。
> 使用者视角的功能说明看 [README.md](../README.md)，实现细节看 [architecture.md](./architecture.md)。

最后更新：2026-10-22 · 版本 **0.12.4** · 状态：**已开发完成，尚未 commit / 未推送 GitHub**

---

## 1. 一句话

DeepSeek Harness（DSH）的微信通道插件：扫码登录后，微信里的消息交给本机 DSH agent 处理，agent 的回复再发回微信；计划审批、编号选择、工作区/会话切换、模型/思考等级切换都能在微信里完成。

## 2. 当前状态

| 项 | 状态 |
|---|---|
| 版本 | `0.12.4`（`package.json` 与 `index.js` 的 `PLUGIN_VERSION` 必须一致，有测试断言） |
| 测试 | `node --test` → **67 个用例全绿**（纯离线，不碰真实微信） |
| 静态检查 | `npm run check` → 全绿（含密钥扫描，见 §8） |
| Git | `git init -b main` 后全部文件已 `git add`；`origin` 指向 `Rorypond-account/dsh-wechat-clawbot`，**尚首次 commit** |
| 运行形态 | 已作为本地 bundle 安装进 `desktop` profile（`link:E:/…/dsh-wechat-clawbot`），实际跑过：扫码登录、收发消息、计划审批、`/计划` 开关 |
| 未完成 | 首次 commit / 推送、CI 从未在 GitHub 上真跑过 |

## 3. 仓库地图

```
index.js              Host 侧插件（DSH 的 Cordis 插件，全部命令、会话、桥接逻辑都在这里）
client.js             设置页（web 客户端插件，注册 settings.section + plugins.bundle.config）
cordis.patch.yml      bundle patch：把插件行插进 profile
bridge/host_bridge.py NDJSON 桥接进程（Node ↔ Python），负责拉起/守护 iLink 客户端
bridge/ilink_client.py iLink（ClawBot）协议客户端：登录、长轮询、发消息
vendor/qrcode.mjs     第三方二维码库（qrcode-generator 2.0.4，未改动，许可证见 THIRD_PARTY_NOTICES.md）
locale/{zh,en}.json   设置页文案
tests/*.test.mjs      离线测试（12 个文件 / 67 用例）
docs/                 架构、配置、协议、排障、开发说明（本文件之外）
scripts/check.mjs     自检脚本：node --check、py_compile、JSON/YAML 解析、client 冒烟、密钥扫描
.github/workflows/    CI：Node 22 + Python 3.12，跑 npm run check 与 npm test
```

## 4. 运行方式

### 4.1 安装到 profile

```bash
# 在 DSH 里（或让 agent 用 plugin_manager 工具）
plugin_manager install_bundle  target=E:/新建文件夹/dsh-wechat-clawbot
```

它会在 profile 的 `package.json` 里加一条 `link:` 依赖，并把 `dsh-wechat-clawbot` 加进 `dsh.profile.bundles`。

### 4.2 热重载（改了 `index.js` 之后必须做）

Host 侧代码不会自动重载。用插件管理器把 `include:channel-wechat-clawbot` 关再开：

```
plugin_manager set_plugin target=include:channel-wechat-clawbot enabled=false
plugin_manager set_plugin target=include:channel-wechat-clawbot enabled=true
```

`client.js`（设置页）的改动不需要这样做，刷新页面即可。

### 4.3 运行时数据（不在仓库里）

全部在 `$DSH_HOME/wechat-clawbot/`（本机是 `C:\Users\<你>\.dsh\wechat-clawbot\`）：

```
config.json         插件配置（设置页保存的就是它）
status.json         最近一次连接状态
log/plugin.log      插件日志（会轮转，2 MB）
state/              iLink 登录态、消息游标（.gitignore 已排除）
state/log/bridge.log 桥接进程日志
```

> 注意：`config.json`、`state/`、`log/` 都**不能**进仓库，`.gitignore` 已经排除；`scripts/check.mjs` 会额外扫密钥。

## 5. 微信侧命令（速查）

中文优先，英文别名保留。完整表格见 README。

| 命令 | 作用 |
|---|---|
| `/帮助` `/status` | 帮助 / 状态 |
| `/重置` | 换一个全新会话 |
| `/模型` `/思考` | 列表 + 编号切换 |
| `/会话` | 列出当前工作区里的**全部**会话（含 GUI 建的），编号切换 |
| `/工作区` | 列出 GUI 与插件登记的工作区，编号切换 |
| `/权限` | 切换权限预设 |
| `/计划 开` / `/计划 关` | 切换 plan 模式（内部走 `/plan` 命令） |

编号回复：直接回数字；`0` 取消；回其他文字视为取消/反馈。列表有 5 分钟 TTL。

## 6. 关键设计决策（改之前先读）

1. **`planMode` 不在 Host 平面上。** Web profile 会禁用根行的 `plan-mode`，把它塞进每个 agent preset 的隔离子组（`isolate: { planMode: true }`）。所以插件里 `ctx.get('planMode')` **永远拿不到**，必须：
   - 读状态：`agentPresets.serviceFor(agent, 'planMode').get(agent)`；
   - 切换：`commands.execute(agent, '/plan' | '/plan off')`（和 GUI 顶栏计划徽标同一条路径）。
2. **提问/计划审阅是独占 waterfall，且 GUI 会抢。** `userQuestions.ask()` 在 agent 作用域派发 `user-questions/request`；`@deepseek-ai/dsh-api-remotes` 先注册，把请求转给浏览器客户端并等它作答，客户端又会按 session 认领。插件因此用 `{ prepend: true }` 抢在它前面，然后**同时**做两件事：发微信 + `next()` 让 GUI 照常弹卡片；两边**先答先赢**，输的一方收到「已作答」提示。
3. **微信只收问题 + 选项，不发计划正文。** 完整计划留在 GUI 卡片里渲染。
4. **会话 id 与「重启即新会话」。** 默认 id 是 `wechat-<peer>`；插件每次加载后第一次用到某个 peer 时，如果这个默认 id 已在磁盘上存在（上一次运行留下的），就**不 resume**，改用 `wechat-<peer>__<时间戳>`；旧会话仍在，可用 `/会话` 切回。`/重置` 也是这个机制。
5. **会话必须挂进工作区。** 工作区之外的会话只有在 agent 活着时才出现在 GUI，一空闲就消失。`ensureGrouped()` 先建目录、找不到工作区就 `workspaceRegistry.create(cwd, '微信 clawbot')` 自动登记，再 `attachSession`。
6. **两套工作区状态。** `config.cwd` 是设置页里改的**默认**目录（只有客户端能改）；`activeCwd` 是运行时 `/工作区` 切换出来的，**只在内存**，重启回落。别把 `/工作区` 写进 `config.json`，那会让默认目录漂移（历史 bug）。
7. **桥接协议是 NDJSON。** Node 写 stdin、读 stdout：`phase` / `log` / `inbound`，反向 `verify-code` / `reply` / `typing` / `logout` / `shutdown`。桥接进程崩了会按退避重启。
8. **脱敏。** `index.js` 与 `host_bridge.py` 各有一份 `redact()`：掩码 `token`/`bot_token`/`context_token`/`typing_ticket`/`verify_code`、`Bearer …`、`xxxx@im.bot` / `xxxx@im.wechat`。日志与 HTTP 返回都过这一层。

## 7. 已知限制 / 遗留问题

| 问题 | 影响 | 备注 |
|---|---|---|
| 微信先答后，GUI 的审阅卡片会留到本轮结束，点它无效 | 观感 | DSH 客户端内部行为，插件拿不到清理 API |
| 微信先答时，`next()` 在 host 侧留一个待投递事件 | 内存缓慢增长 | 等客户端连上或 agent 释放才清；量级小 |
| `ask_user_question` 默认 120 s 到点后，微信侧只能收到「已超时」 | 体验 | host 超时语义优先，无法改 |
| 没有真实微信的自动化测试 | 风险 | 所有测试都是离线的；协议变动只能靠实机发现 |
| `private: true` 且没有 publish 配置 | 不能 `npm publish` | 要走 npm 再改 |

## 8. 发布到 GitHub 前的清单

- [x] 把 `OWNER` 换成真实 GitHub 账号（`package.json` ×3、`README.md`、`README.en.md`）→ `Rorypond-account`
- [x] `git remote add origin`（`Rorypond-account/dsh-wechat-clawbot`）
- [ ] 确认 `git config user.name` / `user.email` 是希望公开的身份（提交记录会带出去）
- [ ] `npm run check` + `npm test` 全绿
- [ ] 确认没有 `bridge/__pycache__/`、`log/`、`state/`、`config.json` 被带进提交
- [ ] 首次 commit，推送 `main`
- [ ] 推完去 Actions 看 CI 是否真的绿（只在本地跑过）

密钥扫描规则（`scripts/check.mjs`）会拒绝：`sk-…` 形式的 key、`C:\Users\<某人>\` 这类个人路径、`<十六进制>@im.bot` 形式的真实会话 id、`bot_token":"…"` 明文。`tests/` 目录被整体跳过（那里的 id 都是合成的假数据）。

## 9. 常见故障 → 先看哪里

| 现象 | 先看 |
|---|---|
| 微信不回话 | `log/plugin.log` 里有没有 `turn/end blocked`（会话被归档）、`replyEnabled=false`、模型报错 |
| 扫码后一直 pending | `status.json` 的 `phase`；`need_verify` 说明要在设置页填配对码 |
| 设置页开关不保存 | 页面刷新后看 `config.json` 是否变化；保存走 `/api/wechat-clawbot/config` |
| 会话在 GUI 里消失 | 是否在某个工作区里（§6.5）；`/状态` 会显示默认工作区与会话工作区 |
| 重启后又接上老会话 | 不应该发生（§6.4）；若发生，检查 `activeSessions` 是否被 `/会话` 选中过 |

排障细节见 [troubleshooting.md](./troubleshooting.md)。

## 10. 下一步建议（按优先级）

1. 补 GitHub 元信息（`OWNER`）、首次提交与推送。
2. 在真机上跑一轮完整验收：扫码 → 收消息 → `/计划 开` → 计划审阅（微信回 1 / GUI 点按钮两条路径）→ `/会话` 切换 → `/工作区` 切换。
3. 如果要做 npm 包：去掉 `private`、补 `publishConfig`、确认 `files` 白名单（现在已限定）。
4. 长期：把「问 ask_user_question 超时后仍可补答」接上（`userQuestions.answer` 的 inbox 路径），目前没做。
