"""配置文件读写。config.json 是唯一事实来源，缺失字段用默认值补齐。"""
from __future__ import annotations

import copy
import json
import threading
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config.json"

DEFAULTS: dict[str, Any] = {
    "window": {"width": 1100, "height": 720, "x": None, "y": None, "maximized": False},
    "theme": "paper",
    "view": "week",
    "poll_minutes": 10,
    "sync_minutes": 30,
    "reminders": [
        {"id": "r-default-1", "kind": "days_before", "days": 1, "time": "18:00", "enabled": True},
        {"id": "r-default-2", "kind": "minutes_before", "minutes": 120, "enabled": True},
    ],
    "mail": {
        "host": "imap.163.com",
        "port": 993,
        "user": "",
        "auth_code": "",
        "folder": "INBOX",
        "sync_mode": "days",
        "initial_days": 7,
    },
    "ai": {"base_url": "", "api_key": "", "model": "", "temperature": 0},
}

_lock = threading.Lock()


def _merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge(out[key], value)
        else:
            out[key] = value
    return out


def load() -> dict:
    with _lock:
        if not CONFIG_PATH.exists():
            return copy.deepcopy(DEFAULTS)
        try:
            raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return copy.deepcopy(DEFAULTS)
    return _merge(DEFAULTS, raw if isinstance(raw, dict) else {})


def save(cfg: dict) -> dict:
    merged = _merge(DEFAULTS, cfg)
    with _lock:
        CONFIG_PATH.write_text(
            json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    return merged


def update(patch: dict) -> dict:
    return save(_merge(load(), patch))