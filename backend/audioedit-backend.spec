# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the sidecar backend (onedir for fast startup).
# Build from backend/:  .venv/bin/pyinstaller audioedit-backend.spec

from PyInstaller.utils.hooks import collect_all

datas, binaries, hiddenimports = [], [], []
# packages whose data files (Thai dictionaries, model code, ffmpeg libs,
# docx templates) must ship inside the bundle
for pkg in ("pythainlp", "faster_whisper", "ctranslate2", "transformers", "torchaudio", "av", "docx"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

# torch has a dedicated PyInstaller hook — collect_all would double its size
hiddenimports += [
    "torch",
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
]

a = Analysis(
    ["serve.py"],
    pathex=["."],
    datas=datas,
    binaries=binaries,
    hiddenimports=hiddenimports,
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="audioedit-backend",
    # windowless: no black console window pops up on Windows when the Tauri
    # app spawns the sidecar (works the same on macOS)
    console=False,
)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="audioedit-backend")
