from __future__ import annotations

import tempfile
import time
import unittest
from pathlib import Path

from auto_voucher.database import Database
from auto_voucher.service import VoucherService


class PerformanceTests(unittest.TestCase):
    def test_ten_thousand_row_csv_preview_completes_under_sixty_seconds(self):
        lines = ["业务日期,供应商,含税金额,审批单号"]
        lines.extend(
            f"2026-07-24,性能供应商-{index % 100},12800.00,SP-{index:05d}"
            for index in range(10_000)
        )
        content = ("\n".join(lines) + "\n").encode("utf-8")
        with tempfile.TemporaryDirectory() as directory:
            database = Database(Path(directory))
            database.put_state({
                "version": 1,
                "operator": "性能测试",
                "sourceDocuments": [],
                "events": [],
                "vouchers": [],
                "exceptions": [],
                "rules": [],
                "connectors": [],
                "auditLog": [],
            })
            started = time.monotonic()
            preview = VoucherService(database).preview_file("ten-thousand.csv", content)
            elapsed = time.monotonic() - started
        self.assertEqual(len(preview["sampleRows"]), 5)
        self.assertEqual(preview["kind"], "businessData")
        self.assertLess(elapsed, 60, f"10,000 行预览耗时 {elapsed:.2f}s")


if __name__ == "__main__":
    unittest.main()
