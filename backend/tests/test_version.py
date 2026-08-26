"""The version the backend reports must be the version that was shipped.

It is the only version an editor ever sees — the status line reads it — and it
had drifted three releases behind before anyone noticed, which quietly makes
every bug report name the wrong code.
"""

import json
from pathlib import Path

from app.main import APP_VERSION

REPO = Path(__file__).resolve().parents[2]


def _version(relative: str) -> str:
    return json.loads((REPO / relative).read_text(encoding="utf-8"))["version"]


def test_backend_version_matches_the_app() -> None:
    assert APP_VERSION == _version("package.json")


def test_installer_version_matches_the_app() -> None:
    assert _version("src-tauri/tauri.conf.json") == _version("package.json")
