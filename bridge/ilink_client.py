"""iLink (WeChat ClawBot) protocol client — pure stdlib.

Implements the bot side of the official `@tencent-weixin/openclaw-weixin`
channel protocol against `https://ilinkai.weixin.qq.com`, mirroring the
plugin's own wire behavior (headers, base_info, cursor handling, typing,
context tokens). Reference sources kept under docs/ in this repo.

Endpoints used by the bridge:
  get_bot_qrcode / get_qrcode_status   QR login (with pairing code support)
  getupdates                          long-poll message receive
  sendmessage                         text send (media is out of scope for v1)
  getconfig / sendtyping              typing indicator support
  msg/notifystart / msg/notifystop    lifecycle notifications
"""

from __future__ import annotations

import base64
import json
import logging
import os
import random
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger("ilink")

_SECRET_RE = re.compile(
    r"(?i)\b(bot_token|context_token|typing_ticket|verify_code|token)"
    r"(\s*[\"']?\s*[:=]\s*[\"']?)([A-Za-z0-9._:@+/=-]{6,})"
)
_BEARER_RE = re.compile(r"(?i)\b(Bearer\s+)([A-Za-z0-9._:@+/=-]{6,})")


def _redact(text: str) -> str:
    """Mask credentials in transport error text before it is logged or raised."""
    masked = _SECRET_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}{m.group(3)[:4]}…", str(text))
    return _BEARER_RE.sub(lambda m: f"{m.group(1)}{m.group(2)[:4]}…", masked)

DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com"
CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c"

# Mirrors the official plugin package identity (observability only).
APP_ID = "bot"
CHANNEL_VERSION = "2.4.6"
CLIENT_VERSION = 0x020406  # 2.4.6 -> 0x00020406
BOT_AGENT = "dsh-wechat-clawbot/0.1.0"

BOT_TYPE = "3"
STALE_TOKEN_ERRCODE = -14

TYPING_TTL_MS = 24 * 60 * 60 * 1000


class IlinkError(Exception):
    """Transport/protocol failure of the iLink API."""


def _random_uin() -> str:
    value = str(random.getrandbits(32))
    return base64.b64encode(value.encode("utf-8")).decode("ascii")


def _base_info() -> dict[str, str]:
    return {"channel_version": CHANNEL_VERSION, "bot_agent": BOT_AGENT}


def _headers(token: Optional[str]) -> dict[str, str]:
    headers = {
        "Content-Type": "application/json",
        "AuthorizationType": "ilink_bot_token",
        "X-WECHAT-UIN": _random_uin(),
        "iLink-App-Id": APP_ID,
        "iLink-App-ClientVersion": str(CLIENT_VERSION),
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


class IlinkClient:
    """One logged-in bot account over the iLink HTTP API."""

    def __init__(
        self,
        *,
        base_url: str = DEFAULT_BASE_URL,
        token: Optional[str] = None,
        request_timeout_s: float = 15.0,
        long_poll_timeout_s: float = 35.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.request_timeout_s = request_timeout_s
        self.long_poll_timeout_s = long_poll_timeout_s
        self._typing_tickets: dict[str, tuple[str, float]] = {}  # user -> (ticket, next_fetch_at)
        self._typing_retry: dict[str, float] = {}

    # ------------------------------------------------------------- transport

    def _post(self, endpoint: str, body: dict[str, Any], timeout_s: float) -> dict[str, Any]:
        payload = {**body, "base_info": _base_info()}
        req = urllib.request.Request(
            f"{self.base_url}/{endpoint}",
            data=json.dumps(payload).encode("utf-8"),
            headers=_headers(self.token),
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:  # noqa: S310 - official API
                raw = resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            raise IlinkError(_redact(f"{endpoint} HTTP {exc.code}: {exc.read()[:300]!r}")) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise IlinkError(_redact(f"{endpoint} network error: {exc}")) from exc
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise IlinkError(_redact(f"{endpoint} non-JSON response: {raw[:200]!r}")) from exc

    def _get(self, endpoint: str, timeout_s: float) -> dict[str, Any]:
        req = urllib.request.Request(
            f"{self.base_url}/{endpoint}",
            headers={
                "iLink-App-Id": APP_ID,
                "iLink-App-ClientVersion": str(CLIENT_VERSION),
            },
            method="GET",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:  # noqa: S310
                raw = resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            raise IlinkError(_redact(f"{endpoint} HTTP {exc.code}: {exc.read()[:300]!r}")) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise IlinkError(_redact(f"{endpoint} network error: {exc}")) from exc
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise IlinkError(_redact(f"{endpoint} non-JSON response: {raw[:200]!r}")) from exc

    # ----------------------------------------------------------------- login

    def fetch_qrcode(self, local_token_list: Optional[list[str]] = None) -> dict[str, str]:
        """POST get_bot_qrcode; returns {qrcode, qrcode_img_content}."""
        resp = self._post(
            f"ilink/bot/get_bot_qrcode?bot_type={urllib.parse.quote(BOT_TYPE)}",
            {"local_token_list": local_token_list or []},
            timeout_s=self.request_timeout_s,
        )
        ret = resp.get("ret")
        if ret not in (None, 0):
            raise IlinkError(
                f"get_bot_qrcode ret={ret} err_msg={resp.get('err_msg') or resp.get('errmsg')}"
            )
        if not resp.get("qrcode"):
            raise IlinkError(
                f"get_bot_qrcode returned no qrcode: {json.dumps(resp, ensure_ascii=False)[:200]}"
            )
        return resp

    def poll_qrcode_status(
        self, qrcode: str, verify_code: Optional[str] = None
    ) -> dict[str, Any]:
        """Long-poll GET get_qrcode_status; returns the raw status object."""
        endpoint = f"ilink/bot/get_qrcode_status?qrcode={urllib.parse.quote(qrcode)}"
        if verify_code:
            endpoint += f"&verify_code={urllib.parse.quote(verify_code)}"
        return self._get(endpoint, timeout_s=self.long_poll_timeout_s)

    # ------------------------------------------------------------- messaging

    def get_updates(self, cursor: str) -> tuple[list[dict[str, Any]], str, dict[str, Any]]:
        """Long-poll getUpdates. Returns (msgs, new_cursor, raw_response)."""
        resp = self._post(
            "ilink/bot/getupdates",
            {"get_updates_buf": cursor},
            timeout_s=self.long_poll_timeout_s,
        )
        msgs = resp.get("msgs") or []
        new_cursor = resp.get("get_updates_buf") or cursor
        return msgs, new_cursor, resp

    def send_text(self, to_user_id: str, text: str, context_token: Optional[str]) -> None:
        """POST sendmessage with one TEXT item (message_type=BOT, state=FINISH)."""
        client_id = f"openclaw-weixin:{int(time.time() * 1000)}-{random.randbytes(4).hex()}"
        msg: dict[str, Any] = {
            "from_user_id": "",
            "to_user_id": to_user_id,
            "client_id": client_id,
            "message_type": 2,
            "message_state": 2,
            "item_list": [{"type": 1, "text_item": {"text": text}}],
        }
        if context_token:
            msg["context_token"] = context_token
        resp = self._post("ilink/bot/sendmessage", {"msg": msg}, timeout_s=self.request_timeout_s)
        ret = resp.get("ret")
        if ret not in (None, 0):
            raise IlinkError(f"sendmessage ret={ret} errmsg={resp.get('errmsg')}")

    # --------------------------------------------------------------- typing

    def get_config(self, user_id: str, context_token: Optional[str] = None) -> str:
        """Return a typing ticket for the user (cached 24h, backoff on failure)."""
        now = time.time() * 1000
        cached = self._typing_tickets.get(user_id)
        if cached and now < cached[1]:
            return cached[0]
        retry_at = self._typing_retry.get(user_id, 0.0)
        if now < retry_at:
            return cached[0] if cached else ""
        try:
            body: dict[str, Any] = {"ilink_user_id": user_id}
            if context_token:
                body["context_token"] = context_token
            resp = self._post("ilink/bot/getconfig", body, timeout_s=10.0)
            if resp.get("ret") == 0 and resp.get("typing_ticket"):
                ticket = str(resp["typing_ticket"])
                self._typing_tickets[user_id] = (
                    ticket,
                    now + random.uniform(0.5, 1.0) * TYPING_TTL_MS,
                )
                self._typing_retry.pop(user_id, None)
                return ticket
            # fall through to backoff
        except IlinkError as exc:
            log.warning("getconfig failed for %s: %s", user_id, exc)
        delay_ms = 2000
        prev = self._typing_retry.get(user_id, 0.0)
        if prev > now:
            delay_ms = int(prev - now)
        else:
            self._typing_retry[user_id] = now + delay_ms
        return cached[0] if cached else ""

    def send_typing(self, user_id: str, ticket: str, status: int) -> None:
        """status: 1=typing, 2=cancel."""
        self._post(
            "ilink/bot/sendtyping",
            {"ilink_user_id": user_id, "typing_ticket": ticket, "status": status},
            timeout_s=10.0,
        )

    # ------------------------------------------------------------ lifecycle

    def notify_start(self) -> None:
        try:
            self._post("ilink/bot/msg/notifystart", {}, timeout_s=10.0)
        except IlinkError as exc:
            log.warning("notifystart failed: %s", exc)

    def notify_stop(self) -> None:
        try:
            self._post("ilink/bot/msg/notifystop", {}, timeout_s=10.0)
        except IlinkError as exc:
            log.warning("notifystop failed: %s", exc)


# ------------------------------------------------------------ state helpers

def _restrict_permissions(path: Path) -> None:
    """Best effort owner-only permissions; a no-op where the OS has no mode bits."""
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def account_state_paths(state_dir: Path) -> tuple[Path, Path]:
    """(index file, accounts dir) for the bot's own state layout."""
    root = Path(state_dir) / "ilink"
    return root / "accounts.json", root / "accounts"


def load_account_index(state_dir: Path) -> list[str]:
    index_file, _ = account_state_paths(state_dir)
    try:
        data = json.loads(index_file.read_text(encoding="utf-8"))
        return [str(x) for x in data] if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def load_account(state_dir: Path, account_id: str) -> Optional[dict[str, Any]]:
    _, accounts_dir = account_state_paths(state_dir)
    path = accounts_dir / f"{account_id}.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def save_account(state_dir: Path, account_id: str, data: dict[str, Any]) -> None:
    index_file, accounts_dir = account_state_paths(state_dir)
    accounts_dir.mkdir(parents=True, exist_ok=True)
    account_file = accounts_dir / f"{account_id}.json"
    account_file.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    _restrict_permissions(account_file)
    index = load_account_index(state_dir)
    if account_id not in index:
        index.append(account_id)
        index_file.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
        _restrict_permissions(index_file)


def load_sync_buf(state_dir: Path, account_id: str) -> str:
    _, accounts_dir = account_state_paths(state_dir)
    try:
        return (accounts_dir / f"{account_id}.sync.json").read_text(encoding="utf-8")
    except OSError:
        return ""


def save_sync_buf(state_dir: Path, account_id: str, cursor: str) -> None:
    _, accounts_dir = account_state_paths(state_dir)
    accounts_dir.mkdir(parents=True, exist_ok=True)
    path = accounts_dir / f"{account_id}.sync.json"
    path.write_text(cursor, encoding="utf-8")
    _restrict_permissions(path)


def load_context_tokens(state_dir: Path, account_id: str) -> dict[str, str]:
    _, accounts_dir = account_state_paths(state_dir)
    try:
        data = json.loads((accounts_dir / f"{account_id}.context-tokens.json").read_text(encoding="utf-8"))
        return {k: str(v) for k, v in data.items()} if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_context_token(state_dir: Path, account_id: str, user_id: str, token: str) -> None:
    tokens = load_context_tokens(state_dir, account_id)
    tokens[user_id] = token
    _, accounts_dir = account_state_paths(state_dir)
    accounts_dir.mkdir(parents=True, exist_ok=True)
    path = accounts_dir / f"{account_id}.context-tokens.json"
    path.write_text(json.dumps(tokens, ensure_ascii=False), encoding="utf-8")
    _restrict_permissions(path)


def ensure_config_file(path: Path) -> dict[str, Any]:
    """Load config.json, creating a default one when absent."""
    defaults: dict[str, Any] = {
        "state_dir": str(Path(os.environ.get("DSH_BOT_STATE_DIR", "state"))),
        "session_root": "sessions",
        "workspace": "workspace",
        "system_prompt": (
            "你是部署在微信里的 DeepSeek Harness 助手。回复使用简体中文，简洁直接；"
            "代码、列表等用适合微信阅读的纯文本格式。"
        ),
        "model": "deepseek-flash",
        "max_tokens": None,
        "allow_from": [],
        "reply_timeout_s": 1800,
        "long_poll_timeout_s": 35,
        "progress_messages": True,
        "stale_token_backoff_s": 45,
        "stale_token_max_retries": 20,
        "message_max_chars": 2000,
        "log_level": "INFO",
    }
    if path.is_file():
        # utf-8-sig tolerates a BOM written by Windows editors/PowerShell.
        loaded = json.loads(path.read_text(encoding="utf-8-sig"))
        defaults.update(loaded)
    else:
        path.write_text(json.dumps(defaults, ensure_ascii=False, indent=2), encoding="utf-8")
    return defaults
