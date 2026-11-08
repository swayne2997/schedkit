"""邮箱同步：拉信 -> 落库 -> 模型解析 -> 待确认队列。

解析只做一次：邮件表里的 verdict 一旦有值就不再重复调用模型。
"""
from __future__ import annotations

import threading
import time
from datetime import datetime

from . import config, imap_client, mails, parser

MAX_PARSE = 50
FIRST_DAYS = 7  # 「上次同步之后」模式在第一次同步时回看的天数

_run_lock = threading.Lock()
_status_lock = threading.Lock()
_status = {"running": False, "error": "", "last_at": "", "fetched": 0, "added": 0}


def _set(**changes) -> None:
    with _status_lock:
        _status.update(changes)


def status() -> dict:
    with _status_lock:
        return dict(_status)


def configured(cfg: dict | None = None) -> bool:
    cfg = cfg or config.load()
    mail = cfg.get("mail") or {}
    ai = cfg.get("ai") or {}
    return bool(
        mail.get("user") and mail.get("auth_code")
        and ai.get("base_url") and ai.get("api_key") and ai.get("model")
    )


def _store_pending(mail_id: int, mail: dict, event: dict | None, reason: str) -> None:
    payload = {
        "subject": mail.get("subject") or "",
        "from_addr": mail.get("from_addr") or "",
        "received_at": mail.get("received_at") or "",
    }
    if event:
        payload["event"] = event
    mails.add_pending(mail_id, payload, reason)


def sync(limit: int = MAX_PARSE) -> dict:
    """同步一轮；同一时间只允许一个任务在跑。"""
    if not _run_lock.acquire(blocking=False):
        return status()
    try:
        _run(limit)
    finally:
        _set(running=False)
        _run_lock.release()
    return status()


def _run(limit: int) -> dict:
    added = 0
    _set(running=True, error="", fetched=0, added=0)
    try:
        cfg = config.load()
        if not configured(cfg):
            raise RuntimeError("邮箱或模型还没配置完整")
        mail_cfg = cfg.get("mail") or {}
        folder = mail_cfg.get("folder") or "INBOX"
        mode = mail_cfg.get("sync_mode") or "days"

        if mode == "last":
            cursor = mails.get_cursor(folder) or {}
            last_uid = int(cursor.get("last_uid") or 0)
            expect = int(cursor.get("uidvalidity") or 0)
            # 没同步过的邮箱（或 UIDVALIDITY 变了）从最近一周开始
            days = FIRST_DAYS
        else:
            last_uid, expect = 0, 0
            days = int(mail_cfg.get("initial_days") or FIRST_DAYS)

        # 「上次同步之后」只取新 UID；其余模式按天数回扫，已判定过的邮件会跳过
        data = imap_client.fetch_mails(mail_cfg, last_uid, expect, days)
        _set(fetched=len(data["mails"]))

        parsed = 0
        # 游标只推进到「已判定完」的最后一封，避免超过单轮上限的邮件再也取不到
        done_uid = int(last_uid)
        for raw in data["mails"]:
            mail_id = mails.save_mail(
                folder, raw["uid"], raw["subject"], raw["from_addr"],
                raw["received_at"], raw["body"], raw["message_id"],
            )
            stored = mails.get_mail(mail_id) or raw
            if stored.get("verdict"):
                done_uid = raw["uid"]
                continue
            if parsed >= limit:
                break  # 留到下一轮
            parsed += 1
            try:
                result = parser.parse_mail(stored)
            except parser.ParseError as exc:
                mails.set_verdict(mail_id, "failed")
                done_uid = raw["uid"]
                _set(error=str(exc))
                continue
            # 模型已按提示排除了宣讲会/投递邀请等；有安排就进待确认
            kept = result["events"]
            if not kept:
                mails.set_verdict(mail_id, "ignored")
                done_uid = raw["uid"]
                continue
            reason = result["summary"] or "模型解析结果，待确认"
            for event in kept:
                _store_pending(mail_id, raw, event, reason)
                added += 1
            mails.set_verdict(mail_id, "recruitment")
            done_uid = raw["uid"]

        # 记下游标，下次「上次同步之后」从这里往后取
        mails.save_cursor(folder, data["uidvalidity"], done_uid)
        _set(last_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"), added=added)
        return status()
    except Exception as exc:  # 网络、登录、接口错误都留在状态里给界面显示
        _set(error=str(exc), added=added)
        return status()


def start_async() -> bool:
    """手动触发：先占锁并置 running，接口立即返回，后台线程接着跑。"""
    if not _run_lock.acquire(blocking=False):
        return False
    _set(running=True, error="", fetched=0, added=0)

    def worker() -> None:
        try:
            _run(MAX_PARSE)
        finally:
            _set(running=False)
            _run_lock.release()

    threading.Thread(target=worker, daemon=True).start()
    return True


def start_background() -> None:
    """常驻线程：按 sync_minutes 周期同步。"""
    def worker() -> None:
        time.sleep(20)
        while True:
            cfg = config.load()
            try:
                if configured(cfg):
                    sync()
            except Exception:
                pass
            minutes = max(5, int(cfg.get("sync_minutes") or 30))
            time.sleep(minutes * 60)

    threading.Thread(target=worker, daemon=True).start()