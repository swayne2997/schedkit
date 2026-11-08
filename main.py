"""程序入口：本地服务 + 窗口 + 提醒轮询。"""
from __future__ import annotations

import ctypes
import threading
import winreg
from ctypes import wintypes
from pathlib import Path

import pystray
import webview
from PIL import Image

from core import config, db, notifier, sync
from server.api import ApiServer

TITLE = "SchedKit"
MIN_SIZE = (900, 560)
STORAGE = Path(__file__).resolve().parent / "data" / "webview"
ICON = Path(__file__).resolve().parent / "assets" / "app.ico"
ICON_INVERSE = Path(__file__).resolve().parent / "assets" / "app-inverse.ico"
SPI_GETWORKAREA = 0x0030


class _Rect(ctypes.Structure):
    _fields_ = [
        ("left", wintypes.LONG),
        ("top", wintypes.LONG),
        ("right", wintypes.LONG),
        ("bottom", wintypes.LONG),
    ]


def _enable_dpi() -> None:
    """先声明 DPI 感知，否则读到的是缩放后的虚拟坐标。"""
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


def _work_area() -> tuple[int, int, int, int] | None:
    rect = _Rect()
    if ctypes.windll.user32.SystemParametersInfoW(SPI_GETWORKAREA, 0, ctypes.byref(rect), 0):
        return rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top
    return None


def _scale() -> float:
    """系统缩放系数，用来把物理工作区换算成窗口使用的逻辑坐标。"""
    try:
        dpi = ctypes.windll.user32.GetDpiForSystem()
        if dpi:
            return dpi / 96.0
    except Exception:
        pass
    try:
        return ctypes.windll.shcore.GetScaleFactorForDevice(0) / 100.0
    except Exception:
        return 1.0


def _fit(geo: dict) -> dict:
    """把记忆的窗口几何夹到当前工作区内，避免超出屏幕。"""
    area = _work_area()
    if not area:
        return geo
    scale = _scale() or 1.0
    left, top, aw, ah = [int(v / scale) for v in area]
    width = min(int(geo.get("width") or 1100), aw)
    height = min(int(geo.get("height") or 720), ah)
    x, y = geo.get("x"), geo.get("y")
    if x is None or y is None:
        x = left + (aw - width) // 2
        y = top + (ah - height) // 2
    else:
        x = max(left, min(int(x), left + aw - width))
        y = max(top, min(int(y), top + ah - height))
    return {"width": width, "height": height, "x": x, "y": y}


def _remember(window) -> None:
    """关闭时记住窗口位置与大小。"""
    try:
        geo = {
            "width": int(window.width or 1100),
            "height": int(window.height or 720),
            "x": None if window.x is None else int(window.x),
            "y": None if window.y is None else int(window.y),
            "maximized": False,
        }
        config.update({"window": geo})
    except Exception as exc:
        print("[window] 保存位置失败", exc)


def _icon_file() -> Path:
    """深色系统用米白版、浅色系统用墨黑版，否则任务栏上会看不见。"""
    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
        ) as key:
            light = winreg.QueryValueEx(key, "AppsUseLightTheme")[0]
        return ICON if light else ICON_INVERSE
    except OSError:
        return ICON


def _icon(size: int) -> Image.Image:
    """托盘用：从 ico 里取图并缩到目标尺寸。"""
    with Image.open(_icon_file()) as img:
        return img.convert("RGBA").resize((size, size), Image.LANCZOS)


def _app_id() -> None:
    """给进程一个独立标识，任务栏才会用窗口图标而不是 python.exe 的。"""
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID.argtypes = [
            wintypes.LPCWSTR
        ]
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("SwanSwang.SchedKit")
    except Exception as exc:
        print("[window] 设置 AppUserModelID 失败", exc)


def main() -> int:
    _enable_dpi()
    _app_id()
    db.init()
    cfg = config.load()
    geo = _fit(cfg.get("window") or {})

    server = ApiServer(0)
    server.start()

    remind = notifier.Notifier()
    remind.start(cfg.get("poll_minutes") or 10)
    sync.start_background()

    window = webview.create_window(
        TITLE,
        server.origin,
        width=int(geo.get("width") or 1100),
        height=int(geo.get("height") or 720),
        x=geo.get("x"),
        y=geo.get("y"),
        min_size=MIN_SIZE,
    )
    quitting = threading.Event()

    def on_closing():
        _remember(window)
        if quitting.is_set():
            return True
        window.hide()
        return False

    def open_window():
        window.show()
        window.restore()

    def quit_app():
        quitting.set()
        tray.stop()
        window.destroy()

    window.events.closing += on_closing
    tray = pystray.Icon(
        "scheduler",
        _icon(64),
        TITLE,
        pystray.Menu(
            pystray.MenuItem("打开", open_window, default=True),
            pystray.MenuItem("退出", quit_app),
        ),
    )
    threading.Thread(target=tray.run, daemon=True).start()

    STORAGE.mkdir(parents=True, exist_ok=True)
    try:
        # icon 会在窗口创建时设给 Form，任务栏按钮才认；事后 WM_SETICON 不生效
        webview.start(
            private_mode=False,
            storage_path=str(STORAGE),
            icon=str(_icon_file()),
        )
    finally:
        quitting.set()
        tray.stop()
        remind.stop()
        server.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())