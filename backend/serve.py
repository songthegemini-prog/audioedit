"""Sidecar entry point for the packaged app (PyInstaller target).

The Tauri shell spawns this with --port and AUDIOEDIT_DATA_DIR set;
it must import app.main lazily AFTER the env is in place (config reads
AUDIOEDIT_DATA_DIR at import time).
"""

import argparse
import os
import sys


def ensure_streams() -> None:
    """Windowed build (console=False): on Windows sys.stdout/stderr are None,
    and uvicorn's log formatter calls .isatty() on them → crash on startup.
    Point them at a log file in the data dir (or devnull) before uvicorn runs.
    """
    if sys.stdout is not None and sys.stderr is not None:
        return
    stream = None
    data_dir = os.environ.get("AUDIOEDIT_DATA_DIR")
    if data_dir:
        try:
            os.makedirs(data_dir, exist_ok=True)
            stream = open(  # noqa: SIM115 — lives for the whole process
                os.path.join(data_dir, "backend.log"),
                "a",
                buffering=1,
                encoding="utf-8",
                errors="replace",
            )
        except OSError:
            stream = None
    if stream is None:
        stream = open(os.devnull, "w")  # noqa: SIM115
    if sys.stdout is None:
        sys.stdout = stream
    if sys.stderr is None:
        sys.stderr = stream


def main() -> None:
    ensure_streams()
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8756)
    args = parser.parse_args()

    import uvicorn

    from app.main import app

    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
