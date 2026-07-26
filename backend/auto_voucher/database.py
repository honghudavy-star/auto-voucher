from __future__ import annotations

import json
import os
import platform
import sqlite3
import tempfile
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


DATABASE_SCHEMA_VERSION = 2

MIGRATIONS: dict[int, tuple[str, ...]] = {
    1: (
        """
        CREATE TABLE IF NOT EXISTS app_state (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            revision INTEGER NOT NULL DEFAULT 1,
            state_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS source_files (
            sha256 TEXT PRIMARY KEY,
            original_name TEXT NOT NULL,
            media_type TEXT NOT NULL,
            byte_size INTEGER NOT NULL,
            archive_path TEXT NOT NULL,
            imported_at TEXT NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS operation_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT NOT NULL,
            subject TEXT NOT NULL,
            detail TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """,
    ),
    2: (
        """
        CREATE TABLE IF NOT EXISTS diagnostic_log (
            id TEXT PRIMARY KEY,
            occurred_at TEXT NOT NULL,
            level TEXT NOT NULL,
            category TEXT NOT NULL,
            event_code TEXT NOT NULL,
            message TEXT NOT NULL,
            user_action TEXT NOT NULL DEFAULT '',
            correlation_id TEXT NOT NULL DEFAULT '',
            operation TEXT NOT NULL DEFAULT '',
            subject_type TEXT NOT NULL DEFAULT '',
            subject_id TEXT NOT NULL DEFAULT '',
            context_json TEXT NOT NULL DEFAULT '{}',
            error_json TEXT NOT NULL DEFAULT '{}',
            duration_ms INTEGER,
            source TEXT NOT NULL DEFAULT 'backend',
            app_version TEXT NOT NULL DEFAULT ''
        )
        """,
        """
        CREATE INDEX IF NOT EXISTS idx_diagnostic_log_time
        ON diagnostic_log(occurred_at DESC)
        """,
        """
        CREATE INDEX IF NOT EXISTS idx_diagnostic_log_level_time
        ON diagnostic_log(level, occurred_at DESC)
        """,
        """
        CREATE INDEX IF NOT EXISTS idx_diagnostic_log_category_time
        ON diagnostic_log(category, occurred_at DESC)
        """,
        """
        CREATE INDEX IF NOT EXISTS idx_diagnostic_log_correlation
        ON diagnostic_log(correlation_id)
        """,
        """
        CREATE TABLE IF NOT EXISTS diagnostic_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """,
    ),
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def default_data_dir() -> Path:
    override = os.environ.get("AUTO_VOUCHER_DATA_DIR")
    if override:
        return Path(override).expanduser().resolve()
    if platform.system() == "Darwin":
        return Path.home() / "Library" / "Application Support" / "Auto Voucher"
    if platform.system() == "Windows":
        return Path(os.environ.get("LOCALAPPDATA", Path.home())) / "Auto Voucher"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "auto-voucher"


class Database:
    def __init__(self, data_dir: Path | None = None) -> None:
        self.data_dir = (data_dir or default_data_dir()).resolve()
        self.archive_dir = self.data_dir / "archive"
        self.db_path = self.data_dir / "auto-voucher.sqlite3"
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.archive_dir.mkdir(parents=True, exist_ok=True)
        self._migrate()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _migrate(self) -> None:
        connection = sqlite3.connect(self.db_path, isolation_level=None)
        try:
            connection.execute("PRAGMA foreign_keys = ON")
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS schema_meta (
                    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                    version INTEGER NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            row = connection.execute(
                "SELECT version FROM schema_meta WHERE singleton = 1"
            ).fetchone()
            current_version = int(row[0]) if row else 0
            if current_version > DATABASE_SCHEMA_VERSION:
                raise ValueError(
                    f"数据库版本 v{current_version} 高于当前程序支持的 "
                    f"v{DATABASE_SCHEMA_VERSION}"
                )
            for version in range(current_version + 1, DATABASE_SCHEMA_VERSION + 1):
                statements = MIGRATIONS.get(version)
                if not statements:
                    raise ValueError(f"缺少数据库迁移 v{version}")
                for statement in statements:
                    connection.execute(statement)
                connection.execute(
                    """
                    INSERT INTO schema_meta(singleton, version, updated_at)
                    VALUES (1, ?, ?)
                    ON CONFLICT(singleton) DO UPDATE SET
                        version = excluded.version,
                        updated_at = excluded.updated_at
                    """,
                    (version, utc_now()),
                )
            connection.execute(
                """
                INSERT OR IGNORE INTO diagnostic_settings(key, value, updated_at)
                VALUES ('retention_days', '30', ?)
                """,
                (utc_now(),),
            )
            connection.execute(
                """
                INSERT OR IGNORE INTO diagnostic_settings(key, value, updated_at)
                VALUES ('max_entries', '50000', ?)
                """,
                (utc_now(),),
            )
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def get_state(self) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT state_json FROM app_state WHERE singleton = 1"
            ).fetchone()
        return json.loads(row["state_json"]) if row else None

    def put_state(self, state: dict[str, Any]) -> dict[str, Any]:
        validate_state(state)
        with self.connect() as connection:
            current = connection.execute(
                "SELECT state_json FROM app_state WHERE singleton = 1"
            ).fetchone()
            if current:
                existing_state = json.loads(current["state_json"])
                assert_audit_log_append_only(
                    existing_state.get("auditLog", []),
                    state.get("auditLog", []),
                )
            state["lastSavedAt"] = utc_now()
            connection.execute(
                """
                INSERT INTO app_state(singleton, revision, state_json, updated_at)
                VALUES (1, 1, ?, ?)
                ON CONFLICT(singleton) DO UPDATE SET
                    revision = revision + 1,
                    state_json = excluded.state_json,
                    updated_at = excluded.updated_at
                """,
                (json.dumps(state, ensure_ascii=False, separators=(",", ":")), state["lastSavedAt"]),
            )
        return state

    def clear_state(self) -> None:
        with self.connect() as connection:
            connection.execute("DELETE FROM app_state")

    def clear_business_data(self) -> None:
        """Remove production business state and source indexes after a verified backup."""
        with self.connect() as connection:
            connection.execute("DELETE FROM app_state")
            connection.execute("DELETE FROM source_files")
            connection.execute("DELETE FROM operation_log")

    def backup_bytes(self) -> bytes:
        with tempfile.TemporaryDirectory(prefix="auto-voucher-db-backup-") as directory:
            target_path = Path(directory) / "auto-voucher.sqlite3"
            with self.connect() as source, closing(sqlite3.connect(target_path)) as target:
                source.backup(target)
            return target_path.read_bytes()

    def quick_check(self) -> str:
        with closing(sqlite3.connect(self.db_path)) as connection:
            row = connection.execute("PRAGMA quick_check").fetchone()
        return str(row[0] if row else "unknown")

    def database_size(self) -> int:
        return self.db_path.stat().st_size if self.db_path.exists() else 0

    def schema_version(self) -> int:
        with closing(sqlite3.connect(self.db_path)) as connection:
            row = connection.execute(
                "SELECT version FROM schema_meta WHERE singleton = 1"
            ).fetchone()
        return int(row[0]) if row else 0

    def has_source(self, digest: str) -> bool:
        with self.connect() as connection:
            return connection.execute(
                "SELECT 1 FROM source_files WHERE sha256 = ?", (digest,)
            ).fetchone() is not None

    def register_source(
        self,
        digest: str,
        original_name: str,
        media_type: str,
        byte_size: int,
        archive_path: Path,
    ) -> None:
        with self.connect() as connection:
            connection.execute(
                """
                INSERT OR IGNORE INTO source_files
                    (sha256, original_name, media_type, byte_size, archive_path, imported_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (digest, original_name, media_type, byte_size, str(archive_path), utc_now()),
            )


def validate_state(state: dict[str, Any]) -> None:
    required_lists = ("sourceDocuments", "events", "vouchers", "exceptions", "rules", "connectors", "auditLog")
    if not isinstance(state, dict) or not state.get("version"):
        raise ValueError("状态数据缺少版本号")
    for key in required_lists:
        if not isinstance(state.get(key), list):
            raise ValueError(f"状态数据字段 {key} 必须为数组")
    for voucher in state["vouchers"]:
        debit = sum(int(line.get("debitCents", 0)) for line in voucher.get("lines", []))
        credit = sum(int(line.get("creditCents", 0)) for line in voucher.get("lines", []))
        if debit != credit:
            raise ValueError(f"凭证 {voucher.get('number', voucher.get('id'))} 借贷不平")


def assert_audit_log_append_only(
    existing: list[dict[str, Any]],
    incoming: list[dict[str, Any]],
) -> None:
    existing_ids = [str(item.get("id") or "") for item in existing]
    incoming_ids = [str(item.get("id") or "") for item in incoming]
    if any(not item_id for item_id in incoming_ids) or len(incoming_ids) != len(set(incoming_ids)):
        raise ValueError("审计日志必须包含唯一且非空的记录编号")

    incoming_by_id = {str(item["id"]): item for item in incoming}
    for item in existing:
        item_id = str(item.get("id") or "")
        if item_id not in incoming_by_id or incoming_by_id[item_id] != item:
            raise ValueError("审计日志只允许追加，不能修改或删除已有记录")

    retained_order = [item_id for item_id in incoming_ids if item_id in set(existing_ids)]
    if retained_order != existing_ids:
        raise ValueError("审计日志只允许追加，不能重排已有记录")
