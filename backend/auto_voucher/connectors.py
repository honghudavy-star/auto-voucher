from __future__ import annotations

import json
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
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


class FeishuApprovalConnector:
    connector_type = "feishu-approval-v4"
    capabilities = ("approval_incremental_sync", "approval_instance_query")

    def __init__(
        self,
        config: dict[str, Any],
        app_secret: str,
        transport: Transport | None = None,
    ) -> None:
        self.config = config
        self.app_secret = app_secret
        self.transport = transport or JsonHttpTransport()
        self.base_url = normalize_base_url(
            config.get("baseUrl") or "https://open.feishu.cn",
            production=config.get("environment") == "生产环境",
        )

    def _token(self) -> str:
        require_fields(self.config, ("appId", "approvalCode"))
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
        token = self._token()
        status, body, headers = self.transport.request(
            "GET",
            f"{self.base_url}/open-apis/approval/v4/approvals/{urllib.parse.quote(self.config['approvalCode'])}",
            headers={"Authorization": f"Bearer {token}"},
        )
        if status != 200 or body.get("code", 0) != 0:
            raise map_feishu_error(status, body)
        return {
            "ok": True,
            "latencyMs": round((time.monotonic() - started) * 1000),
            "identity": {"appId": self.config["appId"]},
            "scope": {"approvalCode": self.config["approvalCode"]},
            "capabilities": list(self.capabilities),
            "requestId": headers.get("X-Request-Id") or headers.get("x-request-id"),
            "serverTimeChecked": True,
        }

    def sync_approved_instances(self, cursor: dict[str, Any] | None = None) -> dict[str, Any]:
        token = self._token()
        now_seconds = int(time.time())
        current_cursor = cursor or {}
        page_token = str(current_cursor.get("pageToken") or "")
        if page_token:
            start_time = int(current_cursor.get("startTime") or current_cursor.get("endTime"))
            end_time = int(current_cursor.get("endTime"))
        else:
            start_time = int(current_cursor.get("endTime") or now_seconds - 7 * 24 * 3600)
            end_time = now_seconds
        payload: dict[str, Any] = {
            "approval_code": self.config["approvalCode"],
            "start_time": str(start_time),
            "end_time": str(end_time),
            "page_size": 100,
        }
        if page_token:
            payload["page_token"] = page_token
        status, body, _headers = self.transport.request(
            "POST",
            f"{self.base_url}/open-apis/approval/v4/instances",
            headers={"Authorization": f"Bearer {token}"},
            payload=payload,
        )
        if status != 200 or body.get("code", 0) != 0:
            raise map_feishu_error(status, body)
        data = body.get("data") or {}
        instance_codes = data.get("instance_code_list") or data.get("instance_codes") or []
        approved: list[dict[str, Any]] = []
        for instance_code in instance_codes:
            detail_status, detail, _detail_headers = self.transport.request(
                "GET",
                f"{self.base_url}/open-apis/approval/v4/instances/{urllib.parse.quote(str(instance_code))}",
                headers={"Authorization": f"Bearer {token}"},
            )
            if detail_status != 200 or detail.get("code", 0) != 0:
                raise map_feishu_error(detail_status, detail)
            instance = (detail.get("data") or {}).get("instance") or detail.get("data") or {}
            if str(instance.get("status", "")).upper() == "APPROVED":
                approved.append(instance)
        has_more = bool(data.get("has_more"))
        next_cursor = {
            "endTime": end_time,
            "pageToken": data.get("page_token") if has_more else "",
        }
        if has_more:
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
    default_capabilities = (
        "save_voucher_draft",
        "query_voucher",
        "query_master_data",
    )

    def __init__(
        self,
        config: dict[str, Any],
        password: str,
        transport: Transport | None = None,
    ) -> None:
        self.config = config
        self.password = password
        self.transport = transport or JsonHttpTransport()
        self.base_url = normalize_base_url(
            str(config.get("baseUrl") or ""),
            production=config.get("environment") == "生产环境",
        )

    def _endpoint(self, service: str) -> str:
        return f"{self.base_url}/K3Cloud/Kingdee.BOS.WebApi.ServicesStub.{service}.common.kdsvc"

    def login(self) -> dict[str, Any]:
        require_fields(self.config, ("accountId", "username"))
        if not self.password:
            raise ConnectorError("SECRET_MISSING", "金蝶密码尚未保存到系统密钥库", "configuration")
        status, body, _headers = self.transport.request(
            "POST",
            self._endpoint("AuthService.ValidateUser"),
            payload=[
                self.config["accountId"],
                self.config["username"],
                self.password,
                int(self.config.get("localeId") or 2052),
            ],
        )
        if status != 200:
            raise map_kingdee_error(status, body)
        login_result = body.get("LoginResultType")
        if login_result not in (None, 1) and not body.get("IsSuccessByAPI"):
            raise ConnectorError(
                "AUTHENTICATION_FAILED",
                str(body.get("Message") or "金蝶登录失败"),
                "authentication",
            )
        return body

    def probe(self) -> dict[str, Any]:
        started = time.monotonic()
        login = self.login()
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
            "identity": {"username": self.config["username"]},
            "scope": {
                "accountId": self.config["accountId"],
                "ledger": self.config.get("ledger"),
            },
            "capabilities": capabilities,
            "serverTimeChecked": True,
            "loginContext": login.get("Context") or {},
        }

    def query_master_data(
        self,
        form_id: str,
        field_keys: list[str],
        filter_string: str = "",
        limit: int = 2000,
    ) -> list[Any]:
        self.login()
        payload = {
            "FormId": form_id,
            "FieldKeys": ",".join(field_keys),
            "FilterString": filter_string,
            "OrderString": "",
            "TopRowCount": min(max(limit, 1), 10_000),
            "StartRow": 0,
            "Limit": min(max(limit, 1), 10_000),
        }
        status, body, _headers = self.transport.request(
            "POST",
            self._endpoint("DynamicFormService.ExecuteBillQuery"),
            payload=[json.dumps(payload, ensure_ascii=False)],
        )
        if status != 200 or isinstance(body, dict) and body.get("ResponseStatus", {}).get("IsSuccess") is False:
            raise map_kingdee_error(status, body)
        return body if isinstance(body, list) else body.get("Result", [])

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
        self.login()
        form_id = str(self.config.get("voucherFormId") or "GL_VOUCHER")
        dimension_field_map = self.config.get("dimensionFieldMap") or {}

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
            "FDate": voucher.get("accountingDate"),
            "FVOUCHERGROUPID": {"FNumber": voucher.get("voucherType") or "记"},
            "FReference": idempotency_key,
            "FEntity": [
                {
                    "FEXPLANATION": line.get("summary"),
                    "FACCOUNTID": {"FNumber": line.get("accountCode")},
                    "FDEBIT": (line.get("debitCents") or 0) / 100,
                    "FCREDIT": (line.get("creditCents") or 0) / 100,
                    **mapped_dimensions(line),
                }
                for line in voucher.get("lines", [])
            ],
        }
        save_payload = {
            "Creator": "",
            "NeedUpDateFields": [],
            "NeedReturnFields": ["FID", "FBillNo"],
            "IsDeleteEntry": False,
            "IsVerifyBaseDataField": True,
            "IsEntryBatchFill": True,
            "IsAutoSubmitAndAudit": False,
            "Model": model,
        }
        status, body, _headers = self.transport.request(
            "POST",
            self._endpoint("DynamicFormService.Save"),
            payload=[form_id, json.dumps(save_payload, ensure_ascii=False)],
        )
        response_status = body.get("Result", {}).get("ResponseStatus") or body.get("ResponseStatus") or {}
        if status != 200 or response_status.get("IsSuccess") is not True:
            raise map_kingdee_error(status, body)
        entity = (response_status.get("SuccessEntitys") or [{}])[0]
        return {
            "externalId": str(entity.get("Id") or ""),
            "externalNumber": str(entity.get("Number") or ""),
            "status": "saved",
            "rawStatus": response_status,
        }

    def query_voucher(self, *, number: str = "", external_id: str = "") -> dict[str, Any] | None:
        self.login()
        form_id = str(self.config.get("voucherFormId") or "GL_VOUCHER")
        selector = {"Number": number} if number else {"Id": external_id}
        status, body, _headers = self.transport.request(
            "POST",
            self._endpoint("DynamicFormService.View"),
            payload=[form_id, json.dumps(selector, ensure_ascii=False)],
        )
        result = body.get("Result") if isinstance(body, dict) else None
        if status != 200:
            raise map_kingdee_error(status, body)
        if not result:
            return None
        response_status = result.get("ResponseStatus") or {}
        if response_status and response_status.get("IsSuccess") is False:
            error = map_kingdee_error(status, body)
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
        self.login()
        form_id = str(self.config.get("voucherFormId") or "GL_VOUCHER")
        field_keys = ["FID", "FBillNo", "FDocumentStatus", "FReference"]
        escaped = idempotency_key.replace("'", "''")
        payload = {
            "FormId": form_id,
            "FieldKeys": ",".join(field_keys),
            "FilterString": f"FReference='{escaped}'",
            "OrderString": "",
            "TopRowCount": 1,
            "StartRow": 0,
            "Limit": 1,
        }
        status, body, _headers = self.transport.request(
            "POST",
            self._endpoint("DynamicFormService.ExecuteBillQuery"),
            payload=[json.dumps(payload, ensure_ascii=False)],
        )
        if status != 200:
            raise map_kingdee_error(status, body)
        rows = body if isinstance(body, list) else body.get("Result", [])
        if not rows:
            return None
        row = rows[0]
        if isinstance(row, list):
            row = dict(zip(field_keys, row))
        return {
            "externalId": str(row.get("FID") or ""),
            "externalNumber": str(row.get("FBillNo") or ""),
            "status": str(row.get("FDocumentStatus") or "saved"),
            "raw": row,
        }

    def query_by_idempotency_reference(self, idempotency_key: str) -> dict[str, Any] | None:
        return self.query_voucher_by_reference(idempotency_key)


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
