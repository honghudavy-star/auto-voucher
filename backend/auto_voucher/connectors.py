from __future__ import annotations

import json
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from http.cookiejar import CookieJar
from typing import Any, Protocol


class Transport(Protocol):
    def request(
        self,
        method: str,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        payload: Any = None,
        timeout: int = 20,
    ) -> tuple[int, dict[str, Any], dict[str, str]]: ...


@dataclass
class ConnectorError(Exception):
    code: str
    message: str
    category: str = "remote_error"
    retryable: bool = False
    detail: str = ""

    def __str__(self) -> str:
        return self.message

    def as_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "category": self.category,
            "retryable": self.retryable,
            "detail": self.detail,
        }


class JsonHttpTransport:
    """Small session-aware JSON transport for official HTTP APIs."""

    def __init__(self) -> None:
        context = ssl.create_default_context()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(CookieJar()),
            urllib.request.HTTPSHandler(context=context),
        )

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        payload: Any = None,
        timeout: int = 20,
    ) -> tuple[int, dict[str, Any], dict[str, str]]:
        data = None
        request_headers = {"Accept": "application/json", **(headers or {})}
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            request_headers.setdefault("Content-Type", "application/json; charset=utf-8")
        request = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers=request_headers,
        )
        try:
            with self.opener.open(request, timeout=timeout) as response:
                raw = response.read()
                body = json.loads(raw.decode("utf-8")) if raw else {}
                return response.status, body, dict(response.headers.items())
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            try:
                body = json.loads(raw.decode("utf-8")) if raw else {}
            except (UnicodeDecodeError, json.JSONDecodeError):
                body = {"message": raw.decode("utf-8", errors="replace")[:500]}
            return exc.code, body, dict(exc.headers.items())
        except (urllib.error.URLError, TimeoutError) as exc:
            raise ConnectorError(
                "NETWORK_ERROR",
                "无法连接目标系统，请检查地址、网络和证书",
                category="network",
                retryable=True,
                detail=str(exc),
            ) from exc


def require_fields(config: dict[str, Any], fields: tuple[str, ...]) -> None:
    missing = [field for field in fields if not str(config.get(field, "")).strip()]
    if missing:
        raise ConnectorError(
            "CONFIG_MISSING",
            f"连接器缺少配置：{', '.join(missing)}",
            category="configuration",
        )


def normalize_base_url(value: str, *, production: bool) -> str:
    url = value.strip().rstrip("/")
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ConnectorError("INVALID_URL", "连接器地址必须是完整的 HTTP(S) 地址", "configuration")
    if production and parsed.scheme != "https":
        raise ConnectorError(
            "HTTPS_REQUIRED",
            "生产环境连接器必须使用 HTTPS",
            category="security",
        )
    return url


def json_path_value(payload: Any, path: str, default: Any = None) -> Any:
    current = payload
    for part in (segment for segment in str(path or "").split(".") if segment):
        if isinstance(current, dict):
            current = current.get(part, default)
        elif isinstance(current, list) and part.isdigit() and int(part) < len(current):
            current = current[int(part)]
        else:
            return default
    return current


class OaJsonApiConnector:
    """Read-only adapter for OA APIs that expose approval records as JSON."""

    connector_type = "oa-json-api"
    capabilities = ("json_record_sync", "field_mapping")

    def __init__(
        self,
        config: dict[str, Any],
        access_token: str,
        transport: Transport | None = None,
    ) -> None:
        self.config = config
        self.access_token = access_token
        self.transport = transport or JsonHttpTransport()
        self.url = normalize_base_url(
            str(config.get("baseUrl") or ""),
            production=config.get("environment") == "生产环境",
        )

    def _headers(self) -> dict[str, str]:
        if not self.access_token:
            raise ConnectorError("SECRET_MISSING", "OA API 访问密钥尚未保存到系统密钥库", "configuration")
        header = str(self.config.get("authHeader") or "Authorization").strip()
        scheme = str(self.config["authScheme"] if "authScheme" in self.config else "Bearer").strip()
        value = f"{scheme} {self.access_token}".strip()
        return {header: value}

    def _records(self, body: Any) -> list[dict[str, Any]]:
        records = json_path_value(body, str(self.config.get("recordsPath") or ""), body)
        if not isinstance(records, list):
            raise ConnectorError(
                "JSON_RECORDS_PATH_INVALID",
                "记录路径没有指向 JSON 数组，请检查接口响应与记录路径",
                "configuration",
            )
        return [item for item in records if isinstance(item, dict)]

    def probe(self) -> dict[str, Any]:
        started = time.monotonic()
        status, body, headers = self.transport.request("GET", self.url, headers=self._headers())
        if status < 200 or status >= 300:
            raise ConnectorError("OA_API_ERROR", f"OA API 返回 HTTP {status}", "remote_error")
        records = self._records(body)
        return {
            "ok": True,
            "latencyMs": round((time.monotonic() - started) * 1000),
            "identity": {"provider": self.config.get("providerName") or "通用 OA"},
            "scope": {
                "recordsPath": self.config.get("recordsPath") or "",
                "sampleCount": len(records),
            },
            "capabilities": list(self.capabilities),
            "requestId": headers.get("X-Request-Id") or headers.get("x-request-id"),
            "serverTimeChecked": True,
        }

    def sync_approved_instances(self, _cursor: dict[str, Any] | None = None) -> dict[str, Any]:
        status, body, _headers = self.transport.request("GET", self.url, headers=self._headers())
        if status < 200 or status >= 300:
            raise ConnectorError("OA_API_ERROR", f"OA API 返回 HTTP {status}", "remote_error")
        records = self._records(body)
        status_path = str(self.config.get("approvalStatusPath") or "").strip()
        approved_values = {str(item) for item in self.config.get("approvedValues") or []}
        if status_path and approved_values:
            records = [
                item for item in records
                if str(json_path_value(item, status_path, "")) in approved_values
            ]
        return {"items": records, "cursor": {}, "hasMore": False}


class FeishuApprovalConnector:
    connector_type = "feishu-approval-v4"
    sync_cursor_version = 6
    initial_backfill_days = 365
    capabilities = (
        "approval_definition_read",
        "approval_incremental_sync",
        "approval_instance_query",
    )
    platform_base_urls = {
        "feishu": "https://open.feishu.cn",
        "lark": "https://open.larksuite.com",
    }

    def __init__(
        self,
        config: dict[str, Any],
        app_secret: str,
        transport: Transport | None = None,
    ) -> None:
        self.config = config
        self.app_secret = app_secret
        self.transport = transport or JsonHttpTransport()
        configured_platform = str(config.get("platform") or "").strip().lower()
        if not configured_platform:
            configured_platform = (
                "lark"
                if "larksuite.com" in str(config.get("baseUrl") or "").lower()
                else "feishu"
            )
        if configured_platform not in self.platform_base_urls:
            raise ConnectorError(
                "CONFIG_INVALID",
                "飞书平台必须选择中国大陆飞书或海外 Lark",
                "configuration",
            )
        self.platform = configured_platform
        self.base_url = self.platform_base_urls[self.platform]

    def _token(self) -> str:
        require_fields(self.config, ("appId",))
        if not self.app_secret:
            raise ConnectorError("SECRET_MISSING", "飞书 App Secret 尚未保存到系统密钥库", "configuration")
        status, body, _headers = self.transport.request(
            "POST",
            f"{self.base_url}/open-apis/auth/v3/tenant_access_token/internal",
            payload={"app_id": self.config["appId"], "app_secret": self.app_secret},
        )
        if status != 200 or body.get("code", 0) != 0 or not body.get("tenant_access_token"):
            raise map_feishu_error(status, body)
        return str(body["tenant_access_token"])

    def probe(self) -> dict[str, Any]:
        started = time.monotonic()
        self._token()
        return {
            "ok": True,
            "latencyMs": round((time.monotonic() - started) * 1000),
            "identity": {"appId": self.config["appId"]},
            "scope": {
                "platform": self.platform,
                "approvalCodeConfigured": bool(str(self.config.get("approvalCode") or "").strip()),
            },
            "capabilities": list(self.capabilities),
            "tenantTokenIssued": True,
        }

    @staticmethod
    def _form_fields(value: Any) -> list[dict[str, Any]]:
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                return []
        fields: list[dict[str, Any]] = []
        seen: set[str] = set()

        def walk(node: Any) -> None:
            if isinstance(node, list):
                for item in node:
                    walk(item)
                return
            if not isinstance(node, dict):
                return
            field_id = str(
                node.get("id")
                or node.get("widget_id")
                or node.get("field_id")
                or node.get("key")
                or ""
            ).strip()
            field_name = str(
                node.get("name")
                or node.get("widget_name")
                or node.get("label")
                or node.get("title")
                or ""
            ).strip()
            if field_id and field_name and field_id not in seen:
                required_value = node.get("required", node.get("is_required", False))
                required = (
                    required_value
                    if isinstance(required_value, bool)
                    else str(required_value).strip().lower() in {"1", "true", "yes"}
                )
                fields.append({
                    "id": field_id,
                    "name": field_name,
                    "type": str(
                        node.get("type")
                        or node.get("widget_type")
                        or node.get("field_type")
                        or ""
                    ),
                    "required": required,
                })
                seen.add(field_id)
            for child_key in (
                "children",
                "items",
                "widgets",
                "fields",
                "form",
                "form_content",
                "value",
            ):
                child = node.get(child_key)
                if isinstance(child, (dict, list)):
                    walk(child)

        walk(value)
        return fields

    def read_approval_fields(self) -> dict[str, Any]:
        require_fields(self.config, ("approvalCode",))
        token = self._token()
        status, body, headers = self.transport.request(
            "GET",
            f"{self.base_url}/open-apis/approval/v4/approvals/"
            f"{urllib.parse.quote(str(self.config['approvalCode']))}",
            headers={"Authorization": f"Bearer {token}"},
        )
        if status != 200 or body.get("code", 0) != 0:
            raise map_feishu_error(status, body)
        data = body.get("data") or {}
        form = (
            data.get("form")
            or data.get("form_content")
            or data.get("approval_form")
            or []
        )
        return {
            "approvalCode": self.config["approvalCode"],
            "approvalName": str(
                data.get("approval_name")
                or data.get("name")
                or data.get("approvalName")
                or ""
            ),
            "fields": self._form_fields(form),
            "requestId": headers.get("X-Request-Id") or headers.get("x-request-id"),
        }

    def sync_approved_instances(self, cursor: dict[str, Any] | None = None) -> dict[str, Any]:
        require_fields(self.config, ("approvalCode",))
        now_seconds = int(time.time())
        query_date_from = str(self.config.get("queryDateFrom") or "").strip()
        query_date_to = str(self.config.get("queryDateTo") or "").strip()

        def completion_date(raw_timestamp: Any) -> str:
            try:
                timestamp = int(str(raw_timestamp or "").strip())
            except ValueError:
                return ""
            if timestamp <= 0:
                return ""
            seconds = timestamp / 1000 if abs(timestamp) >= 10_000_000_000 else timestamp
            return datetime.fromtimestamp(seconds, tz=timezone.utc).date().isoformat()

        def completion_in_query_range(raw_timestamp: Any) -> bool:
            completed_on = completion_date(raw_timestamp)
            if not completed_on:
                return True
            return (
                (not query_date_from or completed_on >= query_date_from)
                and (not query_date_to or completed_on <= query_date_to)
            )

        supplied_cursor = cursor or {}
        current_cursor = (
            supplied_cursor
            if supplied_cursor.get("version") == self.sync_cursor_version
            else {}
        )
        page_token = str(current_cursor.get("pageToken") or "")
        range_end = now_seconds
        if page_token:
            start_time = int(current_cursor.get("startTime") or current_cursor.get("endTime"))
            end_time = int(current_cursor.get("endTime"))
        else:
            initial_start_time = now_seconds - self.initial_backfill_days * 24 * 3600
            if query_date_from:
                try:
                    completion_range_start = datetime.fromisoformat(
                        f"{query_date_from}T00:00:00+00:00"
                    ).astimezone(timezone.utc)
                    initial_start_time = int(
                        (
                            completion_range_start
                            - timedelta(days=self.initial_backfill_days)
                        ).timestamp()
                    )
                except ValueError:
                    pass
            start_time = int(current_cursor.get("endTime") or initial_start_time)
            end_time = min(now_seconds, start_time + 29 * 24 * 3600)
        token = self._token()
        payload: dict[str, Any] = {
            "approval_code": self.config["approvalCode"],
            "instance_status": "APPROVED",
            "instance_start_time_from": str(start_time * 1000),
            "instance_start_time_to": str(end_time * 1000),
        }
        query = {"page_size": 200}
        if page_token:
            query["page_token"] = page_token
        status, body, _headers = self.transport.request(
            "POST",
            f"{self.base_url}/open-apis/approval/v4/instances/query?"
            f"{urllib.parse.urlencode(query)}",
            headers={"Authorization": f"Bearer {token}"},
            payload=payload,
        )
        if status != 200 or body.get("code", 0) != 0:
            raise map_feishu_error(status, body)
        data = body.get("data") or {}
        raw_instances = (
            data.get("instance_code_list")
            or data.get("instance_codes")
            or data.get("instance_list")
            or []
        )
        known_instance_codes = {
            str(instance_code or "").strip()
            for instance_code in self.config.get("_knownInstanceCodes", [])
            if str(instance_code or "").strip()
        }
        instance_codes: list[str] = []
        for item in raw_instances:
            if isinstance(item, dict):
                nested_instance = item.get("instance") or {}
                if not completion_in_query_range(
                    nested_instance.get("end_time")
                    or nested_instance.get("endTime")
                    or item.get("end_time")
                    or item.get("endTime")
                ):
                    continue
                instance_code = (
                    nested_instance.get("code")
                    or nested_instance.get("instance_code")
                    or item.get("instance_code")
                    or item.get("code")
                    or ""
                )
            else:
                instance_code = item
            normalized_code = str(instance_code or "").strip()
            if normalized_code in known_instance_codes:
                continue
            if normalized_code and normalized_code not in instance_codes:
                instance_codes.append(normalized_code)
        def fetch_approved_instance(instance_code: str) -> dict[str, Any] | None:
            detail_status, detail, _detail_headers = self.transport.request(
                "GET",
                f"{self.base_url}/open-apis/approval/v4/instances/{urllib.parse.quote(str(instance_code))}",
                headers={"Authorization": f"Bearer {token}"},
            )
            if detail_status != 200 or detail.get("code", 0) != 0:
                raise map_feishu_error(detail_status, detail)
            instance = (detail.get("data") or {}).get("instance") or detail.get("data") or {}
            if str(instance.get("status", "")).upper() != "APPROVED":
                return None
            if not completion_in_query_range(
                instance.get("end_time") or instance.get("endTime")
            ):
                return None
            return instance

        if isinstance(self.transport, JsonHttpTransport) and len(instance_codes) > 1:
            with ThreadPoolExecutor(max_workers=min(10, len(instance_codes))) as executor:
                fetched_instances = executor.map(fetch_approved_instance, instance_codes)
                approved = [instance for instance in fetched_instances if instance is not None]
        else:
            approved = [
                instance
                for instance_code in instance_codes
                if (instance := fetch_approved_instance(instance_code)) is not None
            ]
        remote_has_more = bool(data.get("has_more"))
        has_more = remote_has_more or end_time < range_end
        next_cursor = {
            "version": self.sync_cursor_version,
            "pageToken": data.get("page_token") if remote_has_more else "",
            "endTime": end_time,
        }
        if remote_has_more:
            next_cursor["startTime"] = start_time
        return {
            "items": approved,
            "cursor": next_cursor,
            "hasMore": has_more,
        }


KINGDEE_ERROR_MAP = {
    1: ("SESSION_LOST", "金蝶会话已失效，需要重新登录", "authentication", True),
    2: ("PERMISSION_DENIED", "金蝶账号没有所需操作权限", "permission", False),
    7: ("LICENSE_ERROR", "金蝶许可不允许当前接口操作", "license", False),
    8: ("INVALID_ARGUMENT", "金蝶接口参数错误", "validation", False),
    9: ("MASTER_DATA_MISSING", "金蝶基础资料字段或值不存在", "master_data", False),
    10: ("NOT_FOUND", "金蝶未找到对应数据", "not_found", False),
    11: ("VALIDATION_FAILED", "金蝶业务校验失败", "validation", False),
    12: ("NOT_OPERABLE", "金蝶当前状态不允许执行该操作", "state", False),
    13: ("NETWORK_CONTROL_CONFLICT", "金蝶网控冲突", "conflict", True),
    14: ("RATE_LIMITED", "金蝶接口调用受限，请稍后重试", "rate_limit", True),
    15: ("ADMIN_LOGIN_FORBIDDEN", "金蝶禁止管理员账号用于接口登录", "security", False),
}


class KingdeeK3CloudConnector:
    connector_type = "kingdee-k3cloud-webapi-v6"
    auth_mode = "app-id-secret-v3"
    default_capabilities = (
        "save_voucher_draft",
        "query_voucher",
        "query_master_data",
    )

    def __init__(
        self,
        config: dict[str, Any],
        app_secret: str,
        sdk_factory: Any | None = None,
    ) -> None:
        self.config = config
        self.app_secret = app_secret
        self.sdk_factory = sdk_factory
        self.server_url = normalize_base_url(
            str(config.get("serverUrl") or config.get("baseUrl") or ""),
            production=config.get("environment") == "生产环境",
        )
        self.acct_id = str(config.get("acctId") or config.get("accountId") or "").strip()
        self._sdk_client: Any | None = None

    def _sdk(self) -> Any:
        if self._sdk_client is not None:
            return self._sdk_client
        require_fields(self.config, ("username", "appId"))
        if not self.acct_id:
            raise ConnectorError("CONFIG_MISSING", "连接器缺少配置：acctId", "configuration")
        if not self.app_secret:
            raise ConnectorError(
                "SECRET_MISSING",
                "金蝶 AppSecret 尚未保存到系统密钥库",
                "configuration",
            )
        try:
            if self.sdk_factory is None:
                from k3cloud_webapi_sdk.main import K3CloudApiSdk

                sdk = K3CloudApiSdk(server_url=self.server_url)
            elif callable(self.sdk_factory):
                sdk = self.sdk_factory(self.server_url)
            else:
                sdk = self.sdk_factory
            sdk.InitConfig(
                self.acct_id,
                str(self.config["username"]),
                str(self.config["appId"]),
                self.app_secret,
                self.server_url,
                int(self.config.get("localeId") or 2052),
                int(self.config.get("orgNum") or 80016),
                int(self.config.get("connectTimeout") or 120),
                int(self.config.get("requestTimeout") or 120),
            )
        except ConnectorError:
            raise
        except ImportError as exc:
            raise ConnectorError(
                "SDK_MISSING",
                "当前安装缺少金蝶官方 Python SDK",
                "configuration",
                detail=str(exc),
            ) from exc
        except Exception as exc:
            raise _map_kingdee_sdk_exception(exc, "初始化") from exc
        self._sdk_client = sdk
        return sdk

    def _call_json(self, operation: str, *args: Any) -> Any:
        try:
            raw = getattr(self._sdk(), operation)(*args)
        except ConnectorError:
            raise
        except Exception as exc:
            raise _map_kingdee_sdk_exception(exc, operation) from exc
        if isinstance(raw, (dict, list)):
            body = raw
        else:
            try:
                body = json.loads(str(raw))
            except (TypeError, ValueError) as exc:
                raise ConnectorError(
                    "INVALID_RESPONSE",
                    "金蝶返回了无法解析的响应",
                    "remote_error",
                    detail=f"{operation}: {str(raw)[:300]}",
                ) from exc
        def error_payload(value: Any) -> dict[str, Any] | None:
            if isinstance(value, dict):
                response_status = value.get("ResponseStatus")
                if isinstance(response_status, dict) and response_status.get("IsSuccess") is False:
                    return value
                result = value.get("Result")
                if isinstance(result, dict):
                    response_status = result.get("ResponseStatus")
                    if isinstance(response_status, dict) and response_status.get("IsSuccess") is False:
                        return value
                for nested in value.values():
                    found = error_payload(nested)
                    if found:
                        return found
            elif isinstance(value, list):
                for nested in value:
                    found = error_payload(nested)
                    if found:
                        return found
            return None

        nested_error = error_payload(body)
        if nested_error:
            raise map_kingdee_error(200, nested_error)
        return body

    def probe(self) -> dict[str, Any]:
        started = time.monotonic()
        books = self.query_master_data(
            "BD_AccountBook",
            ["FBOOKID", "FNumber", "FName"],
            limit=1,
        )
        capabilities = list(self.default_capabilities)
        period_query = self.config.get("periodQuery") or {}
        if period_query.get("formId"):
            require_fields(period_query, ("periodField", "statusField", "filterTemplate"))
        if period_query.get("formId") or self.config.get("openPeriods"):
            capabilities.append("query_period")
        read_models = self.config.get("readModels") or {}
        enabled_models = {
            key: value for key, value in read_models.items()
            if value.get("enabled")
        }
        for key, model in enabled_models.items():
            require_fields(model, ("formId", "filterTemplate"))
            if not model.get("fields"):
                raise ConnectorError(
                    "CONFIG_MISSING",
                    f"只读查询模型 {key} 缺少字段列表",
                    "configuration",
                )
        if "ledger" in enabled_models:
            capabilities.append("query_ledger")
        if all(key in enabled_models for key in ("balanceSheet", "incomeStatement", "cashFlow")):
            capabilities.append("query_financial_reports")
        return {
            "ok": True,
            "latencyMs": round((time.monotonic() - started) * 1000),
            "identity": {
                "username": self.config["username"],
                "appId": self.config["appId"],
            },
            "scope": {
                "acctId": self.acct_id,
                "ledger": self.config.get("ledger"),
                "orgNum": self.config.get("orgNum") or "80016",
            },
            "capabilities": capabilities,
            "remoteQueryChecked": True,
            "sampleAccountBookCount": len(books),
        }

    def query_master_data(
        self,
        form_id: str,
        field_keys: list[str],
        filter_string: str = "",
        limit: int = 100_000,
    ) -> list[Any]:
        if not form_id.strip():
            raise ConnectorError("INVALID_ARGUMENT", "金蝶 FormId 不能为空", "validation")
        if not field_keys:
            raise ConnectorError("INVALID_ARGUMENT", "金蝶查询字段不能为空", "validation")
        max_rows = min(max(int(limit), 1), 100_000)
        page_size = min(max_rows, 2_000)
        rows: list[Any] = []
        while len(rows) < max_rows:
            payload = {
                "FormId": form_id,
                "FieldKeys": ",".join(field_keys),
                "FilterString": filter_string,
                "OrderString": "",
                "TopRowCount": 0,
                "StartRow": len(rows),
                "Limit": min(page_size, max_rows - len(rows)),
            }
            body = self._call_json(
                "ExecuteBillQuery",
                json.dumps(payload, ensure_ascii=False),
            )
            page = body if isinstance(body, list) else body.get("Result", [])
            if not isinstance(page, list):
                raise ConnectorError(
                    "INVALID_RESPONSE",
                    "金蝶基础资料查询结果不是数组",
                    "remote_error",
                )
            rows.extend(page)
            if len(page) < payload["Limit"]:
                break
        return rows

    def sync_master_data(self, queries: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [
            {
                "name": query.get("name") or query.get("formId"),
                "rows": self.query_master_data(
                    str(query["formId"]),
                    list(query.get("fieldKeys") or []),
                    str(query.get("filterString") or ""),
                    int(query.get("limit") or 2000),
                ),
            }
            for query in queries
        ]

    def check_period(self, period: str) -> dict[str, Any]:
        query = self.config.get("periodQuery") or {}
        if query.get("formId"):
            require_fields(query, ("periodField", "statusField", "filterTemplate"))
            filter_string = str(query["filterTemplate"]).replace("{period}", period.replace("'", "''"))
            rows = self.query_master_data(
                str(query["formId"]),
                [str(query["periodField"]), str(query["statusField"])],
                filter_string,
                limit=10,
            )
            if not rows:
                return {"period": period, "open": None, "source": "target-system", "status": "not-found"}
            row = rows[0]
            if isinstance(row, list):
                raw_period = row[0] if row else ""
                raw_status = row[1] if len(row) > 1 else ""
            else:
                raw_period = row.get(str(query["periodField"]))
                raw_status = row.get(str(query["statusField"]))
            open_values = {str(value) for value in query.get("openValues", [])}
            return {
                "period": str(raw_period or period),
                "open": str(raw_status) in open_values,
                "source": "target-system",
                "status": str(raw_status),
            }
        open_periods = {str(item) for item in self.config.get("openPeriods", [])}
        closed_periods = {str(item) for item in self.config.get("closedPeriods", [])}
        if period in closed_periods:
            return {"period": period, "open": False, "source": "connector-config"}
        if open_periods:
            return {"period": period, "open": period in open_periods, "source": "connector-config"}
        return {"period": period, "open": None, "source": "not-configured"}

    def query_read_model(self, model_key: str, parameters: dict[str, str]) -> dict[str, Any]:
        model = (self.config.get("readModels") or {}).get(model_key) or {}
        if not model.get("enabled"):
            raise ConnectorError(
                "CAPABILITY_UNAVAILABLE",
                f"目标版本未启用只读查询模型：{model_key}",
                "configuration",
            )
        require_fields(model, ("formId", "filterTemplate"))
        fields = [str(field).strip() for field in model.get("fields", []) if str(field).strip()]
        if not fields:
            raise ConnectorError("CONFIG_MISSING", "只读查询模型缺少字段列表", "configuration")
        filter_string = str(model["filterTemplate"])
        for name in ("ledger", "period", "account", "dimension"):
            safe_value = str(parameters.get(name) or "").replace("'", "''")
            filter_string = filter_string.replace(f"{{{name}}}", safe_value)
        rows = self.query_master_data(
            str(model["formId"]),
            fields,
            filter_string,
            limit=int(model.get("limit") or 2000),
        )
        return {
            "modelKey": model_key,
            "formId": model["formId"],
            "fields": fields,
            "rows": [
                dict(zip(fields, row)) if isinstance(row, list) else row
                for row in rows
            ],
            "filter": filter_string,
            "source": "target-system-live-query",
        }

    def save_voucher_draft(self, voucher: dict[str, Any], idempotency_key: str) -> dict[str, Any]:
        form_id = str(self.config.get("voucherFormId") or "GL_VOUCHER")
        dimension_field_map = self.config.get("dimensionFieldMap") or {}
        accounting_date = str(voucher.get("accountingDate") or "")
        try:
            year, month, _day = (int(part) for part in accounting_date.split("-", 2))
        except (TypeError, ValueError) as exc:
            raise ConnectorError(
                "INVALID_ACCOUNTING_DATE",
                "凭证日期必须使用 YYYY-MM-DD",
                "validation",
            ) from exc
        marker = f"CVN:{idempotency_key}"

        def mapped_dimensions(line: dict[str, Any]) -> dict[str, Any]:
            dimensions = line.get("dimensions") or {}
            missing = [
                name for name, value in dimensions.items()
                if value not in (None, "") and not dimension_field_map.get(name)
            ]
            if missing:
                raise ConnectorError(
                    "DIMENSION_MAPPING_MISSING",
                    f"金蝶辅助核算缺少目标字段映射：{', '.join(sorted(missing))}",
                    "validation",
                )
            return {
                str(dimension_field_map[name]): {"FNumber": value}
                for name, value in dimensions.items()
                if value not in (None, "") and dimension_field_map.get(name)
            }

        model = {
            "FAccountBookID": {"FNumber": self.config.get("ledger")},
            "FDate": f"{accounting_date} 00:00:00",
            "FBUSDATE": f"{accounting_date} 00:00:00",
            "FYEAR": year,
            "FPERIOD": month,
            "FVOUCHERGROUPID": {
                "FNumber": self.config.get("voucherGroup") or "PZZ47"
            },
            "FSourceBillKey": {"FNumber": idempotency_key},
            "FDocumentStatus": "Z",
            "_antiDuplicate": idempotency_key,
            "FEntity": [
                {
                    "FEXPLANATION": _kingdee_explanation(
                        str(line.get("summary") or voucher.get("summary") or ""),
                        marker,
                    ),
                    "FACCOUNTID": {"FNumber": line.get("accountCode")},
                    "FCURRENCYID": {
                        "FNumber": line.get("currency")
                        or self.config.get("currencyCode")
                        or "PRE001"
                    },
                    "FEXCHANGERATETYPE": {
                        "FNumber": line.get("exchangeRateType")
                        or self.config.get("exchangeRateType")
                        or "001"
                    },
                    "FEXCHANGERATE": str(line.get("exchangeRate") or 1),
                    "FAMOUNTFOR": _kingdee_amount(
                        (
                            line.get("originalAmountCents")
                            if line.get("originalAmountCents") is not None
                            else line.get("debitCents") or line.get("creditCents") or 0
                        )
                    ),
                    "FDEBIT": _kingdee_amount(line.get("debitCents") or 0),
                    "FCREDIT": _kingdee_amount(line.get("creditCents") or 0),
                    **mapped_dimensions(line),
                }
                for line in voucher.get("lines", [])
            ],
        }
        save_payload = {
            "NeedUpDateFields": [],
            "NeedReturnFields": [],
            "IsDeleteEntry": "true",
            "SubSystemId": "",
            "IsVerifyBaseDataField": "false",
            "IsEntryBatchFill": "true",
            "ValidateFlag": "true",
            "NumberSearch": "true",
            "IsAutoAdjustField": "true",
            "ValidateRepeatJson": "true",
            "IsAutoSubmitAndAudit": False,
            "Model": model,
        }
        body = self._call_json("Save", form_id, save_payload)
        response_status = body.get("Result", {}).get("ResponseStatus") or body.get("ResponseStatus") or {}
        result = body.get("Result") or {}
        entity = (response_status.get("SuccessEntitys") or [{}])[0]
        external_id = entity.get("Id") or result.get("Id")
        external_number = entity.get("Number") or result.get("Number")
        if not external_id or not external_number:
            raise ConnectorError(
                "EXTERNAL_REFERENCE_MISSING",
                "金蝶保存成功但没有返回凭证 ID 和编号",
                "validation",
            )
        return {
            "externalId": str(external_id),
            "externalNumber": str(external_number),
            "status": "saved",
            "rawStatus": response_status,
        }

    def query_voucher(self, *, number: str = "", external_id: str = "") -> dict[str, Any] | None:
        form_id = str(self.config.get("voucherFormId") or "GL_VOUCHER")
        selector = {
            "CreateOrgId": 0,
            "Number": number,
            "Id": "" if number else external_id,
            "IsSortBySeq": "false" if number else "true",
        }
        body = self._call_json(
            "View",
            form_id,
            json.dumps(selector, ensure_ascii=False),
        )
        result = body.get("Result") if isinstance(body, dict) else None
        if not result:
            return None
        response_status = result.get("ResponseStatus") or {}
        if response_status and response_status.get("IsSuccess") is False:
            error = map_kingdee_error(200, body)
            if error.code == "NOT_FOUND":
                return None
            raise error
        model = result.get("Result") or result.get("Model") or result
        return {
            "externalId": str(model.get("Id") or model.get("FID") or external_id),
            "externalNumber": str(model.get("Number") or model.get("FBillNo") or number),
            "status": str(model.get("DocumentStatus") or model.get("FDocumentStatus") or "saved"),
            "raw": model,
        }

    def query_voucher_by_reference(self, idempotency_key: str) -> dict[str, Any] | None:
        form_id = str(self.config.get("voucherFormId") or "GL_VOUCHER")
        field_keys = ["FVOUCHERID", "FBillNo", "FDocumentStatus"]
        escaped = f"CVN:{idempotency_key}".replace("'", "''")
        payload = {
            "FormId": form_id,
            "FieldKeys": ",".join(field_keys),
            "FilterString": f"FEXPLANATION LIKE '%{escaped}%'",
            "OrderString": "FBillNo ASC",
            "TopRowCount": 20,
            "StartRow": 0,
            "Limit": 20,
        }
        body = self._call_json(
            "ExecuteBillQuery",
            json.dumps(payload, ensure_ascii=False),
        )
        rows = body if isinstance(body, list) else body.get("Result", [])
        if not rows:
            return None
        unique: dict[str, dict[str, Any]] = {}
        for raw_row in rows:
            row = dict(zip(field_keys, raw_row)) if isinstance(raw_row, list) else raw_row
            voucher_id = str(row.get("FVOUCHERID") or "")
            if voucher_id:
                unique[voucher_id] = row
        if len(unique) != 1:
            raise ConnectorError(
                "IDEMPOTENCY_REFERENCE_AMBIGUOUS",
                "按幂等标记回查到多张金蝶凭证，需要人工核对",
                "conflict",
            )
        row = next(iter(unique.values()))
        return {
            "externalId": str(row.get("FVOUCHERID") or ""),
            "externalNumber": str(row.get("FBillNo") or ""),
            "status": str(row.get("FDocumentStatus") or "saved"),
            "raw": row,
        }

    def query_by_idempotency_reference(self, idempotency_key: str) -> dict[str, Any] | None:
        return self.query_voucher_by_reference(idempotency_key)


def _map_kingdee_sdk_exception(exc: Exception, operation: str) -> ConnectorError:
    detail = str(exc)[:1000]
    try:
        body = json.loads(detail)
    except (TypeError, ValueError):
        body = None
    if isinstance(body, dict):
        return map_kingdee_error(500, body)
    lowered = detail.lower()
    if any(marker in lowered for marker in ("timeout", "timed out", "connection", "network")):
        return ConnectorError(
            "NETWORK_ERROR",
            "无法连接金蝶，请检查服务器地址、网络和证书",
            "network",
            True,
            detail,
        )
    if any(marker in detail for marker in ("授权", "签名", "身份", "应用密钥")):
        return ConnectorError(
            "AUTHENTICATION_FAILED",
            "金蝶 AppID/AppSecret 认证失败",
            "authentication",
            False,
            detail,
        )
    return ConnectorError(
        "KINGDEE_SDK_ERROR",
        f"金蝶 {operation} 调用失败",
        "remote_error",
        False,
        detail,
    )


def _kingdee_amount(cents: Any) -> str:
    try:
        return f"{int(cents) / 100:.2f}"
    except (TypeError, ValueError) as exc:
        raise ConnectorError("INVALID_AMOUNT", "凭证金额必须是整数分", "validation") from exc


def _kingdee_explanation(summary: str, marker: str, max_length: int = 200) -> str:
    suffix = f" | {marker}"
    if marker in summary:
        return summary[:max_length]
    if not summary:
        return marker[-max_length:]
    return f"{summary[:max(0, max_length - len(suffix))]}{suffix}"


def _path_value(payload: Any, path: str, default: Any = None) -> Any:
    current = payload
    for part in str(path or "").split("."):
        if not part:
            continue
        if isinstance(current, dict):
            current = current.get(part, default)
        elif isinstance(current, list) and part.isdigit() and int(part) < len(current):
            current = current[int(part)]
        else:
            return default
    return current


class ConfiguredFinanceConnector:
    """Version-configured adapter for vendor APIs whose field models vary by release.

    Endpoint paths and every voucher/dimension field name must come from the
    customer's official interface package. The adapter deliberately has no
    guessed vendor endpoints.
    """

    connector_type = "configured-finance"
    required_endpoints = (
        "probe",
        "masterData",
        "period",
        "saveDraft",
        "queryVoucher",
        "queryByReference",
    )
    capabilities = (
        "save_voucher_draft",
        "query_voucher",
        "query_master_data",
        "query_period",
    )

    def __init__(
        self,
        config: dict[str, Any],
        access_token: str,
        transport: Transport | None = None,
    ) -> None:
        self.config = config
        self.access_token = access_token
        self.transport = transport or JsonHttpTransport()
        self.base_url = normalize_base_url(
            str(config.get("baseUrl") or ""),
            production=config.get("environment") == "生产环境",
        )

    def _profile(self, name: str) -> dict[str, Any]:
        profile = (self.config.get("endpointProfile") or {}).get(name) or {}
        require_fields(profile, ("path",))
        return profile

    def _headers(self) -> dict[str, str]:
        if not self.access_token:
            raise ConnectorError("SECRET_MISSING", "访问令牌尚未保存到系统密钥库", "configuration")
        header = str(self.config.get("authHeader") or "Authorization")
        scheme = str(self.config.get("authScheme") or "Bearer").strip()
        value = f"{scheme} {self.access_token}".strip()
        return {header: value}

    def _request(self, profile_name: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        profile = self._profile(profile_name)
        method = str(profile.get("method") or "POST").upper()
        url = f"{self.base_url}/{str(profile['path']).lstrip('/')}"
        request_payload = payload
        if method == "GET" and payload:
            query = urllib.parse.urlencode(
                {key: value for key, value in payload.items() if value is not None},
                doseq=True,
            )
            if query:
                separator = "&" if urllib.parse.urlparse(url).query else "?"
                url = f"{url}{separator}{query}"
            request_payload = None
        status, body, _headers = self.transport.request(
            method,
            url,
            headers=self._headers(),
            payload=request_payload,
        )
        if status in {401, 403}:
            raise ConnectorError("PERMISSION_DENIED", "目标系统身份或权限校验失败", "permission")
        if status == 429:
            raise ConnectorError("RATE_LIMITED", "目标系统接口限流，请稍后重试", "rate_limit", True)
        if status >= 500:
            raise ConnectorError("REMOTE_UNAVAILABLE", "目标系统服务暂时不可用", "remote_error", True)
        if status >= 400:
            raise ConnectorError(
                "REMOTE_VALIDATION_FAILED",
                str(_path_value(body, (self.config.get("fieldProfile") or {}).get("errorMessagePath"), "目标系统拒绝请求")),
                "validation",
            )
        return body

    def probe(self) -> dict[str, Any]:
        started = time.monotonic()
        missing = [
            name for name in self.required_endpoints
            if not ((self.config.get("endpointProfile") or {}).get(name) or {}).get("path")
        ]
        if missing:
            raise ConnectorError(
                "VERSION_PROFILE_INCOMPLETE",
                f"目标版本接口配置不完整：{', '.join(missing)}",
                "configuration",
            )
        body = self._request("probe", {"accountId": self.config.get("accountId"), "ledger": self.config.get("ledger")})
        fields = self.config.get("fieldProfile") or {}
        ok_path = str(fields.get("probeOkPath") or "")
        if ok_path and _path_value(body, ok_path) is not True:
            raise ConnectorError("PROBE_FAILED", "目标系统能力探测未通过", "validation")
        return {
            "ok": True,
            "latencyMs": round((time.monotonic() - started) * 1000),
            "identity": {"username": self.config.get("username")},
            "scope": {"accountId": self.config.get("accountId"), "ledger": self.config.get("ledger")},
            "capabilities": list(self.capabilities),
            "profileVersion": str(fields.get("version") or ""),
            "raw": body,
        }

    def query_master_data(
        self,
        form_id: str,
        field_keys: list[str],
        filter_string: str = "",
        limit: int = 2000,
    ) -> list[Any]:
        body = self._request("masterData", {
            "resource": form_id,
            "fields": field_keys,
            "filter": filter_string,
            "limit": min(max(limit, 1), 10_000),
        })
        path = str((self.config.get("fieldProfile") or {}).get("masterDataRowsPath") or "")
        if not path:
            raise ConnectorError("FIELD_PROFILE_INCOMPLETE", "基础资料响应行路径未配置", "configuration")
        rows = _path_value(body, path, [])
        if not isinstance(rows, list):
            raise ConnectorError("INVALID_RESPONSE", "基础资料响应不是数组", "validation")
        return rows

    def sync_master_data(self, queries: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [
            {
                "name": query.get("name") or query.get("formId"),
                "rows": self.query_master_data(
                    str(query["formId"]),
                    list(query.get("fieldKeys") or []),
                    str(query.get("filterString") or ""),
                    int(query.get("limit") or 2000),
                ),
            }
            for query in queries
        ]

    def check_period(self, period: str) -> dict[str, Any]:
        body = self._request("period", {"period": period, "ledger": self.config.get("ledger")})
        path = str((self.config.get("fieldProfile") or {}).get("periodOpenPath") or "")
        if not path:
            raise ConnectorError("FIELD_PROFILE_INCOMPLETE", "期间开放状态路径未配置", "configuration")
        return {
            "period": period,
            "open": _path_value(body, path) is True,
            "source": "target-system",
            "raw": body,
        }

    def _voucher_payload(self, voucher: dict[str, Any], idempotency_key: str) -> dict[str, Any]:
        profile = self.config.get("fieldProfile") or {}
        voucher_fields = profile.get("voucherFields") or {}
        line_fields = profile.get("lineFields") or {}
        required_voucher = ("accountingDate", "voucherType", "reference", "lines")
        required_line = ("summary", "accountCode", "debit", "credit")
        missing = [name for name in required_voucher if not voucher_fields.get(name)]
        missing += [f"line.{name}" for name in required_line if not line_fields.get(name)]
        if missing:
            raise ConnectorError(
                "FIELD_PROFILE_INCOMPLETE",
                f"凭证字段模型不完整：{', '.join(missing)}",
                "configuration",
            )
        dimension_map = self.config.get("dimensionFieldMap") or {}
        lines = []
        for line in voucher.get("lines", []):
            dimensions = line.get("dimensions") or {}
            missing_dimensions = [
                name for name, value in dimensions.items()
                if value not in (None, "") and not dimension_map.get(name)
            ]
            if missing_dimensions:
                raise ConnectorError(
                    "DIMENSION_MAPPING_MISSING",
                    f"辅助核算缺少目标字段映射：{', '.join(sorted(missing_dimensions))}",
                    "validation",
                )
            target_line = {
                line_fields["summary"]: line.get("summary"),
                line_fields["accountCode"]: line.get("accountCode"),
                line_fields["debit"]: (line.get("debitCents") or 0) / 100,
                line_fields["credit"]: (line.get("creditCents") or 0) / 100,
            }
            target_line.update({
                str(dimension_map[name]): value
                for name, value in dimensions.items()
                if value not in (None, "") and dimension_map.get(name)
            })
            lines.append(target_line)
        model = {
            voucher_fields["accountingDate"]: voucher.get("accountingDate"),
            voucher_fields["voucherType"]: voucher.get("voucherType") or "记",
            voucher_fields["reference"]: idempotency_key,
            voucher_fields["lines"]: lines,
        }
        envelope = str(profile.get("voucherEnvelopeKey") or "")
        payload = {envelope: model} if envelope else model
        payload.update({
            str(profile.get("draftFlagField") or "draft"): True,
            str(profile.get("autoSubmitField") or "autoSubmit"): False,
            str(profile.get("autoAuditField") or "autoAudit"): False,
            str(profile.get("autoPostField") or "autoPost"): False,
        })
        return payload

    def _external_reference(self, body: dict[str, Any]) -> dict[str, Any]:
        fields = self.config.get("fieldProfile") or {}
        id_path = str(fields.get("externalIdPath") or "")
        number_path = str(fields.get("externalNumberPath") or "")
        if not id_path or not number_path:
            raise ConnectorError("FIELD_PROFILE_INCOMPLETE", "外部凭证编号响应路径未配置", "configuration")
        external_id = str(_path_value(body, id_path, "") or "")
        external_number = str(_path_value(body, number_path, "") or "")
        if not external_id or not external_number:
            raise ConnectorError("EXTERNAL_REFERENCE_MISSING", "保存结果未返回真实外部编号", "validation")
        status_path = str(fields.get("statusPath") or "")
        return {
            "externalId": external_id,
            "externalNumber": external_number,
            "status": str(_path_value(body, status_path, "saved") if status_path else "saved"),
            "raw": body,
        }

    def save_voucher_draft(self, voucher: dict[str, Any], idempotency_key: str) -> dict[str, Any]:
        return self._external_reference(
            self._request("saveDraft", self._voucher_payload(voucher, idempotency_key))
        )

    def query_voucher(self, *, number: str = "", external_id: str = "") -> dict[str, Any] | None:
        body = self._request("queryVoucher", {"number": number, "externalId": external_id})
        found_path = str((self.config.get("fieldProfile") or {}).get("foundPath") or "")
        if found_path and _path_value(body, found_path) is not True:
            return None
        return self._external_reference(body)

    def query_voucher_by_reference(self, idempotency_key: str) -> dict[str, Any] | None:
        body = self._request("queryByReference", {"reference": idempotency_key})
        found_path = str((self.config.get("fieldProfile") or {}).get("foundPath") or "")
        if found_path and _path_value(body, found_path) is not True:
            return None
        return self._external_reference(body)

    def query_by_idempotency_reference(self, idempotency_key: str) -> dict[str, Any] | None:
        return self.query_voucher_by_reference(idempotency_key)


def map_feishu_error(http_status: int, body: dict[str, Any]) -> ConnectorError:
    code = str(body.get("code") or http_status or "UNKNOWN")
    message = str(body.get("msg") or body.get("message") or "飞书接口调用失败")
    if http_status == 429:
        return ConnectorError(code, "飞书接口限流，请稍后重试", "rate_limit", True, message)
    if http_status in {401, 403}:
        return ConnectorError(code, "飞书身份或审批权限校验失败", "permission", False, message)
    if http_status >= 500:
        return ConnectorError(code, "飞书服务暂时不可用", "remote_error", True, message)
    return ConnectorError(code, message, "validation", False)


def map_kingdee_error(http_status: int, body: dict[str, Any]) -> ConnectorError:
    response_status = (
        body.get("Result", {}).get("ResponseStatus")
        or body.get("ResponseStatus")
        or {}
        if isinstance(body, dict)
        else {}
    )
    numeric_code = response_status.get("ErrorCode")
    try:
        numeric_code = int(numeric_code)
    except (TypeError, ValueError):
        numeric_code = 0
    errors = response_status.get("Errors") or []
    detail = "；".join(str(item.get("Message") or item) for item in errors[:5])
    if numeric_code in KINGDEE_ERROR_MAP:
        code, message, category, retryable = KINGDEE_ERROR_MAP[numeric_code]
        return ConnectorError(code, message, category, retryable, detail)
    if http_status == 429:
        return ConnectorError("RATE_LIMITED", "金蝶接口限流，请稍后重试", "rate_limit", True, detail)
    if http_status in {401, 403}:
        return ConnectorError("PERMISSION_DENIED", "金蝶身份或权限校验失败", "permission", False, detail)
    if http_status >= 500:
        return ConnectorError("REMOTE_ERROR", "金蝶服务暂时不可用", "remote_error", True, detail)
    return ConnectorError(
        str(numeric_code or http_status or "UNKNOWN"),
        detail or str(body.get("Message") if isinstance(body, dict) else "金蝶接口调用失败"),
        "remote_error",
        False,
        detail,
    )
