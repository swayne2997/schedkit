"""提醒时间计算。纯函数，不发送通知、不写库。

事件开始时间 - 每条启用的提醒偏移 = 触发时刻。
轮询方按 (since, until] 取需要弹出的提醒，去重交给调用方。
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import Any, Iterable


def _parse_date(value: Any) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def _parse_time(value: Any) -> time | None:
    if not value:
        return None
    try:
        return time.fromisoformat(str(value)[:5])
    except ValueError:
        return None


def event_start(event: dict) -> datetime | None:
    d = _parse_date(event.get("start_date"))
    t = _parse_time(event.get("start_time")) or time(0, 0)
    if not d:
        return None
    return datetime.combine(d, t)


def fire_time(event: dict, reminder: dict) -> datetime | None:
    """单条提醒的触发时刻；配置不完整或已禁用返回 None。"""
    if not reminder.get("enabled", True):
        return None
    start = event_start(event)
    if not start:
        return None

    kind = reminder.get("kind")
    if kind == "minutes_before":
        try:
            minutes = int(reminder.get("minutes"))
        except (TypeError, ValueError):
            return None
        if minutes < 0:
            return None
        return start - timedelta(minutes=minutes)

    if kind == "days_before":
        try:
            days = int(reminder.get("days"))
        except (TypeError, ValueError):
            return None
        at = _parse_time(reminder.get("time")) or time(18, 0)
        if days < 0:
            return None
        return datetime.combine(start.date() - timedelta(days=days), at)

    return None


def due(
    events: Iterable[dict],
    reminders: Iterable[dict],
    since: datetime,
    until: datetime,
) -> list[dict]:
    """返回 since < 触发时刻 <= until 的提醒，按时间升序。

    每项：{event, reminder, fire_at}。已取消的事件不提醒。
    """
    reminders = list(reminders)
    out: list[dict] = []
    for event in events:
        if event.get("status") == "cancelled":
            continue
        for reminder in reminders:
            when = fire_time(event, reminder)
            if when and since < when <= until:
                out.append({"event": event, "reminder": reminder, "fire_at": when})
    out.sort(key=lambda item: item["fire_at"])
    return out


def label(event: dict) -> str:
    """通知第二行：公司 · 环节。"""
    parts = [str(event.get("company") or "").strip()]
    tail = str(event.get("round") or event.get("position") or "").strip()
    if tail:
        parts.append(tail)
    return " · ".join([p for p in parts if p])