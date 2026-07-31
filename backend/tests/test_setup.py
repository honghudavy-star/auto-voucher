from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from auto_voucher.database import Database
from auto_voucher.defaults import initialize_default_accounts, restore_default_accounts
from auto_voucher.setup import (
    SetupService,
    connector_template,
    empty_production_state,
    ensure_state_v2,
)


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
        for key in (
            "enterpriseProfiles",
            "sourceDocuments",
            "events",
            "vouchers",
            "exceptions",
            "rules",
            "connectors",
            "approvalProcessingRules",
            "auditLog",
        ):
            self.assertEqual(state[key], [])
        self.assertEqual(state["approvalProcessingConfirmations"], {})
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

    def test_kingdee_template_uses_finweb_app_id_secret_configuration(self):
        connector = connector_template("kingdee-k3cloud")
        self.assertEqual(connector["authMode"], "app-id-secret-v3")
        self.assertEqual(connector["serverUrl"], "")
        self.assertEqual(connector["acctId"], "")
        self.assertEqual(connector["appId"], "")
        self.assertEqual(connector["orgNum"], "80016")
        self.assertEqual(connector["voucherFormId"], "GL_VOUCHER")
        self.assertEqual(connector["voucherGroup"], "PZZ47")
        self.assertNotIn("baseUrl", connector)
        self.assertNotIn("accountId", connector)
        self.assertIn(
            "FIN_OTHERS",
            {item["formId"] for item in connector["masterDataQueries"]},
        )
        queries = {item["category"]: item for item in connector["masterDataQueries"]}
        for category in (
            "account",
            "customer",
            "supplier",
            "department",
            "employee",
            "project",
            "assistantData",
            "dimensionDefinition",
            "accountDimension",
            "dimensionValue",
            "exchangeRate",
        ):
            self.assertIn(category, queries)
        self.assertEqual(queries["exchangeRate"]["formId"], "BD_Rate")
        self.assertIn("FExchangeRate", queries["exchangeRate"]["fields"])
        self.assertEqual(queries["assistantData"]["idFields"], ["FId", "FNumber"])
        self.assertIn("FFlex6.FNumber", queries["dimensionValue"]["fields"])
        self.assertIn(
            "dimensionNewProject",
            {item["category"] for item in queries["dimensionValue"]["dimensionMappings"]},
        )

    def test_visible_feishu_source_uses_dedicated_two_stage_configuration(self):
        connector = connector_template("feishu-oa-json")
        self.assertEqual(connector["name"], "飞书 / Lark 审批")
        self.assertEqual(connector["adapter"], "feishu-approval-v4")
        self.assertEqual(connector["platform"], "feishu")
        self.assertEqual(connector["baseUrl"], "https://open.feishu.cn")
        self.assertEqual(connector["appId"], "")
        self.assertEqual(connector["approvalCode"], "")
        self.assertEqual(connector["approvalFields"], [])
        self.assertEqual(connector["fieldMapping"], {})
        self.assertEqual(connector["fieldSources"], [])
        self.assertEqual(connector["additionalApprovalFieldIds"], [])

    def test_legacy_visible_feishu_generic_config_migrates_without_copying_secrets(self):
        state = empty_production_state()
        state["connectors"] = [{
            "id": "feishu-oa-json",
            "name": "飞书 审批 API（JSON）",
            "adapter": "oa-json-api",
            "baseUrl": "https://open.larksuite.com",
            "environment": "测试环境",
            "status": "connected",
            "providerName": "飞书",
        }]
        self.assertTrue(ensure_state_v2(state))
        connector = state["connectors"][0]
        self.assertEqual(connector["adapter"], "feishu-approval-v4")
        self.assertEqual(connector["name"], "飞书 / Lark 审批")
        self.assertEqual(connector["platform"], "lark")
        self.assertEqual(connector["status"], "not_configured")
        self.assertEqual(connector["appId"], "")
        self.assertEqual(connector["approvalCode"], "")
        self.assertNotIn("appSecret", connector)
        self.assertNotIn("accessToken", connector)

    def test_existing_kingdee_query_configuration_is_extended_without_overwriting_custom_filters(self):
        state = empty_production_state()
        state["connectors"] = [{
            "id": "kingdee-k3cloud",
            "adapter": "kingdee-k3cloud-webapi-v6",
            "authMode": "app-id-secret-v3",
            "masterDataQueries": [{
                "category": "account",
                "formId": "BD_Account",
                "fields": ["FNumber", "FName"],
                "filterString": "FForbidStatus='A'",
            }],
        }]
        self.assertTrue(ensure_state_v2(state))
        queries = state["connectors"][0]["masterDataQueries"]
        account = next(item for item in queries if item["formId"] == "BD_Account")
        self.assertEqual(account["filterString"], "FForbidStatus='A'")
        self.assertIn("BD_Customer", {item["formId"] for item in queries})
        self.assertIn("BD_FLEXITEMDETAILV", {item["formId"] for item in queries})

    def test_legacy_kingdee_password_configuration_is_invalidated_and_migrated(self):
        state = empty_production_state()
        state["connectors"] = [{
            "id": "kingdee-k3cloud",
            "adapter": "kingdee-k3cloud-webapi-v6",
            "baseUrl": "https://erp.example.com/K3Cloud",
            "accountId": "acct",
            "username": "legacy-user",
            "status": "connected",
            "capabilities": ["query_voucher"],
            "lastProbe": {"ok": True},
        }]
        self.assertTrue(ensure_state_v2(state))
        connector = state["connectors"][0]
        self.assertEqual(connector["serverUrl"], "https://erp.example.com/K3Cloud")
        self.assertEqual(connector["acctId"], "acct")
        self.assertEqual(connector["authMode"], "app-id-secret-v3")
        self.assertEqual(connector["status"], "not_configured")
        self.assertEqual(connector["capabilities"], [])
        self.assertIsNone(connector["lastProbe"])

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
