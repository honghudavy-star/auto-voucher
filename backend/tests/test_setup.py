from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from auto_voucher.database import Database
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

    def test_plan_is_deterministic_and_creates_only_selected_real_connectors(self):
        result = self.service.plan({
            "enterprise": {
                "name": "客户集团",
                "legalEntity": "客户主体",
                "accountSet": "正式账套",
                "ledger": "总账",
                "accountingStandard": "企业会计准则",
                "baseCurrency": "CNY",
                "voucherType": "记",
                "operator": "财务测试员",
            },
            "targetSystemId": "yonyou-u8",
            "targetVersion": "V13",
            "deployment": "客户本地部署",
            "sourceSystemIds": ["feishu-approval", "local-files"],
            "businessScenarios": ["费用报销", "采购付款"],
        })
        state = result["state"]
        self.assertEqual(state["flowPlan"]["catalogVersion"], "2026.07.1")
        self.assertEqual([step["order"] for step in state["flowPlan"]["steps"]], list(range(1, 8)))
        self.assertEqual({item["id"] for item in state["connectors"]}, {"yonyou-u8", "feishu-approval"})
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
            "enterprise": {
                "name": "客户集团",
                "legalEntity": "客户主体",
                "accountSet": "测试账套",
                "ledger": "总账",
                "accountingStandard": "企业会计准则",
                "baseCurrency": "CNY",
                "voucherType": "记",
                "operator": "财务测试员",
            },
            "targetSystemId": "kingdee-k3cloud",
            "sourceSystemIds": ["local-files"],
            "businessScenarios": ["采购付款"],
        })
        report = self.service.preflight()
        reasons = report["gates"]["systems"]["reasons"]
        self.assertIn("尚未在测试账套保存凭证草稿", reasons)
        self.assertIn("尚未取得财务负责人确认", reasons)
        self.assertFalse(report["ok"])


if __name__ == "__main__":
    unittest.main()
