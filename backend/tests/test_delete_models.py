"""Deleting the downloaded models on request (team feedback 2026-08-20).

Uninstalling the app leaves the ~4.4GB of models behind on purpose, so an
update does not re-download them. The team found that surprising, so the app
now reports the size/location and offers an explicit delete. The delete must
be scoped to the folder WE created — never a custom AUDIOEDIT_MODEL_DIR the
user pointed at their own checkout.
"""

from __future__ import annotations

import importlib

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client_with_data_root(tmp_path, monkeypatch):
    """A TestClient whose DATA_ROOT is an isolated temp folder."""
    monkeypatch.setenv("AUDIOEDIT_DATA_DIR", str(tmp_path))
    from app import config

    importlib.reload(config)
    from app import main

    importlib.reload(main)
    yield TestClient(main.app), tmp_path
    monkeypatch.delenv("AUDIOEDIT_DATA_DIR", raising=False)
    importlib.reload(config)
    importlib.reload(main)


def make_models(root, size: int = 2048) -> None:
    asr = root / "models" / "asr" / "thonburian-large-v2"
    asr.mkdir(parents=True)
    (asr / "model.bin").write_bytes(b"x" * size)


def test_status_reports_where_the_models_live_and_their_size(client_with_data_root) -> None:
    client, root = client_with_data_root
    make_models(root, 4096)

    body = client.get("/models_status").json()

    assert body["modelsDir"] == str(root / "models")
    assert body["modelsBytes"] == 4096


def test_status_reports_zero_bytes_when_nothing_is_installed(client_with_data_root) -> None:
    client, _ = client_with_data_root
    assert client.get("/models_status").json()["modelsBytes"] == 0


def test_delete_removes_the_models_and_reports_what_it_freed(client_with_data_root) -> None:
    client, root = client_with_data_root
    make_models(root, 4096)

    body = client.post("/delete_models").json()

    assert body["deleted"] is True
    assert body["freedBytes"] == 4096
    assert not (root / "models").exists()
    assert client.get("/models_status").json()["asr"] is False


def test_delete_is_a_no_op_when_there_is_nothing_to_delete(client_with_data_root) -> None:
    client, _ = client_with_data_root

    body = client.post("/delete_models").json()

    assert body["deleted"] is False
    assert body["freedBytes"] == 0


def test_delete_leaves_the_rest_of_the_data_dir_alone(client_with_data_root) -> None:
    """The cache and logs live beside models/ — deleting models must not
    take the user's prepared-audio cache with it."""
    client, root = client_with_data_root
    make_models(root)
    cache = root / "cache"
    cache.mkdir()
    (cache / "prepared.wav").write_bytes(b"keep me")
    (root / "backend.log").write_text("keep me too")

    client.post("/delete_models")

    assert (cache / "prepared.wav").read_bytes() == b"keep me"
    assert (root / "backend.log").exists()


def test_delete_never_touches_a_custom_model_dir(client_with_data_root, tmp_path) -> None:
    """AUDIOEDIT_MODEL_DIR can point at a repo checkout — deleting "the
    models" must not delete a folder we did not create."""
    client, root = client_with_data_root
    make_models(root)
    external = tmp_path / "my-own-models"
    external.mkdir()
    (external / "model.bin").write_bytes(b"precious")

    client.post("/delete_models")

    assert (external / "model.bin").read_bytes() == b"precious"
