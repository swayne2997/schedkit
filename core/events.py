"""事件仓储：校验、增删改查。字段与前端展示结构一一对应。"""
from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime

from . import db

TYPES = ("interview", "written", "assessment", "other")
STATUSES = ("normal", "cancelled")
SOURCES = ("mail", "manual")

TEXT_LIMITS = {"position": 80, "round": 40, "mode": 20, "location": 120,
               "link": 500, "note": 1000}
FIELDS = (
    "type", "company", "position", "round", "start_date", "start_time",
    "end_date", "end_time", "mode", "location", "link", "deadline", "status",
    "source", "source_ref", "note", "extra",
)


def now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _date(value: str, label: str) -> str:
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except (TypeError, ValueError):
        raise ValueError(f"{label}格式应为 YYYY-MM-DD")
    return value


def _time(value: str, label: str) -> str:
    try:
        datetime.strptime(value, "%H:%M")
    except (TypeError, ValueError):
        raise ValueError(f"{label}格式应为 HH:MM")
    return value


def _text(value, label: str, limit: int | None = None) -> str:
    out = "" if value is None else str(value).strip()
    if limit and len(out) > limit:
        raise ValueError(f"{label}不能超过 {limit} 字")
    return out


def normalize(data: dict, base: dict | None = None) -> dict:
    """校验并归一化；base 用于局部更新时补全未提交字段。"""
    merged = dict(base or {})
    merged.update(data or {})
    out = {}

    ev_type = merged.get("type") or "other"
    if ev_type not in TYPES:
        raise ValueError("事件类型不合法")
    out["type"] = ev_type

    out["company"] = _text(merged.get("company"), "公司", 80)
    if not out["company"]:
        raise ValueError("公司不能为空")

    for key in ("position", "round", "mode", "location", "link", "note", "source_ref"):
        out[key] = _text(merged.get(key), key, TEXT_LIMITS.get(key))

    start_date = _text(merged.get("start_date"), "开始日期")
    start_time = _text(merged.get("start_time"), "开始时间")
    if start_date:
        out["start_date"] = _date(start_date, "开始日期")
        out["start_time"] = _time(start_time, "开始时间") if start_time else ""
    elif start_time:
        raise ValueError("填了开始时间也要填开始日期")
    else:
        out["start_date"] = ""
        out["start_time"] = ""

    end_date = _text(merged.get("end_date"), "结束日期")
    end_time = _text(merged.get("end_time"), "结束时间")
    if end_date and end_time and out["start_date"] and out["start_time"]:
        out["end_date"] = _date(end_date, "结束日期")
        out["end_time"] = _time(end_time, "结束时间")
        start = datetime.strptime(out["start_date"] + " " + out["start_time"], "%Y-%m-%d %H:%M")
        end = datetime.strptime(out["end_date"] + " " + out["end_time"], "%Y-%m-%d %H:%M")
        if end < start:
            raise ValueError("结束时间不能早于开始时间")
    else:
        out["end_date"] = ""
        out["end_time"] = ""

    deadline = _text(merged.get("deadline"), "截止时间")
    out["deadline"] = deadline

    status = merged.get("status") or "normal"
    if status not in STATUSES:
        raise ValueError("状态不合法")
    out["status"] = status

    source = merged.get("source") or "manual"
    if source not in SOURCES:
        source = "manual"
    out["source"] = source

    extra = merged.get("extra") or ""
    if not isinstance(extra, str):
        extra = json.dumps(extra, ensure_ascii=False)
    out["extra"] = extra

    return out


def to_dict(row: sqlite3.Row) -> dict:
    item = {key: row[key] for key in row.keys()}
    try:
        item["extra"] = json.loads(item.get("extra") or "{}")
    except json.JSONDecodeError:
        item["extra"] = {}
    return item


def list_events(from_date: str | None = None, to_date: str | None = None, query: str | None = None) -> list[dict]:
    sql = "SELECT * FROM event WHERE 1=1"
    params: list = []
    if from_date:
        sql += " AND start_date >= ?"
        params.append(from_date)
    if to_date:
        sql += " AND start_date <= ?"
        params.append(to_date)
    if query:
        like = "%" + query.strip() + "%"
        sql += " AND (company LIKE ? OR position LIKE ? OR round LIKE ?)"
        params.extend([like, like, like])
    sql += " ORDER BY start_date, start_time, company"
    with db.db() as conn:
        return [to_dict(row) for row in conn.execute(sql, params)]


def get_event(event_id: str) -> dict | None:
    with db.db() as conn:
        row = conn.execute("SELECT * FROM event WHERE id = ?", (event_id,)).fetchone()
        return to_dict(row) if row else None


def create_event(data: dict) -> dict:
    item = normalize(data, {"source": "manual"})
    event_id = uuid.uuid4().hex
    stamp = now_str()
    columns = ", ".join(FIELDS)
    marks = ", ".join("?" for _ in FIELDS)
    values = [item.get(key, "") for key in FIELDS]
    with db.db() as conn:
        conn.execute(
            f"INSERT INTO event (id, {columns}, created_at, updated_at) VALUES (?, {marks}, ?, ?)",
            [event_id, *values, stamp, stamp],
        )
    return get_event(event_id)


def update_event(event_id: str, patch: dict) -> dict:
    current = get_event(event_id)
    if not current:
        raise LookupError("事件不存在")
    item = normalize(patch, current)
    assignments = ", ".join(f"{key} = ?" for key in FIELDS)
    values = [item.get(key, "") for key in FIELDS]
    with db.db() as conn:
        conn.execute(
            f"UPDATE event SET {assignments}, updated_at = ? WHERE id = ?",
            [*values, now_str(), event_id],
        )
    return get_event(event_id)


def delete_event(event_id: str) -> bool:
    with db.db() as conn:
        cur = conn.execute("DELETE FROM event WHERE id = ?", (event_id,))
        return cur.rowcount > 0


def create_or_merge(data: dict) -> dict:
    """邮件落库用：同公司+岗位+同一开始时间视为同一场活动，合并成一条。"""
    item = normalize(data, {"source": "manual"})
    existing = _find_same_slot(item)
    if not existing:
        return create_event(item)
    patch = {}
    for key in ("position", "round", "mode", "location", "link", "deadline"):
        if not existing.get(key) and item.get(key):
            patch[key] = item[key]
    note = _merge_note(existing.get("note"), item.get("note"))
    if note != (existing.get("note") or ""):
        patch["note"] = note
    if not patch:
        return existing
    return update_event(existing["id"], patch)


def _find_same_slot(item: dict) -> dict | None:
    if not item.get("start_date") or not item.get("start_time"):
        return None
    with db.db() as conn:
        row = conn.execute(
            "SELECT * FROM event WHERE company = ? AND position = ? "
            "AND start_date = ? AND start_time = ? AND status = 'normal' "
            "ORDER BY created_at LIMIT 1",
            (item["company"], item["position"], item["start_date"], item["start_time"]),
        ).fetchone()
        return to_dict(row) if row else None


def _merge_note(old: str, new: str) -> str:
    old = (old or "").strip()
    new = (new or "").strip()
    if not new or new == old:
        return old
    if not old or old == "无特殊要求":
        return new
    if new == "无特殊要求" or new in old:
        return old
    return old + "\n" + new