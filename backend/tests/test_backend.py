import json
import hashlib
import os
import shutil
import tempfile
import unittest
import zipfile
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from auto_voucher.database import Database
from auto_voucher.importers import parse_csv, to_cents
from auto_voucher.server import create_backup_package, inspect_backup, restore_backup
from auto_voucher.security import redact_text
from auto_voucher.service import (
    VoucherService,
    extract_ocr_candidates,
    extract_pdf_text,
    parse_ocr_candidate_fields,
)


def empty_state():
    return {
        "version": 1,
        "operator": "测试员",
        "sourceDocuments": [],
        "events": [],
        "vouchers": [],
        "exceptions": [],
        "rules": [],
        "connectors": [],
        "auditLog": [],
    }


class BackendTests(unittest.TestCase):
    def test_money_uses_integer_cents(self):
        self.assertEqual(to_cents("12,800.05"), 1_280_005)

    def test_audit_log_redacts_tokens_and_long_account_numbers(self):
        value = redact_text(
            "access_token=secret-token Bearer abc.def 6222021234567890123 身份证 310101199001011234"
        )
        self.assertNotIn("secret-token", value)
        self.assertNotIn("abc.def", value)
        self.assertNotIn("6222021234567890123", value)
        self.assertNotIn("310101199001011234", value)
        self.assertIn("[REDACTED]", value)

    def test_audit_log_is_append_only(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Database(Path(directory))
            state = empty_state()
            state["auditLog"] = [{
                "id": "LOG-1",
                "action": "导入资料",
                "subject": "采购.csv",
                "operator": "测试员",
                "detail": "已归档",
                "at": "2026-07-24T00:00:00Z",
            }]
            database.put_state(state)

            modified = database.get_state()
            modified["auditLog"][0]["detail"] = "已修改"
            with self.assertRaisesRegex(ValueError, "不能修改或删除"):
                database.put_state(modified)

            deleted = database.get_state()
            deleted["auditLog"] = []
            with self.assertRaisesRegex(ValueError, "不能修改或删除"):
                database.put_state(deleted)

            appended = database.get_state()
            appended["auditLog"].insert(0, {
                "id": "LOG-2",
                "action": "生成凭证",
                "subject": "记-0001",
                "operator": "测试员",
                "detail": "规则生成",
                "at": "2026-07-24T00:01:00Z",
            })
            database.put_state(appended)
            self.assertEqual(
                [item["id"] for item in database.get_state()["auditLog"]],
                ["LOG-2", "LOG-1"],
            )

    def test_csv_and_archive_are_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Database(Path(directory))
            database.put_state(empty_state())
            service = VoucherService(database)
            content = "业务日期,供应商,含税金额,审批单号\n2026-07-24,示例供应商,12800.00,SP-1\n".encode()
            first = service.import_files([("采购.csv", content, "text/csv")])
            second = service.import_files([("采购.csv", content, "text/csv")])
            self.assertEqual(first["createdEvents"], 1)
            self.assertEqual(second["duplicate"], 1)
            self.assertEqual(len(database.get_state()["events"]), 1)
            self.assertEqual(len(list(database.archive_dir.rglob("*.csv"))), 1)

    def test_unstructured_file_creates_explicit_exception(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Database(Path(directory))
            database.put_state(empty_state())
            result = VoucherService(database).import_files(
                [("附件.pdf", b"%PDF-1.4 fictional", "application/pdf")]
            )
            self.assertEqual(result["success"], 1)
            self.assertEqual(database.get_state()["exceptions"][0]["type"], "待识别资料")
            self.assertEqual(database.get_state()["sourceDocuments"][0]["extractionStatus"], "pending_ocr")

    def test_ofd_embedded_xml_is_structured_but_signature_stays_blocking(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Database(Path(directory))
            database.put_state(empty_state())
            output = BytesIO()
            with zipfile.ZipFile(output, "w") as archive:
                archive.writestr(
                    "Doc_0/Attachs/invoice.xml",
                    """<?xml version="1.0" encoding="UTF-8"?>
                    <Invoice>
                      <开票日期>2026-07-24</开票日期>
                      <销售方名称>OFD 测试供应商</销售方名称>
                      <价税合计>128.00</价税合计>
                      <发票号码>OFD-001</发票号码>
                      <销售方税号>91310000TEST</销售方税号>
                    </Invoice>""",
                )
                archive.writestr("Doc_0/Signs/Signatures.xml", "<Signatures />")
            result = VoucherService(database).import_files(
                [("电子发票.ofd", output.getvalue(), "application/ofd")]
            )
            state = database.get_state()
            self.assertEqual(result["success"], 1)
            self.assertEqual(state["events"][0]["counterparty"], "OFD 测试供应商")
            self.assertEqual(state["events"][0]["status"], "待处理")
            self.assertEqual(state["sourceDocuments"][0]["signatureStatus"], "not_checked")
            self.assertIn("电子签名待验证", [item["type"] for item in state["exceptions"]])

    def test_ofd_invalid_amount_still_archives_original_and_signature_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Database(Path(directory))
            database.put_state(empty_state())
            output = BytesIO()
            with zipfile.ZipFile(output, "w") as archive:
                archive.writestr(
                    "Doc_0/Attachs/invoice.xml",
                    """<?xml version="1.0" encoding="UTF-8"?>
                    <Invoice>
                      <销售方名称>字段异常供应商</销售方名称>
                      <价税合计>金额待核对</价税合计>
                      <发票号码>OFD-BAD-1</发票号码>
                    </Invoice>""",
                )
                archive.writestr("Doc_0/Signs/Signatures.xml", "<Signatures />")
            content = output.getvalue()
            result = VoucherService(database).import_files(
                [("字段异常电子发票.ofd", content, "application/ofd")]
            )
            state = database.get_state()
            exception_types = {item["type"] for item in state["exceptions"]}
            self.assertEqual(result["success"], 1)
            self.assertEqual(state["events"], [])
            self.assertEqual(state["sourceDocuments"][0]["signatureStatus"], "not_checked")
            self.assertIn("电子签名待验证", exception_types)
            self.assertIn("结构化字段待配置", exception_types)
            self.assertTrue(database.has_source(hashlib.sha256(content).hexdigest()))

    def test_disk_space_shortage_stops_new_archive_without_partial_state(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Database(Path(directory))
            database.put_state(empty_state())
            content = "业务日期,供应商,含税金额,审批单号\n2026-07-24,空间测试,128.00,SP-DISK\n".encode()
            with patch(
                "auto_voucher.service.shutil.disk_usage",
                return_value=shutil._ntuple_diskusage(total=100, used=99, free=1),
            ):
                result = VoucherService(database).import_files(
                    [("空间测试.csv", content, "text/csv")]
                )
            state = database.get_state()
            self.assertEqual(result["failed"], 1)
            self.assertIn("磁盘空间不足", result["errors"][0]["message"])
            self.assertEqual(state["sourceDocuments"], [])

    def test_unknown_columns_can_be_mapped_and_reused_as_template(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Database(Path(directory))
            database.put_state(empty_state())
            service = VoucherService(database)
            content = "txn_day,party,total,ref\n2026-07-24,映射供应商,88.50,CUSTOM-1\n".encode()
            preview = service.preview_file("custom.csv", content)
            self.assertNotIn("amount", preview["suggestedMapping"])
            mapping = {
                "date": "txn_day",
                "counterparty": "party",
                "amount": "total",
                "reference": "ref",
            }
            result = service.import_files(
                [("custom.csv", content, "text/csv")],
                mapping=mapping,
                template_name="自定义采购模板",
            )
            self.assertEqual(result["createdEvents"], 1)
            self.assertEqual(result["state"]["events"][0]["amountCents"], 8_850)
            matched = service.preview_file("next.csv", content)
            self.assertEqual(matched["matchedTemplate"]["name"], "自定义采购模板")
            self.assertEqual(matched["suggestedMapping"], mapping)

    def test_master_data_import_keeps_versions(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Database(Path(directory))
            database.put_state(empty_state())
            service = VoucherService(database)
            first = "基础资料类型,编码,名称,辅助核算\n科目,660201,差旅费,部门，项目\n".encode()
            second = "基础资料类型,编码,名称,辅助核算\n科目,660201,差旅费及交通费,部门，项目\n".encode()
            preview = service.preview_file("科目表-v1.csv", first)
            result_one = service.import_files([("科目表-v1.csv", first, "text/csv")])
            result_two = service.import_files([("科目表-v2.csv", second, "text/csv")])
            records = database.get_state()["masterData"]
            self.assertEqual(result_one["createdMasterData"], 1)
            self.assertEqual(preview["kind"], "masterData")
            self.assertEqual(preview["masterDataCount"], 1)
            self.assertEqual(result_two["createdMasterData"], 1)
            self.assertEqual([item["version"] for item in records], [1, 2])
            self.assertFalse(records[0]["active"])
            self.assertTrue(records[1]["active"])
            self.assertEqual(records[1]["requiredDimensions"], ["部门", "项目"])

    def test_failed_structured_import_does_not_poison_hash_dedupe(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Database(Path(directory))
            database.put_state(empty_state())
            content = "业务日期,供应商\n2026-07-24,缺金额供应商\n".encode()
            result = VoucherService(database).import_files([("invalid.csv", content, "text/csv")])
            self.assertEqual(result["failed"], 1)
            self.assertFalse(database.has_source(hashlib.sha256(content).hexdigest()))

    def test_same_business_key_links_sources_to_one_event(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Database(Path(directory))
            database.put_state(empty_state())
            service = VoucherService(database)
            order = (
                "业务日期,供应商,含税金额,审批单号,资料类型\n"
                "2026-07-24,归并供应商,12800.00,SP-MERGE-1,采购订单\n"
            ).encode()
            invoice = (
                "业务日期,供应商,含税金额,审批单号,资料类型,发票号码,销售方税号\n"
                "2026-07-24,归并供应商,12800.00,SP-MERGE-1,数电发票,INV001,91310000123456789X\n"
            ).encode()
            first = service.import_files([("订单.csv", order, "text/csv")])
            second = service.import_files([("发票.csv", invoice, "text/csv")])
            state = database.get_state()
            self.assertEqual(first["createdEvents"], 1)
            self.assertEqual(second["createdEvents"], 0)
            self.assertEqual(second["linkedEvents"], 1)
            self.assertEqual(len(state["events"]), 1)
            self.assertEqual(len(state["events"][0]["sourceDocumentIds"]), 2)
            self.assertEqual(len(state["events"][0]["sourceRecords"]), 2)

    def test_amount_mismatch_blocks_merged_event(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Database(Path(directory))
            database.put_state(empty_state())
            service = VoucherService(database)
            base = "业务日期,供应商,含税金额,审批单号\n2026-07-24,差异供应商,{},SP-DIFF-1\n"
            service.import_files([("审批.csv", base.format("9000.00").encode(), "text/csv")])
            result = service.import_files([("付款.csv", base.format("10000.00").encode(), "text/csv")])
            state = database.get_state()
            event = state["events"][0]
            exception = next(item for item in state["exceptions"] if item["type"] == "金额不一致")
            self.assertGreaterEqual(result["blockingExceptions"], 1)
            self.assertEqual(event["status"], "待处理")
            self.assertIn(exception["id"], event["exceptionIds"])
            self.assertEqual(exception["type"], "金额不一致")
            self.assertIn("1,000.00", exception["detail"])

    def test_invoice_occupancy_blocks_second_event(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Database(Path(directory))
            database.put_state(empty_state())
            service = VoucherService(database)
            header = "业务日期,供应商,含税金额,审批单号,发票号码,销售方税号\n"
            first = header + "2026-07-24,占用供应商,100.00,SP-ONE,INV-DUP,91310000123456789X\n"
            second = header + "2026-07-24,占用供应商,100.00,SP-TWO,INV-DUP,91310000123456789X\n"
            service.import_files([("发票一.csv", first.encode(), "text/csv")])
            result = service.import_files([("发票二.csv", second.encode(), "text/csv")])
            state = database.get_state()
            blocked = next(event for event in state["events"] if event["reference"] == "SP-TWO")
            self.assertGreaterEqual(result["blockingExceptions"], 1)
            self.assertEqual(blocked["status"], "待处理")
            self.assertIn("重复资料", [item["type"] for item in state["exceptions"]])

    def test_ocr_candidate_fields_remain_explicit_candidates(self):
        fields = parse_ocr_candidate_fields(
            "发票号码: 12345678\n销售方名称: 上海示例材料有限公司\n销售方纳税人识别号: 91310000123456789X\n"
            "开票日期: 2026年07月24日\n价税合计（小写） ¥12,800.50"
        )
        self.assertEqual(fields["invoiceNo"], "12345678")
        self.assertEqual(fields["counterparty"], "上海示例材料有限公司")
        self.assertEqual(fields["sellerTaxId"], "91310000123456789X")
        self.assertEqual(fields["date"], "2026-07-24")
        self.assertEqual(fields["amount"], "12,800.50")

    def test_optional_pdf_worker_contract_keeps_component_out_of_core(self):
        with tempfile.TemporaryDirectory() as directory:
            worker = Path(directory) / "pdf-worker.py"
            worker.write_text(
                "#!/usr/bin/env python3\n"
                "import json,sys\n"
                "open(sys.argv[3], 'w', encoding='utf-8').write(json.dumps({'text':'PDF worker text'}))\n",
                encoding="utf-8",
            )
            worker.chmod(0o700)
            with patch.dict(os.environ, {"AUTO_VOUCHER_PDF_WORKER": str(worker)}):
                self.assertEqual(extract_pdf_text(b"%PDF-test"), "PDF worker text")

    def test_optional_ocr_worker_returns_real_confidence_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            worker = Path(directory) / "ocr-worker.py"
            worker.write_text(
                "#!/usr/bin/env python3\n"
                "import json,sys\n"
                "rows=[[[[0,0],[1,0],[1,1],[0,1]],'金额 128.00',0.91]]\n"
                "open(sys.argv[2], 'w', encoding='utf-8').write(json.dumps({'rows':rows}))\n",
                encoding="utf-8",
            )
            worker.chmod(0o700)
            with patch.dict(os.environ, {"AUTO_VOUCHER_OCR_WORKER": str(worker)}):
                result = extract_ocr_candidates("scan.png", b"image")
            self.assertEqual(result["confidence"], 0.91)
            self.assertEqual(result["candidates"]["amount"], "128.00")

    def test_rejects_unbalanced_state(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Database(Path(directory))
            state = empty_state()
            state["vouchers"] = [{"id": "V1", "lines": [{"debitCents": 100, "creditCents": 0}]}]
            with self.assertRaisesRegex(ValueError, "借贷不平"):
                database.put_state(state)

    def test_backup_restore_rebuilds_source_dedupe_index(self):
        with tempfile.TemporaryDirectory() as source_directory, tempfile.TemporaryDirectory() as target_directory:
            source = Database(Path(source_directory))
            source.put_state(empty_state())
            content = "业务日期,供应商,含税金额\n2026-07-24,示例供应商,100.00\n".encode()
            VoucherService(source).import_files([("采购.csv", content, "text/csv")])
            state = source.get_state()
            output = create_backup_package(source, state)
            target = Database(Path(target_directory))
            report = inspect_backup(output)
            self.assertTrue(report["valid"])
            self.assertEqual(report["scope"]["sourceDocuments"], 1)
            restore_backup(target, output)
            repeated = VoucherService(target).import_files([("采购.csv", content, "text/csv")])
            self.assertEqual(repeated["duplicate"], 1)

    def test_backup_restore_preserves_existing_audit_chain(self):
        with tempfile.TemporaryDirectory() as source_directory, tempfile.TemporaryDirectory() as target_directory:
            source = Database(Path(source_directory))
            source.put_state(empty_state())
            backup = create_backup_package(source, source.get_state())

            target = Database(Path(target_directory))
            target_state = empty_state()
            target_state["auditLog"] = [{
                "id": "LOG-TARGET",
                "action": "导入资料",
                "subject": "恢复前资料",
                "operator": "测试员",
                "detail": "既有审计记录",
                "at": "2026-07-24T00:00:00Z",
            }]
            target.put_state(target_state)
            restored = restore_backup(target, backup)
            self.assertEqual(restored["auditLog"][1]["id"], "LOG-TARGET")
            self.assertEqual(restored["auditLog"][0]["action"], "恢复备份")

    def test_tampered_backup_is_rejected_before_restore(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Database(Path(directory))
            database.put_state(empty_state())
            original = create_backup_package(database, database.get_state())
            source = zipfile.ZipFile(BytesIO(original))
            output = BytesIO()
            with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as target:
                for name in source.namelist():
                    payload = source.read(name)
                    target.writestr(name, b"tampered" if name == "state.json" else payload)
            with self.assertRaisesRegex(ValueError, "完整性校验失败"):
                inspect_backup(output.getvalue())

if __name__ == "__main__":
    unittest.main()
