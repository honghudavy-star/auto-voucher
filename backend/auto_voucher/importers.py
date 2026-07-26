from __future__ import annotations

import csv
import hashlib
import io
import re
import xml.etree.ElementTree as ET
import zipfile
from datetime import date
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Any


ALIASES = {
    "date": ("业务日期", "日期", "date", "business_date", "开票日期"),
    "counterparty": ("供应商", "客户", "客商", "counterparty", "vendor", "销售方名称", "购买方名称"),
    "amount": ("金额", "含税金额", "付款金额", "amount", "gross_amount", "价税合计"),
    "reference": ("单据号", "审批单号", "订单号", "reference", "external_id", "发票号码"),
    "company": ("公司", "主体", "company", "legal_entity", "购买方名称"),
    "ledger": ("账簿", "账套", "ledger", "book"),
    "business_type": ("业务类型", "business_type", "type"),
    "document_type": ("资料类型", "单据类型", "document_type", "source_type"),
    "invoice_no": ("发票号码", "发票号", "invoice_no", "invoice_number"),
    "seller_tax_id": ("销售方税号", "销方税号", "seller_tax_id"),
    "order_no": ("订单号", "采购订单号", "order_no", "po_number"),
    "approval_no": ("审批单号", "approval_no", "approval_number"),
    "bank_serial": ("流水号", "银行流水号", "bank_serial", "transaction_id"),
    "net_amount": ("不含税金额", "net_amount"),
    "tax_amount": ("税额", "tax_amount"),
    "payment_amount": ("付款金额", "实付金额", "payment_amount"),
    "department": ("部门", "department"),
    "project": ("项目", "project"),
    "summary": ("摘要", "业务摘要", "summary", "货物或应税劳务名称"),
}

STANDARD_FIELDS = {
    "date": "业务日期",
    "counterparty": "供应商",
    "amount": "含税金额",
    "reference": "审批单号",
    "company": "公司",
    "ledger": "账簿",
    "business_type": "业务类型",
    "document_type": "资料类型",
    "invoice_no": "发票号码",
    "seller_tax_id": "销售方税号",
    "order_no": "订单号",
    "approval_no": "审批单号",
    "bank_serial": "流水号",
    "net_amount": "不含税金额",
    "tax_amount": "税额",
    "payment_amount": "付款金额",
    "department": "部门",
    "project": "项目",
    "summary": "摘要",
}


def parse_rows(filename: str, content: bytes) -> list[dict[str, Any]]:
    suffix = Path(filename).suffix.lower()
    if suffix == ".csv":
        return parse_csv(content)
    if suffix == ".xlsx":
        return parse_xlsx(content)
    if suffix == ".xml":
        row = parse_xml(content)
        return [row] if row else []
    if suffix == ".xbrl":
        row = parse_xml(content)
        return [row] if row else []
    if suffix == ".ofd":
        row = parse_ofd(content)
        return [row] if row else []
    return []


def headers_for(rows: list[dict[str, Any]]) -> list[str]:
    if not rows:
        return []
    return [str(header) for header in rows[0].keys()]


def header_fingerprint(headers: list[str]) -> str:
    normalized = "\n".join(sorted(header.strip().lower() for header in headers if header.strip()))
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def suggest_mapping(headers: list[str]) -> dict[str, str]:
    mapping: dict[str, str] = {}
    normalized = {header.strip().lower(): header for header in headers}
    for target, aliases in ALIASES.items():
        for alias in aliases:
            if alias.lower() in normalized:
                mapping[target] = normalized[alias.lower()]
                break
    return mapping


def apply_mapping(row: dict[str, Any], mapping: dict[str, str] | None) -> dict[str, Any]:
    if not mapping:
        return row
    mapped = dict(row)
    for target, source in mapping.items():
        canonical = STANDARD_FIELDS.get(target)
        if canonical and source in row:
            mapped[canonical] = row[source]
    return mapped


def parse_csv(content: bytes) -> list[dict[str, str]]:
    text = decode_text(content)
    sample = text[:4096]
    dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
    return [dict(row) for row in csv.DictReader(io.StringIO(text), dialect=dialect)]


def parse_xlsx(content: bytes) -> list[dict[str, Any]]:
    try:
        from openpyxl import load_workbook
    except ImportError as exc:
        raise ValueError("当前运行环境未安装 XLSX 解析组件 openpyxl") from exc
    workbook = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    sheet = workbook.active
    rows = sheet.iter_rows(values_only=True)
    headers = [str(value).strip() if value is not None else "" for value in next(rows)]
    return [
        {header: value for header, value in zip(headers, values) if header}
        for values in rows
        if any(value not in (None, "") for value in values)
    ]


def parse_xml(content: bytes) -> dict[str, Any]:
    root = ET.fromstring(content)
    values: dict[str, str] = {}
    for element in root.iter():
        tag = re.sub(r"^\{.*\}", "", element.tag)
        text = (element.text or "").strip()
        if text and tag not in values:
            values[tag] = text
    normalized: dict[str, Any] = {}
    for target, names in ALIASES.items():
        for name in names:
            if name in values:
                normalized[name] = values[name]
                break
    return normalized


def parse_ofd(content: bytes) -> dict[str, Any]:
    merged: dict[str, Any] = {}
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        members = [
            info for info in archive.infolist()
            if not info.is_dir()
            and Path(info.filename).suffix.lower() in {".xml", ".xbrl"}
            and info.file_size <= 20 * 1024 * 1024
        ]
        if len(members) > 500:
            raise ValueError("OFD 内嵌结构化文件数量异常")
        if sum(info.file_size for info in members) > 100 * 1024 * 1024:
            raise ValueError("OFD 解压后的结构化数据超过 100 MB")
        for info in members:
            try:
                row = parse_xml(archive.read(info))
            except ET.ParseError:
                continue
            for key, value in row.items():
                merged.setdefault(key, value)
    return merged


def event_from_row(row: dict[str, Any], document_id: str, sequence: int, unique: str) -> dict[str, Any]:
    amount = pick(row, ALIASES["amount"])
    counterparty = pick(row, ALIASES["counterparty"])
    if amount in (None, "") or not str(counterparty).strip():
        raise ValueError("缺少“金额”或“供应商/客商”字段")
    amount_cents = to_cents(amount)
    business_date = normalize_date(pick(row, ALIASES["date"]))
    order_no = str(pick(row, ALIASES["order_no"]) or "").strip()
    approval_no = str(pick(row, ALIASES["approval_no"]) or "").strip()
    invoice_no = str(pick(row, ALIASES["invoice_no"]) or "").strip()
    bank_serial = str(pick(row, ALIASES["bank_serial"]) or "").strip()
    reference = str(
        pick(row, ALIASES["reference"])
        or approval_no
        or order_no
        or invoice_no
        or bank_serial
        or f"IMP-{unique}-{sequence:04d}"
    )
    department = str(pick(row, ALIASES["department"]) or "")
    project = str(pick(row, ALIASES["project"]) or "")
    summary = str(pick(row, ALIASES["summary"]) or str(counterparty))
    company = str(pick(row, ALIASES["company"]) or "")
    ledger = str(pick(row, ALIASES["ledger"]) or "")
    business_type = str(pick(row, ALIASES["business_type"]) or "")
    document_type = str(pick(row, ALIASES["document_type"]) or "业务资料")
    seller_tax_id = str(pick(row, ALIASES["seller_tax_id"]) or "").strip()
    business_key = hashlib.sha256(
        f"{company}|{ledger}|{business_type}|{reference}".encode("utf-8")
    ).hexdigest()[:24]
    source_record_key = ""
    if invoice_no and seller_tax_id:
        source_record_key = f"invoice:{seller_tax_id}:{invoice_no}"
    elif bank_serial:
        source_record_key = f"bank:{bank_serial}"
    return {
        "id": f"EV-{unique}-{sequence}",
        "reference": reference,
        "businessKey": business_key,
        "type": business_type,
        "company": company,
        "ledger": ledger,
        "date": business_date,
        "counterparty": str(counterparty),
        "amountCents": amount_cents,
        "amountBreakdown": {
            "grossCents": amount_cents,
            "netCents": optional_cents(pick(row, ALIASES["net_amount"])),
            "taxCents": optional_cents(pick(row, ALIASES["tax_amount"])),
            "paymentCents": optional_cents(pick(row, ALIASES["payment_amount"])),
        },
        "currency": "CNY",
        "department": department,
        "project": project,
        "summary": summary,
        "approvalStatus": "unknown",
        "sourceVerified": False,
        "financeReviewed": False,
        "pushAllowed": False,
        "matchConfidence": None,
        "sourceDocumentIds": [document_id],
        "sourceRecords": [{
            "documentId": document_id,
            "documentType": document_type,
            "recordKey": source_record_key,
            "referenceFields": {
                "reference": reference,
                "orderNo": order_no,
                "approvalNo": approval_no,
                "invoiceNo": invoice_no,
                "bankSerial": bank_serial,
                "sellerTaxId": seller_tax_id,
            },
            "amountCents": amount_cents,
        }],
        "matchExplanation": [
            f"按业务唯一键 {business_type} / {reference} 关联",
            "交易对方和金额用于一致性校验",
        ],
        "exceptionIds": [],
        "status": "可生成",
    }


def pick(row: dict[str, Any], names: tuple[str, ...]) -> Any:
    for name in names:
        if name in row and row[name] not in (None, ""):
            return row[name]
    return ""


def to_cents(value: Any) -> int:
    normalized = str(value).replace(",", "").replace("¥", "").replace("￥", "").strip()
    try:
        return int((Decimal(normalized) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    except InvalidOperation as exc:
        raise ValueError(f"金额格式无效：{value}") from exc


def optional_cents(value: Any) -> int | None:
    if value in (None, ""):
        return None
    return to_cents(value)


def normalize_date(value: Any) -> str:
    if not value:
        return date.today().isoformat()
    if hasattr(value, "date"):
        return value.date().isoformat()
    text = str(value).strip().replace("/", "-")
    return text[:10]


def decode_text(content: bytes) -> str:
    for encoding in ("utf-8-sig", "gb18030", "utf-8"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ValueError("无法识别 CSV 文本编码")
