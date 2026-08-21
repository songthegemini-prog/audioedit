"""Self-contained project folders (team decision 2026-08-20).

Saving a .audioedit.json alone is not portable: it points at an absolute audio
path that only exists on the machine that made it. Packing copies the audio
next to the project file so the whole job moves as one folder.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from tests.test_audiofmt import sine, write_wav_bits

client = TestClient(app)


def make_source(tmp_path, name: str = "บทสัมภาษณ์.wav"):
    src = tmp_path / name
    write_wav_bits(src, sine(seconds=1.0), 16)
    return src


def test_pack_copies_the_audio_into_a_new_folder(tmp_path) -> None:
    src = make_source(tmp_path)
    out_dir = tmp_path / "งาน-project"

    res = client.post(
        "/pack_project", json={"audio_path": str(src), "out_dir": str(out_dir)}
    )

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["audio_name"] == src.name  # Thai filenames survive intact
    assert (out_dir / src.name).read_bytes() == src.read_bytes()
    assert body["bytes"] == src.stat().st_size


def test_pack_leaves_the_source_untouched(tmp_path) -> None:
    """CLAUDE.md hard rule: the source file is never modified."""
    src = make_source(tmp_path)
    before = src.read_bytes()

    client.post(
        "/pack_project",
        json={"audio_path": str(src), "out_dir": str(tmp_path / "out")},
    )

    assert src.read_bytes() == before


def test_pack_refuses_to_copy_a_file_onto_itself(tmp_path) -> None:
    """out_dir == the source's own folder would copy the file onto itself and
    truncate it to nothing."""
    src = make_source(tmp_path)

    res = client.post(
        "/pack_project", json={"audio_path": str(src), "out_dir": str(tmp_path)}
    )

    assert res.status_code == 400
    assert src.stat().st_size > 0  # still intact


def test_pack_creates_missing_parent_folders(tmp_path) -> None:
    src = make_source(tmp_path)
    nested = tmp_path / "a" / "b" / "งาน"

    res = client.post(
        "/pack_project", json={"audio_path": str(src), "out_dir": str(nested)}
    )

    assert res.status_code == 200
    assert (nested / src.name).is_file()


def test_pack_into_an_existing_folder_is_allowed(tmp_path) -> None:
    """Re-packing over a previous export must overwrite, not fail."""
    src = make_source(tmp_path)
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    (out_dir / src.name).write_bytes(b"stale")

    res = client.post(
        "/pack_project", json={"audio_path": str(src), "out_dir": str(out_dir)}
    )

    assert res.status_code == 200
    assert (out_dir / src.name).read_bytes() == src.read_bytes()


def test_pack_404s_on_a_missing_source(tmp_path) -> None:
    res = client.post(
        "/pack_project",
        json={"audio_path": str(tmp_path / "nope.wav"), "out_dir": str(tmp_path / "o")},
    )
    assert res.status_code == 404


def test_pack_rejects_an_out_dir_that_is_a_file(tmp_path) -> None:
    src = make_source(tmp_path)
    blocker = tmp_path / "blocker"
    blocker.write_text("i am a file")

    res = client.post(
        "/pack_project", json={"audio_path": str(src), "out_dir": str(blocker)}
    )

    assert res.status_code == 400
    assert blocker.read_text() == "i am a file"
