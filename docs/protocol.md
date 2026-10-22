# iLink（微信 ClawBot）协议摘要

> 本文是实现笔记，不是腾讯官方文档。协议由腾讯提供并可能随时调整；实现以实际抓包与公开行为为准，不保证长期有效。

## 端点

基址：`https://ilinkai.weixin.qq.com`（登录响应可能给出 `redirect_host`，此时切到 `https://<host>`）。

| 端点 | 方法 | 用途 |
|---|---|---|
| `/ilink/bot/get_bot_qrcode?bot_type=3` | POST | 获取登录二维码（返回 `qrcode`、`qrcode_img_content`） |
| `/ilink/bot/get_qrcode_status?qrcode=…[&verify_code=…]` | GET | 长轮询扫码状态 |
| `/ilink/bot/getupdates` | POST | 长轮询收消息（携带 `get_updates_buf` 游标） |
| `/ilink/bot/sendmessage` | POST | 发送消息（本项目只发文本） |
| `/ilink/bot/getconfig` | POST | 获取 typing ticket |
| `/ilink/bot/sendtyping` | POST | 输入中状态（1=开始，2=取消） |
| `/ilink/bot/msg/notifystart`、`notifystop` | POST | 上线/下线通知（失败不影响主流程） |

请求头（登录后）：

```
AuthorizationType: ilink_bot_token
Authorization: Bearer <bot token>
iLink-App-Id: bot
iLink-App-ClientVersion: <数值版本>
X-WECHAT-UIN: <随机值>
Content-Type: application/json
```

请求体统一附带 `base_info: { channel_version, bot_agent }`。

## 二维码状态机

| status | 含义 | 桥接动作 |
|---|---|---|
| `wait` / 无 | 等待扫码 | 继续轮询 |
| `scaned` | 已扫码 | 提示「正在确认」 |
| `need_verifycode` | 需要数字配对码 | 页面输入后带 `verify_code` 重新轮询 |
| `verify_code_blocked` | 配对码错误过多 | 等待或重新登录 |
| `scaned_but_redirect` | 需要切 IDC | 更新 `base_url` 后继续 |
| `binded_redirect` | 该微信已绑定过 | 复用本地既有 token |
| `expired` | 二维码过期 | 自动刷新（最多 3 次） |
| `confirmed` | 登录成功 | 保存 `bot_token`、`ilink_bot_id`、`baseUrl`、`userId` |

## 消息

收到的消息（`getupdates` → `msgs[]`）：

```jsonc
{
  "msg_id": "…",
  "from_user_id": "<用户>@im.wechat",
  "message_type": 1,
  "group_id": "",              // 非空表示群消息，本项目忽略
  "context_token": "…",        // 回复时需回传
  "item_list": [
    { "type": 1, "text_item": { "text": "你好" } },
    { "type": 3, "voice_item": { "text": "语音转文字结果" } }
  ]
}
```

发送文本：

```jsonc
{
  "msg": {
    "from_user_id": "",
    "to_user_id": "<用户>@im.wechat",
    "client_id": "openclaw-weixin:<毫秒>-<随机>",
    "message_type": 2,
    "message_state": 2,
    "context_token": "…",
    "item_list": [{ "type": 1, "text_item": { "text": "回复" } }]
  },
  "base_info": { "channel_version": "…", "bot_agent": "…" }
}
```

## 游标与重连

- `getupdates` 返回新的 `get_updates_buf`，桥接写入 `state/ilink/accounts/<bot>.sync.json`，重启后从游标续接。
- `ret`/`errcode == -14` 视为冷却信号：指数退避继续用同一 token；超过阈值才要求重新扫码。
- 长轮询超时属正常现象（35 秒无消息即返回），不是错误。

## 凭证

- `state/ilink/accounts.json`：账号索引。
- `state/ilink/accounts/<bot id>.json`：`token`、`baseUrl`、`userId`。
- `state/ilink/accounts/<bot id>.context-tokens.json`：每个用户的 `context_token`。

这些文件只存在本机，保存后尽力设 `0600`；日志与页面输出均对其脱敏。

## 来源与免责

协议细节参考腾讯公开的 `openclaw-weixin` 插件行为与公开抓包，本项目未复制其源码。iLink / ClawBot 的使用受《微信 ClawBot 功能使用条款》约束；接口可能调整、限流或终止。
