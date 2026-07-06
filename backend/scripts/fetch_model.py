"""One-time setup: download the Thai ASR model (~3GB) into models/asr/.

Run from backend/:  .venv/bin/python scripts/fetch_model.py

This is the ONLY place the app touches the network, and it is never called
at runtime — the engine runs with HF_HUB_OFFLINE=1.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from huggingface_hub import snapshot_download  # noqa: E402

from app import config  # noqa: E402


def fetch(repo_id: str, target: Path) -> None:
    if target.is_dir() and any(target.glob("*.bin")):
        print(f"already present, skipping: {target}")
        return
    print(f"downloading {repo_id} -> {target}")
    target.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id=repo_id,
        local_dir=str(target),
        # weights are needed in pytorch format only
        ignore_patterns=["*.h5", "*.msgpack", "*.safetensors.index.json", "tf_*", "flax_*"],
    )
    size_gb = sum(f.stat().st_size for f in target.rglob("*") if f.is_file()) / 1e9
    print(f"done ({size_gb:.1f} GB)")


def main() -> None:
    fetch(config.MODEL_HF_REPO, config.DEFAULT_MODEL_DIR)
    fetch(config.ALIGN_MODEL_HF_REPO, config.DEFAULT_ALIGN_MODEL_DIR)


if __name__ == "__main__":
    main()
