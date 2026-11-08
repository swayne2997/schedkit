"""开机自启：写入当前用户的 Run 注册表项。"""
from __future__ import annotations

import sys
import winreg
from pathlib import Path

RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
VALUE_NAME = "SchedKit"
LEGACY_NAMES = ("SchedulerApp", "OneWay")
ENTRY = Path(__file__).resolve().parent.parent / "main.py"


def _command() -> str:
    exe = Path(sys.executable)
    pythonw = exe.with_name("pythonw.exe")
    runner = pythonw if pythonw.exists() else exe
    return f'"{runner}" "{ENTRY}"'


def _present(name: str) -> bool:
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            value, _ = winreg.QueryValueEx(key, name)
            return bool(value)
    except FileNotFoundError:
        return False


def _drop(key, name: str) -> None:
    """删掉一个值，不存在就当作已删除。"""
    try:
        winreg.DeleteValue(key, name)
    except FileNotFoundError:
        pass


def enabled() -> bool:
    if _present(VALUE_NAME):
        return True
    return any(_present(name) for name in LEGACY_NAMES)


def enable() -> None:
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
        winreg.SetValueEx(key, VALUE_NAME, 0, winreg.REG_SZ, _command())
        for name in LEGACY_NAMES:
            if name != VALUE_NAME:
                _drop(key, name)


def disable() -> None:
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as key:
            _drop(key, VALUE_NAME)
            for name in LEGACY_NAMES:
                if name != VALUE_NAME:
                    _drop(key, name)
    except FileNotFoundError:
        pass