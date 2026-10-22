"""host_bridge.py — iLink (WeChat ClawBot) transport for the dsh-wechat-clawbot plugin.

The DSH Host spawns this process and drives it over newline-delimited JSON on
stdio: stdout carries events only, stderr carries human-readable log lines.

Host → bridge (stdin, one JSON object per line)
    {"type":"verify-code","code":"123456"}
    {"type":"reply","peerId":"...","contextToken":"...","text":"..."}
    {"type":"typing","peerId":"...","on":true}
    {"type":"logout"}
    {"type":"shutdown"}

bridge → Host (stdout, one JSON object per line)
    {"type":"phase","phase":"...","message":"...","qrcodeUrl":"...","accountId":"..."}
    {"type":"inbound","peerId":"...","text":"...","contextToken":"...","messageId":"..."}
    {"type":"log","level":"info|warning|error","text":"..."}

Run by hand for debugging:
    python bridge/host_bridge.py --state /tmp/wechat-clawbot-dev --log-level DEBUG
"""

from __future__ import annotations

import argparse
import json
import logging
import logging.handlers
import os
import queue
import re
import signal
import sys
import threading
import time
from pathlib import Path
from typing import Any, Optional

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from ilink_client import (  # noqa: E402
    IlinkClient,
    IlinkError,
    STALE_TOKEN_ERRCODE,
    load_account,
    load_account_index,
    load_sync_buf,
    save_account,
    save_context_token,
    save_sync_buf,
)

QR_POLL_STEP_S = 1.0
QR_SCAN_TIMEOUT_S = 480
QR_REFRESH_MAX = 3
TYPING_KEEPALIVE_S = 5.0
VERIFY_WAIT_S = 300.0

log = logging.getLogger("wechat-clawbot")

_out_lock = threading.Lock()

_SECRET_RE = re.compile(
    r"(?i)\b(bot_token|context_token|typing_ticket|verify_code|token)"
    r"(\s*[\"']?\s*[:=]\s*[\"']?)([A-Za-z0-9._:@+/=-]{6,})"
)
_BEARER_RE = re.compile(r"(?i)\b(Bearer\s+)([A-Za-z0-9._:@+/=-]{6,})")
_ILINK_ID_RE = re.compile(r"\b([0-9a-f]{8,})(@im\.(?:bot|wechat))", re.IGNORECASE)
_WIN_USER_DIR_RE = re.compile(r"[A-Za-z]:\\Users\\[^\\\s\"'<>|]+")


def _mask(value: str) -> str:
    return f"{value[:4]}…" if len(value) > 4 else "…"


def redact(text: str) -> str:
    """Mask credentials before they reach a log event or the settings page."""
    masked = _SECRET_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}{_mask(m.group(3))}", str(text))
    masked = _BEARER_RE.sub(lambda m: f"{m.group(1)}{_mask(m.group(2))}", masked)
    masked = _ILINK_ID_RE.sub(lambda m: f"{m.group(1)[:4]}…{m.group(2)}", masked)
    masked = _WIN_USER_DIR_RE.sub(lambda m: f"{m.group(0)[:3]}\\Users\\<user>", masked)
    return masked


def emit(event: dict[str, Any]) -> None:
    """Write one NDJSON event to stdout (the Host's only input channel)."""
    line = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
    with _out_lock:
        try:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()
        except (BrokenPipeError, ValueError):
            pass


def report(level: str, text: str, **extra: Any) -> None:
    text = redact(str(text))
    emit({"type": "log", "level": level, "text": text, **extra})
    getattr(log, level if level in ("info", "warning", "error", "debug") else "info")(text)


def phase(name: str, **extra: Any) -> None:
    if isinstance(extra.get("message"), str):
        extra["message"] = redact(extra["message"])
    emit({"type": "phase", "phase": name, **extra})


class TypingLoop:
    """Keeps the 'typing' indicator alive for one peer."""

    def __init__(self, bridge: "Bridge", peer_id: str) -> None:
        self.bridge = bridge
        self.peer_id = peer_id
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._ticket = ""

    def start(self) -> None:
        client = self.bridge.client
        if client is None:
            return
        self._ticket = client.get_config(self.peer_id)
        if not self._ticket:
            return
        try:
            client.send_typing(self.peer_id, self._ticket, 1)
        except IlinkError:
            return
        self._thread = threading.Thread(target=self._loop, name="typing", daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        while not self._stop.wait(TYPING_KEEPALIVE_S):
            client = self.bridge.client
            if client is None:
                return
            try:
                client.send_typing(self.peer_id, self._ticket, 1)
            except IlinkError:
                return

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)
        client = self.bridge.client
        if self._ticket and client is not None:
            try:
                client.send_typing(self.peer_id, self._ticket, 2)
            except IlinkError:
                pass


class Bridge:
    def __init__(self, state_dir: Path, allow_from: list[str], long_poll_timeout_s: float) -> None:
        self.state_dir = state_dir
        self.allow_from = set(x for x in allow_from if x)
        self.long_poll_timeout_s = long_poll_timeout_s
        self.state_dir.mkdir(parents=True, exist_ok=True)

        self.client: Optional[IlinkClient] = None
        self.account_id: Optional[str] = None
        self.account_user_id: Optional[str] = None
        self._client_lock = threading.Lock()

        self.stop_event = threading.Event()
        self.relogin_event = threading.Event()
        self.verify_queue: "queue.Queue[str]" = queue.Queue()
        self._typing: dict[str, TypingLoop] = {}
        self._typing_lock = threading.Lock()

    # ------------------------------------------------------------- commands

    def read_commands(self) -> None:
        """Consume NDJSON commands from stdin until EOF or shutdown."""
        for raw in sys.stdin:
            line = raw.strip()
            if not line:
                continue
            try:
                command = json.loads(line)
            except json.JSONDecodeError:
                report("warning", "host command is not JSON; ignored")
                continue
            if not isinstance(command, dict):
                continue
            kind = command.get("type")
            try:
                if kind == "verify-code":
                    code = str(command.get("code") or "").strip()
                    if code:
                        self.verify_queue.put(code)
                elif kind == "reply":
                    self.send_text(
                        str(command.get("peerId") or ""),
                        str(command.get("text") or ""),
                        str(command.get("contextToken") or ""),
                    )
                elif kind == "typing":
                    self.set_typing(str(command.get("peerId") or ""), bool(command.get("on")))
                elif kind == "logout":
                    self.clear_accounts()
                    self.stop_event.set()
                    return
                elif kind == "shutdown":
                    self.stop_event.set()
                    return
                else:
                    report("warning", f"unknown host command: {kind}")
            except Exception as exc:  # noqa: BLE001 - never kill the reader
                report("error", f"host command {kind} failed: {exc}")
        # EOF: the Host went away.
        self.stop_event.set()

    def send_text(self, peer_id: str, text: str, context_token: str) -> None:
        client = self.client
        if client is None or not peer_id or not text:
            return
        client.send_text(peer_id, text, context_token or None)

    def set_typing(self, peer_id: str, on: bool) -> None:
        if not peer_id:
            return
        with self._typing_lock:
            loop = self._typing.get(peer_id)
            if on:
                if loop is None:
                    loop = TypingLoop(self, peer_id)
                    self._typing[peer_id] = loop
                    loop.start()
            elif loop is not None:
                loop.stop()
                self._typing.pop(peer_id, None)

    # ---------------------------------------------------------------- login

    def clear_accounts(self) -> None:
        root = self.state_dir / "ilink"
        try:
            if root.is_dir():
                for path in sorted(root.rglob("*"), reverse=True):
                    if path.is_file():
                        path.unlink()
                    elif path.is_dir():
                        path.rmdir()
            report("info", "已清除本地登录凭证")
        except OSError as exc:
            report("warning", f"清除本地凭证失败：{exc}")

    def restore_account(self) -> Optional[IlinkClient]:
        index = load_account_index(self.state_dir)
        if not index:
            return None
        account_id = index[-1]
        data = load_account(self.state_dir, account_id) or {}
        token = data.get("token")
        if not token:
            return None
        self.account_id = account_id
        self.account_user_id = data.get("userId")
        client = IlinkClient(
            base_url=data.get("baseUrl") or "https://ilinkai.weixin.qq.com",
            token=str(token),
            long_poll_timeout_s=self.long_poll_timeout_s,
        )
        report("info", f"恢复已保存的登录：{account_id}")
        return client

    def interactive_login(self, force: bool) -> IlinkClient:
        index = [] if force else load_account_index(self.state_dir)
        client = IlinkClient(long_poll_timeout_s=self.long_poll_timeout_s)
        try:
            qr = client.fetch_qrcode(index)
        except IlinkError as exc:
            if not index:
                raise
            report("warning", f"服务器拒绝了本地 token（{exc}），改走新登录")
            self.clear_accounts()
            qr = client.fetch_qrcode([])

        qrcode = qr["qrcode"]
        emit(
            {
                "type": "phase",
                "phase": "qr_ready",
                "message": "请用手机微信扫码登录",
                "qrcodeUrl": qr.get("qrcode_img_content", ""),
            }
        )

        pending_verify: Optional[str] = None
        verify_deadline = 0.0
        deadline = time.monotonic() + QR_SCAN_TIMEOUT_S
        refreshes = 0
        while time.monotonic() < deadline and not self.stop_event.is_set():
            if verify_deadline and time.monotonic() > verify_deadline:
                pending_verify = None
                verify_deadline = 0.0
                phase("waiting_verify", message="配对码输入超时，请重新扫码")
            try:
                status = client.poll_qrcode_status(qrcode, pending_verify)
            except IlinkError as exc:
                report("warning", f"二维码状态轮询失败：{exc}")
                time.sleep(QR_POLL_STEP_S)
                continue
            kind = status.get("status")
            if kind == "need_verifycode":
                phase("need_verify", message="手机微信显示了数字配对码，请在插件页输入")
                try:
                    code = self.verify_queue.get(timeout=1.0)
                except queue.Empty:
                    if not verify_deadline:
                        verify_deadline = time.monotonic() + VERIFY_WAIT_S
                    continue
                verify_deadline = 0.0
                pending_verify = code
                continue
            if kind == "verify_code_blocked":
                phase("need_verify", message="配对码多次错误，请稍后重试")
                pending_verify = None
                verify_deadline = 0.0
            elif kind == "scaned":
                pending_verify = None
                phase("scaned", message="已扫码，正在确认…")
            elif kind == "expired":
                refreshes += 1
                if refreshes > QR_REFRESH_MAX:
                    raise IlinkError("二维码多次过期，登录中止")
                phase("expired", message="二维码已过期，正在刷新…")
                qr = client.fetch_qrcode(load_account_index(self.state_dir))
                qrcode = qr["qrcode"]
                emit(
                    {
                        "type": "phase",
                        "phase": "qr_ready",
                        "message": "请用手机微信扫码登录（已刷新）",
                        "qrcodeUrl": qr.get("qrcode_img_content", ""),
                    }
                )
                pending_verify = None
                verify_deadline = 0.0
            elif kind == "scaned_but_redirect":
                host = status.get("redirect_host")
                if host:
                    client.base_url = f"https://{host}"
                    report("info", f"IDC 重定向到 {host}")
            elif kind == "binded_redirect":
                restored = self.restore_account()
                if restored is None:
                    raise IlinkError("服务器要求复用既有凭证，但本地没有可用的 token")
                phase("confirmed", message="该微信已绑定过本 bot，使用既有凭证", accountId=self.account_id or "")
                return restored
            elif kind == "confirmed":
                token = status.get("bot_token")
                bot_id = status.get("ilink_bot_id")
                if not token or not bot_id:
                    raise IlinkError("登录确认但缺少 bot_token / ilink_bot_id")
                self.account_id = str(bot_id)
                self.account_user_id = status.get("ilink_user_id")
                save_account(
                    self.state_dir,
                    self.account_id,
                    {
                        "token": token,
                        "baseUrl": client.base_url,
                        "userId": self.account_user_id,
                        "savedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    },
                )
                phase("confirmed", message="登录成功", accountId=self.account_id)
                return IlinkClient(
                    base_url=client.base_url,
                    token=str(token),
                    long_poll_timeout_s=self.long_poll_timeout_s,
                )
            elif kind in ("wait", None):
                pass
            else:
                report("info", f"未处理的二维码状态：{kind}")
            time.sleep(QR_POLL_STEP_S)
        raise IlinkError("扫码登录超时")

    # ------------------------------------------------------------ messaging

    @staticmethod
    def extract_text(msg: dict[str, Any]) -> str:
        for item in msg.get("item_list") or []:
            if item.get("type") == 1 and item.get("text_item", {}).get("text") is not None:
                return str(item["text_item"]["text"])
            if item.get("type") == 3 and item.get("voice_item", {}).get("text"):
                return str(item["voice_item"]["text"])
        return ""

    def on_inbound(self, msg: dict[str, Any]) -> None:
        if msg.get("group_id"):
            report("info", f"忽略群消息：{msg.get('from_user_id')}")
            return
        if msg.get("message_type") != 1:
            return
        peer_id = str(msg.get("from_user_id") or "")
        if not peer_id:
            return
        if self.allow_from and peer_id not in self.allow_from:
            report("info", f"忽略非白名单发送者：{peer_id}")
            return
        if not self.allow_from and self.account_user_id and peer_id != self.account_user_id:
            report("info", f"忽略非扫码者消息：{peer_id}")
            return
        text = self.extract_text(msg)
        context_token = str(msg.get("context_token") or "")
        if context_token and self.account_id:
            save_context_token(self.state_dir, self.account_id, peer_id, context_token)
        if not text.strip():
            report("info", f"忽略非文本消息：{peer_id}")
            return
        emit(
            {
                "type": "inbound",
                "peerId": peer_id,
                "text": text,
                "contextToken": context_token,
                "messageId": str(msg.get("msg_id") or msg.get("message_id") or ""),
            }
        )

    # ----------------------------------------------------------------- loop

    def monitor(self, client: IlinkClient) -> None:
        account_id = self.account_id or ""
        cursor = load_sync_buf(self.state_dir, account_id)
        if cursor:
            report("info", f"续接消息游标（{len(cursor)} 字节）")
        failures = 0
        stale_retries = 0
        while not self.stop_event.is_set():
            if self.relogin_event.is_set():
                return
            try:
                msgs, new_cursor, resp = client.get_updates(cursor)
                ret = resp.get("ret")
                errcode = resp.get("errcode")
                if (ret not in (None, 0)) or (errcode not in (None, 0)):
                    if ret == STALE_TOKEN_ERRCODE or errcode == STALE_TOKEN_ERRCODE:
                        stale_retries += 1
                        if stale_retries > 20:
                            report("error", "token 持续过期，准备重新登录")
                            self.relogin_event.set()
                            return
                        report("warning", f"token 暂时不可用（-14），{45}s 后重试（{stale_retries}/20）")
                        time.sleep(45)
                        continue
                    failures += 1
                    report("warning", f"getupdates 返回 ret={ret} errcode={errcode} errmsg={resp.get('errmsg')}")
                    time.sleep(2 if failures < 3 else 30)
                    continue
                failures = 0
                stale_retries = 0
                if new_cursor and new_cursor != cursor:
                    save_sync_buf(self.state_dir, account_id, new_cursor)
                    cursor = new_cursor
                for msg in msgs:
                    self.on_inbound(msg)
            except IlinkError as exc:
                failures += 1
                report("warning", f"长轮询失败（{failures}）：{exc}")
                time.sleep(2 if failures < 3 else 30)

    def run(self) -> int:
        reader = threading.Thread(target=self.read_commands, name="host-stdin", daemon=True)
        reader.start()

        while not self.stop_event.is_set():
            need_relogin = self.relogin_event.is_set()
            self.relogin_event.clear()
            phase("starting", message="正在连接微信…")
            try:
                client = None if need_relogin else self.restore_account()
                if client is None:
                    phase("waiting_qr", message="需要扫码登录微信")
                    client = self.interactive_login(force=need_relogin)
            except IlinkError as exc:
                if self.stop_event.is_set():
                    break
                phase("error", message=f"登录失败：{exc}")
                report("error", f"登录失败：{exc}")
                time.sleep(5)
                continue

            with self._client_lock:
                self.client = client
            client.notify_start()
            phase("connected", message="已连接微信 ClawBot", accountId=self.account_id or "")
            report("info", f"开始监听账号 {self.account_id}")
            try:
                self.monitor(client)
            finally:
                with self._client_lock:
                    self.client = None
                try:
                    client.notify_stop()
                except Exception:  # noqa: BLE001
                    pass
            if not self.relogin_event.is_set():
                break

        phase("stopped", message="桥接已停止")
        return 0


def setup_logging(state_dir: Path, level: str) -> None:
    log_dir = state_dir / "log"
    log_dir.mkdir(parents=True, exist_ok=True)
    handler = logging.handlers.RotatingFileHandler(
        log_dir / "bridge.log",
        maxBytes=2 * 1024 * 1024,
        backupCount=2,
        encoding="utf-8",
    )
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    stderr_handler = logging.StreamHandler(sys.stderr)
    stderr_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s: %(message)s"))
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        handlers=[handler, stderr_handler],
    )


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="WeChat ClawBot bridge for dsh-wechat-clawbot")
    parser.add_argument("--state", required=True, help="state directory")
    parser.add_argument("--log-level", default="INFO")
    parser.add_argument("--allow-from", default="", help="comma separated peer ids")
    parser.add_argument("--long-poll-timeout", type=float, default=35.0)
    args = parser.parse_args(argv)

    try:
        sys.stdout.reconfigure(line_buffering=True)  # type: ignore[attr-defined]
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except (AttributeError, ValueError):
        pass

    state_dir = Path(args.state).expanduser().resolve()
    setup_logging(state_dir, args.log_level)
    bridge = Bridge(
        state_dir=state_dir,
        allow_from=[x.strip() for x in args.allow_from.split(",") if x.strip()],
        long_poll_timeout_s=args.long_poll_timeout,
    )

    def on_signal(_signum, _frame):  # type: ignore[no-untyped-def]
        bridge.stop_event.set()

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)

    log.info("wechat-clawbot bridge starting (state=%s)", state_dir)
    return bridge.run()


if __name__ == "__main__":
    raise SystemExit(main())
