# dsh-wechat-clawbot

[中文](./README.md) | English

A WeChat (Tencent iLink / ClawBot) channel plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). One bundle provides a Host bridge plus a browser settings page: sign in with a QR code, connect automatically on every DSH start, and answer WeChat messages with the local DSH agent.

## Features

- **QR sign-in inside Settings** — scan, paste the pairing code if WeChat asks for one.
- **Connect on start** — the bridge starts with DSH and reuses the stored login; an expired token falls back to a fresh QR code.
- **Replies from the local agent** — messages become turns in the current profile's agent, using its plugins, skills, and prompt.
- **Switchable local-agent answering** — turn it off and the bridge stays connected but only sends a fixed notice; no model call.
- **In-WeChat commands** — `/help`, `/status`, `/reset` are handled locally, never sent to the model.
- **Privacy by default** — logs and page output are redacted, credentials stay in `$DSH_HOME`, and the repository carries no secrets.

## Requirements

| Component | Requirement |
|---|---|
| Node.js | ≥ 22 (bundled with Harness) |
| Python | ≥ 3.10, standard library only |
| DeepSeek Harness | ≥ 0.2.0 with `connection`, `agents`, `agentDefaultModel` services |
| WeChat | ClawBot / 龙虾 available on the phone and enabled in WeChat |

## Install

```bash
git clone https://github.com/Rorypond-account/dsh-wechat-clawbot.git
dsh plugin --profile <your profile> add <absolute path to the checkout>
```

Fully quit and reopen DSH after installing: the browser module is loaded at startup.

## First sign-in

1. Settings → **WeChat ClawBot** (or Settings → Plugins → `dsh-wechat-clawbot`).
2. Click "Sign in / Reconnect" and scan the QR code with WeChat.
3. If WeChat shows a numeric pairing code, submit it on the page.
4. Once the phase reads `connected`, message the bot from WeChat.

Later starts connect automatically until the token expires (~24 h) or you sign out.

## In-WeChat commands

Handled locally by the plugin, never sent to the model. **Without arguments each command prints a numbered list; reply `1`, `2`, `3`… to pick, `0` to cancel** (the list stays valid for five minutes).

Command names are Chinese-first; every English spelling stays as an alias: `/帮助` (`/help`), `/状态` (`/status`), `/重置` (`/reset`), `/模型` (`/model`, `<id>`, `<provider>/<id>`, `列表`), `/思考` (`/think`, `<effort>`, `默认`), `/目录` (`/cwd`, `<path>`), `/工作区` (`/ws`, `新增 <path>`, `使用 <index|path>`), `/权限` (`/perm`, `<preset>`).

Switching the model, reasoning effort, or working directory starts a fresh session; `/perm` also applies to the live session immediately. While a list is pending, a bare number is treated as a choice.

The first message after DSH starts, and every new session, is preceded by a session card (workspace, model, reasoning effort, permission, persona, reply state). Commands that switch these settings append the same card; `announceSession` turns it off.

## Configuration

Everything is edited on the page and saved immediately (switches on click, text fields shortly after typing). The fields are documented in [docs/configuration.md](./docs/configuration.md); defaults live in [config.example.json](./config.example.json).

Highlights: `enabled`, `autoStart`, `replyEnabled` (local-agent answering), `useLocalPrompt` + `systemPrompt`, `cwd`, `provider`/`model`, `permission`, `allowFrom`, `progressMessages`, `messageMaxChars`, `pythonPath`, `logLevel`.

## Data

All state lives under `$DSH_HOME/wechat-clawbot/` (config, status, `state/ilink/` credentials, `log/`, and the WeChat session workspace). Nothing is sent to the plugin author. See [PRIVACY.md](./PRIVACY.md).

## Development

```bash
npm run check   # syntax, secret scan, client module smoke test, Python compile
npm test        # offline tests
```

## Acknowledgements

- Built on top of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
- Code and documentation were written by RoryPond together with the DeepSeek Harness coding agent (`deepseek-flash`); requirements, design decisions, review and release stay with RoryPond.

## License

[MIT](./LICENSE). `vendor/qrcode.mjs` bundles qrcode-generator 2.0.4 (MIT); see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

iLink / ClawBot is a Tencent capability; this project is not affiliated with Tencent or DeepSeek, and the protocol may change without notice.
