# 开发

## 环境

- Node.js ≥ 22（无需构建工具；`client.js` 直接跑在 Harness 的模块表里）
- Python ≥ 3.10（桥接只用标准库）
- 一个可用的 DSH profile（desktop 或 web），含 `connection`、`agents`、`agentDefaultModel`

## 目录

```
index.js               Host 插件
client.js              设置页（两个 slot）
bridge/host_bridge.py  传输层（NDJSON）
bridge/ilink_client.py 协议客户端
vendor/qrcode.mjs      二维码（第三方）
scripts/check.mjs      一键检查
tests/                 离线测试
docs/                  文档
```

## 安装到 profile

用插件管理器 `install_bundle`，target 指向本仓库目录；或用 CLI：

```bash
dsh plugin --profile <profile> add <仓库绝对路径>
```

## 热重载

- **Host**：在插件管理器里把 `dsh-wechat-clawbot` 关闭再打开即可重新加载 `index.js`（会重启桥接）。
- **Client**：`client.js` 改动需要刷新页面；首次安装需要重启 DSH 才会被发现。

## 检查与测试

```bash
npm run check   # node --check、py_compile、JSON/YAML 解析、client 模块冒烟、密钥扫描
npm test        # node --test tests/
```

`check.mjs` 的密钥扫描会拒绝：`sk-…` 形式的 key、`alice` 这类个人账户路径、真实 `@im.bot`/`@im.wechat` id、`bot_token":"…"` 明文。

## 直接调试 Python 桥接

Host 通过 stdin/stdout 与它通信；也可以手工跑：

```bash
# 终端 1：启动桥接（状态目录用临时目录，避免碰到真实登录）
python bridge/host_bridge.py --state /tmp/wechat-clawbot-dev --log-level DEBUG

# 终端 2：喂命令（每行一个 JSON）
{"type":"shutdown"}
{"type":"verify-code","code":"123456"}
```

stdout 每行是一个事件对象；stderr 是人读日志。

## 代码约定

- 不 import `@deepseek-ai/*`：服务通过 `ctx.get(...)` 获取，保证本地目录安装可解析。
- 新日志一律经过 `redact()`；新接口返回前也过一遍。
- 新增可见文本同时补 `client.js` 的 `TEXT` 与 `locale/*.json`。
- 改动路由 / NDJSON 字段时同步更新 `docs/architecture.md`。

## 发布流程

1. 更新 `CHANGELOG.md`，把 `package.json` 的 `version` 与 `index.js` 的 `PLUGIN_VERSION` 同步。
2. `npm run check && npm test`。
3. `package.json` 的 `repository` / `homepage` / `bugs` 里的 `OWNER` 换成实际 GitHub 账号。
4. 打 tag 并推送；本项目不发布到 npm（`private: true`），GitHub 安装即可。

## 手工验收清单

- [ ] 全新安装后重启 DSH，设置页出现，标题/描述/图标正常
- [ ] 扫码 → 配对码 → `connected`
- [ ] 微信发消息 → 本地 agent 回复
- [ ] 关闭「接入本地插件/提示词」→ 只回固定文案，不产生模型调用
- [ ] 重启 DSH → 自动连接，无需扫码
- [ ] 「退出登录」→ 回到等待扫码
- [ ] 设置页改开关/文本框 → 刷新后仍然保留
- [ ] 诊断日志里没有 token / 完整账号 id
