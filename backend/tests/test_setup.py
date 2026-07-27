from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from auto_voucher.database import Database
from auto_voucher.defaults import initialize_default_accounts, restore_default_accounts
from auto_voucher.setup import SetupService, empty_production_state


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.database = Database(Path(self.temporary.name))
        self.database.put_state(empty_production_state())
        self.service = SetupService(self.database)

    def tearDown(self):
        self.temporary.cleanup()

    def test_new_production_state_contains_no_demo_records(self):
        state = self.database.get_state()
        self.assertEqual(state["version"], 2)
        for key in ("enterpriseProfiles", "sourceDocuments", "events", "vouchers", "exceptions", "rules", "connectors", "auditLog"):
            self.assertEqual(state[key], [])
        self.assertEqual(state["company"], "")
        self.assertEqual(state["ledger"], "")
        self.assertFalse(state["productionActivation"]["enabled"])
        accounts = [item for item in state["masterData"] if item["category"] == "account" and item["active"]]
        self.assertEqual(len(accounts), 66)
        self.assertEqual(
            next(item for item in accounts if item["code"] == "1002")["name"],
            "银行存款",
        )
        self.assertEqual(state["defaultAccountSource"]["documentNumber"], "财会〔2011〕17号")

    def test_existing_custom_accounts_are_not_overwritten_during_initialization(self):
        state = empty_production_state()
        state["masterData"] = [{
            "id": "CUSTOM-1",
            "category": "account",
            "code": "1002",
            "name": "自定义银行存款",
            "active": True,
        }]
        state.pop("defaultAccountsInitialized")
        self.assertTrue(initialize_default_accounts(state))
        active = [item for item in state["masterData"] if item.get("active", True)]
        self.assertEqual([item["name"] for item in active], ["自定义银行存款"])

    def test_restore_default_accounts_preserves_history(self):
        state = empty_production_state()
        current = next(item for item in state["masterData"] if item["code"] == "1002")
        current["name"] = "客户银行科目"
        count = restore_default_accounts(state, "2026-07-26T00:00:00Z")
        active = [
            item for item in state["masterData"]
            if item["category"] == "account" and item.get("active", True)
        ]
        self.assertEqual(count, 66)
        self.assertEqual(len(active), 66)
        self.assertEqual(next(item for item in active if item["code"] == "1002")["name"], "银行存款")
        self.assertFalse(current["active"])

    def test_plan_is_deterministic_and_creates_only_selected_real_connectors(self):
        result = self.service.plan({
            "targetSystemId": "yonyou-u8",
            "sourceSystemIds": ["wecom-oa-json", "local-files"],
        })
        state = result["state"]
        self.assertEqual(state["flowPlan"]["catalogVersion"], "2026.07.1")
        self.assertEqual([step["order"] for step in state["flowPlan"]["steps"]], list(range(1, 8)))
        self.assertEqual({item["id"] for item in state["connectors"]}, {"yonyou-u8", "wecom-oa-json"})
        self.assertEqual(state["activeWorkflowConnectorId"], "wecom-oa-json")
        self.assertEqual(
            next(item for item in state["connectors"] if item["id"] == "wecom-oa-json")["providerName"],
            "企业微信",
        )
        self.assertEqual(state["enterpriseProfiles"], [])
        self.assertNotIn("selectedVersion", state["targetSystem"])
        self.assertNotIn("deployment", state["targetSystem"])
        self.assertNotIn("businessScenarios", state)
        self.assertNotIn("demo-finance", {item["id"] for item in state["connectors"]})
        self.assertEqual(state["readiness"]["plan"]["status"], "ready")

    def test_blank_template_can_be_profiled_and_missing_columns_are_actionable(self):
        preview = self.service.preview_template(
            "U8空白模板.csv",
            "\ufeff凭证日期,凭证字,摘要,科目编码,借方,贷方\n".encode(),
            "yonyou-u8",
        )
        self.assertEqual(preview["rowCount"], 0)
        self.assertIn("科目编码", preview["headers"])
        result = self.service.validate_template({
            "name": "U8 凭证模板",
            "targetSystemId": "yonyou-u8",
            "version": "V13",
            "headers": preview["headers"],
            "headerFingerprint": preview["headerFingerprint"],
            "requiredColumns": ["凭证日期", "科目编码", "辅助核算"],
        })
        self.assertFalse(result["ok"])
        self.assertIn("缺少必填列：辅助核算", result["errors"])

    def test_preflight_requires_real_launch_evidence(self):
        self.service.plan({
            "targetSystemId": "kingdee-k3cloud",
            "sourceSystemIds": ["local-files"],
        })
        report = self.service.preflight()
        reasons = report["gates"]["systems"]["reasons"]
        self.assertIn("尚未在测试账套保存凭证草稿", reasons)
        self.assertIn("尚未取得财务负责人确认", reasons)
        self.assertFalse(report["ok"])


if __name__ == "__main__":
    unittest.main()
