# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path
project_root = Path(SPECPATH).parent

a = Analysis(
    [str(project_root / "packaging" / "launcher.py")],
    pathex=[str(project_root / "backend")],
    binaries=[],
    datas=[(str(project_root / "dist"), "dist")],
    hiddenimports=[
        "keyring.backends.Windows",
        "openpyxl",
    ],
    excludes=["rapidocr_onnxruntime", "onnxruntime", "pypdfium2"],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="AutoVoucherCore",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
)
