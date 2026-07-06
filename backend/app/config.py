import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_ROOT = BACKEND_DIR.parent

# Packaged app: the Tauri shell passes AUDIOEDIT_DATA_DIR (per-user app data
# folder) and models live there. Dev mode: unset -> repo's models/ as before.
DATA_ROOT = Path(os.environ["AUDIOEDIT_DATA_DIR"]) if os.environ.get("AUDIOEDIT_DATA_DIR") else PROJECT_ROOT

# Swap ASR models by pointing AUDIOEDIT_MODEL_DIR at any CTranslate2 model dir.
DEFAULT_MODEL_DIR = DATA_ROOT / "models" / "asr" / "thonburian-large-v2"

MODEL_HF_REPO = "mort666/faster-whisper-large-v2-th"

# Optional alternative model (scripts/convert_pathumma.py). NOT the default:
# Pathumma produces cleaner text but DROPS fillers (เอ่อ/อือ) from the
# transcript, which breaks this app's locate-and-cut-fillers workflow.
# Opt in with AUDIOEDIT_MODEL_DIR if a project needs its content accuracy.
PATHUMMA_MODEL_DIR = DATA_ROOT / "models" / "asr" / "pathumma-large-v3"

PATHUMMA_HF_REPO = "nectec/Pathumma-whisper-th-large-v3"


def model_present(path: Path) -> bool:
    return path.is_dir() and any(path.glob("*.bin"))

# Forced-alignment model (Thai char-level CTC).
DEFAULT_ALIGN_MODEL_DIR = DATA_ROOT / "models" / "align" / "wav2vec2-th"

ALIGN_MODEL_HF_REPO = "airesearch/wav2vec2-large-xlsr-53-th"


def model_dir() -> Path:
    """Explicit env override, else Thonburian (keeps fillers as words)."""
    env = os.environ.get("AUDIOEDIT_MODEL_DIR")
    if env:
        return Path(env)
    return DEFAULT_MODEL_DIR


def beam_size() -> int:
    return int(os.environ.get("AUDIOEDIT_BEAM_SIZE", "2"))


def batch_size() -> int:
    return int(os.environ.get("AUDIOEDIT_BATCH_SIZE", "8"))


def cpu_threads() -> int:
    # 0 = let ctranslate2 decide
    return int(os.environ.get("AUDIOEDIT_CPU_THREADS", "0"))


def align_model_dir() -> Path:
    return Path(os.environ.get("AUDIOEDIT_ALIGN_MODEL_DIR", str(DEFAULT_ALIGN_MODEL_DIR)))


def compute_type() -> str:
    return os.environ.get("AUDIOEDIT_COMPUTE_TYPE", "int8")


def device() -> str:
    return os.environ.get("AUDIOEDIT_DEVICE", "auto")
