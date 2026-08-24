from pathlib import Path

import pytest

from app import config


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AUDIOEDIT_MODEL_DIR", raising=False)


def test_env_var_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUDIOEDIT_MODEL_DIR", "/custom/model")
    assert config.model_dir() == Path("/custom/model")


def test_default_is_thonburian_even_when_pathumma_exists(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Pathumma drops fillers from transcripts, which breaks the
    # locate-and-cut-fillers workflow — it must stay opt-in only.
    pathumma = tmp_path / "pathumma"
    pathumma.mkdir()
    (pathumma / "model.bin").write_bytes(b"x")
    monkeypatch.setattr(config, "PATHUMMA_MODEL_DIR", pathumma)
    assert config.model_dir() == config.DEFAULT_MODEL_DIR


def test_tuning_envs_have_sane_defaults() -> None:
    assert config.beam_size() == 2
    assert config.batch_size() == 8
    assert config.cpu_threads() == 0


def test_device_falls_back_to_cpu_without_cuda_libraries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The guarantee behind FIXES.md #33, restated.

    That fix hard-coded "cpu" because CTranslate2's own "auto" probed for CUDA
    and crashed machines with no runtime. The real requirement was never "the
    string must be cpu" — it was "a machine without the CUDA libraries must
    never be pointed at CUDA". GPU support keeps that promise by checking for
    the libraries itself instead of letting CTranslate2 guess.
    """
    from app import gpu

    monkeypatch.delenv("AUDIOEDIT_DEVICE", raising=False)
    monkeypatch.setattr(gpu, "cuda_available", lambda: False)
    assert config.device() == "cpu"


def test_device_uses_gpu_when_the_libraries_are_really_there(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app import gpu

    monkeypatch.delenv("AUDIOEDIT_DEVICE", raising=False)
    monkeypatch.setattr(gpu, "cuda_available", lambda: True)
    assert config.device() == "cuda"


def test_device_env_still_wins_over_detection(monkeypatch: pytest.MonkeyPatch) -> None:
    """An explicit override must be obeyed either way — it is the escape hatch
    when detection is wrong on a machine we cannot reproduce."""
    from app import gpu

    monkeypatch.setattr(gpu, "cuda_available", lambda: True)
    monkeypatch.setenv("AUDIOEDIT_DEVICE", "cpu")
    assert config.device() == "cpu"

    monkeypatch.setattr(gpu, "cuda_available", lambda: False)
    monkeypatch.setenv("AUDIOEDIT_DEVICE", "cuda")
    assert config.device() == "cuda"


def test_compute_type_is_matched_to_the_device(monkeypatch: pytest.MonkeyPatch) -> None:
    """int8_float16 on GPU: same speed as float16 at ~60% of the VRAM, which
    is what lets 4-6GB laptop cards run the large model at all."""
    monkeypatch.delenv("AUDIOEDIT_COMPUTE_TYPE", raising=False)
    assert config.compute_type("cpu") == "int8"
    assert config.compute_type("cuda") == "int8_float16"
    assert config.compute_type() == "int8"


def test_compute_type_env_overrides_both(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUDIOEDIT_COMPUTE_TYPE", "float16")
    assert config.compute_type("cpu") == "float16"
    assert config.compute_type("cuda") == "float16"


def test_align_device_asks_torch_by_default(monkeypatch) -> None:
    """Unlike ASR this needs no add-on folder check: torch bundles its own
    CUDA libraries, so a CUDA build has them or the package is the CPU one."""
    monkeypatch.delenv("AUDIOEDIT_ALIGN_DEVICE", raising=False)

    assert config.align_device() == "auto"


def test_align_device_can_be_forced_to_cpu(monkeypatch) -> None:
    """The escape hatch for a machine whose GPU is needed elsewhere, or where
    a driver turns out to be unreliable mid-job."""
    monkeypatch.setenv("AUDIOEDIT_ALIGN_DEVICE", "cpu")

    assert config.align_device() == "cpu"
