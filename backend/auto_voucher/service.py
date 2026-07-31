from __future__ import annotations

import hashlib
import io
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
import zipfile
from pathlib import Path
from typing import Any, Callable

from .database import Database, utc_now
from .defaults import account_group, account_normal_balance
from .security import redact_text
from .importers import (
    BANK_CREDIT_FIELDS,
    BANK_DEBIT_FIELDS,
    apply_mapping,
    event_from_row,
    header_fingerprint,
    headers_for,
    import_profile,
    normalize_import_rows,
    parse_rows,
    suggest_mapping,
)


SUPPORTED = {".csv", ".txt", ".xls", ".xlsx", ".xml", ".xbrl", ".ofd", ".pdf", ".png", ".jpg", ".jpeg"}


class VoucherService:
    def __init__(self, database: Database) -> None:
        self.database = database

    def preview_file(self, filename: str, content: bytes) -> dict[str, Any]:
        suffix = Path(filename).suffix.lower()
        if suffix not in {".csv", ".txt", ".xls", ".xlsx"}:
            raise ValueError("只有 CSV、TXT、XLS 和 XLSX 支持字段映射预览")
        source_rows = parse_rows(filename, content)
        rows = normalize_import_rows(source_rows)
        if not rows:
            raise ValueError("文件没有可预览的数据行")
        source_headers = headers_for(source_rows)
        headers = headers_for(rows)
        derived_headers = [header for header in headers if header not in source_headers]
        fingerprint = header_fingerprint(headers)
        master_records = parse_master_data_rows(rows)
        state = self.database.get_state() or {}
        template = next(
            (item for item in state.get("mappingTemplates", []) if item.get("fingerprint") == fingerprint),
            None,
        )
        profile = import_profile(rows)
        mapping = dict(template.get("mapping", {})) if template else suggest_mapping(headers)
        if not template and profile == "bankStatement":
            directional_amount_headers = [
                header
                for header in source_headers
                if header in (*BANK_DEBIT_FIELDS, *BANK_CREDIT_FIELDS)
            ]
            if directional_amount_headers:
                mapping["amount"] = directional_amount_headers
        return {
            "filename": Path(filename).name,
            "headers": headers,
            "sourceHeaders": source_headers,
            "derivedHeaders": derived_headers,
            "sampleRows": rows[:5],
            "fingerprint": fingerprint,
            "kind": "masterData" if master_records else "businessData",
            "importProfile": profile,
            "masterDataCount": len(master_records),
            "suggestedMapping": mapping,
            "matchedTemplate": template,
        }

    def import_files(
        self,
        files: list[tuple[str, bytes, str]],
        mapping: dict[str, Any] | None = None,
        template_name: str = "",
        progress: Callable[[dict[str, Any]], None] | None = None,
    ) -> dict[str, Any]:
        state = self.database.get_state()
        if state is None:
            raise ValueError("应用尚未初始化，请先打开工作台")
        result = {
            "success": 0,
            "duplicate": 0,
            "failed": 0,
            "createdEvents": 0,
            "linkedEvents": 0,
            "blockingExceptions": 0,
            "errors": [],
        }
        total = len(files)
        for index, (filename, content, media_type) in enumerate(files, start=1):
            try:
                created, linked, blocked, master_count, fingerprint = self._import_one(
                    state, filename, content, media_type, mapping
                )
                if created is None:
                    result["duplicate"] += 1
                else:
                    result["success"] += 1
                    result["createdEvents"] += created
                    result["linkedEvents"] += linked
                    result["blockingExceptions"] += blocked
                    result.setdefault("createdMasterData", 0)
                    result["createdMasterData"] += master_count
                    if mapping and template_name and fingerprint:
                        self._save_mapping_template(state, template_name, fingerprint, mapping)
            except Exception as exc:
                result["failed"] += 1
                result["errors"].append({"file": filename, "message": str(exc)})
                self._audit(state, "导入失败", filename, str(exc))
            if progress:
                progress({
                    "processed": index,
                    "total": total,
                    "percent": round(index / total * 100),
                    "currentFile": filename,
                    "summary": {
                        key: result[key]
                        for key in ("success", "duplicate", "failed", "createdEvents", "linkedEvents")
                    },
                })
        self.database.put_state(state)
        result["state"] = state
        result["message"] = (
            f"已创建 {result['createdEvents']} 个业务事项；"
            f"关联已有事项 {result['linkedEvents']} 次；"
            f"导入基础资料 {result.get('createdMasterData', 0)} 条；"
            f"新增阻断异常 {result['blockingExceptions']} 个。"
        )
        return result

    def _import_one(
        self,
        state: dict[str, Any],
        filename: str,
        content: bytes,
        media_type: str,
        mapping: dict[str, Any] | None,
    ) -> tuple[int, int, int, int, str | None] | tuple[None, int, int, int, None]:
        safe_name = Path(filename).name
        suffix = Path(safe_name).suffix.lower()
        if suffix not in SUPPORTED:
            raise ValueError(f"不支持的文件格式：{suffix or '无扩展名'}")
        if len(content) > 50 * 1024 * 1024:
            raise ValueError("单个文件不能超过 50 MB")
        digest = hashlib.sha256(content).hexdigest()
        if self.database.has_source(digest):
            return None, 0, 0, 0, None
        source_rows = parse_rows(safe_name, content)
        rows = normalize_import_rows(source_rows)
        fingerprint = header_fingerprint(headers_for(rows)) if rows else None
        mapped_rows = normalize_import_rows([
            apply_mapping(row, mapping)
            for row in source_rows
        ])
        master_records = parse_master_data_rows(mapped_rows)
        unique = uuid.uuid4().hex[:8]
        document_id = f"DOC-{unique.upper()}"
        candidates = []
        candidate_errors: list[tuple[int, str]] = []
        if not master_records:
            for index, row in enumerate(mapped_rows, start=1):
                try:
                    candidates.append(event_from_row(row, document_id, index, unique))
                except ValueError as exc:
                    if suffix != ".ofd":
                        raise
                    candidate_errors.append((index, str(exc)))
        created_events = 0
        linked_events = 0
        blocking_exceptions = 0
        created_master_data = 0
        archive = self.database.archive_dir / digest[:2] / f"{digest}{suffix}"
        archive.parent.mkdir(parents=True, exist_ok=True)
        free_bytes = shutil.disk_usage(archive.parent).free
        reserve_bytes = 50 * 1024 * 1024
        if free_bytes < len(content) + reserve_bytes:
            required_mb = (len(content) + reserve_bytes) / 1024 / 1024
            raise ValueError(
                f"本地磁盘空间不足：至少需要 {required_mb:.1f} MB 可用空间；"
                f"数据目录 {self.database.data_dir}"
            )
        if not archive.exists():
            archive.write_bytes(content)
        detected_type = media_type or mimetypes.guess_type(safe_name)[0] or "application/octet-stream"
        self.database.register_source(digest, safe_name, detected_type, len(content), archive)
        document = {
            "id": document_id,
            "name": safe_name,
            "type": file_type(suffix),
            "size": len(content),
            "fullHash": digest,
            "hash": f"{digest[:4]}…{digest[-4:]}",
            "importedAt": utc_now(),
        }
        if suffix == ".ofd":
            with zipfile.ZipFile(io.BytesIO(content)) as ofd_archive:
                signature_members = [
                    name for name in ofd_archive.namelist()
                    if "signature" in name.lower() or "/signs/" in name.lower()
                ]
            document["signatureStatus"] = "not_checked"
            document["signatureArtifacts"] = len(signature_members)
            state["exceptions"].insert(0, {
                "id": f"EX-SIGN-{unique.upper()}",
                "eventId": candidates[0]["id"] if candidates else None,
                "documentIds": [document_id],
                "type": "电子签名待验证",
                "severity": "阻断",
                "title": f"{safe_name} 的电子签名尚未完成验证",
                "detail": f"OFD 中发现 {len(signature_members)} 个签名相关文件；当前未取得企业信任链和验签组件，不能把签名状态标记为有效。",
                "suggestion": "配置企业认可的 OFD 验签组件和证书信任链；验证通过前仅保留结构化候选和原件，不得确认凭证。",
                "status": "待处理",
            })
            for candidate in candidates:
                candidate.setdefault("exceptionIds", []).append(f"EX-SIGN-{unique.upper()}")
                candidate["status"] = "待处理"
            blocking_exceptions += 1
        for row_index, message in candidate_errors:
            state["exceptions"].insert(0, {
                "id": f"EX-ROW-{unique.upper()}-{row_index}",
                "eventId": None,
                "documentIds": [document_id],
                "type": "结构化字段待配置",
                "severity": "阻断",
                "title": f"{safe_name} 第 {row_index} 条结构化记录无法生成事项",
                "detail": message,
                "suggestion": "核对 OFD 内嵌 XML/XBRL 的字段映射和金额格式；原件及签名材料已保留。",
                "status": "待处理",
            })
            blocking_exceptions += 1
        if suffix == ".pdf":
            extracted = extract_pdf_text(content)
            if extracted:
                document["extractedTextPreview"] = extracted[:20_000]
                candidates_from_text = parse_ocr_candidate_fields(extracted)
                if candidates_from_text:
                    document["extractionStatus"] = "text_candidates"
                    document["ocrCandidates"] = candidates_from_text
                    document["ocrConfidence"] = 1
                    document["lowConfidenceFields"] = []
                else:
                    document["extractionStatus"] = "text_extracted"
            else:
                ocr = extract_ocr_candidates(safe_name, content)
                self._apply_ocr_result(document, ocr)
        elif suffix in {".png", ".jpg", ".jpeg"}:
            ocr = extract_ocr_candidates(safe_name, content)
            self._apply_ocr_result(document, ocr)
        state["sourceDocuments"].insert(0, document)
        if master_records:
            created_master_data = self._merge_master_data(state, master_records, document_id)
        elif candidates:
            for candidate in candidates:
                created, blocked = self._merge_event(state, candidate)
                created_events += int(created)
                linked_events += int(not created)
                blocking_exceptions += blocked
        elif not candidate_errors:
            exception_id = f"EX-{unique.upper()}"
            ocr_ready = document.get("extractionStatus") == "ocr_candidates"
            text_candidates_ready = document.get("extractionStatus") == "text_candidates"
            candidates_ready = ocr_ready or text_candidates_ready
            blocking_exceptions += int(candidates_ready)
            state["exceptions"].insert(0, {
                "id": exception_id,
                "eventId": None,
                "documentIds": [document_id],
                "type": (
                    "OCR 候选待确认"
                    if ocr_ready
                    else "文本候选待确认"
                    if text_candidates_ready
                    else "待结构化资料"
                    if document.get("extractionStatus") == "text_extracted"
                    else "待识别资料"
                ),
                "severity": "阻断" if candidates_ready else "提醒",
                "title": (
                    f"{safe_name} 已生成 OCR 候选，等待人工确认"
                    if ocr_ready
                    else f"{safe_name} 已提取字段候选，等待人工确认"
                    if text_candidates_ready
                    else
                    f"{safe_name} 已提取文本，等待字段确认"
                    if document.get("extractionStatus") == "text_extracted"
                    else f"{safe_name} 已归档，等待 OCR"
                ),
                "detail": (
                    "本地 OCR 已生成候选字段；候选值不会自动成为正式金额、税号、账号或业务主体。"
                    if ocr_ready
                    else "已从文本型 PDF 提取候选字段；候选值不会自动成为正式金额、税号、账号或业务主体。"
                    if text_candidates_ready
                    else
                    "已从文本型 PDF 提取可搜索文本，但尚未把未经人工确认的文本转换为正式业务事项。"
                    if document.get("extractionStatus") == "text_extracted"
                    else "原始文件已完成 SHA-256 去重并保存到本地归档；本地 OCR 组件当前不可用或未识别到文字。"
                ),
                "suggestion": (
                    "逐项核对金额、日期、发票号码和主体后再创建业务事项。"
                    if candidates_ready
                    else
                    "核对提取文本并完成字段映射。"
                    if document.get("extractionStatus") == "text_extracted"
                    else "安装并验证本地 OCR 组件后重新提取，原始文件不会重复保存。"
                ),
                "status": "待处理",
            })
        self._audit(
            state,
            "导入资料",
            safe_name,
            f"SHA-256 {document['hash']}，创建 {created_events} 个事项，关联 {linked_events} 个已有事项",
        )
        return created_events, linked_events, blocking_exceptions, created_master_data, fingerprint

    @staticmethod
    def _merge_master_data(
        state: dict[str, Any],
        records: list[dict[str, Any]],
        document_id: str,
    ) -> int:
        master_data = state.setdefault("masterData", [])
        created = 0
        for record in records:
            current = next(
                (
                    item for item in master_data
                    if item.get("category") == record["category"]
                    and item.get("code") == record["code"]
                    and item.get("active", True)
                ),
                None,
            )
            if record["category"] == "account":
                record["group"] = (
                    record.get("group")
                    or (current or {}).get("group")
                    or account_group(record["code"])
                )
                record["normalBalance"] = (
                    record.get("normalBalance")
                    or (current or {}).get("normalBalance")
                    or account_normal_balance(record["code"])
                )
            comparable = {key: value for key, value in record.items() if key != "version"}
            if current and all(current.get(key) == value for key, value in comparable.items()):
                continue
            version = int(current.get("version", 0)) + 1 if current else 1
            if current:
                current["active"] = False
                current["supersededAt"] = utc_now()
            master_data.append({
                **record,
                "id": f"MD-{uuid.uuid4().hex[:10].upper()}",
                "version": version,
                "active": True,
                "sourceDocumentId": document_id,
                "importedAt": utc_now(),
            })
            created += 1
        return created

    @staticmethod
    def _apply_ocr_result(document: dict[str, Any], result: dict[str, Any] | None) -> None:
        if not result or not result.get("text"):
            document["extractionStatus"] = "pending_ocr"
            return
        document["extractionStatus"] = "ocr_candidates"
        document["extractedTextPreview"] = result["text"][:20_000]
        document["ocrCandidates"] = result.get("candidates", {})
        document["ocrConfidence"] = result.get("confidence", 0)
        document["lowConfidenceFields"] = result.get("lowConfidenceFields", [])

    def _merge_event(self, state: dict[str, Any], candidate: dict[str, Any]) -> tuple[bool, int]:
        existing = next(
            (item for item in state["events"] if item.get("businessKey") == candidate["businessKey"]),
            None,
        )
        if existing is None and not candidate.get("bankSerial"):
            existing = next(
                (
                    item for item in state["events"]
                    if item.get("reference") == candidate["reference"]
                    and item.get("company") == candidate["company"]
                    and item.get("type") == candidate["type"]
                ),
                None,
            )
        blocked = self._protect_source_record_occupancy(state, candidate, existing)
        validation_event = existing or candidate
        for field, label in (("company", "公司/法人主体"), ("ledger", "账簿/账套"), ("type", "业务类型")):
            if not str(candidate.get(field) or "").strip():
                blocked += self._add_exception_once(
                    state,
                    validation_event,
                    f"基础字段缺失:{field}",
                    f"{candidate['reference']} 缺少{label}",
                    f"导入资料未提供{label}，系统不会使用示例值或默认值填充。",
                    f"在字段映射或接入方案中明确{label}后重新处理。",
                )
        if candidate.get("approvalStatus") != "approved":
            blocked += self._add_exception_once(
                state,
                validation_event,
                "审批依据未知",
                f"{candidate['reference']} 尚无明确审批通过依据",
                "文件上传只代表资料已归档，不代表业务审批通过。",
                "关联明确 APPROVED 的审批实例，或由财务按制度补充审批依据。",
            )
        if blocked:
            candidate["status"] = "待处理"
        if existing is None:
            state["events"].insert(0, candidate)
            return True, blocked

        for document_id in candidate["sourceDocumentIds"]:
            if document_id not in existing.setdefault("sourceDocumentIds", []):
                existing["sourceDocumentIds"].append(document_id)
        existing.setdefault("sourceRecords", []).extend(candidate.get("sourceRecords", []))
        existing.setdefault("matchExplanation", []).append(
            f"新增资料按业务唯一键关联：{candidate['reference']}"
        )
        amounts = {record.get("amountCents") for record in existing["sourceRecords"]}
        amounts.discard(None)
        if len(amounts) > 1:
            difference = max(amounts) - min(amounts)
            blocked += self._add_exception_once(
                state,
                existing,
                "金额不一致",
                f"{existing['reference']} 的来源金额不一致",
                f"同一事项来源金额相差 {difference / 100:,.2f} 元。",
                "核对订单、审批、发票和付款金额；确认拆单、部分付款或修正来源资料。",
            )
        evidence_count = len(existing.get("sourceRecords", []))
        existing["matchConfidence"] = (
            round(min(0.99, 0.5 + evidence_count * 0.1), 2)
            if evidence_count >= 2
            else None
        )
        return False, blocked

    def _protect_source_record_occupancy(
        self,
        state: dict[str, Any],
        candidate: dict[str, Any],
        target: dict[str, Any] | None,
    ) -> int:
        blocked = 0
        for record in candidate.get("sourceRecords", []):
            key = record.get("recordKey")
            if not key:
                continue
            owner = next(
                (
                    event for event in state["events"]
                    if event is not target
                    and any(source.get("recordKey") == key for source in event.get("sourceRecords", []))
                ),
                None,
            )
            if owner:
                blocked += self._add_exception_once(
                    state,
                    target or candidate,
                    "重复资料",
                    f"来源资料已被事项 {owner['reference']} 使用",
                    f"唯一来源标识 {key} 已关联到另一有效业务事项。",
                    "打开原事项核对；如为部分付款，请先明确拆分金额后再关联。",
                    related_event_id=owner["id"],
                )
        return blocked

    @staticmethod
    def _add_exception_once(
        state: dict[str, Any],
        event: dict[str, Any],
        exception_type: str,
        title: str,
        detail: str,
        suggestion: str,
        related_event_id: str | None = None,
    ) -> int:
        existing = next(
            (
                item for item in state["exceptions"]
                if item.get("eventId") == event["id"]
                and item.get("type") == exception_type
                and item.get("status") == "待处理"
            ),
            None,
        )
        if existing:
            return 0
        exception_id = f"EX-{uuid.uuid4().hex[:8].upper()}"
        state["exceptions"].insert(0, {
            "id": exception_id,
            "eventId": event["id"],
            "relatedEventId": related_event_id,
            "documentIds": list(event.get("sourceDocumentIds", [])),
            "type": exception_type,
            "severity": "阻断",
            "title": title,
            "detail": detail,
            "suggestion": suggestion,
            "status": "待处理",
        })
        event.setdefault("exceptionIds", []).append(exception_id)
        event["status"] = "待处理"
        return 1

    @staticmethod
    def _save_mapping_template(
        state: dict[str, Any],
        name: str,
        fingerprint: str,
        mapping: dict[str, Any],
    ) -> None:
        templates = state.setdefault("mappingTemplates", [])
        existing = next((item for item in templates if item.get("fingerprint") == fingerprint), None)
        payload = {
            "id": existing.get("id") if existing else f"MAP-{uuid.uuid4().hex[:8].upper()}",
            "name": name[:80],
            "fingerprint": fingerprint,
            "mapping": mapping,
            "updatedAt": utc_now(),
        }
        if existing:
            templates[templates.index(existing)] = payload
        else:
            templates.append(payload)
        VoucherService._audit(state, "保存字段模板", payload["name"], f"已保存 {len(mapping)} 个字段映射")

    @staticmethod
    def _audit(state: dict[str, Any], action: str, subject: str, detail: str) -> None:
        state["auditLog"].insert(0, {
            "id": f"LOG-{uuid.uuid4().hex[:10]}",
            "action": action,
            "subject": subject,
            "operator": state.get("operator") or "本机操作者",
            "detail": redact_text(detail),
            "at": utc_now(),
        })


def file_type(suffix: str) -> str:
    return {
        ".csv": "结构化表格",
        ".txt": "分隔文本",
        ".xls": "旧版 Excel",
        ".xlsx": "Excel",
        ".xml": "数电发票 XML",
        ".xbrl": "XBRL 电子凭证",
        ".ofd": "OFD 电子凭证",
        ".pdf": "PDF",
        ".png": "图片",
        ".jpg": "图片",
        ".jpeg": "图片",
    }[suffix]


def worker_command(worker: str, *arguments: str) -> list[str]:
    if Path(worker).suffix.lower() in {".py", ".pyw"}:
        return [sys.executable, worker, *arguments]
    return [worker, *arguments]


def resolve_worker(environment_name: str, executable_name: str) -> str:
    configured = os.environ.get(environment_name, "").strip()
    if configured:
        return configured
    bundled = Path(sys.executable).resolve().with_name(executable_name)
    return str(bundled) if bundled.is_file() else ""


def extract_pdf_text(content: bytes) -> str:
    worker = resolve_worker("AUTO_VOUCHER_PDF_WORKER", "AutoVoucherPDF.exe")
    if worker:
        with tempfile.TemporaryDirectory(prefix="auto-voucher-pdf-") as directory:
            source = Path(directory) / "source.pdf"
            output = Path(directory) / "result.json"
            source.write_bytes(content)
            result = subprocess.run(
                worker_command(worker, "text", str(source), str(output)),
                capture_output=True,
                timeout=30,
                check=False,
            )
            if result.returncode == 0 and output.is_file():
                try:
                    return str(json.loads(output.read_text("utf-8")).get("text") or "").strip()
                except (OSError, ValueError):
                    return ""
        return ""
    executable = shutil.which("pdftotext")
    if not executable:
        return ""
    with tempfile.TemporaryDirectory(prefix="auto-voucher-pdf-") as directory:
        source = Path(directory) / "source.pdf"
        source.write_bytes(content)
        result = subprocess.run(
            [executable, "-layout", str(source), "-"],
            capture_output=True,
            timeout=20,
            check=False,
        )
    if result.returncode != 0:
        return ""
    return result.stdout.decode("utf-8", errors="replace").strip()


def extract_ocr_candidates(filename: str, content: bytes) -> dict[str, Any] | None:
    suffix = Path(filename).suffix.lower()
    with tempfile.TemporaryDirectory(prefix="auto-voucher-ocr-") as directory:
        root = Path(directory)
        source = root / f"source{suffix}"
        source.write_bytes(content)
        image_path = source
        if suffix == ".pdf":
            pdf_worker = resolve_worker("AUTO_VOUCHER_PDF_WORKER", "AutoVoucherPDF.exe")
            image_path = root / "page.png"
            if pdf_worker:
                result = subprocess.run(
                    worker_command(pdf_worker, "render-first", str(source), str(image_path)),
                    capture_output=True,
                    timeout=45,
                    check=False,
                )
                if result.returncode != 0 or not image_path.is_file():
                    return None
            else:
                converter = shutil.which("pdftoppm")
                if not converter:
                    return None
                prefix = root / "page"
                result = subprocess.run(
                    [converter, "-f", "1", "-singlefile", "-png", "-r", "220", str(source), str(prefix)],
                    capture_output=True,
                    timeout=30,
                    check=False,
                )
                if result.returncode != 0:
                    return None
                image_path = prefix.with_suffix(".png")
        worker = resolve_worker("AUTO_VOUCHER_OCR_WORKER", "AutoVoucherOCR.exe")
        if worker:
            output_path = root / "ocr-result.json"
            result = subprocess.run(
                worker_command(worker, str(image_path), str(output_path)),
                capture_output=True,
                timeout=60,
                check=False,
            )
            if result.returncode != 0 or not output_path.is_file():
                return None
            try:
                rows = json.loads(output_path.read_text("utf-8")).get("rows")
            except (OSError, ValueError):
                return None
        else:
            try:
                from rapidocr_onnxruntime import RapidOCR
            except ImportError:
                return None
            engine = RapidOCR()
            rows, _elapsed = engine(str(image_path))
    if not rows:
        return None
    text_lines = [str(row[1]).strip() for row in rows if len(row) >= 3 and str(row[1]).strip()]
    confidences = [float(row[2]) for row in rows if len(row) >= 3]
    text = "\n".join(text_lines)
    confidence = sum(confidences) / len(confidences) if confidences else 0
    candidates = parse_ocr_candidate_fields(text)
    low_confidence = list(candidates) if confidence < 0.86 else []
    return {
        "text": text,
        "confidence": round(confidence, 4),
        "candidates": candidates,
        "lowConfidenceFields": low_confidence,
    }


def parse_ocr_candidate_fields(text: str) -> dict[str, str]:
    patterns = {
        "invoiceNo": r"(?:发票号码|发票号)[：:\s]*([0-9A-Z]{8,24})",
        "counterparty": r"(?:销售方名称|销方名称|供应商名称)[：:\s]*([^\n\r]{2,80})",
        "sellerTaxId": r"(?:销售方.*?(?:识别号|税号)|销方税号)[：:\s]*([0-9A-Z]{15,20})",
        "date": r"(?:开票日期|日期)[：:\s]*(\d{4}[-年/.]\d{1,2}[-月/.]\d{1,2})",
        "amount": r"(?:价税合计|小写|金额)[^0-9]{0,16}(\d[\d,]*\.\d{2})",
    }
    candidates: dict[str, str] = {}
    compact = re.sub(r"[ \t]+", " ", text)
    for field, pattern in patterns.items():
        match = re.search(pattern, compact, re.IGNORECASE)
        if match:
            candidates[field] = match.group(1).replace("年", "-").replace("月", "-").replace("日", "")
    return candidates


def build_idempotency_key(voucher: dict[str, Any]) -> str:
    raw = "|".join([
        str(voucher.get("company", "")),
        str(voucher.get("ledger", "")),
        "+".join(voucher.get("sourceEventIds", [])),
        str(voucher.get("ruleVersion", "")),
    ])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def parse_master_data_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not rows:
        return []
    type_keys = ("基础资料类型", "类型", "master_type")
    code_keys = ("科目编码", "编码", "代码", "code", "account_code")
    name_keys = ("科目名称", "名称", "name", "account_name")
    has_type = any(key in rows[0] for key in type_keys)
    has_account_columns = (
        any(key in rows[0] for key in code_keys)
        and any(key in rows[0] for key in name_keys)
    )
    has_explicit_account_columns = (
        any(key in rows[0] for key in ("科目编码", "account_code"))
        and any(key in rows[0] for key in ("科目名称", "account_name"))
    )
    if not has_account_columns or (not has_type and not has_explicit_account_columns):
        return []

    def value(row: dict[str, Any], keys: tuple[str, ...]) -> str:
        return str(next((row[key] for key in keys if row.get(key) not in (None, "")), "")).strip()

    category_map = {
        "科目": "account",
        "供应商": "supplier",
        "客户": "customer",
        "部门": "department",
        "项目": "project",
        "成本中心": "cost_center",
        "银行账号": "bank_account",
        "凭证字": "voucher_type",
    }
    records = []
    for row in rows:
        raw_type = value(row, type_keys) if has_type else "科目"
        code = value(row, code_keys)
        name = value(row, name_keys)
        if raw_type not in category_map:
            raise ValueError(f"不支持的基础资料类型：{raw_type or '空'}")
        if not code or not name:
            raise ValueError("基础资料缺少编码或名称")
        records.append({
            "category": category_map[raw_type],
            "categoryLabel": raw_type,
            "code": code,
            "name": name,
            "status": value(row, ("状态", "status")) or "启用",
            "normalBalance": value(row, ("方向", "余额方向", "normal_balance")) or "",
            "requiredDimensions": [
                item.strip()
                for item in re.split(r"[,，;；]", value(row, ("辅助核算", "required_dimensions")))
                if item.strip()
            ],
        })
    return records
