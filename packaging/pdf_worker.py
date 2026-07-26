from __future__ import annotations

import json
import sys
from pathlib import Path

import pypdfium2 as pdfium


def main() -> int:
    if len(sys.argv) != 4:
        return 2
    action, source_name, output_name = sys.argv[1:]
    source = Path(source_name)
    output = Path(output_name)
    if not source.is_file():
        return 2
    document = pdfium.PdfDocument(str(source))
    if action == "text":
        text = "\n".join(
            page.get_textpage().get_text_range()
            for page in document
        ).strip()
        output.write_text(json.dumps({"text": text}, ensure_ascii=False), encoding="utf-8")
        return 0
    if action == "render-first" and len(document):
        image = document[0].render(scale=3).to_pil()
        image.save(output, format="PNG")
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
