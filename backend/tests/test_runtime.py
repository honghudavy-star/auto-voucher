import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from auto_voucher.database import Database
from auto_voucher.runtime import EnvironmentService, LauncherClient, RuntimeStore
from auto_voucher.setup import empty_production_state


class FakeSecretStore:
    def __init__(self, available=True):
        self.available = available
        self.values = {}

    def status(self):
        return {
            "available": self.available,
            "backend": "FakeCredentialManager",
            "message": "可用" if self.available else "不可用",
        }

    def set(self, connector_id, secret_name, value):
        if not self.available:
            raise RuntimeError("不可用")
        self.values[(connector_id, secret_name)] = value

    def get(self, connector_id, secret_name):
        return self.values.get((connector_id, secret_name), "")

    def delete(self, connector_id, secret_name):
        self.values.pop((connector_id, secret_name), None)


class CleanupFailingSecretStore(FakeSecretStore):
    def delete(self, connector_id, secret_name):
        raise Exception("Windows 登录会话已终止")


class SetFailingSecretStore(FakeSecretStore):
    def set(self, connector_id, secret_name, value):
        raise Exception("Windows 登录会话不存在")


class RuntimeTests(unittest.TestCase):
    def make_service(self, directory, *, secrets=True):
        root = Path(directory)
        static = root / "dist"
        static.mkdir()
        (static / "index.html").write_text("<!doctype html>", encoding="utf-8")
        database = Database(root / "data")
        database.put_state(empty_production_state())
        return EnvironmentService(
            database,
            FakeSecretStore(secrets),
            static,
            "127.0.0.1",
            8766,
        )

    def test_environment_check_has_actionable_fixed_shape(self):
        with tempfile.TemporaryDirectory() as directory:
            service = self.make_service(directory)
            with (
                patch("auto_voucher.runtime.platform.system", return_value="Windows"),
                patch("auto_voucher.runtime.platform.release", return_value="11"),
                patch("auto_voucher.runtime.platform.machine", return_value="AMD64"),
                patch.object(service, "_browser_check", return_value=service._result(
                    "default-browser",
                    "默认浏览器",
                    "passed",
                    "Edge",
                    "可打开 Edge 或 Chrome",
                    "无需操作。",
                    blocking=False,
                )),
            ):
                result = service.check(include_network=False)
            self.assertIn(result["overallStatus"], {"ok", "degraded"})
            self.assertTrue(result["supportCode"].startswith("ENV-"))
            self.assertTrue(result["checks"])
            required_fields = {
                "id",
                "name",
                "status",
                "severity",
                "actual",
                "required",
                "blocking",
                "productionBlocking",
                "action",
            }
            self.assertTrue(required_fields.issubset(result["checks"][0]))
            repair_ids = {item["id"] for item in result["repairActions"]}
            self.assertNotIn("reinstall-ocr", repair_ids)
            self.assertNotIn("reinstall-pdf", repair_ids)

    def test_environment_check_accepts_workers_from_complete_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ocr_worker = root / "AutoVoucherOCR.exe"
            pdf_worker = root / "AutoVoucherPDF.exe"
            ocr_worker.write_bytes(b"ocr")
            pdf_worker.write_bytes(b"pdf")
            service = self.make_service(directory)

            def bundled_worker(_environment_name, executable_name):
                return str(root / executable_name)

            with (
                patch("auto_voucher.runtime.platform.system", return_value="Windows"),
                patch("auto_voucher.runtime.platform.release", return_value="11"),
                patch("auto_voucher.runtime.platform.machine", return_value="AMD64"),
                patch("auto_voucher.runtime.resolve_worker", side_effect=bundled_worker),
            ):
                result = service.check(include_network=False)

            checks = {item["id"]: item for item in result["checks"]}
            self.assertEqual(checks["component-ocr"]["status"], "passed")
            self.assertEqual(checks["component-pdf"]["status"], "passed")

    def test_macos_arm64_local_development_does_not_block_production(self):
        with tempfile.TemporaryDirectory() as directory:
            service = self.make_service(directory)
            browser_checks = [
                {"id": check_id, "status": "passed"}
                for check_id in (
                    "browser-fetch",
                    "browser-file",
                    "browser-blob",
                    "browser-crypto",
                    "browser-dom",
                )
            ]
            with (
                patch("auto_voucher.runtime.platform.system", return_value="Darwin"),
                patch("auto_voucher.runtime.platform.release", return_value="25.5.0"),
                patch("auto_voucher.runtime.platform.machine", return_value="arm64"),
            ):
                result = service.check(include_network=False, browser_checks=browser_checks)
                service.assert_production_ready()

            checks = {item["id"]: item for item in result["checks"]}
            self.assertEqual(checks["operating-system"]["status"], "passed")
            self.assertFalse(checks["operating-system"]["productionBlocking"])
            self.assertEqual(checks["architecture"]["status"], "passed")
            self.assertFalse(checks["architecture"]["productionBlocking"])

    def test_credential_manager_failure_degrades_but_blocks_production(self):
        with tempfile.TemporaryDirectory() as directory:
            service = self.make_service(directory, secrets=False)
            with (
                patch("auto_voucher.runtime.platform.system", return_value="Windows"),
                patch("auto_voucher.runtime.platform.release", return_value="11"),
                patch("auto_voucher.runtime.platform.machine", return_value="AMD64"),
            ):
                result = service.check(include_network=False)
            credential = next(item for item in result["checks"] if item["id"] == "credential-manager")
            self.assertFalse(credential["blocking"])
            self.assertTrue(credential["productionBlocking"])
            with self.assertRaisesRegex(ValueError, "Windows 凭据管理器"):
                service.assert_production_ready()

    def test_credential_manager_cleanup_failure_stays_degraded(self):
        with tempfile.TemporaryDirectory() as directory:
            service = self.make_service(directory)
            service.secret_store = CleanupFailingSecretStore(available=False)
            with patch("auto_voucher.runtime.platform.system", return_value="Windows"):
                result = service._keyring_check()
            self.assertEqual(result["status"], "warning")
            self.assertFalse(result["blocking"])
            self.assertTrue(result["productionBlocking"])

    def test_credential_manager_backend_exception_stays_degraded(self):
        with tempfile.TemporaryDirectory() as directory:
            service = self.make_service(directory)
            service.secret_store = SetFailingSecretStore(available=True)
            with patch("auto_voucher.runtime.platform.system", return_value="Windows"):
                result = service._keyring_check()
            self.assertEqual(result["status"], "warning")
            self.assertEqual(result["actual"], "Windows 登录会话不存在")
            self.assertFalse(result["blocking"])
            self.assertTrue(result["productionBlocking"])

    def test_macos_development_keyring_warning_does_not_block_file_workflows(self):
        with tempfile.TemporaryDirectory() as directory:
            service = self.make_service(directory, secrets=False)
            with patch("auto_voucher.runtime.platform.system", return_value="Darwin"):
                result = service._keyring_check()
            self.assertEqual(result["status"], "warning")
            self.assertEqual(result["name"], "系统密钥库")
            self.assertFalse(result["blocking"])
            self.assertFalse(result["productionBlocking"])
            self.assertIn("API 连接器无法配置", result["action"])

    def test_repair_whitelist_does_not_modify_database(self):
        with tempfile.TemporaryDirectory() as directory:
            service = self.make_service(directory)
            before = service.database.db_path.read_bytes()
            (service.cache_dir / "partial.download").write_bytes(b"partial")
            result = service.repair("clear-update-cache")
            self.assertTrue(result["ok"])
            self.assertEqual(service.database.db_path.read_bytes(), before)
            with self.assertRaisesRegex(ValueError, "不允许"):
                service.repair("delete-database")

    def test_critical_environment_fingerprint_change_invalidates_production(self):
        with tempfile.TemporaryDirectory() as directory:
            service = self.make_service(directory)
            state = service.database.get_state()
            state["productionActivation"] = {
                "enabled": True,
                "environmentValidation": {"productionFingerprint": "old"},
            }
            state["readiness"]["production"] = {
                "status": "ready",
                "validatedAt": "2026-07-25T00:00:00Z",
                "reasons": [],
            }
            service.database.put_state(state)
            with (
                patch("auto_voucher.runtime.platform.system", return_value="Windows"),
                patch("auto_voucher.runtime.platform.release", return_value="11"),
                patch("auto_voucher.runtime.platform.machine", return_value="AMD64"),
            ):
                service.check(include_network=False)
            updated = service.database.get_state()
            self.assertFalse(updated["productionActivation"]["enabled"])
            self.assertEqual(updated["readiness"]["production"]["status"], "not_ready")

    def test_launcher_client_is_explicitly_unavailable_in_development(self):
        with tempfile.TemporaryDirectory() as directory:
            client = LauncherClient(RuntimeStore(Path(directory)))
            status = client.status()
            self.assertFalse(status["available"])
            self.assertEqual(status["status"], "launcher_unavailable")
            with self.assertRaisesRegex(ValueError, "未连接 Docker 更新控制"):
                client.command("check")

    def test_development_without_update_manifest_has_no_user_warning(self):
        with tempfile.TemporaryDirectory() as directory:
            service = self.make_service(directory)
            with patch.dict(os.environ, {"AUTO_VOUCHER_UPDATE_MANIFEST_URL": ""}):
                self.assertEqual(service._network_checks(include_network=True), [])

    def test_launcher_client_rejects_removed_component_cleanup_command(self):
        with tempfile.TemporaryDirectory() as directory:
            client = LauncherClient(RuntimeStore(Path(directory)))
            client.endpoint = "http://127.0.0.1:8765"
            client.token = "test-token"
            with self.assertRaisesRegex(ValueError, "不允许执行"):
                client.command("cleanup")


if __name__ == "__main__":
    unittest.main()
