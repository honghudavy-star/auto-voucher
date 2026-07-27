from __future__ import annotations

import hashlib
import json
import shutil
import uuid
from datetime import datetime, timezone
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
from .importers import STANDARD_FIELDS, event_from_row
from .security import SecretStore, redact_text
from .service import build_idempotency_key
from .setup import connector_template, ensure_state_v2


ALLOWED_CONFIG_FIELDS = {
    "name",
    "environment",
    "baseUrl",
    "appId",
    "approvalCode",
    "fieldMapping",
    "accountId",
    "username",
    "ledger",
    "voucherFormId",
    "localeId",
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


def ensure_connector_defaults(state: dict[str, Any]) -> bool:
    return ensure_state_v2(state)


def connector_lock(config: dict[str, Any]) -> str:
    raw = "|".join(
        str(config.get(key) or "")
        for key in (
            "id",
            "adapter",
            "environment",
            "baseUrl",
            "accountId",
            "approvalCode",
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
    values: dict[str, Any] = {}
    for widget in form if isinstance(form, list) else []:
        widget_id = str(widget.get("id") or widget.get("widget_id") or "")
        value = widget.get("value")
        if value in (None, ""):
            value = widget.get("name") or widget.get("text") or widget.get("value_text")
        values[widget_id] = value
    return values


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
        for key, value in values.items():
            config[key] = value
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
            return KingdeeK3CloudConnector(config, self._secret(config["id"], "password"))
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
        if any(
            document.get("fullHash") == digest
            for document in state.setdefault("sourceDocuments", [])
        ):
            return None
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

    def sync_approvals(self, connector_id: str = "feishu-approval") -> dict[str, Any]:
        state = self._state()
        config = self._config(state, connector_id)
        self._assert_connected_and_locked(config)
        if not {"approval_incremental_sync", "json_record_sync"}.intersection(config.get("capabilities", [])):
            raise ValueError("连接器未探测到 OA JSON 同步能力")
        adapter = self._adapter(config)
        cursor = config.get("syncCursor")
        approved_items: list[dict[str, Any]] = []
        has_more = False
        for _page in range(20):
            page = adapter.sync_approved_instances(cursor)
            approved_items.extend(page["items"])
            cursor = page["cursor"]
            has_more = bool(page.get("hasMore"))
            if not has_more:
                break
        created = 0
        skipped = 0
        for instance in approved_items:
            is_feishu = config.get("adapter") == "feishu-approval-v4"
            source_system = "feishu" if is_feishu else config["id"]
            external_id = str(
                (
                    instance.get("instance_code")
                    or instance.get("instance_id")
                    or instance.get("code")
                    or ""
                )
                if is_feishu
                else json_path_value(instance, str(config.get("externalIdPath") or "id"), "")
            )
            if not external_id:
                skipped += 1
                continue
            existing = next(
                (
                    event for event in state.get("events", [])
                    if event.get("sourceSystem") == source_system
                    and event.get("externalId") == external_id
                ),
                None,
            )
            if existing:
                existing["approvalStatus"] = "approved"
                existing["lastSyncedAt"] = utc_now()
                skipped += 1
                continue
            mapping = config.get("fieldMapping") or {}
            row: dict[str, Any] = {}
            values = parse_feishu_form(instance) if is_feishu else instance
            for standard_field, source_path in mapping.items():
                canonical = STANDARD_FIELDS.get(standard_field)
                if canonical:
                    row[canonical] = (
                        values.get(str(source_path), "")
                        if is_feishu
                        else json_path_value(values, str(source_path), "")
                    )
            row.setdefault("业务日期", datetime.now(timezone.utc).date().isoformat())
            row.setdefault("审批单号", external_id)
            row.setdefault("业务类型", config.get("businessType") or "采购付款")
            document = self._archive_json_response(
                state,
                name=(
                    f"飞书审批_{external_id}.json"
                    if is_feishu
                    else f"{config.get('providerName') or config.get('name')}_{external_id}.json"
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
            try:
                event = event_from_row(row, document_id, 1, uuid.uuid4().hex[:8])
            except ValueError as exc:
                state["exceptions"].insert(0, {
                    "id": f"EX-{uuid.uuid4().hex[:8].upper()}",
                    "eventId": None,
                    "documentIds": [document_id],
                    "type": "流程字段映射缺失",
                    "severity": "阻断",
                    "title": f"OA 记录 {external_id} 无法创建业务事项",
                    "detail": str(exc),
                    "suggestion": "在连接器中完成日期、供应商、金额和审批单号字段映射后重新同步。",
                    "status": "待处理",
                })
                skipped += 1
            else:
                event.update({
                    "sourceSystem": source_system,
                    "externalId": external_id,
                    "approvalStatus": "approved",
                    "sourceVerified": True,
                    "financeReviewed": False,
                    "pushAllowed": False,
                    "lastSyncedAt": utc_now(),
                })
                state["events"].insert(0, event)
                created += 1
        config["syncCursor"] = cursor
        config["lastSyncAt"] = utc_now()
        log = {
            "id": f"SYNC-{uuid.uuid4().hex[:10].upper()}",
            "connectorId": connector_id,
            "status": "completed",
            "created": created,
            "skipped": skipped,
            "cursor": cursor,
            "hasMore": has_more,
            "at": utc_now(),
        }
        state["syncLog"].insert(0, log)
        self._audit(state, "同步审批", config["name"], f"新增 {created}，跳过或更新 {skipped}")
        self.database.put_state(state)
        return {"state": state, "sync": log}

    def sync_master_data(self, connector_id: str = "kingdee-k3cloud") -> dict[str, Any]:
        state = self._state()
        config = self._config(state, connector_id)
        self._assert_connected_and_locked(config)
        if "query_master_data" not in config.get("capabilities", []):
            raise ValueError("连接器未探测到基础资料查询能力")
        adapter = self._adapter(config)
        created = 0
        for query in config.get("masterDataQueries", []):
            fields = list(query.get("fields") or ["FNumber", "FName"])
            rows = adapter.query_master_data(
                str(query.get("formId") or ""),
                fields,
                str(query.get("filterString") or ""),
            )
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
            for raw_row in rows:
                row = dict(zip(fields, raw_row)) if isinstance(raw_row, list) else raw_row
                code = str(row.get(fields[0]) or "").strip()
                name = str(row.get(fields[1]) or "").strip()
                if not code or not name:
                    continue
                current = next(
                    (
                        item for item in state.setdefault("masterData", [])
                        if item.get("sourceConnectorId") == connector_id
                        and item.get("category") == query.get("category")
                        and item.get("code") == code
                        and item.get("active", True)
                    ),
                    None,
                )
                if current and current.get("name") == name:
                    continue
                version = int(current.get("version", 0)) + 1 if current else 1
                if current:
                    current["active"] = False
                    current["supersededAt"] = utc_now()
                state["masterData"].append({
                    "id": f"MD-{uuid.uuid4().hex[:10].upper()}",
                    "category": query.get("category"),
                    "code": code,
                    "name": name,
                    "version": version,
                    "active": True,
                    "sourceConnectorId": connector_id,
                    "importedAt": utc_now(),
                })
                created += 1
        config["lastMasterDataSyncAt"] = utc_now()
        self._audit(state, "同步基础资料", config["name"], f"新增或更新 {created} 条")
        self.database.put_state(state)
        return {"state": state, "created": created, "syncedAt": config["lastMasterDataSyncAt"]}

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
            "测试账套可保存草稿；生产账套必须先通过测试上线门槛",
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
        dimensions_ok = all(
            all(line.get("dimensions", {}).get(name) for name in line.get("requiredDimensions", []))
            for line in voucher.get("lines", [])
        )
        check("辅助核算", dimensions_ok, "必填辅助核算已填写")
        report = {
            "ok": all(item["status"] == "passed" for item in checks),
            "connectorId": connector_id,
            "environment": config.get("environment"),
            "checkedAt": utc_now(),
            "checks": checks,
        }
        return {"state": state, "voucher": voucher, "connector": config, "report": report}

    def push_voucher(
        self,
        voucher_id: str,
        connector_id: str,
        expected_environment: str,
    ) -> dict[str, Any]:
        preflight = self.preflight(voucher_id, connector_id, expected_environment)
        if not preflight["report"]["ok"]:
            failed = next(item for item in preflight["report"]["checks"] if item["status"] == "failed")
            raise ValueError(f"推送前校验失败：{failed['name']}（{failed['detail']}）")
        state = preflight["state"]
        voucher = preflight["voucher"]
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
            saved = adapter.save_voucher_draft(voucher, idempotency_key)
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
