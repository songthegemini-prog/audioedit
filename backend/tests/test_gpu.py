"""GPU detection and CUDA library discovery.

Every test here encodes something that actually went wrong on 2026-08-21
while proving GPU acceleration works (10.4x measured on an RTX 5060):

- a GPU the driver can see is NOT a GPU we can use
- DLLs present on disk are not DLLs Windows can find
- only cuBLAS is required; cuDNN is 1.07GB we must not ship
"""

from __future__ import annotations

import os

import pytest

from app import gpu


@pytest.fixture(autouse=True)
def clear_gpu_cache(monkeypatch):
    """enable_cuda_libraries() memoises — reset between tests."""
    monkeypatch.setattr(gpu, "_state", None)
    monkeypatch.delenv("AUDIOEDIT_CUDA_DIR", raising=False)
    yield
    monkeypatch.setattr(gpu, "_state", None)


def make_cuda_dir(tmp_path, *, complete: bool = True):
    d = tmp_path / "cuda"
    d.mkdir()
    names = gpu.REQUIRED_CUDA_DLLS if complete else gpu.REQUIRED_CUDA_DLLS[:1]
    for name in names:
        (d / name).write_bytes(b"not a real dll, but the right name")
    return d


def test_only_cublas_is_required() -> None:
    """cuDNN was measured to be unnecessary AND slightly slower to include.
    Shipping it would add 1.07GB to a USB stick for nothing."""
    assert set(gpu.REQUIRED_CUDA_DLLS) == {"cublas64_12.dll", "cublasLt64_12.dll"}
    assert not any("cudnn" in name for name in gpu.REQUIRED_CUDA_DLLS)


def test_finds_the_libraries_via_the_env_override(tmp_path, monkeypatch) -> None:
    d = make_cuda_dir(tmp_path)
    monkeypatch.setenv("AUDIOEDIT_CUDA_DIR", str(d))

    state = gpu.enable_cuda_libraries()

    assert state["found"] is True
    assert state["dir"] == str(d)


def test_puts_the_directory_on_path_not_just_add_dll_directory(
    tmp_path, monkeypatch
) -> None:
    """The bug that cost an afternoon: os.add_dll_directory() alone is NOT
    enough, because CTranslate2 resolves cublas with a plain LoadLibrary."""
    d = make_cuda_dir(tmp_path)
    monkeypatch.setenv("AUDIOEDIT_CUDA_DIR", str(d))
    monkeypatch.setenv("PATH", "C:\\existing")

    gpu.enable_cuda_libraries()

    assert str(d) in os.environ["PATH"]
    assert "C:\\existing" in os.environ["PATH"]  # never clobber the old PATH


def test_a_partial_add_on_folder_is_rejected(tmp_path, monkeypatch) -> None:
    """Half a copy (interrupted USB transfer) must read as 'no GPU support',
    not as a working install that fails later inside encode()."""
    d = make_cuda_dir(tmp_path, complete=False)
    monkeypatch.setenv("AUDIOEDIT_CUDA_DIR", str(d))

    assert gpu.enable_cuda_libraries()["found"] is False


def test_missing_directory_is_not_an_error(tmp_path, monkeypatch) -> None:
    """Booting must never raise here — a dead backend takes the app with it
    (FIXES.md #32)."""
    monkeypatch.setenv("AUDIOEDIT_CUDA_DIR", str(tmp_path / "nope"))

    assert gpu.enable_cuda_libraries()["found"] is False


def test_result_is_cached(tmp_path, monkeypatch) -> None:
    d = make_cuda_dir(tmp_path)
    monkeypatch.setenv("AUDIOEDIT_CUDA_DIR", str(d))

    first = gpu.enable_cuda_libraries()
    monkeypatch.delenv("AUDIOEDIT_CUDA_DIR")
    second = gpu.enable_cuda_libraries()

    assert first is second


def test_cuda_unavailable_without_libraries_even_with_a_gpu(
    tmp_path, monkeypatch
) -> None:
    """THE core lesson. get_cuda_device_count() only asks the display driver.
    A card with no cuBLAS is the configuration that HANGS, so it must report
    unavailable rather than 'available, will fall back'."""
    monkeypatch.setenv("AUDIOEDIT_CUDA_DIR", str(tmp_path / "absent"))

    assert gpu.cuda_available() is False


def test_cuda_unavailable_when_libraries_exist_but_no_device(
    tmp_path, monkeypatch
) -> None:
    d = make_cuda_dir(tmp_path)
    monkeypatch.setenv("AUDIOEDIT_CUDA_DIR", str(d))
    fake = type("m", (), {"get_cuda_device_count": staticmethod(lambda: 0)})
    monkeypatch.setitem(__import__("sys").modules, "ctranslate2", fake)

    assert gpu.cuda_available() is False


def test_cuda_available_needs_both_halves(tmp_path, monkeypatch) -> None:
    d = make_cuda_dir(tmp_path)
    monkeypatch.setenv("AUDIOEDIT_CUDA_DIR", str(d))
    fake = type("m", (), {"get_cuda_device_count": staticmethod(lambda: 1)})
    monkeypatch.setitem(__import__("sys").modules, "ctranslate2", fake)

    assert gpu.cuda_available() is True


def test_status_reports_what_the_user_needs_to_fix_it(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("AUDIOEDIT_CUDA_DIR", str(tmp_path / "absent"))

    body = gpu.status()

    assert body["libraries_found"] is False
    assert body["available"] is False
    # The UI tells the user exactly which files to copy onto the machine.
    assert body["required_dlls"] == list(gpu.REQUIRED_CUDA_DLLS)


def test_status_never_raises_when_ctranslate2_is_broken(monkeypatch) -> None:
    class Boom:
        @staticmethod
        def get_cuda_device_count():
            raise RuntimeError("driver exploded")

    monkeypatch.setitem(__import__("sys").modules, "ctranslate2", Boom)

    assert gpu.status()["available"] is False
    assert gpu.cuda_available() is False


def test_finds_the_add_on_in_the_data_folder(tmp_path, monkeypatch) -> None:
    """The location the docs recommend: beside `models/`, which the team
    already knows how to reach and can write to without admin rights."""
    data = tmp_path / "data"
    cuda = data / "cuda"
    cuda.mkdir(parents=True)
    for name in gpu.REQUIRED_CUDA_DLLS:
        (cuda / name).write_bytes(b"x")
    monkeypatch.setenv("AUDIOEDIT_DATA_DIR", str(data))

    state = gpu.enable_cuda_libraries()

    assert state["found"] is True
    assert state["dir"] == str(cuda)


def test_finds_the_add_on_dropped_next_to_the_app_icon(tmp_path, monkeypatch) -> None:
    """Tauri puts the sidecar at <install>/resources/backend/audioedit-backend/,
    NOT beside the main .exe — but "next to the app icon" is where a user will
    actually drop the files. Walking up from the sidecar has to reach it, or
    the team copies the add-on and nothing happens."""
    install = tmp_path / "audioedit"
    sidecar = install / "resources" / "backend" / "audioedit-backend"
    sidecar.mkdir(parents=True)
    for name in gpu.REQUIRED_CUDA_DLLS:  # dropped at the INSTALL root
        (install / name).write_bytes(b"x")
    monkeypatch.delenv("AUDIOEDIT_DATA_DIR", raising=False)
    monkeypatch.setattr(gpu.sys, "executable", str(sidecar / "audioedit-backend.exe"))

    state = gpu.enable_cuda_libraries()

    assert state["found"] is True
    assert state["dir"] == str(install)


# --- finding and installing the add-on -------------------------------------


def test_a_folder_holding_both_libraries_is_found(tmp_path, monkeypatch) -> None:
    """Most machines with an NVIDIA card already have these somewhere. The
    panel used to tell the editor to go and find two DLLs by name, which is
    not something anyone can act on (reported 2026-08-26)."""
    good = tmp_path / "cuda-toolkit" / "bin"
    good.mkdir(parents=True)
    for name in gpu.REQUIRED_CUDA_DLLS:
        (good / name).write_bytes(b"x")
    monkeypatch.setattr(gpu, "_search_dirs", lambda: iter([tmp_path, good]))

    assert gpu.find_add_on_source() == good


def test_a_folder_with_only_one_library_is_not_a_find(tmp_path, monkeypatch) -> None:
    # Half an add-on is the configuration that hangs — never report it as found.
    half = tmp_path / "half"
    half.mkdir()
    (half / gpu.REQUIRED_CUDA_DLLS[0]).write_bytes(b"x")
    monkeypatch.setattr(gpu, "_search_dirs", lambda: iter([half]))

    assert gpu.find_add_on_source() is None


def test_the_search_stops_at_the_first_hit(tmp_path, monkeypatch) -> None:
    """Built eagerly the search took 13.5s even with the answer first in the
    list — too slow to sit behind a button."""
    good = tmp_path / "first"
    good.mkdir()
    for name in gpu.REQUIRED_CUDA_DLLS:
        (good / name).write_bytes(b"x")
    visited: list = []

    def spy():
        for directory in (good, tmp_path / "never-reached"):
            visited.append(directory)
            yield directory

    monkeypatch.setattr(gpu, "_search_dirs", spy)
    gpu.find_add_on_source()

    assert visited == [good]


def test_installing_copies_both_libraries_into_the_add_on_folder(
    tmp_path, monkeypatch
) -> None:
    source = tmp_path / "src"
    source.mkdir()
    for name in gpu.REQUIRED_CUDA_DLLS:
        (source / name).write_bytes(b"payload")
    target = tmp_path / "data" / "cuda"
    monkeypatch.setattr(gpu, "add_on_dir", lambda: target)

    result = gpu.install_add_on(source)

    assert sorted(result["copied"]) == sorted(gpu.REQUIRED_CUDA_DLLS)
    for name in gpu.REQUIRED_CUDA_DLLS:
        assert (target / name).read_bytes() == b"payload"


def test_installing_from_an_incomplete_folder_is_refused(tmp_path, monkeypatch) -> None:
    source = tmp_path / "src"
    source.mkdir()
    (source / gpu.REQUIRED_CUDA_DLLS[0]).write_bytes(b"x")
    monkeypatch.setattr(gpu, "add_on_dir", lambda: tmp_path / "cuda")

    with pytest.raises(FileNotFoundError):
        gpu.install_add_on(source)


def test_status_reports_files_that_arrived_after_startup(tmp_path, monkeypatch) -> None:
    """The confusing case, and the reason this field exists: the libraries
    were put in place while the app was running. libraries_found is decided
    once at startup and stays false, so the panel kept saying "not enabled"
    with the files sitting right there and no hint that only a restart was
    left to do."""
    add_on = tmp_path / "cuda"
    add_on.mkdir()
    for name in gpu.REQUIRED_CUDA_DLLS:
        (add_on / name).write_bytes(b"x")
    monkeypatch.setattr(gpu, "add_on_dir", lambda: add_on)
    monkeypatch.setattr(gpu, "_state", {"found": False, "dir": None})

    body = gpu.status()

    assert body["libraries_found"] is False  # this process still cannot use them
    assert body["dlls_in_place"] is True  # ...but they ARE there now
