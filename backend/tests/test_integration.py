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
    def __init__(
        self,
        *,
        save_error=None,
        reference_result=None,
        master_data_errors=None,
        dimension_rows=None,
    ):
        self.save_error = save_error
        self.reference_result = reference_result
        self.master_data_errors = master_data_errors or {}
        self.dimension_rows = dimension_rows
        self.master_queries = []
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

    def query_master_data(self, form_id, fields, filter_string="", limit=10_000):
        self.master_queries.append((form_id, fields, filter_string, limit))
        if form_id in self.master_data_errors:
            raise self.master_data_errors[form_id]
        if form_id == "BOS_ASSISTANTDATA_DETAIL":
            return [
                ["10", "A01", "辅助资料 A"],
                ["10", "A01", "辅助资料 A"],
                ["10", "A02", "辅助资料 B"],
            ]
        if form_id == "BD_FLEXITEMDETAILV" and self.dimension_rows is not None:
            return self.dimension_rows
        return [["1403", "原材料"], ["2202", "应付账款"]]

    def save_voucher_draft(self, voucher, idempotency_key):
        self.saved.append((voucher["id"], idempotency_key, voucher))
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
            "scope": {"platform": "feishu"},
            "capabilities": ["approval_incremental_sync", "approval_instance_query"],
            "latencyMs": 2,
        }

    def read_approval_fields(self):
        return {
            "approvalCode": "APPROVAL-1",
            "approvalName": "采购付款",
            "fields": [
                {"id": "date", "name": "业务日期", "type": "date", "required": True},
                {"id": "party", "name": "供应商", "type": "input", "required": True},
                {"id": "amount", "name": "付款金额", "type": "amount", "required": True},
                {"id": "ref", "name": "审批单号", "type": "input", "required": False},
            ],
            "requestId": "req-fields",
        }

    def sync_approved_instances(self, cursor):
        self.calls += 1
        return {
            "items": [{
                "instance_code": "APPROVED-1",
                "serial_number": "202607050002",
                "status": "APPROVED",
                "end_time": "1784073600000",
                "form": [
                    {"id": "date", "value": "1784851200000"},
                    {
                        "id": "details",
                        "type": "fieldList",
                        "value": [
                            [
                                {"id": "party", "value": "飞书供应商"},
                                {"id": "amount", "value": 100},
                            ],
                            [
                                {"id": "party", "value": "飞书供应商"},
                                {"id": "amount", "value": 28},
                            ],
                        ],
                    },
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

    def _configured_kingdee(self, adapter, extra_config=None):
        service = self._service(adapter)
        config = {
            "serverUrl": "http://127.0.0.1:9999/K3Cloud/",
            "acctId": "acct",
            "username": "integration-user",
            "appId": "client_encoded-secret",
            "orgNum": "80016",
            "ledger": "017",
            "openPeriods": ["2026-07"],
        }
        config.update(extra_config or {})
        service.configure("kingdee-k3cloud", config)
        report = service.probe("kingdee-k3cloud")
        self.assertTrue(report["report"]["ok"])
        service.sync_master_data()
        return service

    def test_configuration_rejects_inline_secrets_and_locks_environment(self):
        service = self._service(FakeKingdee())
        with self.assertRaisesRegex(ValueError, "密钥库"):
            service.configure("kingdee-k3cloud", {"appSecret": "secret"})
        with self.assertRaisesRegex(ValueError, "明确输入"):
            service.configure(
                "kingdee-k3cloud",
                {"environment": "生产环境"},
            )
        result = service.configure(
            "kingdee-k3cloud",
            {
                "environment": "生产环境",
                "serverUrl": "https://erp.example.com/K3Cloud/",
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
                    "serverUrl": "https://erp.example.com/K3Cloud/",
                    "username": "integration-user",
                },
                "生产环境",
            )
        with self.assertRaisesRegex(ValueError, "管理员账号"):
            service.configure(
                "kingdee-k3cloud",
                {
                    "environment": "生产环境",
                    "serverUrl": "https://erp.example.com/K3Cloud/",
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

    def test_preflight_resolves_dimension_name_and_pushes_only_verified_code(self):
        adapter = FakeKingdee(dimension_rows=[{
            "FFlex4.FNumber": "SUP001",
            "FFlex4.FName": "测试供应商",
        }])
        service = self._configured_kingdee(
            adapter,
            {"dimensionFieldMap": {"supplier": "FDETAILID__FFLEX4"}},
        )
        state = self.database.get_state()
        state["vouchers"][0]["lines"][1].update({
            "dimensions": {"supplier": "测试供应商"},
            "requiredDimensions": ["supplier"],
        })
        self.database.put_state(state)

        preflight = service.preflight("VCH-1", "kingdee-k3cloud", "测试环境")
        self.assertTrue(preflight["report"]["ok"])
        self.assertEqual(
            preflight["resolvedVoucher"]["lines"][1]["dimensions"]["supplier"],
            "SUP001",
        )
        self.assertEqual(
            preflight["report"]["dimensionValidation"]["matches"][0]["status"],
            "live_matched",
        )

        result = service.push_voucher("VCH-1", "kingdee-k3cloud", "测试环境")
        self.assertEqual(result["voucher"]["status"], "已推送")
        self.assertEqual(
            adapter.saved[0][2]["lines"][1]["dimensions"]["supplier"],
            "SUP001",
        )

    def test_preflight_blocks_optional_dimension_when_name_is_ambiguous(self):
        adapter = FakeKingdee(dimension_rows=[
            {"FFlex4.FNumber": "SUP001", "FFlex4.FName": "同名供应商"},
            {"FFlex4.FNumber": "SUP002", "FFlex4.FName": "同名供应商"},
        ])
        service = self._configured_kingdee(
            adapter,
            {"dimensionFieldMap": {"supplier": "FDETAILID__FFLEX4"}},
        )
        state = self.database.get_state()
        state["vouchers"][0]["lines"][1].update({
            "dimensions": {"supplier": "同名供应商"},
            "requiredDimensions": [],
        })
        self.database.put_state(state)

        report = service.preflight("VCH-1", "kingdee-k3cloud", "测试环境")["report"]
        self.assertFalse(report["ok"])
        issue = report["dimensionValidation"]["issues"][0]
        self.assertEqual(issue["status"], "ambiguous")
        self.assertIn("多个有效编码", issue["message"])

    def test_customer_dimension_cannot_match_same_named_supplier(self):
        adapter = FakeKingdee(dimension_rows=[{
            "FFlex4.FNumber": "SUP001",
            "FFlex4.FName": "同名单位",
            "FFlex6.FNumber": "CUS002",
            "FFlex6.FName": "其他客户",
        }])
        service = self._configured_kingdee(
            adapter,
            {"dimensionFieldMap": {"customer": "FDETAILID__FFLEX6"}},
        )
        state = self.database.get_state()
        state["vouchers"][0]["lines"][1].update({
            "dimensions": {"customer": "同名单位"},
            "requiredDimensions": ["customer"],
        })
        self.database.put_state(state)

        report = service.preflight("VCH-1", "kingdee-k3cloud", "测试环境")["report"]
        self.assertFalse(report["ok"])
        issue = report["dimensionValidation"]["issues"][0]
        self.assertEqual(issue["key"], "customer")
        self.assertEqual(issue["status"], "missing")

    def test_dimension_live_query_escapes_master_data_codes(self):
        adapter = FakeKingdee(dimension_rows=[{
            "FFlex4.FNumber": "SUP'01",
            "FFlex4.FName": "O'Reilly 供应商",
        }])
        service = self._configured_kingdee(
            adapter,
            {"dimensionFieldMap": {"supplier": "FDETAILID__FFLEX4"}},
        )
        state = self.database.get_state()
        state["vouchers"][0]["lines"][1].update({
            "dimensions": {"supplier": "O'Reilly 供应商"},
            "requiredDimensions": ["supplier"],
        })
        self.database.put_state(state)

        report = service.preflight("VCH-1", "kingdee-k3cloud", "测试环境")["report"]
        self.assertTrue(report["ok"])
        live_query = next(
            query for query in reversed(adapter.master_queries)
            if query[0] == "BD_FLEXITEMDETAILV" and query[2]
        )
        self.assertEqual(live_query[2], "FFlex4.FNumber='SUP''01'")

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
        })
        service.configure_approval_query("feishu-approval", {
            "approvalCode": "APPROVAL-1",
            "queryDateFrom": "2026-07-01",
            "queryDateTo": "2026-07-29",
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
        self.assertEqual(events[0]["date"], "2026-07-24")
        self.assertEqual(events[0]["externalId"], "APPROVED-1")
        self.assertEqual(events[0]["approvalNo"], "202607050002")
        self.assertEqual(events[0]["reference"], "202607050002")
        self.assertEqual(
            events[0]["sourceRecords"][0]["referenceFields"]["approvalNo"],
            "202607050002",
        )
        self.assertEqual(events[0]["approvalCode"], "APPROVAL-1")
        self.assertEqual(events[0]["approvalName"], "")
        self.assertEqual(events[0]["approvalCompletedDate"], "2026-07-15")
        self.assertTrue(events[0]["approvalCompletedAt"].startswith("2026-07-15T"))
        raw_documents = [
            item for item in state["sourceDocuments"]
            if item.get("type") == "飞书审批原始响应"
        ]
        self.assertEqual(len(raw_documents), 1)
        self.assertTrue(raw_documents[0]["rawResponsePreserved"])
        self.assertTrue(
            (self.database.data_dir / raw_documents[0]["archivePath"]).exists()
        )

    def test_feishu_sync_supports_multiple_approval_code_profiles(self):
        class ProfileFeishu(FakeFeishu):
            def __init__(self, config):
                super().__init__()
                self.approval_code = str(config.get("approvalCode") or "")

            def sync_approved_instances(self, cursor):
                self.calls += 1
                suffix = self.approval_code.rsplit("-", 1)[-1]
                return {
                    "items": [{
                        "instance_code": f"INSTANCE-{suffix}",
                        "serial_number": f"2026070100{suffix}",
                        "status": "APPROVED",
                        "end_time": "1784073600000",
                        "form": [
                            {"id": "date", "value": "1784851200000"},
                            {"id": "party", "value": f"供应商 {suffix}"},
                            {"id": "amount", "value": 100},
                        ],
                    }],
                    "cursor": {"version": 5, "endTime": 500 + int(suffix)},
                    "hasMore": False,
                }

        service = ConnectorService(
            self.database,
            factories={
                "feishu-approval": lambda config: ProfileFeishu(config),
            },
        )
        service.configure("feishu-approval", {"appId": "cli-test"})
        first = service.configure_approval_query("feishu-approval", {
            "approvalCode": "APPROVAL-1",
            "queryDateFrom": "2026-07-01",
            "queryDateTo": "2026-07-29",
            "fieldMapping": {
                "date": "date",
                "counterparty": "party",
                "amount": "amount",
            },
        })
        second = service.configure_approval_query("feishu-approval", {
            "approvalCode": "APPROVAL-2",
            "queryDateFrom": "2026-07-01",
            "queryDateTo": "2026-07-29",
            "fieldMapping": {
                "date": "date",
                "counterparty": "party",
                "amount": "amount",
            },
        })
        self.assertNotEqual(first["profile"]["id"], second["profile"]["id"])
        self.assertEqual(
            [profile["approvalCode"] for profile in second["connector"]["approvalProfiles"]],
            ["APPROVAL-1", "APPROVAL-2"],
        )

        service.probe("feishu-approval")
        result = service.sync_approvals("feishu-approval")
        approval_events = [
            event for event in result["state"]["events"]
            if event.get("sourceSystem") == "feishu"
        ]
        self.assertEqual(
            {event["approvalCode"] for event in approval_events},
            {"APPROVAL-1", "APPROVAL-2"},
        )
        self.assertEqual(
            {
                profile["approvalCode"]: profile["syncCursor"]["endTime"]
                for profile in result["connector"]["approvalProfiles"]
            },
            {"APPROVAL-1": 501, "APPROVAL-2": 502},
        )

    def test_feishu_sync_can_retry_archived_instances_after_mapping_is_fixed(self):
        adapter = FakeFeishu()
        service = self._service(adapter, "feishu-approval")
        service.configure("feishu-approval", {"appId": "cli-test"})
        service.configure_approval_query("feishu-approval", {
            "approvalCode": "APPROVAL-1",
            "queryDateFrom": "2026-07-01",
            "queryDateTo": "2026-07-29",
            "fieldMapping": {
                "date": "date",
                "counterparty": "missing-party",
                "amount": "amount",
            },
        })
        service.probe("feishu-approval")
        failed = service.sync_approvals()
        self.assertEqual(failed["sync"]["created"], 0)
        self.assertEqual(len(failed["state"]["sourceDocuments"]), 1)
        self.assertEqual(
            len([
                item for item in failed["state"]["exceptions"]
                if item.get("type") == "流程字段映射缺失"
            ]),
            1,
        )

        configured = service.configure_approval_query("feishu-approval", {
            "approvalCode": "APPROVAL-1",
            "queryDateFrom": "2026-07-01",
            "queryDateTo": "2026-07-29",
            "fieldMapping": {
                "date": "date",
                "counterparty": "party",
                "amount": "amount",
            },
        })
        self.assertEqual(configured["connector"]["syncCursor"], {})
        retried = service.sync_approvals()
        self.assertEqual(retried["sync"]["created"], 1)
        self.assertEqual(len(retried["state"]["sourceDocuments"]), 1)
        self.assertFalse([
            item for item in retried["state"]["exceptions"]
            if item.get("type") == "流程字段映射缺失"
        ])

    def test_feishu_reads_and_saves_approval_fields_with_mapping_suggestions(self):
        adapter = FakeFeishu()
        service = self._service(adapter, "feishu-approval")
        service.configure("feishu-approval", {
            "platform": "feishu",
            "appId": "cli-test",
            "approvalCode": "APPROVAL-1",
        })
        result = service.read_approval_fields("feishu-approval")
        connector = result["connector"]
        self.assertEqual(connector["approvalName"], "采购付款")
        self.assertEqual(len(connector["approvalFields"]), 4)
        self.assertEqual(connector["fieldMapping"]["date"], "date")
        self.assertEqual(connector["fieldMapping"]["counterparty"], "party")
        self.assertEqual(connector["fieldMapping"]["amount"], "amount")
        self.assertNotIn("reference", connector["fieldMapping"])

    def test_feishu_sync_preserves_all_approval_fields_for_record_filtering(self):
        adapter = FakeFeishu()
        service = self._service(adapter, "feishu-approval")
        service.configure("feishu-approval", {
            "platform": "feishu",
            "appId": "cli-test",
            "approvalCode": "APPROVAL-1",
        })
        service.read_approval_fields("feishu-approval")
        configured = service.configure_approval_query("feishu-approval", {
            "approvalCode": "APPROVAL-1",
            "queryDateFrom": "2026-07-01",
            "queryDateTo": "2026-07-29",
            "fieldMapping": {
                "date": "date",
                "counterparty": "party",
                "amount": "amount",
            },
            "additionalApprovalFieldIds": ["ref"],
        })
        self.assertEqual(
            configured["connector"]["additionalApprovalFieldIds"],
            ["ref"],
        )

        service.probe("feishu-approval")
        service.sync_approvals()
        event = next(
            item for item in self.database.get_state()["events"]
            if item.get("sourceSystem") == "feishu"
        )
        values = {
            item["id"]: item["value"]
            for item in event["approvalFieldValues"]
        }
        self.assertEqual(set(values), {"date", "party", "amount", "ref"})
        self.assertEqual(values["date"], "1784851200000")
        self.assertEqual(values["party"], ["飞书供应商", "飞书供应商"])
        self.assertEqual(values["amount"], [100, 28])
        self.assertEqual(values["ref"], "")

    def test_feishu_sync_backfills_legacy_events_from_archived_responses(self):
        adapter = FakeFeishu()
        service = self._service(adapter, "feishu-approval")
        service.configure("feishu-approval", {
            "platform": "feishu",
            "appId": "cli-test",
            "approvalCode": "APPROVAL-1",
        })
        service.read_approval_fields("feishu-approval")
        service.configure_approval_query("feishu-approval", {
            "approvalCode": "APPROVAL-1",
            "queryDateFrom": "2026-07-01",
            "queryDateTo": "2026-07-29",
            "fieldMapping": {
                "date": "date",
                "counterparty": "party",
                "amount": "amount",
            },
        })
        service.probe("feishu-approval")
        service.sync_approvals()

        state = self.database.get_state()
        event = next(
            item for item in state["events"]
            if item.get("sourceSystem") == "feishu"
        )
        event.pop("approvalFieldValues", None)
        event.pop("approvalCompletedAt", None)
        event.pop("approvalCompletedDate", None)
        event["counterparty"] = "旧映射值"
        self.database.put_state(state)
        adapter.sync_approved_instances = lambda _cursor: {
            "items": [],
            "cursor": {"endTime": 999},
        }

        result = service.sync_approvals()
        refreshed = next(
            item for item in result["state"]["events"]
            if item.get("sourceSystem") == "feishu"
        )
        self.assertEqual(result["sync"]["backfilled"], 1)
        self.assertEqual(refreshed["counterparty"], "飞书供应商")
        self.assertEqual(
            {item["id"] for item in refreshed["approvalFieldValues"]},
            {"date", "party", "amount", "ref"},
        )
        self.assertEqual(refreshed["approvalCompletedDate"], "2026-07-15")

    def test_completion_query_range_change_does_not_reset_lark_sync_cursor(self):
        adapter = FakeFeishu()
        service = self._service(adapter, "feishu-approval")
        service.configure("feishu-approval", {"appId": "cli-test"})
        service.configure_approval_query("feishu-approval", {
            "approvalCode": "APPROVAL-1",
            "queryDateFrom": "2026-07-01",
            "queryDateTo": "2026-07-29",
            "fieldMapping": {
                "date": "date",
                "counterparty": "party",
                "amount": "amount",
            },
        })
        state = self.database.get_state()
        connector = next(
            item for item in state["connectors"]
            if item["id"] == "feishu-approval"
        )
        connector["syncCursor"] = {
            "version": 5,
            "endTime": 123456,
            "pageToken": "",
        }
        self.database.put_state(state)

        result = service.configure_approval_query("feishu-approval", {
            "approvalCode": "APPROVAL-1",
            "queryDateFrom": "2026-07-10",
            "queryDateTo": "2026-07-20",
            "fieldMapping": {
                "date": "date",
                "counterparty": "party",
                "amount": "amount",
            },
        })

        self.assertEqual(result["connector"]["syncCursor"], {
            "version": 5,
            "endTime": 123456,
            "pageToken": "",
        })

    def test_feishu_sync_preserves_record_counterparty_field_selection(self):
        adapter = FakeFeishu()
        service = self._service(adapter, "feishu-approval")
        service.configure("feishu-approval", {
            "platform": "feishu",
            "appId": "cli-test",
            "approvalCode": "APPROVAL-1",
        })
        service.read_approval_fields("feishu-approval")
        service.configure_approval_query("feishu-approval", {
            "approvalCode": "APPROVAL-1",
            "queryDateFrom": "2026-07-01",
            "queryDateTo": "2026-07-29",
            "fieldMapping": {
                "date": "date",
                "counterparty": "party",
                "amount": "amount",
            },
        })
        service.probe("feishu-approval")
        service.sync_approvals()

        state = self.database.get_state()
        event = next(
            item for item in state["events"]
            if item.get("sourceSystem") == "feishu"
        )
        event["counterparty"] = "100 / 28"
        event["counterpartyMappedValue"] = "飞书供应商"
        event["counterpartyFieldSelection"] = {
            "fieldId": "amount",
            "fieldName": "付款金额",
            "selectedAt": "2026-07-30T12:00:00.000Z",
            "selectedBy": "财务甲",
        }
        self.database.put_state(state)
        adapter.sync_approved_instances = lambda _cursor: {
            "items": [],
            "cursor": {"endTime": 999},
        }

        result = service.sync_approvals()
        refreshed = next(
            item for item in result["state"]["events"]
            if item.get("sourceSystem") == "feishu"
        )
        self.assertEqual(refreshed["counterparty"], "100 / 28")
        self.assertEqual(
            refreshed["counterpartyMappedValue"],
            "飞书供应商",
        )
        self.assertEqual(
            refreshed["counterpartyFieldSelection"]["fieldId"],
            "amount",
        )

    def test_feishu_mapping_can_use_a_registered_local_business_field(self):
        adapter = FakeFeishu()
        service = self._service(adapter, "feishu-approval")
        service.configure("feishu-approval", {"appId": "cli-test"})
        service.configure_approval_query("feishu-approval", {
            "approvalCode": "APPROVAL-1",
            "queryDateFrom": "2026-07-01",
            "queryDateTo": "2026-07-29",
            "fieldMapping": {
                "date": "date",
                "counterparty": "party",
                "amount": "amount",
            },
        })
        service.probe("feishu-approval")
        service.sync_approvals()

        state = self.database.get_state()
        state["events"].append({
            "id": "EV-LOCAL-1",
            "reference": "APPROVED-1",
            "date": "2026-07-24",
            "counterparty": "本地业务数据供应商",
            "amountCents": 12_800,
            "department": "本地财务部",
            "project": "本地项目",
            "summary": "本地业务摘要",
            "sourceDocumentIds": [],
            "approvalStatus": "unknown",
        })
        self.database.put_state(state)

        configured = service.configure_approval_query("feishu-approval", {
            "approvalCode": "APPROVAL-1",
            "queryDateFrom": "2026-07-01",
            "queryDateTo": "2026-07-29",
            "fieldSources": [{
                "id": "local-counterparty",
                "sourceSystem": "local-files",
                "field": "counterparty",
                "label": "本地文件 · 供应商 / 客商",
            }],
            "fieldMapping": {
                "date": "date",
                "counterparty": "source:local-counterparty",
                "amount": "amount",
            },
        })
        self.assertEqual(
            configured["connector"]["fieldSources"][0]["matchField"],
            "reference",
        )
        service.sync_approvals()
        refreshed = next(
            item for item in self.database.get_state()["events"]
            if item.get("sourceSystem") == "feishu"
        )
        self.assertEqual(refreshed["counterparty"], "本地业务数据供应商")

    def test_feishu_approval_query_configuration_is_separate_from_base_connection(self):
        adapter = FakeFeishu()
        service = self._service(adapter, "feishu-approval")
        service.configure("feishu-approval", {
            "platform": "feishu",
            "appId": "cli-test",
        })
        connected = service.probe("feishu-approval")["connector"]
        original_lock = connected["environmentLock"]

        result = service.configure_approval_query("feishu-approval", {
            "approvalCode": "APPROVAL-1",
            "queryDateFrom": "2026-07-01",
            "queryDateTo": "2026-07-29",
            "fieldMapping": {
                "date": "date",
                "counterparty": "party",
                "amount": "amount",
                "department": "department",
            },
        })
        connector = result["connector"]
        self.assertEqual(connector["status"], "connected")
        self.assertEqual(connector["environmentLock"], original_lock)
        self.assertEqual(connector["approvalCode"], "APPROVAL-1")
        self.assertEqual(connector["queryDateFrom"], "2026-07-01")
        self.assertEqual(connector["queryDateTo"], "2026-07-29")
        self.assertEqual(connector["fieldMapping"]["department"], "department")

        with self.assertRaisesRegex(ValueError, "不支持的审批业务字段"):
            service.configure_approval_query("feishu-approval", {
                "approvalCode": "APPROVAL-1",
                "queryDateFrom": "2026-07-01",
                "queryDateTo": "2026-07-29",
                "fieldMapping": {"unsupported": "field"},
            })

        with self.assertRaisesRegex(ValueError, "其他来源尚未配置"):
            service.configure_approval_query("feishu-approval", {
                "approvalCode": "APPROVAL-1",
                "queryDateFrom": "2026-07-01",
                "queryDateTo": "2026-07-29",
                "fieldSources": [{
                    "id": "unknown-source-field",
                    "sourceSystem": "unknown-source",
                    "field": "counterparty",
                    "label": "未知来源字段",
                }],
                "fieldMapping": {},
            })

        with self.assertRaisesRegex(ValueError, "不存在的其他来源字段"):
            service.configure_approval_query("feishu-approval", {
                "approvalCode": "APPROVAL-1",
                "queryDateFrom": "2026-07-01",
                "queryDateTo": "2026-07-29",
                "fieldMapping": {"counterparty": "source:missing"},
            })

        with self.assertRaisesRegex(ValueError, "开始日期不能晚于结束日期"):
            service.configure_approval_query("feishu-approval", {
                "approvalCode": "APPROVAL-1",
                "queryDateFrom": "2026-07-29",
                "queryDateTo": "2026-07-01",
                "fieldMapping": {},
            })

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

    def test_master_data_sync_continues_when_one_category_fails_and_logs_each_category(self):
        adapter = FakeKingdee(master_data_errors={
            "BD_Customer": ConnectorError(
                "REMOTE_ERROR",
                "客户资料无权访问",
                "permission",
            ),
        })
        service = self._configured_kingdee(adapter)
        result = service.sync_master_data()
        self.assertEqual(result["sync"]["status"], "completed_with_warnings")
        categories = result["sync"]["categories"]
        customer = next(item for item in categories if item["formId"] == "BD_Customer")
        supplier = next(item for item in categories if item["formId"] == "BD_Supplier")
        self.assertEqual(customer["status"], "failed")
        self.assertEqual(supplier["status"], "completed")
        persisted = self.database.get_state()["syncLog"][0]
        self.assertEqual(persisted["operation"], "master-data")
        self.assertEqual(persisted["status"], "completed_with_warnings")

    def test_optional_master_data_form_is_logged_as_unavailable_without_failing_sync(self):
        service = self._configured_kingdee(FakeKingdee(master_data_errors={
            "BD_Project": ConnectorError(
                "REMOTE_ERROR",
                "当前账套不存在项目表单",
                "remote_error",
            ),
        }))
        sync = self.database.get_state()["syncLog"][0]
        project = next(item for item in sync["categories"] if item["formId"] == "BD_Project")
        self.assertEqual(sync["status"], "completed")
        self.assertEqual(project["status"], "unavailable")

    def test_master_data_sync_uses_composite_identity_and_is_stable_on_rerun(self):
        service = self._configured_kingdee(FakeKingdee())
        rerun = service.sync_master_data()
        self.assertEqual(rerun["created"], 0)
        current = [
            item for item in self.database.get_state()["masterData"]
            if item.get("category") == "assistantData" and item.get("active", True)
        ]
        self.assertEqual(len(current), 2)
        self.assertEqual(
            {item["sourceExternalId"] for item in current},
            {"10::A01", "10::A02"},
        )


if __name__ == "__main__":
    unittest.main()
