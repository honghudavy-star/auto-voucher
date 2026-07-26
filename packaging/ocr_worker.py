from __future__ import annotations

import json
import sys
from pathlib import Path

from rapidocr_onnxruntime import RapidOCR


def main() -> int:
    if len(sys.argv) != 3:
        return 2
    image = Path(sys.argv[1])
    output = Path(sys.argv[2])
    if not image.is_file():
        output.write_text(json.dumps({"error": "图片不存在"}), encoding="utf-8")
        return 2
    rows, elapsed = RapidOCR()(str(image))
    output.write_text(
        json.dumps({"rows": rows or [], "elapsed": elapsed}, ensure_ascii=False),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
