"""Sidecar entry point for the packaged app (PyInstaller target).

The Tauri shell spawns this with --port and AUDIOEDIT_DATA_DIR set;
it must import app.main lazily AFTER the env is in place (config reads
AUDIOEDIT_DATA_DIR at import time).
"""

import argparse


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8756)
    args = parser.parse_args()

    import uvicorn

    from app.main import app

    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
