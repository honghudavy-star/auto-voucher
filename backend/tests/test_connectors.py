from __future__ import annotations

import json
import unittest
import urllib.parse

from auto_voucher.connectors import (
    ConfiguredFinanceConnector,
    ConnectorError,
    FeishuApprovalConnector,
    KingdeeK3CloudConnector,
    OaJsonApiConnector,
    map_kingdee_error,
)


class FakeTransport:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def request(self, method, url, *, headers=None, payload=None, timeout=20):
        self.requests.append({
            "method": method,
            "url": url,
            "headers": headers or {},
            "payload": payload,
            "timeout": timeout,
        })
        if not self.responses:
            raise AssertionError("没有为请求准备响应")
        return self.responses.pop(0)


class ConnectorTests(unittest.TestCase):
    def test_generic_oa_json_api_filters_approved_records_and_maps_nested_paths(self):
        transport = FakeTransport([
            (200, {
                "data": {
                    "items": [
                        {"id": "OA-1", "approval": {"status": "APPROVED"}},
                        {"id": "OA-2", "approval": {"status": "PENDING"}},
                    ],
                },
            }, {"X-Request-Id": "oa-request"}),
        ])
        connector = OaJsonApiConnector(
            {
                "baseUrl": "https://oa.example.test/api/records",
                "environment": "测试环境",
                "providerName": "企业微信",
                "recordsPath": "data.items",
                "approvalStatusPath": "approval.status",
                "approvedValues": ["APPROVED"],
                "authHeader": "X-Access-Token",
                "authScheme": "",
            },
            "secret-token",
            transport,
        )
        result = connector.sync_approved_instances()
        self.assertEqual([item["id"] for item in result["items"]], ["OA-1"])
        self.assertEqual(transport.requests[0]["headers"]["X-Access-Token"], "secret-token")

    def test_finance_adapters_expose_the_unified_contract(self):
        contract = (
            "probe",
            "sync_master_data",
            "check_period",
            "save_voucher_draft",
            "query_voucher",
            "query_by_idempotency_reference",
        )
        for adapter in (KingdeeK3CloudConnector, ConfiguredFinanceConnector):
            with self.subTest(adapter=adapter.__name__):
                for method in contract:
                    self.assertTrue(callable(getattr(adapter, method, None)), method)

    def test_configured_get_profile_encodes_payload_as_query_parameters(self):
        transport = FakeTransport([(200, {"ok": True}, {})])
        connector = ConfiguredFinanceConnector(
            {
                "baseUrl": "http://127.0.0.1:9999",
                "environment": "测试环境",
                "endpointProfile": {
                    "probe": {"path": "/probe?locale=zh-CN", "method": "GET"},
                },
            },
            "token",
            transport,
        )
        connector._request("probe", {
            "accountId": "账套 A",
            "fields": ["code", "name"],
            "ignored": None,
        })
        request = transport.requests[0]
        parsed = urllib.parse.urlparse(request["url"])
        query = urllib.parse.parse_qs(parsed.query)
        self.assertEqual(request["method"], "GET")
        self.assertIsNone(request["payload"])
        self.assertEqual(query["locale"], ["zh-CN"])
        self.assertEqual(query["accountId"], ["账套 A"])
        self.assertEqual(query["fields"], ["code", "name"])
        self.assertNotIn("ignored", query)

    def test_feishu_probe_checks_identity_approval_scope_and_capabilities(self):
        transport = FakeTransport([
            (200, {"code": 0, "tenant_access_token": "t-test"}, {}),
            (200, {"code": 0, "data": {"approval_name": "采购付款"}}, {"X-Request-Id": "req-1"}),
        ])
        connector = FeishuApprovalConnector(
            {
                "appId": "cli-test",
                "approvalCode": "approval-code",
                "environment": "测试环境",
            },
            "secret",
            transport,
        )
        report = connector.probe()
        self.assertTrue(report["ok"])
        self.assertEqual(report["scope"]["approvalCode"], "approval-code")
        self.assertIn("approval_incremental_sync", report["capabilities"])
        self.assertEqual(transport.requests[1]["headers"]["Authorization"], "Bearer t-test")

    def test_feishu_incremental_sync_only_returns_approved_instances(self):
        transport = FakeTransport([
            (200, {"code": 0, "tenant_access_token": "t-test"}, {}),
            (200, {
                "code": 0,
                "data": {
                    "instance_code_list": ["APPROVED-1", "REJECTED-1"],
                    "has_more": False,
                },
            }, {}),
            (200, {"code": 0, "data": {"instance": {"instance_code": "APPROVED-1", "status": "APPROVED"}}}, {}),
            (200, {"code": 0, "data": {"instance": {"instance_code": "REJECTED-1", "status": "REJECTED"}}}, {}),
        ])
        connector = FeishuApprovalConnector(
            {
                "appId": "cli-test",
                "approvalCode": "approval-code",
                "environment": "测试环境",
            },
            "secret",
            transport,
        )
        result = connector.sync_approved_instances({"endTime": 100})
        self.assertEqual([item["instance_code"] for item in result["items"]], ["APPROVED-1"])
        self.assertGreater(result["cursor"]["endTime"], 100)

    def test_feishu_pagination_reuses_the_same_time_window(self):
        transport = FakeTransport([
            (200, {"code": 0, "tenant_access_token": "t-test"}, {}),
            (200, {
                "code": 0,
                "data": {
                    "instance_code_list": [],
                    "has_more": True,
                    "page_token": "next-page",
                },
            }, {}),
        ])
        connector = FeishuApprovalConnector(
            {
                "appId": "cli-test",
                "approvalCode": "approval-code",
                "environment": "测试环境",
            },
            "secret",
            transport,
        )
        first = connector.sync_approved_instances({"endTime": 100})
        cursor = first["cursor"]
        self.assertEqual(cursor["startTime"], 100)
        self.assertEqual(cursor["pageToken"], "next-page")

        second_transport = FakeTransport([
            (200, {"code": 0, "tenant_access_token": "t-test"}, {}),
            (200, {
                "code": 0,
                "data": {"instance_code_list": [], "has_more": False},
            }, {}),
        ])
        second = FeishuApprovalConnector(
            connector.config,
            "secret",
            second_transport,
        ).sync_approved_instances(cursor)
        payload = second_transport.requests[1]["payload"]
        self.assertEqual(payload["start_time"], str(cursor["startTime"]))
        self.assertEqual(payload["end_time"], str(cursor["endTime"]))
        self.assertEqual(payload["page_token"], "next-page")

    def test_kingdee_production_rejects_plain_http(self):
        with self.assertRaisesRegex(ConnectorError, "HTTPS"):
            KingdeeK3CloudConnector(
                {
                    "baseUrl": "http://erp.example.com",
                    "environment": "生产环境",
                },
                "password",
                FakeTransport([]),
            )

    def test_kingdee_probe_reports_draft_only_capabilities(self):
        transport = FakeTransport([
            (200, {"LoginResultType": 1, "Context": {"DataCenterName": "测试账套"}}, {}),
        ])
        connector = KingdeeK3CloudConnector(
            {
                "baseUrl": "http://127.0.0.1:9999",
                "environment": "测试环境",
                "accountId": "acct",
                "username": "integration-user",
                "ledger": "人民币账套",
                "openPeriods": ["2026-07"],
            },
            "password",
            transport,
        )
        report = connector.probe()
        self.assertIn("save_voucher_draft", report["capabilities"])
        self.assertNotIn("submit_voucher", report["capabilities"])
        self.assertNotIn("audit_voucher", report["capabilities"])
        self.assertIn("query_period", report["capabilities"])

    def test_kingdee_period_query_uses_configured_read_only_model(self):
        transport = FakeTransport([
            (200, {"LoginResultType": 1}, {}),
            (200, [["2026-07", "OPEN"]], {}),
        ])
        connector = KingdeeK3CloudConnector(
            {
                "baseUrl": "http://127.0.0.1:9999",
                "environment": "测试环境",
                "accountId": "acct",
                "username": "integration-user",
                "periodQuery": {
                    "formId": "CUSTOM_PERIOD",
                    "periodField": "FNumber",
                    "statusField": "FStatus",
                    "filterTemplate": "FNumber='{period}'",
                    "openValues": ["OPEN"],
                },
            },
            "password",
            transport,
        )
        report = connector.check_period("2026-07")
        self.assertTrue(report["open"])
        self.assertEqual(report["source"], "target-system")
        query_payload = json.loads(transport.requests[1]["payload"][0])
        self.assertEqual(query_payload["FormId"], "CUSTOM_PERIOD")
        self.assertEqual(query_payload["FilterString"], "FNumber='2026-07'")

    def test_kingdee_read_model_maps_rows_and_escapes_filter_parameters(self):
        transport = FakeTransport([
            (200, {"LoginResultType": 1}, {}),
            (200, [["1001", "库存现金", 88.5]], {}),
        ])
        connector = KingdeeK3CloudConnector(
            {
                "baseUrl": "http://127.0.0.1:9999",
                "environment": "测试环境",
                "accountId": "acct",
                "username": "integration-user",
                "readModels": {
                    "ledger": {
                        "enabled": True,
                        "formId": "CUSTOM_LEDGER",
                        "fields": ["FAccount", "FName", "FBalance"],
                        "filterTemplate": "FPeriod='{period}' AND FAccount='{account}'",
                    }
                },
            },
            "password",
            transport,
        )
        result = connector.query_read_model(
            "ledger",
            {"period": "2026-07", "account": "10'01"},
        )
        self.assertEqual(result["rows"][0]["FBalance"], 88.5)
        query_payload = json.loads(transport.requests[1]["payload"][0])
        self.assertEqual(
            query_payload["FilterString"],
            "FPeriod='2026-07' AND FAccount='10''01'",
        )

    def test_kingdee_save_forces_draft_and_returns_external_reference(self):
        transport = FakeTransport([
            (200, {"LoginResultType": 1}, {}),
            (200, {
                "Result": {
                    "ResponseStatus": {
                        "IsSuccess": True,
                        "SuccessEntitys": [{"Id": 88, "Number": "记-0088"}],
                    }
                }
            }, {}),
        ])
        connector = KingdeeK3CloudConnector(
            {
                "baseUrl": "http://127.0.0.1:9999",
                "environment": "测试环境",
                "accountId": "acct",
                "username": "integration-user",
                "ledger": "人民币账套",
            },
            "password",
            transport,
        )
        result = connector.save_voucher_draft(
            {
                "accountingDate": "2026-07-24",
                "voucherType": "记",
                "lines": [
                    {"summary": "采购", "accountCode": "1403", "debitCents": 10000, "creditCents": 0},
                    {"summary": "应付", "accountCode": "2202", "debitCents": 0, "creditCents": 10000},
                ],
            },
            "idem-1",
        )
        self.assertEqual(result["externalId"], "88")
        save_request = transport.requests[1]
        self.assertIn('"IsAutoSubmitAndAudit": false', save_request["payload"][1])
        self.assertIn('"FReference": "idem-1"', save_request["payload"][1])

    def test_kingdee_error_code_is_mapped_to_user_action(self):
        error = map_kingdee_error(
            200,
            {
                "Result": {
                    "ResponseStatus": {
                        "IsSuccess": False,
                        "ErrorCode": 9,
                        "Errors": [{"Message": "科目 1403 不存在"}],
                    }
                }
            },
        )
        self.assertEqual(error.code, "MASTER_DATA_MISSING")
        self.assertEqual(error.category, "master_data")
        self.assertFalse(error.retryable)
        self.assertIn("1403", error.detail)

    def test_yonyou_and_inspur_profiles_force_draft_and_send_dimensions(self):
        for adapter in ("yonyou-u8-openapi-v12", "inspur-gscloud-igix"):
            with self.subTest(adapter=adapter):
                transport = FakeTransport([
                    (200, {"ok": True}, {}),
                    (200, {"data": {"id": "EXT-88", "number": "记-0088", "status": "draft"}}, {}),
                ])
                connector = ConfiguredFinanceConnector(
                    {
                        "adapter": adapter,
                        "baseUrl": "http://127.0.0.1:9999",
                        "environment": "测试环境",
                        "accountId": "acct",
                        "username": "integration-user",
                        "ledger": "测试账簿",
                        "endpointProfile": {
                            "probe": {"path": "/probe"},
                            "masterData": {"path": "/master"},
                            "period": {"path": "/period"},
                            "saveDraft": {"path": "/voucher/draft"},
                            "queryVoucher": {"path": "/voucher/query"},
                            "queryByReference": {"path": "/voucher/reference"},
                        },
                        "fieldProfile": {
                            "version": "customer-v1",
                            "probeOkPath": "ok",
                            "voucherEnvelopeKey": "voucher",
                            "voucherFields": {
                                "accountingDate": "date",
                                "voucherType": "word",
                                "reference": "reference",
                                "lines": "entries",
                            },
                            "lineFields": {
                                "summary": "summary",
                                "accountCode": "account",
                                "debit": "debit",
                                "credit": "credit",
                            },
                            "externalIdPath": "data.id",
                            "externalNumberPath": "data.number",
                            "statusPath": "data.status",
                        },
                        "dimensionFieldMap": {"department": "departmentCode", "supplier": "supplierCode"},
                    },
                    "token",
                    transport,
                )
                report = connector.probe()
                self.assertIn("save_voucher_draft", report["capabilities"])
                result = connector.save_voucher_draft(
                    {
                        "accountingDate": "2026-07-24",
                        "voucherType": "记",
                        "lines": [{
                            "summary": "采购",
                            "accountCode": "1403",
                            "debitCents": 10000,
                            "creditCents": 0,
                            "dimensions": {"department": "D01", "supplier": "S01"},
                        }],
                    },
                    "idem-profile-1",
                )
                self.assertEqual(result["externalId"], "EXT-88")
                payload = transport.requests[1]["payload"]
                self.assertTrue(payload["draft"])
                self.assertFalse(payload["autoSubmit"])
                self.assertFalse(payload["autoAudit"])
                self.assertFalse(payload["autoPost"])
                self.assertEqual(payload["voucher"]["entries"][0]["departmentCode"], "D01")
                self.assertEqual(payload["voucher"]["entries"][0]["supplierCode"], "S01")

    def test_configured_finance_rejects_unmapped_dimensions(self):
        connector = ConfiguredFinanceConnector(
            {
                "baseUrl": "http://127.0.0.1:9999",
                "environment": "测试环境",
                "endpointProfile": {"saveDraft": {"path": "/draft"}},
                "fieldProfile": {
                    "voucherFields": {
                        "accountingDate": "date",
                        "voucherType": "word",
                        "reference": "reference",
                        "lines": "entries",
                    },
                    "lineFields": {
                        "summary": "summary",
                        "accountCode": "account",
                        "debit": "debit",
                        "credit": "credit",
                    },
                },
                "dimensionFieldMap": {},
            },
            "token",
            FakeTransport([]),
        )
        with self.assertRaisesRegex(ConnectorError, "辅助核算缺少目标字段映射"):
            connector.save_voucher_draft(
                {
                    "accountingDate": "2026-07-24",
                    "lines": [{
                        "summary": "采购",
                        "accountCode": "1403",
                        "debitCents": 100,
                        "creditCents": 0,
                        "dimensions": {"project": "P01"},
                    }],
                },
                "idem-2",
            )


if __name__ == "__main__":
    unittest.main()
