from __future__ import annotations

import json
import unittest
import urllib.parse
from datetime import datetime, timezone

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


class FakeKingdeeSdk:
    def __init__(self, *, bill_queries=None, saves=None, views=None):
        self.bill_queries = list(bill_queries or [])
        self.saves = list(saves or [])
        self.views = list(views or [])
        self.init_args = None
        self.calls = []

    def InitConfig(self, *args):
        self.init_args = args

    def ExecuteBillQuery(self, data):
        self.calls.append(("ExecuteBillQuery", data))
        if not self.bill_queries:
            raise AssertionError("没有为 ExecuteBillQuery 准备响应")
        return json.dumps(self.bill_queries.pop(0), ensure_ascii=False)

    def Save(self, form_id, data):
        self.calls.append(("Save", form_id, data))
        if not self.saves:
            raise AssertionError("没有为 Save 准备响应")
        return json.dumps(self.saves.pop(0), ensure_ascii=False)

    def View(self, form_id, data):
        self.calls.append(("View", form_id, data))
        if not self.views:
            raise AssertionError("没有为 View 准备响应")
        return json.dumps(self.views.pop(0), ensure_ascii=False)


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

    def test_feishu_probe_only_checks_base_credentials(self):
        transport = FakeTransport([
            (200, {"code": 0, "tenant_access_token": "t-test"}, {}),
        ])
        connector = FeishuApprovalConnector(
            {
                "appId": "cli-test",
                "platform": "lark",
                "environment": "测试环境",
            },
            "secret",
            transport,
        )
        report = connector.probe()
        self.assertTrue(report["ok"])
        self.assertEqual(report["scope"]["platform"], "lark")
        self.assertIn("approval_incremental_sync", report["capabilities"])
        self.assertEqual(len(transport.requests), 1)
        self.assertEqual(
            transport.requests[0]["url"],
            "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
        )

    def test_feishu_reads_approval_definition_fields_separately(self):
        transport = FakeTransport([
            (200, {"code": 0, "tenant_access_token": "t-test"}, {}),
            (
                200,
                {
                    "code": 0,
                    "data": {
                        "approval_name": "采购付款",
                        "form": json.dumps([
                            {"id": "amount", "name": "付款金额", "type": "amount", "required": True},
                            {
                                "type": "fieldList",
                                "children": [
                                    {"id": "party", "name": "供应商", "type": "input"},
                                ],
                            },
                        ], ensure_ascii=False),
                    },
                },
                {"X-Request-Id": "req-fields"},
            ),
        ])
        connector = FeishuApprovalConnector(
            {
                "appId": "cli-test",
                "approvalCode": "approval-code",
                "platform": "feishu",
                "environment": "测试环境",
            },
            "secret",
            transport,
        )
        result = connector.read_approval_fields()
        self.assertEqual(result["approvalName"], "采购付款")
        self.assertEqual(
            result["fields"],
            [
                {"id": "amount", "name": "付款金额", "type": "amount", "required": True},
                {"id": "party", "name": "供应商", "type": "input", "required": False},
            ],
        )
        self.assertEqual(result["requestId"], "req-fields")

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
        result = connector.sync_approved_instances({"version": 6, "endTime": 100})
        self.assertEqual([item["instance_code"] for item in result["items"]], ["APPROVED-1"])
        self.assertGreater(result["cursor"]["endTime"], 100)
        request = transport.requests[1]
        parsed = urllib.parse.urlparse(request["url"])
        self.assertEqual(parsed.path, "/open-apis/approval/v4/instances/query")
        self.assertEqual(urllib.parse.parse_qs(parsed.query)["page_size"], ["200"])
        self.assertEqual(request["payload"]["approval_code"], "approval-code")
        self.assertEqual(request["payload"]["instance_status"], "APPROVED")
        self.assertIn("instance_start_time_from", request["payload"])
        self.assertIn("instance_start_time_to", request["payload"])

    def test_lark_instance_list_extracts_nested_instance_codes(self):
        transport = FakeTransport([
            (200, {"code": 0, "tenant_access_token": "t-test"}, {}),
            (200, {
                "code": 0,
                "data": {
                    "instance_list": [
                        {
                            "approval": {"code": "approval-code"},
                            "instance": {
                                "code": "LARK-APPROVED-1",
                                "status": "APPROVED",
                            },
                        },
                    ],
                    "has_more": False,
                    "page_token": "",
                },
            }, {}),
            (200, {
                "code": 0,
                "data": {
                    "instance": {
                        "instance_code": "LARK-APPROVED-1",
                        "status": "APPROVED",
                    },
                },
            }, {}),
        ])
        connector = FeishuApprovalConnector(
            {
                "appId": "cli-test",
                "approvalCode": "approval-code",
                "platform": "lark",
                "environment": "测试环境",
            },
            "secret",
            transport,
        )
        result = connector.sync_approved_instances({"version": 6, "endTime": 100})
        self.assertEqual(
            [item["instance_code"] for item in result["items"]],
            ["LARK-APPROVED-1"],
        )
        self.assertEqual(result["cursor"]["version"], 6)
        self.assertIn(
            "/open-apis/approval/v4/instances/LARK-APPROVED-1",
            transport.requests[2]["url"],
        )

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
        first = connector.sync_approved_instances({"version": 6, "endTime": 100})
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
        self.assertEqual(
            payload["instance_start_time_from"],
            str(cursor["startTime"] * 1000),
        )
        self.assertEqual(
            payload["instance_start_time_to"],
            str(cursor["endTime"] * 1000),
        )
        query = urllib.parse.parse_qs(
            urllib.parse.urlparse(second_transport.requests[1]["url"]).query
        )
        self.assertEqual(query["page_token"], ["next-page"])

    def test_lark_completion_query_range_keeps_incremental_start_window(self):
        completed_in_range = int(
            datetime(2026, 7, 2, tzinfo=timezone.utc).timestamp() * 1000
        )
        transport = FakeTransport([
            (200, {"code": 0, "tenant_access_token": "t-test"}, {}),
            (200, {
                "code": 0,
                "data": {
                    "instance_code_list": ["RECENT-APPROVAL"],
                    "has_more": False,
                },
            }, {}),
            (200, {"code": 0, "data": {"instance": {
                "instance_code": "RECENT-APPROVAL",
                "status": "APPROVED",
                "start_time": "1750000000000",
                "end_time": str(completed_in_range),
            }}}, {}),
        ])
        connector = FeishuApprovalConnector(
            {
                "appId": "cli-test",
                "approvalCode": "approval-code",
                "queryDateFrom": "2026-07-01",
                "queryDateTo": "2026-07-29",
                "environment": "测试环境",
            },
            "secret",
            transport,
        )
        result = connector.sync_approved_instances({"version": 6, "endTime": 100})
        request = transport.requests[1]
        self.assertEqual(request["payload"]["instance_start_time_from"], "100000")
        self.assertIn("instance_start_time_to", request["payload"])
        self.assertEqual(
            [item["instance_code"] for item in result["items"]],
            ["RECENT-APPROVAL"],
        )
        self.assertEqual(result["cursor"]["version"], 6)
        self.assertNotIn("queryDateFrom", result["cursor"])
        self.assertNotIn("queryDateTo", result["cursor"])

    def test_lark_completion_range_filters_search_results_before_detail_fetch(self):
        completed_before_range = int(
            datetime(2026, 6, 30, tzinfo=timezone.utc).timestamp() * 1000
        )
        completed_in_range = int(
            datetime(2026, 7, 2, tzinfo=timezone.utc).timestamp() * 1000
        )
        transport = FakeTransport([
            (200, {"code": 0, "tenant_access_token": "t-test"}, {}),
            (200, {
                "code": 0,
                "data": {
                    "instance_list": [
                        {
                            "instance": {
                                "code": "OUTSIDE-COMPLETION-RANGE",
                                "status": "APPROVED",
                                "end_time": completed_before_range,
                            },
                        },
                        {
                            "instance": {
                                "code": "INSIDE-COMPLETION-RANGE",
                                "status": "APPROVED",
                                "end_time": completed_in_range,
                            },
                        },
                    ],
                    "has_more": False,
                },
            }, {}),
            (200, {"code": 0, "data": {"instance": {
                "instance_code": "INSIDE-COMPLETION-RANGE",
                "status": "APPROVED",
                "end_time": completed_in_range,
            }}}, {}),
        ])
        connector = FeishuApprovalConnector(
            {
                "appId": "cli-test",
                "approvalCode": "approval-code",
                "queryDateFrom": "2026-07-01",
                "queryDateTo": "2026-07-29",
                "environment": "测试环境",
            },
            "secret",
            transport,
        )

        result = connector.sync_approved_instances({"version": 6, "endTime": 100})

        self.assertEqual(
            [item["instance_code"] for item in result["items"]],
            ["INSIDE-COMPLETION-RANGE"],
        )
        detail_urls = [
            request["url"]
            for request in transport.requests
            if (
                "/open-apis/approval/v4/instances/" in request["url"]
                and not request["url"].split("?", 1)[0].endswith("/query")
            )
        ]
        self.assertEqual(len(detail_urls), 1)
        self.assertIn("INSIDE-COMPLETION-RANGE", detail_urls[0])

    def test_lark_backfill_skips_instances_already_stored_locally(self):
        completed_in_range = int(
            datetime(2026, 7, 2, tzinfo=timezone.utc).timestamp() * 1000
        )
        transport = FakeTransport([
            (200, {"code": 0, "tenant_access_token": "t-test"}, {}),
            (200, {
                "code": 0,
                "data": {
                    "instance_list": [
                        {
                            "instance": {
                                "code": "ALREADY-STORED",
                                "status": "APPROVED",
                                "end_time": completed_in_range,
                            },
                        },
                        {
                            "instance": {
                                "code": "MISSING-LOCALLY",
                                "status": "APPROVED",
                                "end_time": completed_in_range,
                            },
                        },
                    ],
                    "has_more": False,
                },
            }, {}),
            (200, {"code": 0, "data": {"instance": {
                "instance_code": "MISSING-LOCALLY",
                "status": "APPROVED",
                "end_time": completed_in_range,
            }}}, {}),
        ])
        connector = FeishuApprovalConnector(
            {
                "appId": "cli-test",
                "approvalCode": "approval-code",
                "queryDateFrom": "2026-07-01",
                "queryDateTo": "2026-07-29",
                "_knownInstanceCodes": ["ALREADY-STORED"],
                "environment": "测试环境",
            },
            "secret",
            transport,
        )

        result = connector.sync_approved_instances({"version": 6, "endTime": 100})

        self.assertEqual(
            [item["instance_code"] for item in result["items"]],
            ["MISSING-LOCALLY"],
        )
        self.assertFalse(any(
            request["url"].split("?", 1)[0].endswith("/ALREADY-STORED")
            for request in transport.requests
        ))

    def test_lark_first_sync_backfills_before_configured_completion_date(self):
        transport = FakeTransport([
            (200, {"code": 0, "tenant_access_token": "t-test"}, {}),
            (200, {
                "code": 0,
                "data": {
                    "instance_code_list": [],
                    "has_more": False,
                },
            }, {}),
        ])
        connector = FeishuApprovalConnector(
            {
                "appId": "cli-test",
                "approvalCode": "approval-code",
                "queryDateFrom": "2026-07-01",
                "queryDateTo": "2026-07-29",
                "environment": "测试环境",
            },
            "secret",
            transport,
        )

        connector.sync_approved_instances()

        expected_start = int(
            datetime(2025, 7, 1, tzinfo=timezone.utc).timestamp() * 1000
        )
        self.assertEqual(
            transport.requests[1]["payload"]["instance_start_time_from"],
            str(expected_start),
        )

    def test_lark_old_start_time_cursor_is_invalidated_for_completion_backfill(self):
        transport = FakeTransport([
            (200, {"code": 0, "tenant_access_token": "t-test"}, {}),
            (200, {
                "code": 0,
                "data": {
                    "instance_code_list": [],
                    "has_more": False,
                },
            }, {}),
        ])
        connector = FeishuApprovalConnector(
            {
                "appId": "cli-test",
                "approvalCode": "approval-code",
                "queryDateFrom": "2026-07-01",
                "queryDateTo": "2026-07-29",
                "environment": "测试环境",
            },
            "secret",
            transport,
        )

        connector.sync_approved_instances({
            "version": 5,
            "endTime": int(datetime(2026, 7, 1, tzinfo=timezone.utc).timestamp()),
        })

        expected_start = int(
            datetime(2025, 7, 1, tzinfo=timezone.utc).timestamp() * 1000
        )
        self.assertEqual(
            transport.requests[1]["payload"]["instance_start_time_from"],
            str(expected_start),
        )

    def test_kingdee_production_rejects_plain_http(self):
        with self.assertRaisesRegex(ConnectorError, "HTTPS"):
            KingdeeK3CloudConnector(
                {
                    "serverUrl": "http://erp.example.com/K3Cloud/",
                    "environment": "生产环境",
                },
                "app-secret",
                FakeKingdeeSdk(),
            )

    def test_kingdee_probe_uses_finweb_app_id_secret_auth_and_real_query(self):
        sdk = FakeKingdeeSdk(bill_queries=[[["88", "017", "测试账簿"]]])
        connector = KingdeeK3CloudConnector(
            {
                "serverUrl": "http://127.0.0.1:9999/K3Cloud/",
                "environment": "测试环境",
                "acctId": "acct",
                "username": "integration-user",
                "appId": "client_encoded-secret",
                "orgNum": "80016",
                "ledger": "017",
                "openPeriods": ["2026-07"],
            },
            "app-secret",
            sdk,
        )
        report = connector.probe()
        self.assertEqual(
            sdk.init_args,
            (
                "acct",
                "integration-user",
                "client_encoded-secret",
                "app-secret",
                "http://127.0.0.1:9999/K3Cloud",
                2052,
                80016,
                120,
                120,
            ),
        )
        query = json.loads(sdk.calls[0][1])
        self.assertEqual(query["FormId"], "BD_AccountBook")
        self.assertEqual(report["sampleAccountBookCount"], 1)
        self.assertIn("save_voucher_draft", report["capabilities"])
        self.assertNotIn("submit_voucher", report["capabilities"])
        self.assertNotIn("audit_voucher", report["capabilities"])
        self.assertIn("query_period", report["capabilities"])

    def test_kingdee_master_data_query_paginates_until_the_last_partial_page(self):
        sdk = FakeKingdeeSdk(bill_queries=[
            [[str(index), f"名称 {index}"] for index in range(2000)],
            [["2000", "名称 2000"]],
        ])
        connector = KingdeeK3CloudConnector(
            {
                "serverUrl": "http://127.0.0.1:9999/K3Cloud/",
                "environment": "测试环境",
                "acctId": "acct",
                "username": "integration-user",
                "appId": "client_encoded-secret",
            },
            "app-secret",
            sdk,
        )
        rows = connector.query_master_data("BD_Account", ["FNumber", "FName"])
        self.assertEqual(len(rows), 2001)
        first_payload = json.loads(sdk.calls[0][1])
        second_payload = json.loads(sdk.calls[1][1])
        self.assertEqual(first_payload["StartRow"], 0)
        self.assertEqual(first_payload["Limit"], 2000)
        self.assertEqual(second_payload["StartRow"], 2000)

    def test_kingdee_period_query_uses_configured_read_only_model(self):
        sdk = FakeKingdeeSdk(bill_queries=[[["2026-07", "OPEN"]]])
        connector = KingdeeK3CloudConnector(
            {
                "serverUrl": "http://127.0.0.1:9999/K3Cloud/",
                "environment": "测试环境",
                "acctId": "acct",
                "username": "integration-user",
                "appId": "client_encoded-secret",
                "periodQuery": {
                    "formId": "CUSTOM_PERIOD",
                    "periodField": "FNumber",
                    "statusField": "FStatus",
                    "filterTemplate": "FNumber='{period}'",
                    "openValues": ["OPEN"],
                },
            },
            "app-secret",
            sdk,
        )
        report = connector.check_period("2026-07")
        self.assertTrue(report["open"])
        self.assertEqual(report["source"], "target-system")
        query_payload = json.loads(sdk.calls[0][1])
        self.assertEqual(query_payload["FormId"], "CUSTOM_PERIOD")
        self.assertEqual(query_payload["FilterString"], "FNumber='2026-07'")

    def test_kingdee_read_model_maps_rows_and_escapes_filter_parameters(self):
        sdk = FakeKingdeeSdk(bill_queries=[[["1001", "库存现金", 88.5]]])
        connector = KingdeeK3CloudConnector(
            {
                "serverUrl": "http://127.0.0.1:9999/K3Cloud/",
                "environment": "测试环境",
                "acctId": "acct",
                "username": "integration-user",
                "appId": "client_encoded-secret",
                "readModels": {
                    "ledger": {
                        "enabled": True,
                        "formId": "CUSTOM_LEDGER",
                        "fields": ["FAccount", "FName", "FBalance"],
                        "filterTemplate": "FPeriod='{period}' AND FAccount='{account}'",
                    }
                },
            },
            "app-secret",
            sdk,
        )
        result = connector.query_read_model(
            "ledger",
            {"period": "2026-07", "account": "10'01"},
        )
        self.assertEqual(result["rows"][0]["FBalance"], 88.5)
        query_payload = json.loads(sdk.calls[0][1])
        self.assertEqual(
            query_payload["FilterString"],
            "FPeriod='2026-07' AND FAccount='10''01'",
        )

    def test_kingdee_save_forces_draft_and_returns_external_reference(self):
        sdk = FakeKingdeeSdk(saves=[{
                "Result": {
                    "ResponseStatus": {
                        "IsSuccess": True,
                        "SuccessEntitys": [{"Id": 88, "Number": "记-0088"}],
                    }
                }
            }])
        connector = KingdeeK3CloudConnector(
            {
                "serverUrl": "http://127.0.0.1:9999/K3Cloud/",
                "environment": "测试环境",
                "acctId": "acct",
                "username": "integration-user",
                "appId": "client_encoded-secret",
                "ledger": "017",
            },
            "app-secret",
            sdk,
        )
        result = connector.save_voucher_draft(
            {
                "accountingDate": "2026-07-24",
                "voucherType": "记",
                "lines": [
                    {
                        "summary": "采购",
                        "accountCode": "1403",
                        "currency": "PRE013",
                        "exchangeRateType": "001",
                        "exchangeRate": "0.0174",
                        "originalAmountCents": 70800,
                        "debitCents": 1232,
                        "creditCents": 0,
                    },
                    {"summary": "应付", "accountCode": "2202", "debitCents": 0, "creditCents": 10000},
                ],
            },
            "idem-1",
        )
        self.assertEqual(result["externalId"], "88")
        _operation, form_id, payload = sdk.calls[0]
        self.assertEqual(form_id, "GL_VOUCHER")
        self.assertFalse(payload["IsAutoSubmitAndAudit"])
        self.assertEqual(payload["Model"]["_antiDuplicate"], "idem-1")
        self.assertEqual(payload["Model"]["FAccountBookID"]["FNumber"], "017")
        self.assertEqual(payload["Model"]["FVOUCHERGROUPID"]["FNumber"], "PZZ47")
        self.assertEqual(payload["Model"]["FEntity"][0]["FCURRENCYID"]["FNumber"], "PRE013")
        self.assertEqual(payload["Model"]["FEntity"][0]["FEXCHANGERATE"], "0.0174")
        self.assertEqual(payload["Model"]["FEntity"][0]["FAMOUNTFOR"], "708.00")
        self.assertEqual(payload["Model"]["FEntity"][0]["FDEBIT"], "12.32")
        self.assertIn("CVN:idem-1", payload["Model"]["FEntity"][0]["FEXPLANATION"])

    def test_kingdee_queries_voucher_detail_through_official_sdk(self):
        sdk = FakeKingdeeSdk(views=[{
            "Result": {
                "ResponseStatus": {"IsSuccess": True},
                "Result": {
                    "Id": 88,
                    "Number": "记-0088",
                    "DocumentStatus": "Z",
                },
            },
        }])
        connector = KingdeeK3CloudConnector(
            {
                "serverUrl": "http://127.0.0.1:9999/K3Cloud/",
                "environment": "测试环境",
                "acctId": "acct",
                "username": "integration-user",
                "appId": "client_encoded-secret",
            },
            "app-secret",
            sdk,
        )
        result = connector.query_voucher(external_id="88")
        self.assertEqual(result["externalId"], "88")
        self.assertEqual(result["externalNumber"], "记-0088")
        _operation, form_id, raw_selector = sdk.calls[0]
        self.assertEqual(form_id, "GL_VOUCHER")
        self.assertEqual(json.loads(raw_selector)["Id"], "88")

    def test_kingdee_idempotency_recheck_uses_finweb_explanation_marker(self):
        sdk = FakeKingdeeSdk(bill_queries=[[
            ["88", "记-0088", "Z"],
            ["88", "记-0088", "Z"],
        ]])
        connector = KingdeeK3CloudConnector(
            {
                "serverUrl": "http://127.0.0.1:9999/K3Cloud/",
                "environment": "测试环境",
                "acctId": "acct",
                "username": "integration-user",
                "appId": "client_encoded-secret",
            },
            "app-secret",
            sdk,
        )
        result = connector.query_voucher_by_reference("idem-1")
        self.assertEqual(result["externalId"], "88")
        query = json.loads(sdk.calls[0][1])
        self.assertEqual(
            query["FilterString"],
            "FEXPLANATION LIKE '%CVN:idem-1%'",
        )

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

    def test_kingdee_query_detects_error_wrapped_inside_result_rows(self):
        sdk = FakeKingdeeSdk(bill_queries=[[
            [{
                "Result": {
                    "ResponseStatus": {
                        "IsSuccess": False,
                        "ErrorCode": 1,
                        "Errors": [{"Message": "字段不存在"}],
                    }
                }
            }]
        ]])
        connector = KingdeeK3CloudConnector(
            {
                "serverUrl": "http://127.0.0.1:9999/K3Cloud/",
                "environment": "测试环境",
                "acctId": "acct",
                "username": "integration-user",
                "appId": "client_encoded-secret",
            },
            "app-secret",
            sdk,
        )
        with self.assertRaises(ConnectorError) as caught:
            connector.query_master_data("BOS_ASSISTANTDATA_DETAIL", ["FNumber", "FName"])
        self.assertIn("字段不存在", caught.exception.detail)

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
