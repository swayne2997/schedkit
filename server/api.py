"""本地 HTTP 服务：静态界面 + 事件接口 + SSE 推送。只监听 127.0.0.1。"""
from __future__ import annotations

import json
import mimetypes
import queue
import re
import sys
import threading
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from core import autostart, config, db, events, mails, sync

ROOT = Path(__file__).resolve().parent.parent


class Hub:
    """极简事件广播，SSE 连接各占一个线程，客户端数量只是个位数。"""

    def __init__(self) -> None:
        self._clients: set[queue.Queue] = set()
        self._lock = threading.Lock()

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue()
        with self._lock:
            self._clients.add(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            self._clients.discard(q)

    def publish(self) -> None:
        with self._lock:
            targets = list(self._clients)
        for q in targets:
            q.put("changed")


HUB = Hub()
EVENT_ID = re.compile(r"^/api/events/([A-Za-z0-9_-]+)$")
PENDING_ID = re.compile(r"^/api/pending/([A-Za-z0-9_-]+)/(accept|skip)$")

CNCOLOR_DATA = ROOT / "data" / "cncolor.json"

_cncolor_lock = threading.Lock()
_cncolor_cache: dict | None = None


def _cncolor_pack() -> dict | None:
    """cncolor.art 的 384 色数据（含节气与释义），首次使用时加载。"""
    global _cncolor_cache
    with _cncolor_lock:
        if _cncolor_cache is None:
            try:
                _cncolor_cache = json.loads(CNCOLOR_DATA.read_text(encoding="utf-8"))
            except Exception:
                _cncolor_cache = {}
        return _cncolor_cache or None


def _term_start(year: int, term: dict) -> date:
    """节气起始日，算法与 cncolor.art 前端一致。"""
    y = year % 100
    offset = (y - 1) // 4 if term["month"] <= 2 else y // 4
    day = int(y * 0.2422 + term["c"]) - offset
    day += (term.get("adj") or {}).get(str(year), 0)
    return date(year, term["month"], day)


def _cncolor_for(day: str) -> dict | None:
    """按 cncolor.art 的每日推荐算法取当日传统色与节气文案。"""
    pack = _cncolor_pack()
    if not pack:
        return None
    try:
        d = date.fromisoformat(day)
    except ValueError:
        d = date.today()

    coeffs = pack.get("terms_date") or []
    current = "冬至"
    for term in reversed(coeffs):
        if d >= _term_start(d.year, term):
            current = term["name"]
            break

    term = next((t for t in pack["terms"] if t["name"] == current), None)
    colors = [c for c in pack["colors"] if c["term"] == current]
    if not term or not colors:
        return None

    coeff = next(t for t in coeffs if t["name"] == current)
    start = _term_start(d.year, coeff)
    if d < start:
        start = _term_start(d.year - 1, coeff)
    in_term = (d - start).days + 1
    color = colors[(in_term - 1) % len(colors)]

    r, g, b = (int(x) for x in color["rgb"].split(","))
    ink = "#1a1816" if (r * 299 + g * 587 + b * 114) / 1000 > 128 else "#f0ece4"
    return {
        "kind": "cncolor",
        "text": term["story"],
        "color": color["name"],
        "pinyin": color["pinyin"],
        "hex": color["hex"],
        "term": term["name"],
        "day_in_term": in_term,
        "ink": ink,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "SchedKit/0.3"

    def log_message(self, fmt: str, *args) -> None:  # 静默访问日志
        return

    # ---------- 响应工具 ----------
    def _json(self, status: int, payload) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("请求体不是合法 JSON")
        if not isinstance(data, dict):
            raise ValueError("请求体应为对象")
        return data

    def _guard(self, fn) -> None:
        try:
            fn()
        except ValueError as exc:
            self._json(400, {"error": str(exc)})
        except LookupError as exc:
            self._json(404, {"error": str(exc)})
        except Exception as exc:  # 兜底，避免连接悬挂
            self._json(500, {"error": f"服务内部错误：{exc}"})

    # ---------- 路由 ----------
    def do_GET(self) -> None:
        self._guard(self._get)

    def do_POST(self) -> None:
        self._guard(self._post)

    def do_PATCH(self) -> None:
        self._guard(self._patch)

    def do_DELETE(self) -> None:
        self._guard(self._delete)

    def _get(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/events":
            qs = parse_qs(parsed.query)
            items = events.list_events(
                (qs.get("from") or [None])[0],
                (qs.get("to") or [None])[0],
                (qs.get("q") or [None])[0],
            )
            self._json(200, {"events": items})
            return
        if path == "/api/config":
            self._json(200, {"config": config.load()})
            return
        if path == "/api/meta":
            self._json(200, self._meta())
            return
        if path == "/api/autostart":
            self._json(200, {"enabled": autostart.enabled()})
            return
        if path == "/api/daily-color":
            qs = parse_qs(parsed.query)
            day = (qs.get("date") or [""])[0] or date.today().isoformat()
            self._json(200, _cncolor_for(day) or {})
            return
        if path == "/api/pending":
            self._json(200, {"pending": mails.list_pending()})
            return
        if path == "/api/sync":
            self._json(200, sync.status())
            return
        if path == "/api/events/stream":
            self._stream()
            return
        self._static(path)

    def _post(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/events":
            item = events.create_event(self._body())
            HUB.publish()
            self._json(201, {"event": item})
            return
        if path == "/api/autostart":
            wanted = bool(self._body().get("enabled"))
            autostart.enable() if wanted else autostart.disable()
            self._json(200, {"enabled": autostart.enabled()})
            return
        if path == "/api/sync":
            sync.start_async()
            self._json(202, sync.status())
            return
        if path == "/api/pending/accept-all":
            self._pending_all("accept")
            return
        if path == "/api/pending/skip-all":
            self._pending_all("skip")
            return
        match = PENDING_ID.match(path)
        if match:
            self._pending(match.group(1), match.group(2))
            return
        self._json(404, {"error": "接口不存在"})

    def _pending(self, pending_id: str, action: str) -> None:
        item = mails.get_pending(pending_id)
        if not item or item.get("status") != "open":
            raise LookupError("这条待确认不存在或已处理")
        if action == "skip":
            mails.resolve_pending(pending_id, "skipped")
            HUB.publish()
            self._json(200, {"ok": True})
            return
        created = self._accept_pending(item)
        HUB.publish()
        self._json(201, {"event": created})

    def _pending_all(self, action: str) -> None:
        items = mails.list_pending()
        done, failed = 0, 0
        for item in items:
            try:
                if action == "skip":
                    mails.resolve_pending(item["id"], "skipped")
                else:
                    self._accept_pending(item)
                done += 1
            except Exception:
                failed += 1
        HUB.publish()
        self._json(200, {"ok": True, "done": done, "failed": failed})

    def _accept_pending(self, item: dict) -> dict:
        draft = (item.get("payload") or {}).get("event")
        if not draft:
            raise ValueError("这条没有可采纳的日程，请忽略后手动新建")
        draft = dict(draft)
        draft["source"] = "mail"
        draft["source_ref"] = str(item.get("mail_id") or "")
        created = events.create_or_merge(draft)
        if item.get("mail_id"):
            mails.link_event(created["id"], int(item["mail_id"]), "create")
            mails.set_verdict(int(item["mail_id"]), "recruitment", created["id"])
        mails.resolve_pending(item["id"], "done")
        return created

    def _patch(self) -> None:
        path = urlparse(self.path).path
        match = EVENT_ID.match(path)
        if match:
            item = events.update_event(match.group(1), self._body())
            HUB.publish()
            self._json(200, {"event": item})
            return
        if path == "/api/config":
            self._json(200, {"config": config.update(self._body())})
            return
        self._json(404, {"error": "接口不存在"})

    def _delete(self) -> None:
        match = EVENT_ID.match(urlparse(self.path).path)
        if not match:
            self._json(404, {"error": "接口不存在"})
            return
        ok = events.delete_event(match.group(1))
        if not ok:
            raise LookupError("事件不存在")
        HUB.publish()
        self._json(200, {"ok": True})

    def _meta(self) -> dict:
        with db.db() as conn:
            pending = conn.execute(
                "SELECT COUNT(*) AS n FROM pending WHERE status = 'open'"
            ).fetchone()["n"]
        return {"pending": pending}

    def _stream(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        q = HUB.subscribe()
        try:
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            while True:
                try:
                    q.get(timeout=20)
                    payload = b"event: changed\ndata: {}\n\n"
                except queue.Empty:
                    payload = b": ping\n\n"
                self.wfile.write(payload)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            HUB.unsubscribe(q)

    def _static(self, path: str) -> None:
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        target = (ROOT / rel).resolve()
        if not str(target).startswith(str(ROOT)) or not target.is_file():
            self.send_response(404)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write("404".encode("utf-8"))
            return
        data = target.read_bytes()
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


class _Server(ThreadingHTTPServer):
    """浏览器断开 SSE 时不要把连接重置当异常打出来。"""

    daemon_threads = True

    def handle_error(self, request, client_address) -> None:
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionAbortedError, ConnectionResetError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


class ApiServer:
    def __init__(self, port: int = 0) -> None:
        self.httpd = _Server(("127.0.0.1", port), Handler)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        self._thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    @property
    def origin(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()