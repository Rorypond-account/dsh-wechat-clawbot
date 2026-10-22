# 贡献指南

## 环境

- Node.js ≥ 22（`client.js` 用 Harness 的模块表，不需要构建工具）
- Python ≥ 3.10（桥接只用标准库）
- 一个可用的 DeepSeek Harness profile（desktop / web）

## 目录

| 路径 | 作用 |
|---|---|
| `index.js` | Host 插件：spawn/守护桥接、agent 会话、HTTP 路由、脱敏 |
| `client.js` | 设置页（`plugins.bundle.config` + `settings.section` 两个 slot） |
| `bridge/host_bridge.py` | iLink 传输层，stdin/stdout NDJSON |
| `bridge/ilink_client.py` | iLink 协议客户端 |
| `vendor/qrcode.mjs` | 二维码生成（第三方，勿改） |
| `scripts/check.mjs` | 一键检查 |
| `tests/` | 离线测试 |

## 检查与测试

```bash
npm run check
npm test
```

`check.mjs` 会做：JS 语法、Python 编译、JSON/YAML 解析、client 模块加载冒烟、密钥扫描。提交前必须全绿。

## 手动验证

1. 用插件管理器安装本目录（`install_bundle`，target = 仓库路径）。
2. 关闭再打开该 bundle 以热重载 Host；`client.js` 改动刷新页面。
3. 打开 设置 → 微信 ClawBot，确认状态、开关、日志正常。
4. 若改了协议层，用真实账号走一遍：扫码 → 发消息 → 回复 → 重启后自动连接 → 退出登录。

## 提交规范

- 提交信息用 `feat: …` / `fix: …` / `docs: …` / `chore: …`。
- 一个提交只做一件事；不要混入格式化无关改动。
- PR 描述写：问题、方案、验证方式、影响面（是否改配置默认值 / 路由 / 协议）。

## 隐私红线（PR 会被直接拒绝）

- 提交任何真实 token、`.credentials.yaml`、`config.json`、`state/`、`log/`、会话记录。
- 提交含二维码、微信号、bot id、昵称的截图或日志片段。
- 在测试里写死个人绝对路径（用 `os.tmpdir()` / `%TEMP%`）。
- 把 `pythonPath`、`cwd` 默认值指向作者本机目录。

## 代码约定

- Host/Client 不引入 `@deepseek-ai/*` 依赖：服务一律通过 `ctx.get(...)` 拿，保证本地目录安装时可解析。
- 新增对外文本同时补 `locale/zh.json`、`locale/en.json` 与 `client.js` 里的 `TEXT`。
- 新增日志必须经 `redact()`（JS）或 `redact()`（Python）。
- 改路由时同步更新 `docs/architecture.md` 与 `PRIVACY.md`。
