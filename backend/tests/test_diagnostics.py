import json
import tempfile
import unittest
import zipfile
from io import BytesIO
from pathlib import Path

from auto_voucher.database import Database
from auto_voucher.diagnostics import DiagnosticLogger
from auto_voucher.security import redact_data


class DiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.database = Database(Path(self.temporary.name))
        self.logger = DiagnosticLogger(self.database)

    def tearDown(self):
        self.temporary.cleanup()

    def test_structured_log_is_redacted_and_searchable(self):
        entry = self.logger.log(
            "ERROR",
            "connector",
            "KINGDEE_LOGIN_FAILED",
            "password=plain-secret，账号 6222021234567890123",
            user_action="检查权限",
            correlation_id="REQ-001",
            context={
                "username": "finance@example.com",
                "access_token": "token-value",
                "nested": {"clientSecret": "secret-value"},
            },
        )
        result = self.logger.query(
            level="ERROR",
            category="connector",
            search="KINGDEE",
        )
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["items"][0]["id"], entry["id"])
        serialized = json.dumps(result, ensure_ascii=False)
        self.assertNotIn("plain-secret", serialized)
        self.assertNotIn("token-value", serialized)
        self.assertNotIn("secret-value", serialized)
        self.assertNotIn("6222021234567890123", serialized)
        self.assertIn("[REDACTED]", serialized)

    def test_free_text_redaction_covers_actual_secret_names_and_authorization_schemes(self):
        sentinels = (
            "app-secret-sentinel",
            "private-key-sentinel",
            "basic-authorization-sentinel",
        )
        self.logger.exception(
            "connector",
            "CONNECTOR_SECRET_FAILURE",
            "app_secret=app-secret-sentinel",
            RuntimeError(
                "private_key=private-key-sentinel; "
                "Authorization: Basic basic-authorization-sentinel"
            ),
        )
        serialized = json.dumps(self.logger.query(search="CONNECTOR_SECRET_FAILURE"), ensure_ascii=False)
        for sentinel in sentinels:
            self.assertNotIn(sentinel, serialized)
        self.assertIn("[REDACTED]", serialized)

    def test_settings_are_bounded_and_prune_overflow(self):
        settings = self.logger.update_settings(1, 2)
        self.assertEqual(settings["retentionDays"], 7)
        self.assertEqual(settings["maxEntries"], 5_000)
        for index in range(3):
            self.logger.log(
                "INFO",
                "application",
                f"EVENT_{index}",
                f"事件 {index}",
            )
        self.assertEqual(self.logger.summary()["total"], 3)

    def test_diagnostic_package_excludes_business_payload_and_secrets(self):
        self.logger.log(
            "ERROR",
            "frontend",
            "UI_FAILURE",
            "access_token=should-not-leak",
            context={"password": "should-not-leak", "route": "vouchers"},
        )
        state = {
            "version": 1,
            "environment": "测试环境",
            "sourceDocuments": [{"name": "真实客户发票.pdf"}],
            "events": [{"counterparty": "真实客户名称"}],
            "vouchers": [{"lines": [{"summary": "敏感凭证摘要"}]}],
            "exceptions": [],
            "rules": [],
            "auditLog": [],
            "connectors": [{
                "id": "kingdee-k3cloud",
                "name": "金蝶云·星空",
                "adapter": "kingdee-k3cloud-webapi-v6",
                "environment": "测试环境",
                "status": "error",
                "username": "admin",
                "password": "should-not-leak",
            }],
        }
        content, support_code = self.logger.export_zip(state, 7)
        with zipfile.ZipFile(BytesIO(content)) as archive:
            names = set(archive.namelist())
            self.assertEqual(
                names,
                {
                    "manifest.json",
                    "README.txt",
                    "environment.json",
                    "state-summary.json",
                    "logs.jsonl",
                },
            )
            combined = b"\n".join(archive.read(name) for name in names).decode("utf-8")
        self.assertIn(support_code, combined)
        self.assertNotIn("should-not-leak", combined)
        self.assertNotIn("真实客户发票", combined)
        self.assertNotIn("真实客户名称", combined)
        self.assertNotIn("敏感凭证摘要", combined)
        self.assertNotIn('"username"', combined)

    def test_recursive_redaction_limits_depth_and_sensitive_keys(self):
        value = redact_data({
            "Authorization": "Bearer abc.def",
            "safe": {"email": "finance@example.com"},
        })
        self.assertEqual(value["Authorization"], "[REDACTED]")
        self.assertEqual(value["safe"]["email"], "f***@example.com")

    def test_copy_summary_is_plain_language_and_runtime_bundle_is_redacted(self):
        summary = self.logger.copy_summary(
            environment={
                "overallStatus": "degraded",
                "checks": [{
                    "status": "warning",
                    "name": "OCR 组件",
                    "action": "首次使用时安装。",
                }],
            },
            update={"status": "idle"},
            runtime={
                "launcherVersion": "0.2.0",
                "serviceHealthy": True,
                "databaseStatus": "ok",
            },
        )
        self.assertIn("支持编号", summary["text"])
        self.assertIn("首次使用时安装", summary["text"])
        self.assertNotIn("{", summary["text"])

        content, _ = self.logger.export_zip(
            {"version": 2},
            runtime_bundle={
                "launcher": {
                    "logs": [{
                        "message": "access_token=must-not-leak",
                        "context": {"password": "must-not-leak"},
                    }]
                }
            },
        )
        with zipfile.ZipFile(BytesIO(content)) as archive:
            runtime = archive.read("runtime-summary.json").decode("utf-8")
        self.assertNotIn("must-not-leak", runtime)
        self.assertIn("[REDACTED]", runtime)


if __name__ == "__main__":
    unittest.main()
