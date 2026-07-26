from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from auto_voucher.connectors import ConnectorError
from auto_voucher.database import Database
from auto_voucher.integration import ConnectorService, connector_lock


def integration_state():
    state = {
        "version": 1,
        "operator": "测试员",
        "company": "示例科技有限公司",
        "ledger": "人民币账套",
        "environment": "测试环境",
        "sourceDocuments": [],
        "events": [{
            "id": "EV-1",
            "reference": "SP-1",
            "approvalStatus": "approved",
            "sourceVerified": True,
            "sourceDocumentIds": [],
            "exceptionIds": [],
            "status": "已生成",
        }],
        "vouchers": [{
            "id": "VCH-1",
            "number": "记-测试-0001",
            "company": "示例科技有限公司",
            "ledger": "人民币账套",
            "period": "2026-07",
            "accountingDate": "2026-07-24",
            "sourceEventIds": ["EV-1"],
            "ruleVersion": "测试规则 v1",
            "status": "已确认",
            "financeReviewed": True,
            "pushAllowed": True,
            "lines": [
                {
                    "summary": "采购",
                    "accountCode": "1403",
                    "debitCents": 10_000,
                    "creditCents": 0,
                    "dimensions": {},
                },
                {
                    "summary": "应付",
                    "accountCode": "2202",
                    "debitCents": 0,
                    "creditCents": 10_000,
                    "dimensions": {},
                },
            ],
        }],
        "exceptions": [],
        "rules": [],
        "connectors": [],
        "masterData": [],
        "auditLog": [],
    }
    return state


class FakeKingdee:
    def __init__(self, *, save_error=None, reference_result=None):
        self.save_error = save_error
        self.reference_result = reference_result
        self.saved = []

    def probe(self):
        return {
            "ok": True,
            "scope": {"accountId": "acct", "ledger": "人民币账套"},
            "capabilities": [
                "save_voucher_draft",
                "query_voucher",
                "query_master_data",
                "query_period",
                "query_ledger",
                "query_financial_reports",
            ],
            "latencyMs": 3,
        }

    def check_period(self, period):
        return {"period": period, "open": True, "source": "target"}

    def query_master_data(self, form_id, fields, filter_string=""):
        return [["1403", "原材料"], ["2202", "应付账款"]]

    def save_voucher_draft(self, voucher, idempotency_key):
        self.saved.append((voucher["id"], idempotency_key))
        if self.save_error:
            raise self.save_error
        return {"externalId": "88", "externalNumber": "记-0088", "status": "saved"}

    def query_voucher(self, *, number="", external_id=""):
        return {
            "externalId": external_id or "88",
            "externalNumber": number or "记-0088",
            "status": "saved",
        }

    def query_voucher_by_reference(self, reference):
        return self.reference_result

    def query_read_model(self, model_key, parameters):
        return {
            "modelKey": model_key,
            "fields": ["项目", "本期金额"],
            "rows": [{"项目": "测试行", "本期金额": 100.0}],
            "source": "target-system-live-query",
        }


class FakeFeishu:
    def __init__(self):
        self.calls = 0

    def probe(self):
        return {
            "ok": True,
            "scope": {"approvalCode": "APPROVAL-1"},
            "capabilities": ["approval_incremental_sync", "approval_instance_query"],
            "latencyMs": 2,
        }

    def sync_approved_instances(self, cursor):
        self.calls += 1
        return {
            "items": [{
                "instance_code": "APPROVED-1",
                "status": "APPROVED",
                "form": [
                    {"id": "date", "value": "2026-07-24"},
                    {"id": "party", "value": "飞书供应商"},
                    {"id": "amount", "value": "128.00"},
                    {"id": "ref", "value": "SP-FS-1"},
                ],
            }],
            "cursor": {"endTime": 200 + self.calls},
        }


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.database = Database(Path(self.temporary.name))
        self.database.put_state(integration_state())

    def tearDown(self):
        self.temporary.cleanup()

    def _service(self, adapter, connector_id="kingdee-k3cloud"):
        return ConnectorService(
            self.database,
            factories={connector_id: lambda _config: adapter},
        )

    def _configured_kingdee(self, adapter):
        service = self._service(adapter)
        service.configure("kingdee-k3cloud", {
            "baseUrl": "http://127.0.0.1:9999",
            "accountId": "acct",
            "username": "integration-user",
            "ledger": "人民币账套",
            "openPeriods": ["2026-07"],
        })
        report = service.probe("kingdee-k3cloud")
        self.assertTrue(report["report"]["ok"])
        service.sync_master_data()
        return service

    def test_configuration_rejects_inline_secrets_and_locks_environment(self):
        service = self._service(FakeKingdee())
        with self.assertRaisesRegex(ValueError, "密钥库"):
            service.configure("kingdee-k3cloud", {"password": "secret"})
        with self.assertRaisesRegex(ValueError, "明确输入"):
            service.configure(
                "kingdee-k3cloud",
                {"environment": "生产环境"},
            )
        result = service.configure(
            "kingdee-k3cloud",
            {
                "environment": "生产环境",
                "baseUrl": "https://erp.example.com",
                "leastPrivilegeConfirmed": True,
            },
            "生产环境",
        )
        connector = result["connector"]
        self.assertEqual(connector["environmentLock"], connector_lock(connector))

    def test_production_rejects_admin_or_unconfirmed_least_privilege_account(self):
        service = self._service(FakeKingdee())
        with self.assertRaisesRegex(ValueError, "最小权限"):
            service.configure(
                "kingdee-k3cloud",
                {
                    "environment": "生产环境",
                    "baseUrl": "https://erp.example.com",
                    "username": "integration-user",
                },
                "生产环境",
            )
        with self.assertRaisesRegex(ValueError, "管理员账号"):
            service.configure(
                "kingdee-k3cloud",
                {
                    "environment": "生产环境",
                    "baseUrl": "https://erp.example.com",
                    "username": "Administrator",
                    "leastPrivilegeConfirmed": True,
                },
                "生产环境",
            )

    def test_preflight_checks_target_environment_approval_period_and_master_data(self):
        adapter = FakeKingdee()
        service = self._configured_kingdee(adapter)
        report = service.preflight("VCH-1", "kingdee-k3cloud", "测试环境")["report"]
        self.assertTrue(report["ok"])
        wrong = service.preflight("VCH-1", "kingdee-k3cloud", "生产环境")["report"]
        self.assertFalse(wrong["ok"])
        self.assertEqual(
            next(item for item in wrong["checks"] if item["name"] == "目标环境")["status"],
            "failed",
        )
        state = self.database.get_state()
        state["events"][0]["approvalStatus"] = "pending"
        self.database.put_state(state)
        blocked = service.preflight("VCH-1", "kingdee-k3cloud", "测试环境")["report"]
        self.assertFalse(blocked["ok"])

    def test_push_saves_draft_once_and_requires_external_recheck(self):
        adapter = FakeKingdee()
        service = self._configured_kingdee(adapter)
        result = service.push_voucher("VCH-1", "kingdee-k3cloud", "测试环境")
        self.assertEqual(result["voucher"]["status"], "已推送")
        self.assertEqual(len(adapter.saved), 1)
        self.assertEqual(result["state"]["postingAttempts"][0]["status"], "verified")
        with self.assertRaisesRegex(ValueError, "凭证状态"):
            service.push_voucher("VCH-1", "kingdee-k3cloud", "测试环境")

    def test_external_voucher_query_records_source_environment_and_cache(self):
        adapter = FakeKingdee()
        service = self._configured_kingdee(adapter)
        result = service.query_external_voucher(
            "kingdee-k3cloud",
            number="记-0088",
        )
        self.assertTrue(result["result"]["found"])
        self.assertEqual(result["result"]["environment"], "测试环境")
        self.assertEqual(result["result"]["source"], "target-system-live-query")
        self.assertEqual(
            self.database.get_state()["externalQueryCache"][0]["voucher"]["externalId"],
            "88",
        )

    def test_external_ledger_and_reports_record_live_source_and_cache_time(self):
        adapter = FakeKingdee()
        service = self._configured_kingdee(adapter)
        ledger = service.query_external_ledger(
            "kingdee-k3cloud",
            {"ledger": "人民币账套", "period": "2026-07", "account": "1001"},
        )
        report = service.query_external_report(
            "kingdee-k3cloud",
            "balanceSheet",
            "2026-07",
        )
        self.assertEqual(ledger["result"]["source"], "target-system-live-query")
        self.assertEqual(report["result"]["label"], "资产负债表")
        cache = self.database.get_state()["externalReadCache"]
        self.assertEqual([item["kind"] for item in cache[:2]], ["balanceSheet", "ledger"])

    def test_retryable_save_error_queries_reference_before_marking_unknown(self):
        adapter = FakeKingdee(
            save_error=ConnectorError(
                "NETWORK_TIMEOUT",
                "连接超时",
                "network",
                retryable=True,
            ),
            reference_result={
                "externalId": "99",
                "externalNumber": "记-0099",
                "status": "saved",
            },
        )
        service = self._configured_kingdee(adapter)
        result = service.push_voucher("VCH-1", "kingdee-k3cloud", "测试环境")
        self.assertEqual(result["voucher"]["status"], "已推送")
        self.assertIn("网络异常后", result["message"])

    def test_retryable_save_error_without_reference_stays_unknown(self):
        adapter = FakeKingdee(
            save_error=ConnectorError(
                "NETWORK_TIMEOUT",
                "连接超时",
                "network",
                retryable=True,
            ),
        )
        service = self._configured_kingdee(adapter)
        result = service.push_voucher("VCH-1", "kingdee-k3cloud", "测试环境")
        self.assertEqual(result["voucher"]["status"], "状态待确认")
        self.assertEqual(result["state"]["outbox"][0]["status"], "manual_review")
        with self.assertRaisesRegex(ValueError, "凭证状态"):
            service.push_voucher("VCH-1", "kingdee-k3cloud", "测试环境")

    def test_feishu_sync_maps_fields_and_deduplicates_reruns(self):
        adapter = FakeFeishu()
        service = self._service(adapter, "feishu-approval")
        service.configure("feishu-approval", {
            "appId": "cli-test",
            "approvalCode": "APPROVAL-1",
            "fieldMapping": {
                "date": "date",
                "counterparty": "party",
                "amount": "amount",
                "reference": "ref",
            },
        })
        service.probe("feishu-approval")
        first = service.sync_approvals()
        second = service.sync_approvals()
        self.assertEqual(first["sync"]["created"], 1)
        self.assertEqual(second["sync"]["created"], 0)
        state = self.database.get_state()
        events = [item for item in state["events"] if item.get("sourceSystem") == "feishu"]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["counterparty"], "飞书供应商")
        self.assertEqual(events[0]["amountCents"], 12_800)
        raw_documents = [
            item for item in state["sourceDocuments"]
            if item.get("type") == "飞书审批原始响应"
        ]
        self.assertEqual(len(raw_documents), 1)
        self.assertTrue(raw_documents[0]["rawResponsePreserved"])
        self.assertTrue(
            (self.database.data_dir / raw_documents[0]["archivePath"]).exists()
        )

    def test_master_data_sync_preserves_raw_response_once(self):
        adapter = FakeKingdee()
        service = self._configured_kingdee(adapter)
        service.sync_master_data()
        documents = [
            item for item in self.database.get_state()["sourceDocuments"]
            if item.get("type") == "金蝶基础资料原始响应"
        ]
        self.assertTrue(documents)
        self.assertEqual(
            len({item["fullHash"] for item in documents}),
            len(documents),
        )
        self.assertTrue(all(
            (self.database.data_dir / item["archivePath"]).exists()
            for item in documents
        ))


if __name__ == "__main__":
    unittest.main()
