from __future__ import annotations

import hashlib
import io
import json
import os
import platform
import shutil
import sys
import traceback
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from importlib.metadata import PackageNotFoundError, version
from typing import Any

from .database import Database, utc_now
from .security import redact_data, redact_text


LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")
CATEGORIES = (
    "application",
    "http",
    "frontend",
    "import",
    "voucher",
    "connector",
    "background_job",
    "storage",
    "backup",
    "security",
    "environment",
    "update",
    "launcher",
)


def app_version() -> str:
    embedded = os.environ.get("AUTO_VOUCHER_CORE_VERSION", "").strip()
    if embedded:
        return embedded
    try:
        return version("auto-voucher")
    except PackageNotFoundError:
        return "0.2.0-dev"


class DiagnosticLogger:
    def __init__(self, database: Database) -> None:
        self.database = database
        self._writes_since_prune = 0

    def log(
        self,
        level: str,
        category: str,
        event_code: str,
        message: str,
        *,
        user_action: str = "",
        correlation_id: str = "",
        operation: str = "",
        subject_type: str = "",
        subject_id: str = "",
        context: Any = None,
        error: Any = None,
        duration_ms: int | None = None,
        source: str = "backend",
    ) -> dict[str, Any]:
        normalized_level = level.upper()
        if normalized_level not in LEVELS:
            normalized_level = "INFO"
        normalized_category = category if category in CATEGORIES else "application"
        entry = {
            "id": f"DLOG-{uuid.uuid4().hex[:16].upper()}",
            "occurredAt": utc_now(),
            "level": normalized_level,
            "category": normalized_category,
            "eventCode": redact_text(event_code)[:100],
            "message": redact_text(message)[:2000],
            "userAction": redact_text(user_action)[:2000],
            "correlationId": redact_text(correlation_id)[:160],
            "operation": redact_text(operation)[:200],
            "subjectType": redact_text(subject_type)[:100],
            "subjectId": redact_text(subject_id)[:200],
            "context": redact_data(context or {}),
            "error": redact_data(error or {}),
            "durationMs": int(duration_ms) if duration_ms is not None else None,
            "source": source if source in {"backend", "frontend"} else "backend",
            "appVersion": app_version(),
        }
        with self.database.connect() as connection:
            connection.execute(
                """
                INSERT INTO diagnostic_log(
                    id, occurred_at, level, category, event_code, message,
                    user_action, correlation_id, operation, subject_type,
                    subject_id, context_json, error_json, duration_ms, source,
                    app_version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    entry["id"],
                    entry["occurredAt"],
                    entry["level"],
                    entry["category"],
                    entry["eventCode"],
                    entry["message"],
                    entry["userAction"],
                    entry["correlationId"],
                    entry["operation"],
                    entry["subjectType"],
                    entry["subjectId"],
                    json.dumps(entry["context"], ensure_ascii=False, separators=(",", ":")),
                    json.dumps(entry["error"], ensure_ascii=False, separators=(",", ":")),
                    entry["durationMs"],
                    entry["source"],
                    entry["appVersion"],
                ),
            )
        self._writes_since_prune += 1
        if self._writes_since_prune >= 100:
            self.prune()
            self._writes_since_prune = 0
        return entry

    def exception(
        self,
        category: str,
        event_code: str,
        message: str,
        exc: BaseException,
        **kwargs: Any,
    ) -> dict[str, Any]:
        error = {
            "type": exc.__class__.__name__,
            "message": str(exc),
            "traceback": "".join(traceback.format_exception(exc))[-12000:],
        }
        return self.log(
            "ERROR",
            category,
            event_code,
            message,
            error=error,
            **kwargs,
        )

    def query(
        self,
        *,
        level: str = "",
        category: str = "",
        search: str = "",
        correlation_id: str = "",
        date_from: str = "",
        date_to: str = "",
        limit: int = 200,
        offset: int = 0,
    ) -> dict[str, Any]:
        clauses: list[str] = []
        values: list[Any] = []
        if level.upper() in LEVELS:
            clauses.append("level = ?")
            values.append(level.upper())
        if category in CATEGORIES:
            clauses.append("category = ?")
            values.append(category)
        if correlation_id:
            clauses.append("correlation_id = ?")
            values.append(correlation_id[:160])
        if date_from:
            clauses.append("occurred_at >= ?")
            values.append(date_from)
        if date_to:
            clauses.append("occurred_at <= ?")
            values.append(date_to)
        if search:
            clauses.append(
                "(message LIKE ? OR event_code LIKE ? OR user_action LIKE ? "
                "OR subject_id LIKE ? OR correlation_id LIKE ?)"
            )
            needle = f"%{search[:200]}%"
            values.extend([needle] * 5)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        bounded_limit = min(max(int(limit), 1), 1000)
        bounded_offset = max(int(offset), 0)
        with self.database.connect() as connection:
            total = connection.execute(
                f"SELECT COUNT(*) AS count FROM diagnostic_log {where}",
                values,
            ).fetchone()["count"]
            rows = connection.execute(
                f"""
                SELECT * FROM diagnostic_log
                {where}
                ORDER BY occurred_at DESC
                LIMIT ? OFFSET ?
                """,
                [*values, bounded_limit, bounded_offset],
            ).fetchall()
        return {
            "items": [self._row(row) for row in rows],
            "total": total,
            "limit": bounded_limit,
            "offset": bounded_offset,
            "filters": {
                "levels": list(LEVELS),
                "categories": list(CATEGORIES),
            },
        }

    def summary(self, hours: int = 24) -> dict[str, Any]:
        safe_hours = min(max(int(hours), 1), 24 * 90)
        since = (datetime.now(timezone.utc) - timedelta(hours=safe_hours)).isoformat()
        with self.database.connect() as connection:
            total = connection.execute(
                "SELECT COUNT(*) AS count FROM diagnostic_log WHERE occurred_at >= ?",
                (since,),
            ).fetchone()["count"]
            by_level = {
                row["level"]: row["count"]
                for row in connection.execute(
                    """
                    SELECT level, COUNT(*) AS count
                    FROM diagnostic_log WHERE occurred_at >= ?
                    GROUP BY level
                    """,
                    (since,),
                )
            }
            by_category = {
                row["category"]: row["count"]
                for row in connection.execute(
                    """
                    SELECT category, COUNT(*) AS count
                    FROM diagnostic_log WHERE occurred_at >= ?
                    GROUP BY category
                    """,
                    (since,),
                )
            }
            latest_error = connection.execute(
                """
                SELECT * FROM diagnostic_log
                WHERE occurred_at >= ? AND level IN ('ERROR', 'CRITICAL')
                ORDER BY occurred_at DESC LIMIT 1
                """,
                (since,),
            ).fetchone()
        return {
            "hours": safe_hours,
            "total": total,
            "byLevel": by_level,
            "byCategory": by_category,
            "latestError": self._row(latest_error) if latest_error else None,
            "settings": self.get_settings(),
        }

    def get_settings(self) -> dict[str, int]:
        with self.database.connect() as connection:
            values = {
                row["key"]: row["value"]
                for row in connection.execute(
                    "SELECT key, value FROM diagnostic_settings"
                )
            }
        return {
            "retentionDays": int(values.get("retention_days", 30)),
            "maxEntries": int(values.get("max_entries", 50_000)),
        }

    def update_settings(self, retention_days: int, max_entries: int) -> dict[str, int]:
        safe_days = min(max(int(retention_days), 7), 365)
        safe_entries = min(max(int(max_entries), 5_000), 500_000)
        with self.database.connect() as connection:
            for key, value in (
                ("retention_days", safe_days),
                ("max_entries", safe_entries),
            ):
                connection.execute(
                    """
                    INSERT INTO diagnostic_settings(key, value, updated_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET
                        value = excluded.value,
                        updated_at = excluded.updated_at
                    """,
                    (key, str(value), utc_now()),
                )
        self.prune()
        return self.get_settings()

    def prune(self) -> dict[str, int]:
        settings = self.get_settings()
        cutoff = (
            datetime.now(timezone.utc)
            - timedelta(days=settings["retentionDays"])
        ).isoformat()
        with self.database.connect() as connection:
            expired = connection.execute(
                "DELETE FROM diagnostic_log WHERE occurred_at < ?",
                (cutoff,),
            ).rowcount
            overflow = connection.execute(
                """
                DELETE FROM diagnostic_log
                WHERE id IN (
                    SELECT id FROM diagnostic_log
                    ORDER BY occurred_at DESC
                    LIMIT -1 OFFSET ?
                )
                """,
                (settings["maxEntries"],),
            ).rowcount
        return {"expired": max(expired, 0), "overflow": max(overflow, 0)}

    def copy_summary(
        self,
        *,
        environment: dict[str, Any],
        update: dict[str, Any],
        runtime: dict[str, Any],
    ) -> dict[str, str]:
        support_code = f"SUP-{datetime.now().strftime('%Y%m%d')}-{uuid.uuid4().hex[:6].upper()}"
        recent = self.query(
            level="ERROR",
            date_from=(datetime.now(timezone.utc) - timedelta(hours=24)).isoformat(),
            limit=5,
        )["items"]
        failed_checks = [
            item for item in environment.get("checks", [])
            if item.get("status") != "passed"
        ]
        lines = [
            "Auto Voucher 问题信息",
            f"支持编号：{support_code}",
            f"生成时间：{utc_now()}",
            f"程序版本：{app_version()}",
            f"启动器版本：{runtime.get('launcherVersion') or '未连接'}",
            "按需组件："
            + (
                "、".join(
                    f"{name} {component_version}"
                    for name, component_version in (update.get("components") or {}).items()
                )
                or "尚未通过启动器安装"
            ),
            f"系统：{platform.system()} {platform.release()} {platform.machine()}",
            f"本地服务：{'运行中' if runtime.get('serviceHealthy') else '异常'}",
            f"数据库状态：{runtime.get('databaseStatus') or '未知'}",
            f"环境检测：{environment.get('overallStatus') or '未检测'}",
            f"最近更新：{update.get('status') or '未连接启动器'}",
        ]
        if failed_checks:
            lines.append("需要处理的环境问题：")
            lines.extend(
                f"- {item.get('name')}：{item.get('action')}"
                for item in failed_checks[:8]
            )
        if recent:
            lines.append("最近错误：")
            lines.extend(
                f"- {item.get('eventCode')}：{item.get('message')}"
                + (f"（{item.get('correlationId')}）" if item.get("correlationId") else "")
                for item in recent
            )
        lines.append("说明：以上信息已脱敏，不包含票据、凭证分录、数据库或密钥。")
        text = redact_text("\n".join(lines))
        self.log(
            "INFO",
            "application",
            "DIAGNOSTIC_SUMMARY_COPIED",
            "已生成一键诊断摘要",
            correlation_id=support_code,
            context={"environment": environment.get("overallStatus"), "update": update.get("status")},
        )
        return {"supportCode": support_code, "text": text}

    def export_zip(
        self,
        state: dict[str, Any] | None,
        days: int = 7,
        runtime_bundle: dict[str, Any] | None = None,
    ) -> tuple[bytes, str]:
        safe_days = min(max(int(days), 1), 90)
        support_code = f"AV-{datetime.now().strftime('%Y%m%d')}-{uuid.uuid4().hex[:6].upper()}"
        date_from = (
            datetime.now(timezone.utc) - timedelta(days=safe_days)
        ).isoformat()
        logs = self.query(date_from=date_from, limit=1000)["items"]
        offset = 1000
        while len(logs) < 50_000:
            page = self.query(date_from=date_from, limit=1000, offset=offset)["items"]
            if not page:
                break
            logs.extend(page)
            offset += len(page)
        state = state or {}
        connectors = [
            {
                "id": item.get("id"),
                "name": item.get("name"),
                "adapter": item.get("adapter"),
                "environment": item.get("environment"),
                "status": item.get("status"),
                "capabilities": item.get("capabilities", []),
                "lastCheckedAt": item.get("lastCheckedAt"),
                "lastSyncAt": item.get("lastSyncAt"),
            }
            for item in state.get("connectors", [])
        ]
        disk = shutil.disk_usage(self.database.data_dir)
        environment = redact_data({
            "supportCode": support_code,
            "createdAt": utc_now(),
            "appVersion": app_version(),
            "platform": platform.system(),
            "platformRelease": platform.release(),
            "architecture": platform.machine(),
            "python": platform.python_version(),
            "frozen": bool(getattr(sys, "frozen", False)),
            "databaseBytes": self.database.db_path.stat().st_size if self.database.db_path.exists() else 0,
            "diskFreeBytes": disk.free,
            "retention": self.get_settings(),
        })
        state_summary = redact_data({
            "version": state.get("version"),
            "environment": state.get("environment"),
            "counts": {
                "sourceDocuments": len(state.get("sourceDocuments", [])),
                "events": len(state.get("events", [])),
                "vouchers": len(state.get("vouchers", [])),
                "exceptions": len(state.get("exceptions", [])),
                "rules": len(state.get("rules", [])),
                "auditEvents": len(state.get("auditLog", [])),
            },
            "connectors": connectors,
        })
        summary = (
            "Auto Voucher 脱敏诊断包\n"
            f"支持编号：{support_code}\n"
            f"生成时间：{environment['createdAt']}\n"
            f"日志范围：最近 {safe_days} 天\n"
            f"日志条数：{len(logs)}\n\n"
            "安全说明：本诊断包不包含原始票据、凭证分录、完整账号、密钥、令牌或数据库文件。\n"
            "发送给技术支持前，仍建议由财务人员检查包内 summary.json 和 logs.jsonl。\n"
        ).encode("utf-8")
        members = {
            "README.txt": summary,
            "environment.json": json.dumps(environment, ensure_ascii=False, indent=2).encode("utf-8"),
            "state-summary.json": json.dumps(state_summary, ensure_ascii=False, indent=2).encode("utf-8"),
            "logs.jsonl": (
                "\n".join(json.dumps(item, ensure_ascii=False) for item in logs) + "\n"
            ).encode("utf-8"),
        }
        if runtime_bundle:
            members["runtime-summary.json"] = json.dumps(
                redact_data(runtime_bundle),
                ensure_ascii=False,
                indent=2,
            ).encode("utf-8")
        manifest = {
            "kind": "auto-voucher-diagnostics",
            "version": 1,
            "supportCode": support_code,
            "createdAt": utc_now(),
            "files": {
                name: {
                    "sha256": hashlib.sha256(content).hexdigest(),
                    "size": len(content),
                }
                for name, content in members.items()
            },
        }
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(
                "manifest.json",
                json.dumps(manifest, ensure_ascii=False, indent=2),
            )
            for name, content in members.items():
                archive.writestr(name, content)
        self.log(
            "INFO",
            "application",
            "DIAGNOSTIC_EXPORT_CREATED",
            "已生成脱敏诊断包",
            user_action="可将支持编号和诊断包发送给技术支持",
            correlation_id=support_code,
            context={"days": safe_days, "entries": len(logs)},
        )
        return output.getvalue(), support_code

    @staticmethod
    def _row(row: Any) -> dict[str, Any]:
        return {
            "id": row["id"],
            "occurredAt": row["occurred_at"],
            "level": row["level"],
            "category": row["category"],
            "eventCode": row["event_code"],
            "message": row["message"],
            "userAction": row["user_action"],
            "correlationId": row["correlation_id"],
            "operation": row["operation"],
            "subjectType": row["subject_type"],
            "subjectId": row["subject_id"],
            "context": json.loads(row["context_json"] or "{}"),
            "error": json.loads(row["error_json"] or "{}"),
            "durationMs": row["duration_ms"],
            "source": row["source"],
            "appVersion": row["app_version"],
        }
