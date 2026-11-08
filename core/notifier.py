"""桌面通知与轮询调度。

通知只有两行：标题是时间（今天 14:00 / 11月12日 14:00），正文是公司 · 环节。
不持久化待发队列，每次轮询按事件表重算；进程内记录已弹过的提醒避免重复。
"""
from __future__ import annotations

import threading
from datetime import datetime, timedelta
from typing import Callable

from . import config, events, reminders

APP_ID = "SchedKit"


def describe_when(start: datetime, now: datetime) -> str:
    days = (start.date() - now.date()).days
    clock = start.strftime("%H:%M")
    if days == 0:
        return "今天 " + clock
    if days == 1:
        return "明天 " + clock
    if days == -1:
        return "昨天 " + clock
    return f"{start.month}月{start.day}日 {clock}"


def send(item: dict, now: datetime | None = None) -> None:
    now = now or datetime.now()
    start = reminders.event_start(item["event"])
    title = describe_when(start, now) if start else ""
    msg = reminders.label(item["event"])
    try:
        from winotify import Notification

        Notification(app_id=APP_ID, title=title, msg=msg).show()
    except Exception as exc:  # 通知失败不影响轮询
        print("[notify]", title, "|", msg, "|", exc)


class Notifier:
    """周期性检查到期提醒并弹通知。"""

    def __init__(
        self,
        sender: Callable[[dict, datetime], None] = send,
        max_late: timedelta = timedelta(hours=2),
    ) -> None:
        self.sender = sender
        self.max_late = max_late
        self._last = datetime.now()
        self._fired: dict[tuple, datetime] = {}
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def poll(self, now: datetime | None = None) -> list[dict]:
        now = now or datetime.now()
        since = min(max(self._last, now - self.max_late), now)

        cfg = config.load()
        rules = cfg.get("reminders") or []
        if not rules:
            self._last = now
            return []

        span_from = (now - timedelta(days=3)).date().isoformat()
        span_to = (now + timedelta(days=90)).date().isoformat()
        items = reminders.due(events.list_events(span_from, span_to), rules, since, now)

        sent: list[dict] = []
        for item in items:
            key = (
                item["event"]["id"],
                item["reminder"].get("id") or "",
                item["fire_at"].isoformat(),
            )
            if key in self._fired:
                continue
            self._fired[key] = item["fire_at"]
            try:
                self.sender(item, now)
            except Exception as exc:
                print("[notify] 发送失败", exc)
            sent.append(item)

        self._prune(now)
        self._last = now
        return sent

    def _prune(self, now: datetime) -> None:
        keep_after = now - timedelta(days=2)
        for key in [k for k, t in self._fired.items() if t < keep_after]:
            self._fired.pop(key, None)

    def start(self, interval_minutes: int = 10) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop, args=(interval_minutes,), name="notifier", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self, interval_minutes: int) -> None:
        while not self._stop.is_set():
            try:
                self.poll()
            except Exception as exc:
                print("[notify] 轮询失败", exc)
            self._stop.wait(max(30, int(interval_minutes) * 60))