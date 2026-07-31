from __future__ import annotations

import copy
import hashlib
import json
import shutil
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any

from .connectors import (
    ConfiguredFinanceConnector,
    ConnectorError,
    FeishuApprovalConnector,
    KingdeeK3CloudConnector,
    OaJsonApiConnector,
    json_path_value,
)
from .database import Database, utc_now
from .importers import STANDARD_FIELDS, event_from_row, suggest_mapping
from .security import SecretStore, redact_text
from .service import build_idempotency_key
from .setup import (
    APPROVAL_PROFILE_DEFAULTS,
    KINGDEE_MASTER_DATA_QUERIES,
    approval_profile_id,
    connector_template,
    ensure_state_v2,
    legacy_approval_profile,
)


ALLOWED_CONFIG_FIELDS = {
    "name",
    "environment",
    "baseUrl",
    "serverUrl",
    "platform",
    "appId",
    "approvalCode",
    "fieldMapping",
    "accountId",
    "acctId",
    "username",
    "orgNum",
    "ledger",
    "voucherFormId",
    "voucherGroup",
    "currencyCode",
    "exchangeRateType",
    "localeId",
    "connectTimeout",
    "requestTimeout",
    "authMode",
    "approvalControlEnabled",
    "enforceTargetMasterData",
    "enforcePeriodQuery",
    "openPeriods",
    "closedPeriods",
    "periodQuery",
    "readModels",
    "masterDataQueries",
    "endpointProfile",
    "fieldProfile",
    "dimensionFieldMap",
    "authHeader",
    "authScheme",
    "providerName",
    "recordsPath",
    "externalIdPath",
    "approvalStatusPath",
    "approvedValues",
    "enabled",
    "leastPrivilegeConfirmed",
}

FORBIDDEN_CONFIG_MARKERS = ("secret", "password", "token", "privatekey", "certificatepassword")
APPROVAL_MAPPING_FIELDS = {
    "date",
    "counterparty",
    "amount",
    "currency",
    "exchange_rate",
    "reference",
    "department",
    "project",
    "summary",
}
APPROVAL_SOURCE_FIELD_KEYS = {
    "date",
    "counterparty",
    "amount",
    "currency",
    "exchangeRate",
    "reference",
    "company",
    "ledger",
    "businessType",
    "department",
    "project",
    "summary",
}

AUXILIARY_DIMENSION_POLICIES: dict[str, dict[str, str]] = {
    "department": {"label": "部门", "category": "dimensionDepartment"},
    "project": {"label": "项目", "category": "project"},
    "supplier": {"label": "供应商", "category": "dimensionSupplier"},
    "customer": {"label": "客户", "category": "dimensionCustomer"},
    "employee": {"label": "员工", "category": "dimensionEmployee"},
    "material": {"label": "物料", "category": "dimensionMaterial"},
    "expense": {"label": "费用项目", "category": "dimensionExpense"},
    "organization": {"label": "组织机构", "category": "dimensionOrganization"},
    "bank": {"label": "银行", "category": "dimensionBank"},
    "bankAccount": {"label": "银行账号", "category": "dimensionBankAccount"},
    "otherCounterparty": {"label": "其他往来", "category": "dimensionOtherCounterparty"},
    "serviceType": {"label": "服务类型", "category": "dimensionServiceType"},
    "unit": {"label": "Unit", "category": "dimensionUnit"},
    "region": {"label": "入账地区", "category": "dimensionRegion"},
    "oldProject": {"label": "旧项目", "category": "dimensionOldProject"},
    "newProject": {"label": "新项目", "category": "dimensionNewProject"},
}
APPROVAL_SOURCE_REFERENCE_PREFIX = "source:"


def approval_source_event_value(event: dict[str, Any], field: str) -> Any:
    if field == "amount":
        amount_cents = event.get("amountCents")
        if amount_cents in (None, ""):
            return ""
        return str(Decimal(str(amount_cents)) / Decimal("100"))
    event_key = {
        "businessType": "type",
    }.get(field, field)
    return event.get(event_key, "")


def resolve_approval_mapping_value(
    state: dict[str, Any],
    config: dict[str, Any],
    approval_values: dict[str, Any],
    approval_reference: str,
    mapping_value: str,
) -> Any:
    if not mapping_value.startswith(APPROVAL_SOURCE_REFERENCE_PREFIX):
        return approval_values.get(mapping_value, "")
    source_id = mapping_value.removeprefix(APPROVAL_SOURCE_REFERENCE_PREFIX)
    source = next(
        (
            item for item in config.get("fieldSources", [])
            if str(item.get("id") or "") == source_id
        ),
        None,
    )
    if not source:
        return ""
    source_system = str(source.get("sourceSystem") or "")
    matching_event = next(
        (
            event for event in state.get("events", [])
            if (
                (
                    source_system == "local-files"
                    and not str(event.get("sourceSystem") or "")
                )
                or str(event.get("sourceSystem") or "") == source_system
            )
            and approval_reference in {
                str(event.get("reference") or ""),
                str(event.get("externalId") or ""),
            }
        ),
        None,
    )
    if not matching_event:
        return ""
    return approval_source_event_value(
        matching_event,
        str(source.get("field") or ""),
    )


def ensure_connector_defaults(state: dict[str, Any]) -> bool:
    return ensure_state_v2(state)


def approval_profiles(config: dict[str, Any]) -> list[dict[str, Any]]:
    profiles = config.setdefault("approvalProfiles", [])
    if not profiles:
        legacy_profile = legacy_approval_profile(config)
        if legacy_profile:
            profiles.append(legacy_profile)
    return [
        profile
        for profile in profiles
        if isinstance(profile, dict) and str(profile.get("approvalCode") or "").strip()
    ]


def approval_profile_config(
    config: dict[str, Any],
    profile: dict[str, Any],
) -> dict[str, Any]:
    merged = dict(config)
    merged.update({
        key: copy.deepcopy(value)
        for key, value in profile.items()
        if key != "id"
    })
    merged["approvalProfileId"] = str(profile.get("id") or "")
    return merged


def mirror_primary_approval_profile(
    config: dict[str, Any],
    profile: dict[str, Any],
) -> None:
    profiles = approval_profiles(config)
    if not profiles or profiles[0] is not profile:
        return
    config["approvalCode"] = str(profile.get("approvalCode") or "")
    for key, default in APPROVAL_PROFILE_DEFAULTS.items():
        config[key] = copy.deepcopy(profile.get(key, default))


def connector_lock(config: dict[str, Any]) -> str:
    raw = "|".join(
        str(config.get(key) or "")
        for key in (
            "id",
            "adapter",
            "environment",
            "baseUrl",
            "serverUrl",
            "platform",
            "accountId",
            "acctId",
            "appId",
            "orgNum",
            "ledger",
        )
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def parse_feishu_form(instance: dict[str, Any]) -> dict[str, Any]:
    form = instance.get("form") or []
    if isinstance(form, str):
        try:
            form = json.loads(form)
        except json.JSONDecodeError:
            form = []
    collected: dict[str, list[Any]] = {}

    def walk(node: Any) -> None:
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return
        widget_id = str(node.get("id") or node.get("widget_id") or "").strip()
        value = node.get("value")
        if widget_id and not isinstance(value, (dict, list)):
            if value in (None, ""):
                value = node.get("text") or node.get("value_text")
            if value not in (None, ""):
                collected.setdefault(widget_id, []).append(value)
        for child_key in ("value", "children", "items", "fields"):
            child = node.get(child_key)
            if isinstance(child, (dict, list)):
                walk(child)

    walk(form)
    return {
        widget_id: items[0] if len(items) == 1 else items
        for widget_id, items in collected.items()
    }


def normalize_feishu_mapped_value(standard_field: str, value: Any) -> Any:
    items = value if isinstance(value, list) else [value]
    items = [item for item in items if item not in (None, "")]
    if not items:
        return ""
    if standard_field == "amount":
        try:
            return str(sum((Decimal(str(item)) for item in items), Decimal("0")))
        except InvalidOperation:
            return items[0]
    if standard_field == "date":
        return items[0]
    unique_values = list(dict.fromkeys(str(item).strip() for item in items if str(item).strip()))
    return " / ".join(unique_values)


def approval_field_values(
    config: dict[str, Any],
    approval_values: dict[str, Any],
) -> list[dict[str, Any]]:
    return [
        {
            "id": str(field.get("id") or ""),
            "name": str(field.get("name") or field.get("id") or ""),
            "type": str(field.get("type") or ""),
            "value": copy.deepcopy(approval_values.get(str(field.get("id") or ""), "")),
        }
        for field in config.get("approvalFields", [])
        if str(field.get("id") or "")
    ]


def approval_completion_metadata(instance: dict[str, Any]) -> dict[str, str]:
    raw_timestamp = instance.get("end_time") or instance.get("endTime")
    try:
        timestamp = int(str(raw_timestamp or "").strip())
    except ValueError:
        return {}
    if timestamp <= 0:
        return {}
    seconds = timestamp / 1000 if abs(timestamp) >= 10_000_000_000 else timestamp
    completed_at = datetime.fromtimestamp(seconds, tz=timezone.utc)
    return {
        "approvalCompletedAt": completed_at.isoformat(),
        "approvalCompletedDate": completed_at.date().isoformat(),
    }


def feishu_approval_row(
    state: dict[str, Any],
    config: dict[str, Any],
    approval_values: dict[str, Any],
    external_id: str,
    approval_number: str,
) -> dict[str, Any]:
    row: dict[str, Any] = {}
    for standard_field, source_path in (config.get("fieldMapping") or {}).items():
        canonical = STANDARD_FIELDS.get(standard_field)
        if not canonical:
            continue
        source_value = resolve_approval_mapping_value(
            state,
            config,
            approval_values,
            external_id,
            str(source_path),
        )
        row[canonical] = normalize_feishu_mapped_value(standard_field, source_value)
    row.setdefault("业务日期", datetime.now(timezone.utc).date().isoformat())
    row["审批单号"] = approval_number
    row.setdefault("业务类型", config.get("businessType") or "采购付款")
    return row


class ConnectorService:
    def __init__(
        self,
        database: Database,
        secret_store: SecretStore | None = None,
        factories: dict[str, Any] | None = None,
    ) -> None:
        self.database = database
        self.secret_store = secret_store or SecretStore()
        self.factories = factories or {}

    def _state(self) -> dict[str, Any]:
        state = self.database.get_state()
        if state is None:
            raise ValueError("应用尚未初始化")
        if ensure_connector_defaults(state):
            self.database.put_state(state)
        return state

    @staticmethod
    def _config(state: dict[str, Any], connector_id: str) -> dict[str, Any]:
        config = next(
            (item for item in state.get("connectors", []) if item.get("id") == connector_id),
            None,
        )
        if not config:
            raise ValueError("连接器不存在")
        return config

    def configure(
        self,
        connector_id: str,
        values: dict[str, Any],
        production_confirmation: str = "",
    ) -> dict[str, Any]:
        lowered = {key.lower().replace("_", "") for key in values}
        if any(any(marker in key for marker in FORBIDDEN_CONFIG_MARKERS) for key in lowered):
            raise ValueError("密钥、令牌和密码必须通过系统密钥库接口保存")
        unknown = set(values) - ALLOWED_CONFIG_FIELDS
        if unknown:
            raise ValueError(f"不支持的连接器配置字段：{', '.join(sorted(unknown))}")
        state = self._state()
        if not any(item.get("id") == connector_id for item in state.get("connectors", [])):
            state.setdefault("connectors", []).append(connector_template(connector_id))
        config = self._config(state, connector_id)
        next_environment = values.get("environment", config.get("environment"))
        if next_environment not in {"测试环境", "生产环境"}:
            raise ValueError("连接器环境必须是测试环境或生产环境")
        if next_environment == "生产环境" and production_confirmation != "生产环境":
            raise ValueError("切换生产环境必须明确输入“生产环境”")
        if next_environment == "生产环境" and values.get(
            "leastPrivilegeConfirmed",
            config.get("leastPrivilegeConfirmed"),
        ) is not True:
            raise ValueError("生产连接器必须确认使用专用最小权限账号")
        if (
            next_environment == "生产环境"
            and config.get("adapter") == "kingdee-k3cloud-webapi-v6"
        ):
            username = str(values.get("username", config.get("username")) or "").strip().lower()
            if username in {"admin", "administrator", "系统管理员", "administrator@system"}:
                raise ValueError("生产连接器禁止使用管理员账号，请创建专用最小权限集成账号")
        approval_code_changed = False
        if config.get("adapter") == "feishu-approval-v4":
            platform = str(values.get("platform", config.get("platform") or "feishu")).strip().lower()
            if platform not in {"feishu", "lark"}:
                raise ValueError("飞书平台必须选择中国大陆飞书或海外 Lark")
            values["platform"] = platform
            values["baseUrl"] = (
                "https://open.larksuite.com"
                if platform == "lark"
                else "https://open.feishu.cn"
            )
            approval_code_changed = (
                "approvalCode" in values
                and str(values.get("approvalCode") or "").strip()
                != str(config.get("approvalCode") or "").strip()
            )
        for key, value in values.items():
            config[key] = value
        if approval_code_changed:
            config["approvalName"] = ""
            config["approvalFields"] = []
            if not values.get("fieldMapping"):
                config["fieldMapping"] = {}
            config["syncCursor"] = {}
        config["status"] = "configured"
        config["environmentLock"] = connector_lock(config)
        config["environmentLockedAt"] = utc_now()
        config["lastProbe"] = None
        self._audit(
            state,
            "配置连接器",
            config["name"],
            f"适配器 {config['adapter']}；环境 {config['environment']}；密钥未写入业务数据库",
        )
        self.database.put_state(state)
        return {"state": state, "connector": config}

    def configure_approval_query(
        self,
        connector_id: str,
        values: dict[str, Any],
    ) -> dict[str, Any]:
        unknown = set(values) - {
            "approvalCode",
            "profileId",
            "additionalApprovalFieldIds",
            "fieldMapping",
            "fieldSources",
            "queryDateFrom",
            "queryDateTo",
        }
        if unknown:
            raise ValueError(f"不支持的审批查询配置字段：{', '.join(sorted(unknown))}")
        state = self._state()
        config = self._config(state, connector_id)
        if config.get("adapter") != "feishu-approval-v4":
            raise ValueError("只有飞书审批连接器支持审批查询与字段映射")
        approval_code = str(values.get("approvalCode") or "").strip()
        if not approval_code:
            raise ValueError("审批模板编码（approval_code）不能为空")
        profiles = config.setdefault("approvalProfiles", [])
        if not profiles:
            legacy_profile = legacy_approval_profile(config)
            if legacy_profile:
                profiles.append(legacy_profile)
        profile_id = str(values.get("profileId") or "").strip()
        profile = next(
            (
                item for item in profiles
                if isinstance(item, dict) and str(item.get("id") or "") == profile_id
            ),
            None,
        )
        if profile_id and not profile:
            raise ValueError("审批模板配置不存在，请刷新后重试")
        if not profile:
            profile = next(
                (
                    item for item in profiles
                    if isinstance(item, dict)
                    and str(item.get("approvalCode") or "").strip() == approval_code
                ),
                None,
            )
        if not profile:
            profile = {
                "id": approval_profile_id(approval_code),
                "approvalCode": approval_code,
                **copy.deepcopy(APPROVAL_PROFILE_DEFAULTS),
            }
            profiles.append(profile)
        if any(
            item is not profile
            and str(item.get("approvalCode") or "").strip() == approval_code
            for item in profiles
            if isinstance(item, dict)
        ):
            raise ValueError("该 approval_code 已经添加")
        if (
            profiles
            and profiles[0] is profile
            and not profile.get("syncCursor")
            and config.get("syncCursor")
        ):
            profile["syncCursor"] = copy.deepcopy(config["syncCursor"])
        raw_mapping = values.get("fieldMapping") or {}
        if not isinstance(raw_mapping, dict):
            raise ValueError("审批字段映射格式无效")
        raw_field_sources = values.get("fieldSources") or []
        if not isinstance(raw_field_sources, list):
            raise ValueError("其他来源字段格式无效")
        if len(raw_field_sources) > 50:
            raise ValueError("其他来源字段不能超过 50 个")
        allowed_source_systems = {
            "local-files",
            *(
                str(item.get("id") or "")
                for item in state.get("sourceSystems", [])
            ),
            *(
                str(item.get("id") or "")
                for item in state.get("connectors", [])
                if item.get("id") != connector_id and item.get("type") == "workflow"
            ),
        }
        field_sources = []
        known_source_ids: set[str] = set()
        for raw_source in raw_field_sources:
            if not isinstance(raw_source, dict):
                raise ValueError("其他来源字段必须是对象")
            source_id = str(raw_source.get("id") or "").strip()
            source_system = str(raw_source.get("sourceSystem") or "").strip()
            field = str(raw_source.get("field") or "").strip()
            label = str(raw_source.get("label") or "").strip()
            if not source_id or len(source_id) > 80 or source_id in known_source_ids:
                raise ValueError("其他来源字段 ID 无效或重复")
            if source_system not in allowed_source_systems:
                raise ValueError(f"其他来源尚未配置：{source_system or '未选择'}")
            if field not in APPROVAL_SOURCE_FIELD_KEYS:
                raise ValueError(f"不支持的其他来源字段：{field or '未选择'}")
            if not label or len(label) > 80:
                raise ValueError("其他来源字段名称不能为空且不能超过 80 个字符")
            known_source_ids.add(source_id)
            field_sources.append({
                "id": source_id,
                "sourceSystem": source_system,
                "field": field,
                "label": label,
                "matchField": "reference",
            })
        unsupported_mapping = set(raw_mapping) - APPROVAL_MAPPING_FIELDS
        if unsupported_mapping:
            raise ValueError(
                f"不支持的审批业务字段：{', '.join(sorted(unsupported_mapping))}"
            )
        mapping = {
            key: str(value or "").strip()
            for key, value in raw_mapping.items()
            if str(value or "").strip()
        }
        raw_additional_field_ids = values.get("additionalApprovalFieldIds") or []
        if not isinstance(raw_additional_field_ids, list):
            raise ValueError("其他审批字段格式无效")
        if len(raw_additional_field_ids) > 50:
            raise ValueError("其他审批字段不能超过 50 个")
        known_approval_field_ids = {
            str(field.get("id") or "")
            for field in profile.get("approvalFields", [])
            if str(field.get("id") or "")
        }
        additional_approval_field_ids = list(dict.fromkeys(
            str(field_id or "").strip()
            for field_id in raw_additional_field_ids
            if str(field_id or "").strip()
        ))
        unknown_additional_field_ids = (
            set(additional_approval_field_ids) - known_approval_field_ids
        )
        if unknown_additional_field_ids:
            raise ValueError(
                "其他审批字段不存在于当前审批模板："
                + "、".join(sorted(unknown_additional_field_ids))
            )
        mapped_approval_field_ids = {
            value
            for value in mapping.values()
            if not value.startswith(APPROVAL_SOURCE_REFERENCE_PREFIX)
        }
        additional_approval_field_ids = [
            field_id
            for field_id in additional_approval_field_ids
            if field_id not in mapped_approval_field_ids
        ]
        missing_source_references = {
            value.removeprefix(APPROVAL_SOURCE_REFERENCE_PREFIX)
            for value in mapping.values()
            if value.startswith(APPROVAL_SOURCE_REFERENCE_PREFIX)
            and value.removeprefix(APPROVAL_SOURCE_REFERENCE_PREFIX) not in known_source_ids
        }
        if missing_source_references:
            raise ValueError("字段映射引用了不存在的其他来源字段")
        query_date_from = str(values.get("queryDateFrom") or "").strip()
        query_date_to = str(values.get("queryDateTo") or "").strip()
        if bool(query_date_from) != bool(query_date_to):
            raise ValueError("审批记录完成日期必须同时填写开始日期和结束日期")
        if query_date_from:
            try:
                start_date = date.fromisoformat(query_date_from)
                end_date = date.fromisoformat(query_date_to)
            except ValueError as exc:
                raise ValueError("审批记录完成日期格式必须为 YYYY-MM-DD") from exc
            if start_date > end_date:
                raise ValueError("审批记录完成日期的开始日期不能晚于结束日期")
            if end_date > date.today():
                raise ValueError("审批记录完成日期的结束日期不能晚于今天")
            if (end_date - start_date).days > 365:
                raise ValueError("单次审批记录查询范围不能超过 366 天")
        approval_code_changed = approval_code != str(profile.get("approvalCode") or "").strip()
        if approval_code_changed:
            additional_approval_field_ids = []
        mapping_changed = (
            mapping != dict(profile.get("fieldMapping") or {})
            or field_sources != list(profile.get("fieldSources") or [])
            or additional_approval_field_ids
            != list(profile.get("additionalApprovalFieldIds") or [])
        )
        profile["approvalCode"] = approval_code
        profile["fieldMapping"] = mapping
        profile["fieldSources"] = field_sources
        profile["additionalApprovalFieldIds"] = additional_approval_field_ids
        config["queryDateFrom"] = query_date_from
        config["queryDateTo"] = query_date_to
        config["lastApprovalConfigAt"] = utc_now()
        if approval_code_changed or mapping_changed:
            profile["syncCursor"] = {}
        if approval_code_changed:
            profile["id"] = approval_profile_id(approval_code)
            profile["approvalName"] = ""
            profile["approvalFields"] = []
        mirror_primary_approval_profile(config, profile)
        if config.get("status") == "connected":
            config["environmentLock"] = connector_lock(config)
        self._audit(
            state,
            "配置审批查询",
            config["name"],
            (
                f"审批模板 {approval_code or '未填写'}；"
                f"完成日期 {query_date_from or '未填写'} 至 {query_date_to or '未填写'}；"
                f"映射 {len(mapping)} 个业务字段；"
                f"其他审批字段 {len(additional_approval_field_ids)} 个"
            ),
        )
        self.database.put_state(state)
        return {"state": state, "connector": config, "profile": profile}

    def read_approval_fields(
        self,
        connector_id: str,
        profile_id: str = "",
    ) -> dict[str, Any]:
        state = self._state()
        config = self._config(state, connector_id)
        if config.get("adapter") != "feishu-approval-v4":
            raise ValueError("只有飞书审批连接器支持读取审批字段")
        profiles = approval_profiles(config)
        profile = next(
            (
                item for item in profiles
                if str(item.get("id") or "") == str(profile_id or "")
            ),
            None,
        )
        if not profile:
            profile = profiles[0] if len(profiles) == 1 and not profile_id else None
        if not profile:
            raise ValueError("请先保存要读取的 approval_code")
        result = self._adapter(
            approval_profile_config(config, profile)
        ).read_approval_fields()
        fields = result.get("fields") or []
        profile["approvalName"] = str(result.get("approvalName") or "")
        profile["approvalFields"] = fields
        known_field_ids = {
            str(field.get("id") or "")
            for field in fields
            if str(field.get("id") or "")
        }
        profile["additionalApprovalFieldIds"] = [
            str(field_id)
            for field_id in profile.get("additionalApprovalFieldIds", [])
            if str(field_id) in known_field_ids
        ]
        profile["lastApprovalFieldsReadAt"] = utc_now()
        names = [str(item.get("name") or "") for item in fields if item.get("name")]
        suggested_by_name = suggest_mapping(names)
        first_id_by_name = {
            str(item.get("name") or ""): str(item.get("id") or "")
            for item in fields
            if item.get("name") and item.get("id")
        }
        mapping = dict(profile.get("fieldMapping") or {})
        for standard_field, field_name in suggested_by_name.items():
            if standard_field == "reference":
                continue
            source_id = first_id_by_name.get(field_name)
            if source_id and not mapping.get(standard_field):
                mapping[standard_field] = source_id
        profile["fieldMapping"] = mapping
        mirror_primary_approval_profile(config, profile)
        self._audit(
            state,
            "读取飞书审批字段",
            config["name"],
            f"审批 {profile.get('approvalCode')}；读取 {len(fields)} 个字段；未保存访问令牌",
        )
        self.database.put_state(state)
        return {
            "state": state,
            "connector": config,
            "profile": profile,
            "approval": result,
        }

    def _secret(self, connector_id: str, name: str) -> str:
        try:
            return self.secret_store.get(connector_id, name)
        except RuntimeError as exc:
            raise ConnectorError("KEYRING_UNAVAILABLE", str(exc), "security") from exc

    def _adapter(self, config: dict[str, Any]):
        factory = self.factories.get(config["id"]) or self.factories.get(config["adapter"])
        if factory:
            return factory(config)
        if config["adapter"] == "feishu-approval-v4":
            return FeishuApprovalConnector(config, self._secret(config["id"], "app_secret"))
        if config["adapter"] == "oa-json-api":
            return OaJsonApiConnector(config, self._secret(config["id"], "access_token"))
        if config["adapter"] == "kingdee-k3cloud-webapi-v6":
            return KingdeeK3CloudConnector(config, self._secret(config["id"], "app_secret"))
        if config["adapter"] in {"yonyou-u8-openapi-v12", "inspur-gscloud-igix"}:
            return ConfiguredFinanceConnector(
                config,
                self._secret(config["id"], "access_token"),
            )
        raise ConnectorError("ADAPTER_UNSUPPORTED", "当前连接器适配器不受支持", "configuration")

    def _archive_json_response(
        self,
        state: dict[str, Any],
        *,
        name: str,
        document_type: str,
        source_system: str,
        payload: Any,
        external_id: str = "",
    ) -> dict[str, Any] | None:
        raw = json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        digest = hashlib.sha256(raw).hexdigest()
        existing_document = next(
            (
                document
                for document in state.setdefault("sourceDocuments", [])
                if document.get("fullHash") == digest
            ),
            None,
        )
        if existing_document:
            return existing_document
        archive = self.database.archive_dir / digest[:2] / f"{digest}.json"
        archive.parent.mkdir(parents=True, exist_ok=True)
        reserve_bytes = 50 * 1024 * 1024
        if shutil.disk_usage(archive.parent).free < len(raw) + reserve_bytes:
            raise ValueError(
                f"本地磁盘空间不足，无法归档源系统原始响应；数据目录 {self.database.data_dir}"
            )
        if not archive.exists():
            archive.write_bytes(raw)
        self.database.register_source(
            digest,
            name,
            "application/json",
            len(raw),
            archive,
        )
        document = {
            "id": f"DOC-API-{uuid.uuid4().hex[:10].upper()}",
            "name": name,
            "type": document_type,
            "size": len(raw),
            "fullHash": digest,
            "hash": f"{digest[:4]}…{digest[-4:]}",
            "importedAt": utc_now(),
            "sourceSystem": source_system,
            "externalId": external_id,
            "archivePath": str(archive.relative_to(self.database.data_dir)),
            "extractionStatus": "structured",
            "rawResponsePreserved": True,
        }
        state["sourceDocuments"].insert(0, document)
        return document

    def probe(self, connector_id: str) -> dict[str, Any]:
        state = self._state()
        config = self._config(state, connector_id)
        checks = [
            {
                "name": "配置完整性",
                "status": "passed",
                "detail": "连接器元数据从业务数据库读取，密钥从系统密钥库读取",
            }
        ]
        try:
            report = self._adapter(config).probe()
            checks.extend([
                {"name": "身份验证", "status": "passed", "detail": "目标系统接受连接器身份"},
                {"name": "目标范围", "status": "passed", "detail": json.dumps(report.get("scope", {}), ensure_ascii=False)},
                {"name": "能力探测", "status": "passed", "detail": "、".join(report.get("capabilities", []))},
                {"name": "时间连通性", "status": "passed", "detail": f"往返 {report.get('latencyMs', 0)} ms"},
            ])
            config["status"] = "connected"
            config["capabilities"] = report.get("capabilities", [])
            config["lastProbe"] = {
                "ok": True,
                "at": utc_now(),
                "checks": checks,
                "environmentLock": connector_lock(config),
                "report": report,
            }
        except ConnectorError as exc:
            checks.append({
                "name": "连接测试",
                "status": "failed",
                "detail": exc.message,
                "error": exc.as_dict(),
            })
            config["status"] = "error"
            config["lastProbe"] = {
                "ok": False,
                "at": utc_now(),
                "checks": checks,
                "environmentLock": connector_lock(config),
                "error": exc.as_dict(),
            }
        self._audit(
            state,
            "测试连接器",
            config["name"],
            "通过" if config["lastProbe"]["ok"] else config["lastProbe"]["error"]["message"],
        )
        self.database.put_state(state)
        return {"state": state, "connector": config, "report": config["lastProbe"]}

    @staticmethod
    def _refresh_approval_event(
        existing: dict[str, Any],
        *,
        instance: dict[str, Any],
        row: dict[str, Any],
        document_id: str,
        approval_number: str,
        config: dict[str, Any],
        field_values: list[dict[str, Any]],
    ) -> bool:
        try:
            refreshed = event_from_row(
                row,
                document_id,
                1,
                uuid.uuid4().hex[:8],
            )
        except ValueError:
            return False
        for field in (
            "reference",
            "businessKey",
            "date",
            "counterparty",
            "amountCents",
            "amountBreakdown",
            "currency",
            "exchangeRate",
            "department",
            "project",
            "summary",
        ):
            existing[field] = refreshed[field]
        refreshed_source = (refreshed.get("sourceRecords") or [{}])[0]
        refreshed_document_id = refreshed_source.get("documentId")
        existing_source = next(
            (
                record for record in existing.get("sourceRecords", [])
                if record.get("documentId") == refreshed_document_id
            ),
            None,
        )
        if existing_source:
            existing_source["referenceFields"] = copy.deepcopy(
                refreshed_source.get("referenceFields") or {}
            )
            existing_source["amountCents"] = refreshed_source.get("amountCents")
        else:
            existing.setdefault("sourceRecords", []).append(
                copy.deepcopy(refreshed_source)
            )
        existing["matchExplanation"] = [
            str(item).replace(
                str(existing.get("externalId") or ""),
                approval_number,
            )
            for item in existing.get("matchExplanation", [])
        ]
        existing["approvalNo"] = approval_number
        existing["approvalStatus"] = "approved"
        existing["approvalCode"] = str(config.get("approvalCode") or "")
        existing["approvalName"] = str(config.get("approvalName") or "")
        existing["approvalFieldValues"] = field_values
        existing.update(approval_completion_metadata(instance))
        selection = existing.get("counterpartyFieldSelection")
        if isinstance(selection, dict) and str(selection.get("fieldId") or ""):
            existing["counterpartyMappedValue"] = refreshed["counterparty"]
            selected_field = next(
                (
                    field for field in field_values
                    if str(field.get("id") or "") == str(selection.get("fieldId") or "")
                ),
                None,
            )
            selected_value = normalize_feishu_mapped_value(
                "counterparty",
                selected_field.get("value") if selected_field else "",
            )
            if selected_value not in (None, ""):
                existing["counterparty"] = selected_value
                selection["fieldName"] = str(
                    selected_field.get("name")
                    or selection.get("fieldName")
                    or selection.get("fieldId")
                )
                selection.pop("unavailableAt", None)
            else:
                existing["counterparty"] = refreshed["counterparty"]
                selection["unavailableAt"] = utc_now()
        existing["lastSyncedAt"] = utc_now()
        return True

    def _backfill_approval_events_from_archives(
        self,
        state: dict[str, Any],
        config: dict[str, Any],
    ) -> int:
        documents = {
            str(document.get("id") or ""): document
            for document in state.get("sourceDocuments", [])
            if document.get("rawResponsePreserved")
            and document.get("archivePath")
        }
        current_approval_code = str(config.get("approvalCode") or "")
        backfilled = 0
        for existing in state.get("events", []):
            if existing.get("sourceSystem") != "feishu":
                continue
            event_approval_code = str(existing.get("approvalCode") or "")
            if (
                current_approval_code
                and event_approval_code
                and event_approval_code != current_approval_code
            ):
                continue
            document = next(
                (
                    documents.get(str(document_id))
                    for document_id in existing.get("sourceDocumentIds", [])
                    if documents.get(str(document_id))
                ),
                None,
            )
            if not document:
                continue
            archive_path = self.database.data_dir / str(document["archivePath"])
            try:
                instance = json.loads(archive_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            external_id = str(
                existing.get("externalId")
                or document.get("externalId")
                or instance.get("instance_code")
                or instance.get("instance_id")
                or ""
            )
            if not external_id:
                continue
            approval_number = str(
                instance.get("serial_number")
                or existing.get("approvalNo")
                or external_id
            ).strip()
            values = parse_feishu_form(instance)
            row = feishu_approval_row(
                state,
                config,
                values,
                external_id,
                approval_number,
            )
            if self._refresh_approval_event(
                existing,
                instance=instance,
                row=row,
                document_id=str(document.get("id") or ""),
                approval_number=approval_number,
                config=config,
                field_values=approval_field_values(config, values),
            ):
                backfilled += 1
        return backfilled

    def sync_approvals(self, connector_id: str = "feishu-approval") -> dict[str, Any]:
        state = self._state()
        config = self._config(state, connector_id)
        is_feishu_connector = config.get("adapter") == "feishu-approval-v4"
        profiles = approval_profiles(config) if is_feishu_connector else []
        if is_feishu_connector:
            if not profiles:
                raise ValueError("请先填写 approval_code 并读取审批字段")
            if not (
                str(config.get("queryDateFrom") or "").strip()
                and str(config.get("queryDateTo") or "").strip()
            ):
                raise ValueError("请先选择审批记录完成日期范围")
            for profile in profiles:
                mapping = profile.get("fieldMapping") or {}
                missing = [
                    label
                    for key, label in (
                        ("date", "业务日期"),
                        ("counterparty", "供应商/客商"),
                        ("amount", "金额"),
                    )
                    if not mapping.get(key)
                ]
                if missing:
                    profile_label = (
                        str(profile.get("approvalName") or "").strip()
                        or str(profile.get("approvalCode") or "")
                    )
                    raise ValueError(
                        f"请先完成审批模板 {profile_label} 的字段映射：{'、'.join(missing)}"
                    )
        self._assert_connected_and_locked(config)
        if not {"approval_incremental_sync", "json_record_sync"}.intersection(config.get("capabilities", [])):
            raise ValueError("连接器未探测到 OA JSON 同步能力")
        approved_items: list[tuple[dict[str, Any], dict[str, Any]]] = []
        has_more = False
        sync_cursors: dict[str, Any] = {}
        created = 0
        skipped = 0
        backfilled = 0
        if is_feishu_connector:
            for profile in profiles:
                item_config = approval_profile_config(config, profile)
                item_config["_knownInstanceCodes"] = [
                    str(event.get("externalId") or "").strip()
                    for event in state.get("events", [])
                    if event.get("sourceSystem") == "feishu"
                    and str(event.get("approvalCode") or "").strip()
                    == str(profile.get("approvalCode") or "").strip()
                    and str(event.get("externalId") or "").strip()
                ]
                adapter = self._adapter(item_config)
                cursor = profile.get("syncCursor")
                profile_has_more = False
                for _page in range(20):
                    page = adapter.sync_approved_instances(cursor)
                    approved_items.extend(
                        (instance, item_config)
                        for instance in page["items"]
                    )
                    cursor = page["cursor"]
                    profile_has_more = bool(page.get("hasMore"))
                    if not profile_has_more:
                        break
                profile["syncCursor"] = cursor
                sync_cursors[str(profile.get("id") or "")] = cursor
                has_more = has_more or profile_has_more
                backfilled += self._backfill_approval_events_from_archives(
                    state,
                    item_config,
                )
            mirror_primary_approval_profile(config, profiles[0])
        else:
            adapter = self._adapter(config)
            cursor = config.get("syncCursor")
            for _page in range(20):
                page = adapter.sync_approved_instances(cursor)
                approved_items.extend(
                    (instance, config)
                    for instance in page["items"]
                )
                cursor = page["cursor"]
                has_more = bool(page.get("hasMore"))
                if not has_more:
                    break
            config["syncCursor"] = cursor
            sync_cursors["default"] = cursor
        for instance, item_config in approved_items:
            is_feishu = item_config.get("adapter") == "feishu-approval-v4"
            source_system = "feishu" if is_feishu else item_config["id"]
            external_id = str(
                (
                    instance.get("instance_code")
                    or instance.get("instance_id")
                    or instance.get("code")
                    or ""
                )
                if is_feishu
                else json_path_value(instance, str(item_config.get("externalIdPath") or "id"), "")
            )
            if not external_id:
                skipped += 1
                continue
            approval_number = (
                str(instance.get("serial_number") or "").strip() or external_id
                if is_feishu
                else external_id
            )
            mapping = item_config.get("fieldMapping") or {}
            values = parse_feishu_form(instance) if is_feishu else instance
            stored_approval_fields = (
                approval_field_values(item_config, values)
                if is_feishu
                else []
            )
            if is_feishu:
                row = feishu_approval_row(
                    state,
                    item_config,
                    values,
                    external_id,
                    approval_number,
                )
            else:
                row = {}
                for standard_field, source_path in mapping.items():
                    canonical = STANDARD_FIELDS.get(standard_field)
                    if canonical:
                        row[canonical] = json_path_value(
                            values,
                            str(source_path),
                            "",
                        )
                row.setdefault("业务日期", datetime.now(timezone.utc).date().isoformat())
                row.setdefault("审批单号", external_id)
                row.setdefault("业务类型", item_config.get("businessType") or "采购付款")
            existing = next(
                (
                    event for event in state.get("events", [])
                    if event.get("sourceSystem") == source_system
                    and event.get("externalId") == external_id
                ),
                None,
            )
            if existing:
                self._refresh_approval_event(
                    existing,
                    instance=instance,
                    row=row,
                    document_id=(existing.get("sourceDocumentIds") or [""])[0],
                    approval_number=approval_number,
                    config=item_config,
                    field_values=stored_approval_fields,
                )
                skipped += 1
                continue
            document = self._archive_json_response(
                state,
                name=(
                    f"飞书审批_{external_id}.json"
                    if is_feishu
                    else f"{item_config.get('providerName') or item_config.get('name')}_{external_id}.json"
                ),
                document_type="飞书审批原始响应" if is_feishu else "OA API JSON 原始响应",
                source_system=source_system,
                payload=instance,
                external_id=external_id,
            )
            if not document:
                skipped += 1
                continue
            document_id = document["id"]
            exception_title = f"OA 记录 {external_id} 无法创建业务事项"
            try:
                event = event_from_row(row, document_id, 1, uuid.uuid4().hex[:8])
            except ValueError as exc:
                if not any(
                    item.get("type") == "流程字段映射缺失"
                    and item.get("title") == exception_title
                    for item in state.get("exceptions", [])
                ):
                    state["exceptions"].insert(0, {
                        "id": f"EX-{uuid.uuid4().hex[:8].upper()}",
                        "eventId": None,
                        "documentIds": [document_id],
                        "type": "流程字段映射缺失",
                        "severity": "阻断",
                        "title": exception_title,
                        "detail": str(exc),
                        "suggestion": "在“审批数据”页面完成业务日期、供应商和金额字段映射后重新同步。",
                        "status": "待处理",
                    })
                skipped += 1
            else:
                state["exceptions"] = [
                    item for item in state.get("exceptions", [])
                    if not (
                        item.get("type") == "流程字段映射缺失"
                        and item.get("title") == exception_title
                    )
                ]
                event.update({
                    "sourceSystem": source_system,
                    "externalId": external_id,
                    "approvalNo": approval_number,
                    "approvalStatus": "approved",
                    "approvalCode": str(item_config.get("approvalCode") or ""),
                    "approvalName": str(item_config.get("approvalName") or ""),
                    "approvalFieldValues": stored_approval_fields,
                    "sourceVerified": True,
                    "financeReviewed": False,
                    "pushAllowed": False,
                    "lastSyncedAt": utc_now(),
                })
                event.update(approval_completion_metadata(instance))
                state["events"].insert(0, event)
                created += 1
        config["lastSyncAt"] = utc_now()
        log = {
            "id": f"SYNC-{uuid.uuid4().hex[:10].upper()}",
            "connectorId": connector_id,
            "status": "completed",
            "created": created,
            "skipped": skipped,
            "backfilled": backfilled,
            "cursor": sync_cursors,
            "hasMore": has_more,
            "at": utc_now(),
        }
        state["syncLog"].insert(0, log)
        self._audit(
            state,
            "同步审批",
            config["name"],
            f"新增 {created}，跳过或更新 {skipped}，归档回填 {backfilled}",
        )
        self.database.put_state(state)
        return {"state": state, "connector": config, "sync": log}

    def sync_master_data(self, connector_id: str = "kingdee-k3cloud") -> dict[str, Any]:
        state = self._state()
        config = self._config(state, connector_id)
        self._assert_connected_and_locked(config)
        if "query_master_data" not in config.get("capabilities", []):
            raise ValueError("连接器未探测到基础资料查询能力")
        adapter = self._adapter(config)
        created = 0
        categories: list[dict[str, Any]] = []
        first_error: ConnectorError | None = None
        for query in config.get("masterDataQueries", []):
            fields = list(query.get("fields") or ["FNumber", "FName"])
            category = str(query.get("category") or query.get("formId") or "uncategorized")
            form_id = str(query.get("formId") or "")
            try:
                rows = adapter.query_master_data(
                    form_id,
                    fields,
                    str(query.get("filterString") or ""),
                    int(query.get("limit") or 100_000),
                )
            except ConnectorError as exc:
                optional = bool(query.get("optional"))
                if not optional:
                    first_error = first_error or exc
                categories.append({
                    "category": category,
                    "formId": form_id,
                    "status": "unavailable" if optional else "failed",
                    "rows": 0,
                    "created": 0,
                    "errorCode": exc.code,
                    "message": str(exc),
                })
                continue
            self._archive_json_response(
                state,
                name=(
                    f"{config.get('name') or connector_id}基础资料_"
                    f"{query.get('category') or query.get('formId') or '未分类'}.json"
                ),
                document_type=(
                    "金蝶基础资料原始响应"
                    if connector_id == "kingdee-k3cloud"
                    else f"{config.get('name') or connector_id}基础资料原始响应"
                ),
                source_system=connector_id,
                payload={
                    "formId": query.get("formId"),
                    "category": query.get("category"),
                    "fields": fields,
                    "rows": rows,
                },
            )
            category_created = 0
            logical_results: list[dict[str, Any]] = []
            logical_queries = query.get("dimensionMappings") or [query]
            for logical_query in logical_queries:
                logical_category = str(logical_query.get("category") or category)
                code_field = str(logical_query.get("codeField") or query.get("codeField") or fields[0])
                name_field = str(logical_query.get("nameField") or query.get("nameField") or fields[min(1, len(fields) - 1)])
                id_fields = [
                    str(field) for field in (
                        logical_query.get("idFields")
                        or query.get("idFields")
                        or ([query.get("idField")] if query.get("idField") else [])
                    )
                    if field
                ]
                current_by_key: dict[str, dict[str, Any]] = {}
                for item in state.setdefault("masterData", []):
                    if (
                        item.get("sourceConnectorId") == connector_id
                        and item.get("category") == logical_category
                        and item.get("active", True)
                    ):
                        if (
                            query.get("replaceLegacyIdentity")
                            and id_fields
                            and "::" not in str(item.get("sourceExternalId") or "")
                        ):
                            item["active"] = False
                            item["supersededAt"] = utc_now()
                            continue
                        item_key = str(item.get("sourceExternalId") or item.get("code") or "")
                        if item_key:
                            current_by_key[item_key] = item
                candidates: dict[str, list[tuple[str, str, str, dict[str, Any]]]] = {}
                for raw_row in rows:
                    row = dict(zip(fields, raw_row)) if isinstance(raw_row, list) else raw_row
                    code = str(row.get(code_field) or "").strip()
                    name = str(row.get(name_field) or "").strip()
                    identity_parts = [str(row.get(field) or "").strip() for field in id_fields]
                    source_external_id = (
                        "::".join(identity_parts)
                        if identity_parts and all(identity_parts)
                        else ""
                    )
                    if not code or not name:
                        continue
                    item_key = source_external_id or code
                    candidates.setdefault(item_key, []).append((code, name, source_external_id, row))
                logical_created = 0
                for item_key, item_candidates in candidates.items():
                    name_counts: dict[str, int] = {}
                    for _code, candidate_name, _external_id, _row in item_candidates:
                        name_counts[candidate_name] = name_counts.get(candidate_name, 0) + 1
                    code, name, source_external_id, row = min(
                        item_candidates,
                        key=lambda candidate: (
                            -name_counts[candidate[1]],
                            candidate[1],
                            candidate[0],
                        ),
                    )
                    current = current_by_key.get(item_key)
                    if current and current.get("name") == name:
                        continue
                    version = int(current.get("version", 0)) + 1 if current else 1
                    if current:
                        current["active"] = False
                        current["supersededAt"] = utc_now()
                    new_item = {
                        "id": f"MD-{uuid.uuid4().hex[:10].upper()}",
                        "category": logical_category,
                        "categoryLabel": logical_query.get("categoryLabel") or query.get("categoryLabel"),
                        "code": code,
                        "name": name,
                        "version": version,
                        "active": True,
                        "sourceConnectorId": connector_id,
                        "sourceExternalId": source_external_id or None,
                        "sourceAttributes": {
                            key: value for key, value in row.items()
                            if key not in {code_field, name_field, *id_fields}
                        },
                        "importedAt": utc_now(),
                    }
                    state["masterData"].append(new_item)
                    current_by_key[item_key] = new_item
                    created += 1
                    category_created += 1
                    logical_created += 1
                logical_results.append({
                    "category": logical_category,
                    "rows": len(candidates),
                    "created": logical_created,
                })
            categories.append({
                "category": category,
                "formId": form_id,
                "status": "completed" if rows else "empty",
                "rows": len(rows),
                "created": category_created,
                "dimensions": logical_results if query.get("dimensionMappings") else [],
            })
        config["lastMasterDataSyncAt"] = utc_now()
        failed_count = sum(item["status"] == "failed" for item in categories)
        unavailable_count = sum(item["status"] == "unavailable" for item in categories)
        successful_count = sum(item["status"] in {"completed", "empty"} for item in categories)
        status = (
            "failed" if categories and successful_count == 0
            else "completed_with_warnings" if failed_count
            else "completed"
        )
        sync = {
            "id": f"SYNC-{uuid.uuid4().hex[:10].upper()}",
            "connectorId": connector_id,
            "operation": "master-data",
            "status": status,
            "created": created,
            "categories": categories,
            "at": config["lastMasterDataSyncAt"],
        }
        state.setdefault("syncLog", []).insert(0, sync)
        self._audit(
            state,
            "同步基础资料",
            config["name"],
            (
                f"查询 {len(categories)} 类，成功 {successful_count} 类，"
                f"当前账套不可用 {unavailable_count} 类，失败 {failed_count} 类，"
                f"新增或更新 {created} 条"
            ),
        )
        self.database.put_state(state)
        if status == "failed" and first_error:
            raise first_error
        return {
            "state": state,
            "created": created,
            "syncedAt": config["lastMasterDataSyncAt"],
            "sync": sync,
        }

    @staticmethod
    def _dimension_query_profile(
        config: dict[str, Any],
        category: str,
    ) -> dict[str, Any] | None:
        queries = (
            KINGDEE_MASTER_DATA_QUERIES
            if config.get("adapter") == "kingdee-k3cloud-webapi-v6"
            else config.get("masterDataQueries", [])
        )
        for query in queries:
            logical_queries = query.get("dimensionMappings") or [query]
            for logical in logical_queries:
                if str(logical.get("category") or query.get("category") or "") != category:
                    continue
                fields = [str(field) for field in query.get("fields") or ["FNumber", "FName"]]
                return {
                    "formId": str(query.get("formId") or ""),
                    "fields": fields,
                    "codeField": str(logical.get("codeField") or query.get("codeField") or fields[0]),
                }
        return None

    def _resolve_voucher_dimensions(
        self,
        state: dict[str, Any],
        config: dict[str, Any],
        voucher: dict[str, Any],
        connector_id: str,
    ) -> dict[str, Any]:
        resolved_voucher = copy.deepcopy(voucher)
        issues: list[dict[str, Any]] = []
        matches: list[dict[str, Any]] = []
        live_groups: dict[str, dict[str, Any]] = {}
        dimension_field_map = config.get("dimensionFieldMap") or {}
        enforce = config.get("enforceTargetMasterData") is not False

        def issue(
            *,
            line_no: int,
            key: str,
            label: str,
            raw_value: str,
            status: str,
            message: str,
        ) -> None:
            issues.append({
                "lineNo": line_no,
                "key": key,
                "label": label,
                "input": raw_value[:160],
                "status": status,
                "message": message,
            })

        active_by_category: dict[str, list[dict[str, Any]]] = {}
        for item in state.get("masterData", []):
            if (
                item.get("sourceConnectorId") == connector_id
                and item.get("active", True)
            ):
                active_by_category.setdefault(str(item.get("category") or ""), []).append(item)

        for line_index, line in enumerate(resolved_voucher.get("lines", []), start=1):
            dimensions = line.get("dimensions") or {}
            required = {str(name) for name in line.get("requiredDimensions", [])}
            references = line.setdefault("dimensionRefs", {})
            for key in sorted(set(dimensions) | required):
                policy = AUXILIARY_DIMENSION_POLICIES.get(key)
                raw_value = str(dimensions.get(key) or "").strip()
                label = policy["label"] if policy else key
                if not raw_value:
                    if key in required:
                        issue(
                            line_no=line_index,
                            key=key,
                            label=label,
                            raw_value="",
                            status="required_missing",
                            message=f"第 {line_index} 行缺少必填辅助核算：{label}",
                        )
                    continue
                if not policy:
                    issue(
                        line_no=line_index,
                        key=key,
                        label=label,
                        raw_value=raw_value,
                        status="unsupported",
                        message=f"第 {line_index} 行使用了不受支持的辅助核算类型：{key}",
                    )
                    continue
                if not dimension_field_map.get(key):
                    issue(
                        line_no=line_index,
                        key=key,
                        label=label,
                        raw_value=raw_value,
                        status="mapping_missing",
                        message=f"第 {line_index} 行{label}缺少目标凭证字段映射",
                    )
                    continue
                category = policy["category"]
                candidates = active_by_category.get(category, [])
                normalized = raw_value.casefold()
                code_matches = [
                    item for item in candidates
                    if str(item.get("code") or "").strip().casefold() == normalized
                ]
                name_matches = [
                    item for item in candidates
                    if str(item.get("name") or "").strip().casefold() == normalized
                ]
                selected = code_matches or name_matches
                if not candidates:
                    issue(
                        line_no=line_index,
                        key=key,
                        label=label,
                        raw_value=raw_value,
                        status="unsynced",
                        message=f"第 {line_index} 行{label}主数据尚未从目标账套同步",
                    )
                    continue
                if not selected:
                    issue(
                        line_no=line_index,
                        key=key,
                        label=label,
                        raw_value=raw_value,
                        status="missing",
                        message=f"第 {line_index} 行目标账套不存在有效{label}：{raw_value}",
                    )
                    continue
                if len(selected) != 1:
                    issue(
                        line_no=line_index,
                        key=key,
                        label=label,
                        raw_value=raw_value,
                        status="ambiguous",
                        message=f"第 {line_index} 行{label}“{raw_value}”匹配到多个有效编码",
                    )
                    continue
                master = selected[0]
                code = str(master.get("code") or "").strip()
                line["dimensions"][key] = code
                reference = {
                    "input": raw_value,
                    "code": code,
                    "name": str(master.get("name") or "").strip(),
                    "label": label,
                    "masterCategory": category,
                    "masterDataId": str(master.get("id") or ""),
                    "status": "matched",
                }
                references[key] = reference
                match = {
                    "lineNo": line_index,
                    "key": key,
                    **reference,
                }
                matches.append(match)
                live_groups.setdefault(category, {
                    "codes": set(),
                    "matches": [],
                })
                live_groups[category]["codes"].add(code)
                live_groups[category]["matches"].append(match)

        if enforce and matches and not issues:
            adapter = self._adapter(config)
            for category, group in live_groups.items():
                profile = self._dimension_query_profile(config, category)
                if not profile or not profile["formId"]:
                    for match in group["matches"]:
                        issue(
                            line_no=match["lineNo"],
                            key=match["key"],
                            label=match["label"],
                            raw_value=match["input"],
                            status="query_unavailable",
                            message=f"{match['label']}缺少允许的目标主数据查询配置",
                        )
                    continue
                escaped = [
                    str(code).replace("'", "''")
                    for code in sorted(group["codes"])
                ]
                quoted_codes = ",".join(f"'{code}'" for code in escaped)
                filter_string = (
                    f"{profile['codeField']}='{escaped[0]}'"
                    if len(escaped) == 1
                    else f"{profile['codeField']} IN ({quoted_codes})"
                )
                try:
                    rows = adapter.query_master_data(
                        profile["formId"],
                        profile["fields"],
                        filter_string,
                        max(len(escaped) * 3, 10),
                    )
                except ConnectorError as exc:
                    for match in group["matches"]:
                        issue(
                            line_no=match["lineNo"],
                            key=match["key"],
                            label=match["label"],
                            raw_value=match["input"],
                            status="query_failed",
                            message=f"{match['label']}目标主数据实时查询失败：{exc.message}",
                        )
                    continue
                returned_codes = {
                    str(
                        (dict(zip(profile["fields"], row)) if isinstance(row, list) else row)
                        .get(profile["codeField"]) or ""
                    ).strip()
                    for row in rows
                }
                for match in group["matches"]:
                    if match["code"] not in returned_codes:
                        issue(
                            line_no=match["lineNo"],
                            key=match["key"],
                            label=match["label"],
                            raw_value=match["input"],
                            status="remote_missing",
                            message=(
                                f"第 {match['lineNo']} 行{match['label']}编码 "
                                f"{match['code']} 未通过目标账套实时复核"
                            ),
                        )
                    else:
                        match["status"] = "live_matched"
                        match["verifiedAt"] = utc_now()
                        line = resolved_voucher["lines"][match["lineNo"] - 1]
                        line["dimensionRefs"][match["key"]].update({
                            "status": "live_matched",
                            "verifiedAt": match["verifiedAt"],
                        })

        return {
            "ok": not issues,
            "resolvedVoucher": resolved_voucher,
            "matches": matches,
            "issues": issues,
        }

    def preflight(
        self,
        voucher_id: str,
        connector_id: str,
        expected_environment: str,
    ) -> dict[str, Any]:
        state = self._state()
        config = self._config(state, connector_id)
        voucher = next((item for item in state.get("vouchers", []) if item.get("id") == voucher_id), None)
        if not voucher:
            raise ValueError("凭证不存在")
        checks: list[dict[str, Any]] = []

        def check(name: str, ok: bool, detail: str) -> None:
            checks.append({"name": name, "status": "passed" if ok else "failed", "detail": detail})

        check("凭证状态", voucher.get("status") == "已确认", f"当前状态 {voucher.get('status')}")
        check(
            "财务复核",
            voucher.get("financeReviewed") is True,
            "必须由财务人员明确完成复核",
        )
        check(
            "允许推送",
            voucher.get("pushAllowed") is True,
            "复核通过后仍需单独允许推送",
        )
        lock_ok = (
            config.get("status") == "connected"
            and config.get("environmentLock") == connector_lock(config)
            and (config.get("lastProbe") or {}).get("ok") is True
            and (config.get("lastProbe") or {}).get("environmentLock") == connector_lock(config)
        )
        check("连接器与环境锁", lock_ok, f"{config.get('name')} · {config.get('environment')}")
        check(
            "目标环境",
            expected_environment == config.get("environment"),
            f"用户确认 {expected_environment or '未提供'}；连接器目标 {config.get('environment')}",
        )
        check(
            "保存草稿权限",
            "save_voucher_draft" in config.get("capabilities", []),
            "只允许保存草稿，不调用提交、审核或过账",
        )
        source_events = [
            event for event in state.get("events", [])
            if event.get("id") in voucher.get("sourceEventIds", [])
        ]
        approval_ok = not config.get("approvalControlEnabled") or all(
            event.get("approvalStatus") == "approved" for event in source_events
        )
        check("审批状态", approval_ok, "所有来源事项必须明确审批通过")
        verified_ok = all(event.get("sourceVerified") is True for event in source_events)
        check("资料验证", verified_ok, "所有来源事项必须完成资料真实性与完整性确认")
        production_allowed = (
            config.get("environment") != "生产环境"
            or (state.get("productionActivation") or {}).get("enabled") is True
        )
        check(
            "生产启用",
            production_allowed,
            "测试账套可保存草稿；生产账套必须先完成生产启用验证",
        )
        period = str(voucher.get("period") or "")
        if config.get("enforcePeriodQuery"):
            try:
                period_report = self._adapter(config).check_period(period)
                period_ok = period_report.get("open") is True
                period_detail = f"{period} · {period_report.get('source')}"
            except ConnectorError as exc:
                period_ok = False
                period_detail = f"{period} · {exc.message}"
        else:
            period_ok = period not in config.get("closedPeriods", [])
            period_detail = f"{period} · 本地配置"
        check("会计期间", period_ok, period_detail)
        target_accounts = {
            item.get("code")
            for item in state.get("masterData", [])
            if item.get("sourceConnectorId") == connector_id
            and item.get("category") == "account"
            and item.get("active", True)
        }
        voucher_accounts = {line.get("accountCode") for line in voucher.get("lines", [])}
        master_ok = (
            not config.get("enforceTargetMasterData")
            or bool(target_accounts) and voucher_accounts.issubset(target_accounts)
        )
        missing_accounts = sorted(voucher_accounts - target_accounts)
        check(
            "目标科目",
            master_ok,
            "已同步并存在" if master_ok else f"缺少目标科目：{', '.join(missing_accounts)}",
        )
        missing_required_dimensions = [
            f"第 {line_index} 行 {AUXILIARY_DIMENSION_POLICIES.get(name, {}).get('label', name)}"
            for line_index, line in enumerate(voucher.get("lines", []), start=1)
            for name in line.get("requiredDimensions", [])
            if not line.get("dimensions", {}).get(name)
        ]
        dimensions_ok = not missing_required_dimensions
        check(
            "辅助核算",
            dimensions_ok,
            (
                "必填辅助核算已填写"
                if dimensions_ok
                else f"缺少必填辅助核算：{', '.join(missing_required_dimensions)}"
            ),
        )
        dimension_validation = self._resolve_voucher_dimensions(
            state,
            config,
            voucher,
            connector_id,
        )
        dimension_detail = (
            f"已验证 {len(dimension_validation['matches'])} 个辅助核算引用"
            if dimension_validation["ok"]
            else dimension_validation["issues"][0]["message"]
        )
        check("辅助核算主数据", dimension_validation["ok"], dimension_detail)
        report = {
            "ok": all(item["status"] == "passed" for item in checks),
            "connectorId": connector_id,
            "environment": config.get("environment"),
            "checkedAt": utc_now(),
            "checks": checks,
            "dimensionValidation": {
                "matches": dimension_validation["matches"],
                "issues": dimension_validation["issues"],
            },
        }
        return {
            "state": state,
            "voucher": voucher,
            "resolvedVoucher": dimension_validation["resolvedVoucher"],
            "connector": config,
            "report": report,
        }

    def push_voucher(
        self,
        voucher_id: str,
        connector_id: str,
        expected_environment: str,
    ) -> dict[str, Any]:
        preflight = self.preflight(voucher_id, connector_id, expected_environment)
        if not preflight["report"]["ok"]:
            failed = next(item for item in preflight["report"]["checks"] if item["status"] == "failed")
            state = preflight["state"]
            voucher = preflight["voucher"]
            self._audit(
                state,
                "推送前校验失败",
                voucher.get("number", voucher_id),
                f"{failed['name']}：{failed['detail']}",
            )
            self.database.put_state(state)
            raise ValueError(f"推送前校验失败：{failed['name']}（{failed['detail']}）")
        state = preflight["state"]
        voucher = preflight["voucher"]
        resolved_voucher = preflight["resolvedVoucher"]
        config = preflight["connector"]
        adapter = self._adapter(config)
        idempotency_key = build_idempotency_key(voucher)
        existing = next(
            (
                item for item in state.get("postingAttempts", [])
                if item.get("connectorId") == connector_id
                and item.get("idempotencyKey") == idempotency_key
                and item.get("status") in {"sending", "unknown", "verified"}
            ),
            None,
        )
        if existing:
            raise ValueError("相同幂等键已有发送中、待确认或成功记录，禁止重复保存")
        attempt = {
            "id": f"POST-{uuid.uuid4().hex[:10].upper()}",
            "voucherId": voucher_id,
            "connectorId": connector_id,
            "environment": config["environment"],
            "idempotencyKey": idempotency_key,
            "status": "sending",
            "startedAt": utc_now(),
            "preflight": preflight["report"],
        }
        outbox = {
            "id": f"OUT-{uuid.uuid4().hex[:10].upper()}",
            "voucherId": voucher_id,
            "connectorId": connector_id,
            "idempotencyKey": idempotency_key,
            "status": "processing",
            "attemptId": attempt["id"],
            "createdAt": utc_now(),
        }
        state.setdefault("postingAttempts", []).append(attempt)
        state.setdefault("outbox", []).append(outbox)
        voucher["status"] = "推送中"
        self.database.put_state(state)
        try:
            saved = adapter.save_voucher_draft(resolved_voucher, idempotency_key)
            remote = adapter.query_voucher(
                number=saved.get("externalNumber", ""),
                external_id=saved.get("externalId", ""),
            )
        except ConnectorError as exc:
            remote = None
            if exc.retryable:
                try:
                    remote = adapter.query_voucher_by_reference(idempotency_key)
                except ConnectorError:
                    remote = None
            if remote and remote.get("externalId"):
                return self._mark_verified(
                    state,
                    voucher,
                    config,
                    attempt,
                    outbox,
                    idempotency_key,
                    remote,
                    "网络异常后已按幂等引用回查，外部草稿实际保存成功",
                )
            attempt.update({
                "status": "unknown" if exc.retryable else "failed",
                "error": exc.as_dict(),
                "finishedAt": utc_now(),
            })
            outbox["status"] = "manual_review" if exc.retryable else "failed"
            voucher["status"] = "状态待确认" if exc.retryable else "推送失败"
            self._audit(state, "推送失败", voucher.get("number", voucher_id), exc.message)
            self.database.put_state(state)
            return {"state": state, "voucher": voucher, "message": exc.message, "error": exc.as_dict()}
        if not remote or not remote.get("externalId"):
            attempt.update({"status": "unknown", "finishedAt": utc_now()})
            outbox["status"] = "manual_review"
            voucher["status"] = "状态待确认"
            self.database.put_state(state)
            return {
                "state": state,
                "voucher": voucher,
                "message": "保存后未回查到外部凭证，已禁止自动重发",
            }
        return self._mark_verified(
            state,
            voucher,
            config,
            attempt,
            outbox,
            idempotency_key,
            remote,
            "保存草稿并回查成功",
        )

    def _mark_verified(
        self,
        state: dict[str, Any],
        voucher: dict[str, Any],
        config: dict[str, Any],
        attempt: dict[str, Any],
        outbox: dict[str, Any],
        idempotency_key: str,
        remote: dict[str, Any],
        message: str,
    ) -> dict[str, Any]:
        verified_at = utc_now()
        voucher["externalReference"] = {
            "system": config["name"],
            "environment": config["environment"],
            **remote,
            "verifiedAt": verified_at,
            "idempotencyKey": idempotency_key,
        }
        voucher["status"] = "已推送"
        attempt.update({"status": "verified", "verifiedAt": verified_at, "finishedAt": verified_at})
        outbox["status"] = "completed"
        self._audit(
            state,
            "回查凭证",
            voucher.get("number", voucher.get("id", "未编号凭证")),
            f"取得外部凭证 {remote['externalId']}，状态 {remote.get('status')}",
        )
        self.database.put_state(state)
        return {"state": state, "voucher": voucher, "message": message}

    def recheck_voucher(self, voucher_id: str, connector_id: str) -> dict[str, Any]:
        state = self._state()
        config = self._config(state, connector_id)
        voucher = next((item for item in state.get("vouchers", []) if item.get("id") == voucher_id), None)
        if not voucher:
            raise ValueError("凭证不存在")
        idempotency_key = build_idempotency_key(voucher)
        remote = self._adapter(config).query_voucher_by_reference(idempotency_key)
        if not remote or not remote.get("externalId"):
            return {"state": state, "voucher": voucher, "message": "仍未查到外部凭证，继续禁止自动重发"}
        verified_at = utc_now()
        voucher["externalReference"] = {
            "system": config["name"],
            "environment": config["environment"],
            **remote,
            "verifiedAt": verified_at,
            "idempotencyKey": idempotency_key,
        }
        voucher["status"] = "已推送"
        attempt = next(
            (
                item for item in reversed(state.get("postingAttempts", []))
                if item.get("voucherId") == voucher_id and item.get("connectorId") == connector_id
            ),
            None,
        )
        if attempt:
            attempt.update({"status": "verified", "verifiedAt": verified_at})
        outbox = next(
            (
                item for item in reversed(state.get("outbox", []))
                if item.get("voucherId") == voucher_id and item.get("connectorId") == connector_id
            ),
            None,
        )
        if outbox:
            outbox["status"] = "completed"
        self._audit(state, "回查凭证", voucher.get("number", voucher_id), f"取得外部凭证 {remote['externalId']}")
        self.database.put_state(state)
        return {"state": state, "voucher": voucher, "message": "回查成功，已取得外部凭证 ID"}

    def query_external_voucher(
        self,
        connector_id: str,
        *,
        number: str = "",
        reference: str = "",
    ) -> dict[str, Any]:
        state = self._state()
        config = self._config(state, connector_id)
        self._assert_connected_and_locked(config)
        if "query_voucher" not in config.get("capabilities", []):
            raise ValueError("连接器未探测到外部凭证查询能力")
        if not number.strip() and not reference.strip():
            raise ValueError("请输入外部凭证号或幂等引用")
        adapter = self._adapter(config)
        remote = (
            adapter.query_voucher_by_reference(reference.strip())
            if reference.strip()
            else adapter.query_voucher(number=number.strip())
        )
        result = {
            "id": f"EXTQ-{uuid.uuid4().hex[:10].upper()}",
            "connectorId": connector_id,
            "connectorName": config["name"],
            "environment": config["environment"],
            "query": {"number": number.strip(), "reference": reference.strip()},
            "found": bool(remote and remote.get("externalId")),
            "voucher": remote,
            "queriedAt": utc_now(),
            "source": "target-system-live-query",
        }
        cache = state.setdefault("externalQueryCache", [])
        cache.insert(0, result)
        del cache[100:]
        self._audit(
            state,
            "查询外部凭证",
            number.strip() or reference.strip(),
            f"{config['name']} {config['environment']}：{'已找到' if result['found'] else '未找到'}",
        )
        self.database.put_state(state)
        return {"state": state, "result": result}

    def query_external_ledger(
        self,
        connector_id: str,
        parameters: dict[str, str],
    ) -> dict[str, Any]:
        return self._query_external_read_model(
            connector_id,
            "ledger",
            "query_ledger",
            parameters,
            "外部账簿",
        )

    def query_external_report(
        self,
        connector_id: str,
        report_type: str,
        period: str,
    ) -> dict[str, Any]:
        labels = {
            "balanceSheet": "资产负债表",
            "incomeStatement": "利润表",
            "cashFlow": "现金流量表",
        }
        if report_type not in labels:
            raise ValueError("不支持的财务报表类型")
        return self._query_external_read_model(
            connector_id,
            report_type,
            "query_financial_reports",
            {"period": period},
            labels[report_type],
        )

    def _query_external_read_model(
        self,
        connector_id: str,
        model_key: str,
        capability: str,
        parameters: dict[str, str],
        label: str,
    ) -> dict[str, Any]:
        state = self._state()
        config = self._config(state, connector_id)
        self._assert_connected_and_locked(config)
        if capability not in config.get("capabilities", []):
            raise ValueError(f"连接器未探测到{label}查询能力")
        cleaned = {
            key: str(value or "").strip()
            for key, value in parameters.items()
        }
        if not cleaned.get("period"):
            raise ValueError(f"{label}查询必须指定会计期间")
        read = self._adapter(config).query_read_model(model_key, cleaned)
        result = {
            "id": f"EXTR-{uuid.uuid4().hex[:10].upper()}",
            "kind": model_key,
            "label": label,
            "connectorId": connector_id,
            "connectorName": config["name"],
            "environment": config["environment"],
            "parameters": cleaned,
            "fields": read["fields"],
            "rows": read["rows"],
            "queriedAt": utc_now(),
            "source": read["source"],
        }
        cache = state.setdefault("externalReadCache", [])
        cache.insert(0, result)
        del cache[50:]
        self._audit(
            state,
            f"查询{label}",
            cleaned["period"],
            f"{config['name']} {config['environment']}：返回 {len(result['rows'])} 行",
        )
        self.database.put_state(state)
        return {"state": state, "result": result}

    @staticmethod
    def _assert_connected_and_locked(config: dict[str, Any]) -> None:
        if config.get("status") != "connected":
            raise ValueError("连接器尚未通过连接测试")
        if config.get("environmentLock") != connector_lock(config):
            raise ValueError("连接器目标配置已变化，必须重新测试并锁定环境")
        last_probe = config.get("lastProbe") or {}
        if not last_probe.get("ok") or last_probe.get("environmentLock") != connector_lock(config):
            raise ValueError("连接测试已失效，请重新测试")

    @staticmethod
    def _audit(state: dict[str, Any], action: str, subject: str, detail: str) -> None:
        state.setdefault("auditLog", []).insert(0, {
            "id": f"LOG-{uuid.uuid4().hex[:10]}",
            "action": action,
            "subject": subject,
            "operator": state.get("operator") or "本机操作者",
            "detail": redact_text(detail),
            "at": utc_now(),
        })
