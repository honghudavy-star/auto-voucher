from __future__ import annotations

import hashlib
import csv
import io
import json
import uuid
from pathlib import Path
from typing import Any

from .database import Database, utc_now
from .importers import header_fingerprint, headers_for, parse_rows


STATE_VERSION = 2

CAPABILITY_CATALOG: dict[str, Any] = {
    "version": "2026.07.1",
    "targets": [
        {
            "id": "kingdee-k3cloud",
            "brand": "金蝶",
            "product": "云星空",
            "versions": ["WebAPI v6+"],
            "adapter": "kingdee-k3cloud-webapi-v6",
            "modes": ["api", "template"],
            "verification": "contract-tested",
            "capabilities": [
                "probe",
                "sync_master_data",
                "check_period",
                "save_voucher_draft",
                "query_voucher",
                "query_by_idempotency_reference",
            ],
        },
        {
            "id": "yonyou-u8",
            "brand": "用友",
            "product": "U8",
            "versions": ["V12+"],
            "adapter": "yonyou-u8-openapi-v12",
            "modes": ["api", "template"],
            "verification": "configuration-required",
            "capabilities": [
                "probe",
                "sync_master_data",
                "check_period",
                "save_voucher_draft",
                "query_voucher",
                "query_by_idempotency_reference",
            ],
        },
        {
            "id": "inspur-gscloud",
            "brand": "浪潮",
            "product": "海岳 GS Cloud",
            "versions": ["iGIX/OpenAPI"],
            "adapter": "inspur-gscloud-igix",
            "modes": ["api", "template"],
            "verification": "configuration-required",
            "capabilities": [
                "probe",
                "sync_master_data",
                "check_period",
                "save_voucher_draft",
                "query_voucher",
                "query_by_idempotency_reference",
            ],
        },
        {
            "id": "other-file-target",
            "brand": "其他品牌",
            "product": "模板导入",
            "versions": ["客户提供"],
            "adapter": "file-template",
            "modes": ["template"],
            "verification": "customer-evidence-required",
            "capabilities": ["template_preview", "template_validate", "export_file"],
        },
    ],
    "sources": [
        {
            "id": "feishu-approval",
            "brand": "飞书",
            "product": "审批",
            "versions": ["v4"],
            "adapter": "feishu-approval-v4",
            "modes": ["api"],
            "verification": "contract-tested",
            "capabilities": ["probe", "approval_incremental_sync"],
        },
        {
            "id": "local-files",
            "brand": "文件",
            "product": "本地文件",
            "versions": ["CSV", "XLSX", "XML", "XBRL", "OFD", "PDF", "图片", "银行流水"],
            "adapter": "local-files",
            "modes": ["file"],
            "verification": "built-in",
            "capabilities": ["archive", "parse", "ocr_candidates", "deduplicate"],
        },
    ],
}


def empty_production_state() -> dict[str, Any]:
    return {
        "version": STATE_VERSION,
        "operator": "",
        "operatorConfigured": False,
        "company": "",
        "ledger": "",
        "environment": "",
        "enterpriseProfiles": [],
        "targetSystem": None,
        "sourceSystems": [],
        "businessScenarios": [],
        "flowPlan": None,
        "readiness": {
            "plan": {"status": "not_ready", "validatedAt": None, "reasons": ["尚未生成接入方案"]},
            "systems": {"status": "not_ready", "validatedAt": None, "reasons": ["尚未完成系统与数据验证"]},
            "rules": {"status": "not_ready", "validatedAt": None, "reasons": ["尚未确认凭证规则"]},
            "production": {"status": "not_ready", "validatedAt": None, "reasons": ["尚未通过测试上线"]},
        },
        "productionActivation": {
            "enabled": False,
            "activatedAt": None,
            "confirmedTarget": None,
            "batchLimit": None,
        },
        "launchEvidence": {
            "permissionChecked": False,
            "periodChecked": False,
            "testDraftSaved": False,
            "voucherRechecked": False,
            "idempotencyChecked": False,
            "shadowRunChecked": False,
            "financeConfirmed": False,
        },
        "templateProfiles": [],
        "sourceDocuments": [],
        "events": [],
        "vouchers": [],
        "exceptions": [],
        "rules": [],
        "connectors": [],
        "masterData": [],
        "mappingTemplates": [],
        "auditLog": [],
        "syncLog": [],
        "externalQueryCache": [],
        "externalReadCache": [],
        "postingAttempts": [],
        "outbox": [],
        "activeFinanceConnectorId": "",
        "activeWorkflowConnectorId": "",
        "selectedEventId": "",
    }


def ensure_state_v2(state: dict[str, Any]) -> bool:
    changed = False
    blank = empty_production_state()
    for key, value in blank.items():
        if key not in state:
            state[key] = json.loads(json.dumps(value, ensure_ascii=False))
            changed = True
    if state.get("version") != STATE_VERSION:
        state["version"] = STATE_VERSION
        changed = True
    return changed


def connector_template(system_id: str, *, environment: str = "测试环境") -> dict[str, Any]:
    entry = next(
        (item for item in CAPABILITY_CATALOG["targets"] + CAPABILITY_CATALOG["sources"] if item["id"] == system_id),
        None,
    )
    if not entry or entry["adapter"] in {"file-template", "local-files"}:
        raise ValueError("该系统不需要 API 连接器")
    common = {
        "id": entry["id"],
        "name": f"{entry['brand']} {entry['product']}",
        "type": "workflow" if system_id == "feishu-approval" else "finance",
        "adapter": entry["adapter"],
        "environment": environment,
        "status": "not_configured",
        "baseUrl": "https://open.feishu.cn" if system_id == "feishu-approval" else "",
        "capabilities": [],
        "leastPrivilegeConfirmed": False,
    }
    if system_id == "feishu-approval":
        common.update({"appId": "", "approvalCode": "", "fieldMapping": {}, "syncCursor": {}})
    elif system_id == "kingdee-k3cloud":
        common.update({
            "accountId": "",
            "username": "",
            "ledger": "",
            "voucherFormId": "GL_VOUCHER",
            "localeId": 2052,
            "approvalControlEnabled": True,
            "enforceTargetMasterData": True,
            "enforcePeriodQuery": True,
            "periodQuery": {},
            "dimensionFieldMap": {},
            "masterDataQueries": [
                {"category": "account", "formId": "BD_Account", "fields": ["FNumber", "FName"]},
                {"category": "supplier", "formId": "BD_Supplier", "fields": ["FNumber", "FName"]},
            ],
        })
    else:
        common.update({
            "accountId": "",
            "username": "",
            "ledger": "",
            "approvalControlEnabled": True,
            "enforceTargetMasterData": True,
            "enforcePeriodQuery": True,
            "endpointProfile": {},
            "fieldProfile": {},
            "dimensionFieldMap": {},
            "masterDataQueries": [],
        })
    return common


def invalidate_downstream(state: dict[str, Any], from_gate: str) -> None:
    order = ["plan", "systems", "rules", "production"]
    start = order.index(from_gate)
    for gate in order[start:]:
        state["readiness"][gate] = {
            "status": "not_ready",
            "validatedAt": None,
            "reasons": ["上游配置已变化，需要重新验证"],
        }
    state["productionActivation"] = {
        "enabled": False,
        "activatedAt": None,
        "confirmedTarget": None,
        "batchLimit": None,
    }


def invalidate_if_upstream_changed(existing: dict[str, Any] | None, incoming: dict[str, Any]) -> None:
    if not existing:
        return
    sections = [
        ("plan", ("enterpriseProfiles", "targetSystem", "sourceSystems", "businessScenarios")),
        ("systems", ("connectors", "masterData", "templateProfiles")),
        ("rules", ("rules",)),
    ]
    for gate, keys in sections:
        before = json.dumps({key: existing.get(key) for key in keys}, ensure_ascii=False, sort_keys=True)
        after = json.dumps({key: incoming.get(key) for key in keys}, ensure_ascii=False, sort_keys=True)
        if hashlib.sha256(before.encode()).digest() != hashlib.sha256(after.encode()).digest():
            invalidate_downstream(incoming, gate)
            return


class SetupService:
    def __init__(self, database: Database) -> None:
        self.database = database

    def _state(self) -> dict[str, Any]:
        state = self.database.get_state()
        if state is None:
            state = empty_production_state()
            self.database.put_state(state)
        ensure_state_v2(state)
        return state

    def plan(self, payload: dict[str, Any]) -> dict[str, Any]:
        enterprise = payload.get("enterprise") or {}
        target_id = str(payload.get("targetSystemId") or "").strip()
        source_ids = [str(item) for item in payload.get("sourceSystemIds") or []]
        scenarios = [str(item).strip() for item in payload.get("businessScenarios") or [] if str(item).strip()]
        required = {
            "企业名称": enterprise.get("name"),
            "法人主体": enterprise.get("legalEntity"),
            "账套": enterprise.get("accountSet"),
            "账簿": enterprise.get("ledger"),
            "会计制度": enterprise.get("accountingStandard"),
            "本位币": enterprise.get("baseCurrency"),
            "凭证字": enterprise.get("voucherType"),
            "操作者": enterprise.get("operator"),
        }
        missing = [name for name, value in required.items() if not str(value or "").strip()]
        if missing:
            raise ValueError(f"接入方案缺少必填项：{'、'.join(missing)}")
        target = next((item for item in CAPABILITY_CATALOG["targets"] if item["id"] == target_id), None)
        if not target:
            raise ValueError("请选择能力目录中的目标系统")
        sources = [item for item in CAPABILITY_CATALOG["sources"] if item["id"] in source_ids]
        if not sources:
            raise ValueError("至少选择一个数据来源")
        if not scenarios:
            raise ValueError("至少选择一个自动化业务场景")

        mode = "api" if "api" in target["modes"] else "template"
        blockers = []
        if target["verification"] in {"configuration-required", "customer-evidence-required"}:
            blockers.append("待客户提供目标版本接口或成功模板资料后验证")
        flow_steps = [
            {"order": 1, "name": "数据来源", "detail": "、".join(item["product"] for item in sources)},
            {"order": 2, "name": "资料匹配", "detail": "关联主数据、业务单据和审批依据"},
            {"order": 3, "name": "异常检查", "detail": "完整性、审批、期间、科目和辅助核算检查"},
            {"order": 4, "name": "凭证草稿", "detail": "仅按已启用的确定性规则生成"},
            {"order": 5, "name": "人工复核", "detail": "财务确认分录与来源证据"},
            {"order": 6, "name": "ERP 草稿/模板", "detail": "API 保存草稿" if mode == "api" else "生成已验证模板文件"},
            {"order": 7, "name": "回查", "detail": "取得外部编号并核对幂等引用" if mode == "api" else "记录测试账套导入结果"},
        ]
        state = self._state()
        state["enterpriseProfiles"] = [{**enterprise, "id": enterprise.get("id") or "enterprise-primary"}]
        state["company"] = str(enterprise["legalEntity"]).strip()
        state["ledger"] = str(enterprise["ledger"]).strip()
        state["operator"] = str(enterprise["operator"]).strip()
        state["operatorConfigured"] = True
        state["targetSystem"] = {
            **target,
            "selectedVersion": str(payload.get("targetVersion") or target["versions"][0]),
            "deployment": str(payload.get("deployment") or "客户环境"),
            "connectionMode": mode,
        }
        state["sourceSystems"] = sources
        state["businessScenarios"] = scenarios
        state["flowPlan"] = {
            "catalogVersion": CAPABILITY_CATALOG["version"],
            "generatedAt": utc_now(),
            "mode": mode,
            "steps": flow_steps,
            "blockers": blockers,
            "manualNodes": ["异常处理", "凭证复核", "生产启用确认"],
        }
        invalidate_downstream(state, "plan")
        state["readiness"]["plan"] = {
            "status": "ready",
            "validatedAt": utc_now(),
            "reasons": blockers,
        }
        wanted = [target_id, *source_ids]
        state["connectors"] = [
            connector for connector in state["connectors"] if connector.get("id") in wanted
        ]
        existing_ids = {item.get("id") for item in state["connectors"]}
        for system_id in wanted:
            if system_id not in existing_ids and system_id not in {"local-files", "other-file-target"}:
                state["connectors"].append(connector_template(system_id))
        state["activeFinanceConnectorId"] = target_id if mode == "api" else ""
        state["activeWorkflowConnectorId"] = "feishu-approval" if "feishu-approval" in source_ids else ""
        self.database.put_state(state)
        return {"state": state, "plan": state["flowPlan"]}

    def preflight(self) -> dict[str, Any]:
        state = self._state()
        target = state.get("targetSystem") or {}
        mode = target.get("connectionMode")
        target_connector = next(
            (item for item in state["connectors"] if item.get("id") == target.get("id")),
            None,
        )
        template = next(
            (item for item in state["templateProfiles"] if item.get("targetSystemId") == target.get("id")),
            None,
        )
        system_reasons = []
        if mode == "api":
            if not target_connector or target_connector.get("status") != "connected":
                system_reasons.append("目标 ERP API 尚未测试通过")
            elif not (target_connector.get("lastProbe") or {}).get("ok"):
                system_reasons.append("目标 ERP 连接测试已失效")
        elif not template or template.get("testImportStatus") != "passed":
            system_reasons.append("目标 ERP 模板尚未在测试账套导入成功")
        for source in state.get("sourceSystems", []):
            if source.get("adapter") == "feishu-approval-v4":
                connector = next((item for item in state["connectors"] if item.get("id") == source["id"]), None)
                if not connector or connector.get("status") != "connected":
                    system_reasons.append("飞书审批连接尚未测试通过")
        if not state.get("masterData"):
            system_reasons.append("尚未导入或同步目标基础资料")
        evidence_labels = {
            "permissionChecked": "尚未确认最小权限测试",
            "periodChecked": "尚未确认测试期间检查",
            "testDraftSaved": "尚未在测试账套保存凭证草稿",
            "voucherRechecked": "尚未回查取得真实外部编号",
            "idempotencyChecked": "尚未完成幂等重复请求测试",
            "shadowRunChecked": "尚未完成影子运行",
            "financeConfirmed": "尚未取得财务负责人确认",
        }
        evidence = state.get("launchEvidence") or {}
        system_reasons.extend(message for key, message in evidence_labels.items() if evidence.get(key) is not True)

        enabled_rules = [item for item in state.get("rules", []) if item.get("enabled")]
        rule_reasons = []
        if not enabled_rules:
            rule_reasons.append("尚无经人工确认并启用的凭证规则")
        for rule in enabled_rules:
            posting = rule.get("posting") or {}
            if not posting.get("debitAccountCode") or not posting.get("creditAccountCode"):
                rule_reasons.append(f"规则 {rule.get('name') or rule.get('id')} 缺少完整借贷科目")

        gates = {
            "plan": state["readiness"]["plan"],
            "systems": {
                "status": "ready" if not system_reasons else "not_ready",
                "validatedAt": utc_now(),
                "reasons": system_reasons,
            },
            "rules": {
                "status": "ready" if not rule_reasons else "not_ready",
                "validatedAt": utc_now(),
                "reasons": rule_reasons,
            },
            "production": {
                "status": "not_ready",
                "validatedAt": utc_now(),
                "reasons": ["需要明确确认目标公司、账套、环境和批量上限"],
            },
        }
        state["readiness"].update(gates)
        state["productionActivation"]["enabled"] = False
        self.database.put_state(state)
        return {"state": state, "ok": all(gates[key]["status"] == "ready" for key in ("plan", "systems", "rules")), "gates": gates}

    def activate(self, payload: dict[str, Any]) -> dict[str, Any]:
        report = self.preflight()
        if not report["ok"]:
            failed = next(
                reason
                for key in ("plan", "systems", "rules")
                for reason in report["gates"][key]["reasons"]
                if report["gates"][key]["status"] != "ready"
            )
            raise ValueError(f"生产启用前检查失败：{failed}")
        state = report["state"]
        enterprise = (state.get("enterpriseProfiles") or [{}])[0]
        expected = {
            "company": enterprise.get("legalEntity"),
            "accountSet": enterprise.get("accountSet"),
            "ledger": enterprise.get("ledger"),
            "environment": "生产环境",
        }
        for key, value in expected.items():
            if str(payload.get(key) or "").strip() != str(value or "").strip():
                raise ValueError(f"生产确认不一致：{key}")
        batch_limit = int(payload.get("batchLimit") or 0)
        if batch_limit < 1 or batch_limit > 1000:
            raise ValueError("生产批量上限必须在 1 到 1000 之间")
        state["environment"] = "生产环境"
        state["productionActivation"] = {
            "enabled": True,
            "activatedAt": utc_now(),
            "confirmedTarget": expected,
            "batchLimit": batch_limit,
            "environmentValidation": payload.get("environmentValidation"),
        }
        state["readiness"]["production"] = {
            "status": "ready",
            "validatedAt": utc_now(),
            "reasons": [],
        }
        self.database.put_state(state)
        return {"state": state, "activation": state["productionActivation"]}

    def preview_template(self, filename: str, content: bytes, target_system_id: str) -> dict[str, Any]:
        try:
            rows = parse_rows(filename, content)
        except (csv.Error, StopIteration):
            rows = []
        headers = headers_for(rows)
        suffix = Path(filename).suffix.lower()
        if not headers and suffix == ".csv":
            text = content.decode("utf-8-sig", errors="replace")
            headers = [str(item).strip() for item in next(csv.reader(io.StringIO(text)), []) if str(item).strip()]
        if not headers and suffix == ".xlsx":
            try:
                from openpyxl import load_workbook
            except ImportError as exc:
                raise ValueError("当前运行环境未安装 XLSX 解析组件 openpyxl") from exc
            workbook = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
            first = next(workbook.active.iter_rows(values_only=True), ())
            headers = [str(item).strip() for item in first if item not in (None, "")]
        if not headers:
            raise ValueError("模板没有可读取的表头")
        return {
            "filename": Path(filename).name,
            "targetSystemId": target_system_id,
            "headers": headers,
            "headerFingerprint": header_fingerprint(headers),
            "sampleRows": rows[:5],
            "rowCount": len(rows),
        }

    def validate_template(self, payload: dict[str, Any]) -> dict[str, Any]:
        state = self._state()
        headers = [str(item).strip() for item in payload.get("headers") or [] if str(item).strip()]
        required = [str(item).strip() for item in payload.get("requiredColumns") or [] if str(item).strip()]
        missing = [item for item in required if item not in headers]
        profile = {
            "id": str(payload.get("id") or f"TPL-{uuid.uuid4().hex[:10].upper()}"),
            "name": str(payload.get("name") or "未命名 ERP 模板").strip(),
            "targetSystemId": str(payload.get("targetSystemId") or "").strip(),
            "version": str(payload.get("version") or "1").strip(),
            "headerFingerprint": str(payload.get("headerFingerprint") or header_fingerprint(headers)),
            "headers": headers,
            "fieldMapping": payload.get("fieldMapping") or {},
            "requiredColumns": required,
            "formatRules": payload.get("formatRules") or {},
            "testImportStatus": str(payload.get("testImportStatus") or "not_tested"),
            "validatedAt": utc_now(),
            "validationErrors": [f"缺少必填列：{item}" for item in missing],
        }
        if not profile["targetSystemId"]:
            raise ValueError("模板档案缺少目标系统")
        existing = next((item for item in state["templateProfiles"] if item.get("id") == profile["id"]), None)
        if existing:
            existing.update(profile)
        else:
            state["templateProfiles"].append(profile)
        invalidate_downstream(state, "systems")
        self.database.put_state(state)
        return {"state": state, "profile": profile, "ok": not missing, "errors": profile["validationErrors"]}
