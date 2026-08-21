"""Optional NVIDIA GPU acceleration for ASR.

Measured on an RTX 5060 (Blackwell, 8GB) against this project's own settings
on 2026-08-21: CPU int8 103.4s vs GPU int8_float16 9.9s for the same 60s of
Thai speech — **10.4x**, turning a 50-minute file from ~86 minutes into ~8.

Three things this module exists to get right, all learned the hard way:

1. **`get_cuda_device_count() > 0` DOES NOT mean CUDA works.** It only asks the
   display driver (`nvcuda.dll`, always present on a machine with an NVIDIA
   card). The compute libraries are a separate install. Trusting that count is
   what made an earlier attempt hang for 51 minutes.

2. **Putting the DLLs on disk is not enough — Windows has to be able to find
   them.** `os.add_dll_directory()` alone does NOT work: it only affects
   `LoadLibraryEx` with `LOAD_LIBRARY_SEARCH_USER_DIRS`, and CTranslate2
   resolves `cublas64_12.dll` with a plain `LoadLibrary` deep in its own C++.
   The directory must also go on `PATH`.

3. **Only cuBLAS is needed.** cuDNN (1.07GB) was measured to be unnecessary,
   and dropping it was marginally *faster* (9.9s vs 11.1s). The shippable
   add-on is therefore two files, ~736MB: `cublas64_12.dll` +
   `cublasLt64_12.dll`.

Nothing here may raise: this runs while the sidecar boots, and a backend that
dies on startup takes the whole app with it (FIXES.md #32).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# The two DLLs an offline "gpu add-on" folder has to contain (Windows).
REQUIRED_CUDA_DLLS = ("cublas64_12.dll", "cublasLt64_12.dll")

# Set once enable_cuda_libraries() has run, so repeat calls are free and the
# status endpoint can report what happened without redoing the work.
_state: dict | None = None


def _candidate_dirs() -> list[Path]:
    """Every place the CUDA DLLs might live, most explicit first.

    Covers the three real deployments: an env override, a folder shipped
    beside the packaged app (the USB hand-off the team uses for models), and
    pip wheels in a dev virtualenv.
    """
    # An explicit override is EXCLUSIVE. If someone says "the CUDA libraries
    # are here" and they are not, silently using a different copy would hide
    # the mistake and make the machine impossible to reason about — same
    # principle as AUDIOEDIT_DEVICE winning over detection.
    override = os.environ.get("AUDIOEDIT_CUDA_DIR")
    if override:
        return [Path(override)]

    dirs: list[Path] = []

    # Packaged app: the user drops the add-on next to the sidecar executable.
    # sys.executable is the .exe when frozen; _MEIPASS is PyInstaller's
    # unpack dir, which onedir builds also populate.
    roots = [Path(sys.executable).parent]
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        roots.append(Path(meipass))
    for root in roots:
        dirs.append(root)
        dirs.append(root / "cuda")

    # Dev virtualenv: pip wheels put the DLLs in nvidia/<lib>/bin.
    try:
        import importlib.util

        for pkg in ("nvidia.cublas", "nvidia.cudnn"):
            spec = importlib.util.find_spec(pkg)
            if spec and spec.submodule_search_locations:
                dirs.append(Path(list(spec.submodule_search_locations)[0]) / "bin")
    except Exception:
        pass  # a missing/broken nvidia package must never break startup

    return dirs


def _has_required_dlls(directory: Path) -> bool:
    try:
        return all((directory / name).is_file() for name in REQUIRED_CUDA_DLLS)
    except OSError:
        return False


def enable_cuda_libraries() -> dict:
    """Make the CUDA DLLs loadable, if they are present anywhere we look.

    Returns a status dict (also cached): `{"found": bool, "dir": str | None}`.
    Safe to call repeatedly and safe to call when there is no GPU at all.
    """
    global _state
    if _state is not None:
        return _state

    found_dir: Path | None = None
    for directory in _candidate_dirs():
        if _has_required_dlls(directory):
            found_dir = directory
            break

    if found_dir is not None:
        try:
            # BOTH are required — see the module docstring. add_dll_directory
            # covers Python's own imports; PATH covers CTranslate2's internal
            # LoadLibrary, which is the one that actually needs cuBLAS.
            if hasattr(os, "add_dll_directory"):
                os.add_dll_directory(str(found_dir))
            os.environ["PATH"] = str(found_dir) + os.pathsep + os.environ.get("PATH", "")
        except OSError:
            found_dir = None  # unreadable path — behave as if it were absent

    _state = {"found": found_dir is not None, "dir": str(found_dir) if found_dir else None}
    return _state


def cuda_available() -> bool:
    """Do we have a GPU AND the libraries to drive it?

    Deliberately conservative: both halves must hold. A machine with a card
    but no cuBLAS reports False, because that is exactly the configuration
    that hangs.
    """
    if not enable_cuda_libraries()["found"]:
        return False
    try:
        import ctranslate2

        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


def status() -> dict:
    """What the app should tell the user about GPU acceleration."""
    libs = enable_cuda_libraries()
    devices = 0
    try:
        import ctranslate2

        devices = ctranslate2.get_cuda_device_count()
    except Exception:
        pass
    return {
        "libraries_found": libs["found"],
        "libraries_dir": libs["dir"],
        "devices": devices,
        # Only this combination is actually usable.
        "available": libs["found"] and devices > 0,
        "required_dlls": list(REQUIRED_CUDA_DLLS),
    }
