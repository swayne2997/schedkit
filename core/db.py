"""SQLite 连接与表结构。"""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "scheduler.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS event (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'other',
  company TEXT NOT NULL,
  position TEXT NOT NULL DEFAULT '',
  round TEXT NOT NULL DEFAULT '',
  start_date TEXT,
  start_time TEXT,
  end_date TEXT,
  end_time TEXT,
  mode TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  deadline TEXT,
  status TEXT NOT NULL DEFAULT 'normal',
  source TEXT NOT NULL DEFAULT 'manual',
  source_ref TEXT,
  note TEXT NOT NULL DEFAULT '',
  extra TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_start ON event(start_date, start_time);
CREATE INDEX IF NOT EXISTS idx_event_status ON event(status);

CREATE TABLE IF NOT EXISTS mail (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid INTEGER NOT NULL,
  mailbox TEXT NOT NULL,
  message_id TEXT,
  subject TEXT NOT NULL DEFAULT '',
  from_addr TEXT NOT NULL DEFAULT '',
  received_at TEXT,
  body TEXT NOT NULL DEFAULT '',
  digest TEXT NOT NULL DEFAULT '',
  verdict TEXT NOT NULL DEFAULT '',
  event_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (mailbox, uid)
);
CREATE INDEX IF NOT EXISTS idx_mail_message ON mail(message_id);

CREATE TABLE IF NOT EXISTS event_mail (
  event_id TEXT NOT NULL,
  mail_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'update',
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_id, mail_id)
);

CREATE TABLE IF NOT EXISTS pending (
  id TEXT PRIMARY KEY,
  mail_id INTEGER,
  payload TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_cursor (
  mailbox TEXT PRIMARY KEY,
  uidvalidity INTEGER NOT NULL DEFAULT 0,
  last_uid INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
"""


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=8)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def db():
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init() -> None:
    with db() as conn:
        conn.executescript(SCHEMA)
        _migrate(conn)


def _migrate(conn: sqlite3.Connection) -> None:
    """已有库补列，避免旧表缺字段。"""
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(mail)")}
    if "body" not in columns:
        conn.execute("ALTER TABLE mail ADD COLUMN body TEXT NOT NULL DEFAULT ''")
    event_cols = {row["name"] for row in conn.execute("PRAGMA table_info(event)")}
    if "location" not in event_cols:
        conn.execute("ALTER TABLE event ADD COLUMN location TEXT NOT NULL DEFAULT ''")