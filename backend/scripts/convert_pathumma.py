"""One-time setup: download Pathumma-whisper-th-large-v3 and convert it to
CTranslate2 format for faster-whisper.

Run from backend/:  .venv/bin/python scripts/convert_pathumma.py

Downloads ~6GB from Hugging Face (setup-time only; runtime stays offline) and
writes a ~3GB float16 CT2 model. Once the converted model exists, the backend
prefers it automatically (see app/config.py model_dir()).
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config  # noqa: E402


def main() -> None:
    target = config.PATHUMMA_MODEL_DIR
    if target.is_dir() and any(target.glob("*.bin")):
        print(f"already converted: {target}")
        return

    from ctranslate2.converters import TransformersConverter  # heavy import
    from transformers import AutoFeatureExtractor, AutoTokenizer

    print(f"downloading + converting {config.PATHUMMA_HF_REPO} -> {target}")
    print("(several GB — this can take 10-20 minutes)")
    converter = TransformersConverter(config.PATHUMMA_HF_REPO)
    converter.convert(str(target), quantization="float16", force=True)
    # The NECTEC repo ships no tokenizer.json, and faster-whisper needs
    # tokenizer.json + preprocessor_config.json (128 mel bins for large-v3)
    # next to model.bin — regenerate both from the repo's configs.
    AutoTokenizer.from_pretrained(config.PATHUMMA_HF_REPO).save_pretrained(str(target))
    AutoFeatureExtractor.from_pretrained(config.PATHUMMA_HF_REPO).save_pretrained(str(target))
    size_gb = sum(f.stat().st_size for f in target.rglob("*") if f.is_file()) / 1e9
    print(f"done ({size_gb:.1f} GB) — backend will now prefer this model")


if __name__ == "__main__":
    main()
