"""邮件与待确认队列的存储层。不含 IMAP 与模型调用。"""
from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime

from . import db

BODY_LIMIT = 20000
VERDICTS = ("", "recruitment", "ignored", "failed")


def now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _row(row: sqlite3.Row | None) -> dict | None:
    return {key: row[key] for key in row.keys()} if row else None


# ---------- 邮件 ----------
def save_mail(mailbox: str, uid: int, subject: str, from_addr: str,
              received_at: str | None, body: str, message_id: str = "") -> int:
    """以 (mailbox, uid) 去重写入，返回本地邮件 id。"""
    fields = {
        "message_id": message_id or "",
        "subject": (subject or "")[:500],
        "from_addr": (from_addr or "")[:200],
        "received_at": received_at or "",
        "body": (body or "")[:BODY_LIMIT],
        "digest": "",
    }
    with db.db() as conn:
        row = conn.execute(
            "SELECT id FROM mail WHERE mailbox = ? AND uid = ?", (mailbox, uid)
        ).fetchone()
        if row:
            conn.execute(
                "UPDATE mail SET message_id = ?, subject = ?, from_addr = ?, "
                "received_at = ?, body = ?, digest = ? WHERE id = ?",
                [*fields.values(), row["id"]],
            )
            return row["id"]
        cur = conn.execute(
            "INSERT INTO mail (uid, mailbox, created_at) VALUES (?, ?, ?)",
            (uid, mailbox, now_str()),
        )
        mail_id = cur.lastrowid
        conn.execute(
            "UPDATE mail SET message_id = ?, subject = ?, from_addr = ?, "
            "received_at = ?, body = ?, digest = ? WHERE id = ?",
            [*fields.values(), mail_id],
        )
        return mail_id


def get_mail(mail_id: int) -> dict | None:
    with db.db() as conn:
        return _row(conn.execute("SELECT * FROM mail WHERE id = ?", (mail_id,)).fetchone())


def set_verdict(mail_id: int, verdict: str, event_id: str | None = None) -> None:
    if verdict not in VERDICTS:
        raise ValueError("邮件判定不合法")
    with db.db() as conn:
        conn.execute(
            "UPDATE mail SET verdict = ?, event_id = ? WHERE id = ?",
            (verdict, event_id, mail_id),
        )


def link_event(event_id: str, mail_id: int, role: str = "create") -> None:
    with db.db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO event_mail (event_id, mail_id, role, created_at) "
            "VALUES (?, ?, ?, ?)",
            (event_id, mail_id, role, now_str()),
        )


# ---------- 同步游标 ----------
def get_cursor(mailbox: str) -> dict | None:
    with db.db() as conn:
        return _row(conn.execute(
            "SELECT * FROM mail_cursor WHERE mailbox = ?", (mailbox,)
        ).fetchone())


def save_cursor(mailbox: str, uidvalidity: int, last_uid: int) -> None:
    with db.db() as conn:
        conn.execute(
            "INSERT INTO mail_cursor (mailbox, uidvalidity, last_uid, updated_at) "
            "VALUES (?, ?, ?, ?) ON CONFLICT(mailbox) DO UPDATE SET "
            "uidvalidity = excluded.uidvalidity, last_uid = excluded.last_uid, "
            "updated_at = excluded.updated_at",
            (mailbox, int(uidvalidity), int(last_uid), now_str()),
        )


# ---------- 待确认队列 ----------
def add_pending(mail_id: int | None, payload: dict, reason: str) -> str:
    pending_id = uuid.uuid4().hex
    with db.db() as conn:
        conn.execute(
            "INSERT INTO pending (id, mail_id, payload, reason, status, created_at) "
            "VALUES (?, ?, ?, ?, 'open', ?)",
            (pending_id, mail_id, json.dumps(payload, ensure_ascii=False), reason, now_str()),
        )
    return pending_id


def list_pending(status: str = "open") -> list[dict]:
    with db.db() as conn:
        rows = conn.execute(
            "SELECT p.*, m.subject, m.from_addr, m.received_at FROM pending p "
            "LEFT JOIN mail m ON m.id = p.mail_id "
            "WHERE p.status = ? ORDER BY p.created_at DESC",
            (status,),
        ).fetchall()
        items = []
        for row in rows:
            item = _row(row)
            try:
                item["payload"] = json.loads(item.get("payload") or "{}")
            except json.JSONDecodeError:
                item["payload"] = {}
            items.append(item)
        return items


def get_pending(pending_id: str) -> dict | None:
    with db.db() as conn:
        row = conn.execute("SELECT * FROM pending WHERE id = ?", (pending_id,)).fetchone()
        if not row:
            return None
        item = _row(row)
        try:
            item["payload"] = json.loads(item.get("payload") or "{}")
        except json.JSONDecodeError:
            item["payload"] = {}
        return item


def resolve_pending(pending_id: str, status: str = "done") -> None:
    if status not in ("done", "skipped"):
        raise ValueError("待确认状态不合法")
    with db.db() as conn:
        conn.execute("UPDATE pending SET status = ? WHERE id = ?", (status, pending_id))