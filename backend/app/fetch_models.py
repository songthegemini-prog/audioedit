"""Model download used by both scripts/fetch_model.py and the in-app
first-run installer (/download_models). Setup-time network only — the
engines themselves always run with HF_HUB_OFFLINE=1."""

from __future__ import annotations

import threading
from collections.abc import Callable
from pathlib import Path

from . import config

# rough on-disk totals for progress estimation (bytes)
EXPECTED_BYTES = {
    "asr": 3_100_000_000,
    "align": 1_300_000_000,
}


def dir_bytes(path: Path) -> int:
    if not path.is_dir():
        return 0
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def fetch(repo_id: str, target: Path) -> None:
    if config.model_present(target):
        return
    from huggingface_hub import snapshot_download

    target.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id=repo_id,
        local_dir=str(target),
        ignore_patterns=["*.h5", "*.msgpack", "*.safetensors.index.json", "tf_*", "flax_*"],
    )


def download_all(
    progress: Callable[[float], None] | None = None,
    abort_check: Callable[[], None] | None = None,
) -> None:
    """Download ASR + alignment models, reporting fractional progress by
    sampling on-disk size against the expected totals. abort_check runs
    between repos (a single snapshot download is not interruptible)."""
    plan = [
        (config.MODEL_HF_REPO, config.DEFAULT_MODEL_DIR, EXPECTED_BYTES["asr"]),
        (config.ALIGN_MODEL_HF_REPO, config.DEFAULT_ALIGN_MODEL_DIR, EXPECTED_BYTES["align"]),
    ]
    total_expected = sum(expected for _, _, expected in plan)

    done = threading.Event()

    def sample() -> None:
        while not done.wait(1.0):
            if progress:
                got = sum(min(dir_bytes(t), e) for _, t, e in plan)
                progress(min(got / total_expected, 0.99))

    sampler = threading.Thread(target=sample, daemon=True)
    sampler.start()
    try:
        for repo, target, _ in plan:
            if abort_check:
                abort_check()
            fetch(repo, target)
    finally:
        done.set()
        sampler.join(timeout=2)
    if progress:
        progress(1.0)
