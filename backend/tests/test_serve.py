"""Windowed-build regression (FIXES.md #32): with console=False on Windows,
sys.stdout/stderr are None and uvicorn's formatter crashes on .isatty().
ensure_streams() must leave both usable before uvicorn ever runs."""

import sys

import serve


def test_ensure_streams_replaces_none_stdout_stderr(tmp_path, monkeypatch):
    monkeypatch.setenv("AUDIOEDIT_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(sys, "stdout", None)
    monkeypatch.setattr(sys, "stderr", None)

    serve.ensure_streams()

    # uvicorn's DefaultFormatter needs .isatty(); logging needs .write()
    assert sys.stdout.isatty() is False
    assert sys.stderr.isatty() is False
    sys.stderr.write("boot ok\n")
    assert (tmp_path / "backend.log").read_text(encoding="utf-8") == "boot ok\n"


def test_ensure_streams_falls_back_to_devnull(monkeypatch):
    monkeypatch.delenv("AUDIOEDIT_DATA_DIR", raising=False)
    monkeypatch.setattr(sys, "stdout", None)
    monkeypatch.setattr(sys, "stderr", None)

    serve.ensure_streams()

    assert sys.stdout is not None and sys.stderr is not None
    sys.stdout.write("no data dir, still alive\n")


def test_ensure_streams_keeps_real_streams(capsys):
    before_out, before_err = sys.stdout, sys.stderr
    serve.ensure_streams()
    assert sys.stdout is before_out
    assert sys.stderr is before_err
