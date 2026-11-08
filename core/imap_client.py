"""163 IMAP 拉取。只负责取信与解出纯文本，不写库。"""
from __future__ import annotations

import email
import imaplib
import re
import time
from email import policy
from email.utils import parsedate_to_datetime

BATCH = 50
PAUSE = 1.0
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
TAG = re.compile(r"<[^>]+>")
BLANK = re.compile(r"\n{3,}")


class ImapError(RuntimeError):
    pass


def _since(days: int) -> str:
    from datetime import date, timedelta

    d = date.today() - timedelta(days=max(1, int(days)))
    return f"{d.day:02d}-{MONTHS[d.month - 1]}-{d.year}"


def _uidvalidity(conn) -> int:
    _, data = conn.response("UIDVALIDITY")
    try:
        return int(data[0])
    except (TypeError, ValueError, IndexError):
        raise ImapError("读不到邮箱 UIDVALIDITY")


def _send_id(conn) -> None:
    """163 要求登录后声明客户端身份，否则 SELECT 会被判为 Unsafe Login。"""
    try:
        imaplib.Commands.setdefault("ID", ("AUTH", "SELECTED"))
        conn._simple_command(
            "ID", '("name" "scheduler" "version" "0.2" "vendor" "local")')
        conn._untagged_response("OK", [None], "ID")
    except Exception:
        pass


def _text_of(msg) -> str:
    plain, html = [], []
    for part in msg.walk():
        if part.is_multipart():
            continue
        ctype = part.get_content_type()
        if ctype not in ("text/plain", "text/html"):
            continue
        try:
            content = part.get_content()
        except Exception:
            continue
        if not isinstance(content, str):
            continue
        (plain if ctype == "text/plain" else html).append(content)
    text = "\n".join(plain) if plain else TAG.sub(" ", "\n".join(html))
    text = text.replace("\r\n", "\n").replace("\xa0", " ")
    return BLANK.sub("\n\n", text).strip()[:40000]


def _received_at(msg, fallback: str) -> str:
    raw = msg.get("Date")
    if not raw:
        return fallback
    try:
        return parsedate_to_datetime(raw).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return fallback


def _decode(data: bytes) -> str:
    return data.decode("utf-8", "replace")


def fetch_mails(cfg: dict, last_uid: int = 0, expect_uidvalidity: int = 0,
                days: int = 0) -> dict:
    """拉取邮件。last_uid 为 0 或 UIDVALIDITY 对不上时，按 days 回扫。

    返回 {"uidvalidity", "mails": [...], "last_uid": 本轮最大 UID}。
    """
    host = cfg.get("host") or "imap.163.com"
    port = int(cfg.get("port") or 993)
    user = cfg.get("user") or ""
    code = cfg.get("auth_code") or ""
    folder = cfg.get("folder") or "INBOX"
    if not user or not code:
        raise ImapError("还没填邮箱账号或授权码")

    try:
        conn = imaplib.IMAP4_SSL(host, port, timeout=20)
    except Exception as exc:
        raise ImapError(f"连不上 {host}：{exc}")

    mails: list[dict] = []
    max_uid = 0
    try:
        try:
            conn.login(user, code)
        except imaplib.IMAP4.error as exc:
            detail = exc.args[0] if exc.args else exc
            if isinstance(detail, bytes):
                detail = detail.decode("utf-8", "replace")
            raise ImapError(f"登录失败：{detail}（请确认授权码有效，并在邮箱设置里开启 IMAP 服务）")
        _send_id(conn)
        try:
            ok, data = conn.select(folder, readonly=True)
        except imaplib.IMAP4.error as exc:
            detail = exc.args[0] if exc.args else exc
            if isinstance(detail, bytes):
                detail = detail.decode("utf-8", "replace")
            raise ImapError(f"打不开文件夹 {folder}：{detail}")
        if ok != "OK":
            detail = b" ".join(x for x in (data or []) if isinstance(x, bytes))
            raise ImapError(f"打不开文件夹 {folder}：{detail.decode('utf-8', 'replace')}")
        uidvalidity = _uidvalidity(conn)

        # UIDVALIDITY 变了说明邮箱重建过、旧 UID 失效，只能当作首次同步回扫
        reuse = bool(last_uid) and (
            not expect_uidvalidity or int(expect_uidvalidity) == uidvalidity)
        if reuse:
            max_uid = int(last_uid)
            typ, data = conn.uid("SEARCH", None, "UID", f"{int(last_uid) + 1}:*")
            if typ != "OK":
                raise ImapError("搜索新邮件失败")
            uids = [int(x) for x in _decode(b" ".join(data or [])).split() if x]
            uids = [u for u in uids if u > int(last_uid)]
        else:
            typ, data = conn.uid(
                "SEARCH", None, "SINCE", _since(days or cfg.get("initial_days") or 7))
            if typ != "OK":
                raise ImapError("搜索历史邮件失败")
            uids = [int(x) for x in _decode(b" ".join(data or [])).split() if x]

        uids.sort()
        for start in range(0, len(uids), BATCH):
            batch = uids[start:start + BATCH]
            typ, items = conn.uid(
                "FETCH", ",".join(str(u) for u in batch), "(BODY.PEEK[])")
            if typ != "OK":
                raise ImapError("读取邮件内容失败")
            for item in items:
                if not isinstance(item, tuple) or len(item) < 2:
                    continue
                num = re.search(rb"UID (\d+)", item[0])
                if not num:
                    continue
                uid = int(num.group(1))
                msg = email.message_from_bytes(item[1], policy=policy.default)
                mails.append({
                    "uid": uid,
                    "subject": str(msg.get("Subject") or ""),
                    "from_addr": str(msg.get("From") or ""),
                    "message_id": str(msg.get("Message-ID") or "").strip(),
                    "received_at": _received_at(msg, ""),
                    "body": _text_of(msg),
                })
                max_uid = max(max_uid, uid)
            if len(uids) > BATCH and start + BATCH < len(uids):
                time.sleep(PAUSE)
        return {"uidvalidity": uidvalidity, "mails": mails, "last_uid": max_uid}
    finally:
        try:
            conn.logout()
        except Exception:
            pass