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
