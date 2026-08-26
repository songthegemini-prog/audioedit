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

    # The data folder, beside `models/`. This is the FIRST place we look and
    # the one the docs recommend: the team already knows how to reach it
    # (it is where they drop the models folder from USB), and unlike the
    # install directory it needs no admin rights to write to.
    data_dir = os.environ.get("AUDIOEDIT_DATA_DIR")
    if data_dir:
        dirs.append(Path(data_dir) / "cuda")

    # Packaged app. The sidecar does NOT live next to the main executable —
    # Tauri puts it at <install>/resources/backend/audioedit-backend/ — but
    # "next to the app icon" is exactly where a user will drop the add-on.
    # So walk UP from the sidecar as well, which covers both spellings.
    roots: list[Path] = [Path(sys.executable).parent]
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        roots.append(Path(meipass))
    for root in list(roots):
        # 4 levels reaches the install root from
        # <install>/resources/backend/audioedit-backend/
        parent = root
        for _ in range(4):
            parent = parent.parent
            if parent == parent.parent:  # hit the drive root
                break
            roots.append(parent)
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
        # Checked FRESH every call, unlike libraries_found which is decided
        # once at startup and cached. The two disagree in exactly one case,
        # and it is the confusing one: the files were put in place while the
        # app was already running. The app then kept saying "you have a card
        # but it is not enabled" with the files sitting right there, and
        # nothing told the editor a restart was all that was left
        # (reported 2026-08-26).
        "dlls_in_place": _has_required_dlls(add_on_dir()),
    }


def add_on_dir() -> Path:
    """Where the app tells people to put the CUDA libraries.

    Beside `models/` in the data folder: no admin rights needed, and the team
    already knows how to reach it — it is where they drop the models folder
    from a USB stick.
    """
    from . import config

    return config.DATA_ROOT / "cuda"


# Places a machine that already has CUDA keeps these libraries. Searched in
# order and each one is cheap to check — no walking whole drives, which took
# minutes when tried by hand and is not something to do behind a button.
def _search_dirs():
    """Yielded, not returned as a list, so the caller can stop at the first
    hit. Built eagerly it took 13.5s even when the answer was in the very
    first place looked at — far too slow to sit behind a button."""
    # PATH first: a CUDA Toolkit install puts its bin directory there, so this
    # single pass usually answers the question outright.
    for entry in os.environ.get("PATH", "").split(os.pathsep):
        if entry.strip():
            yield Path(entry)

    program_files = [
        Path(os.environ.get("ProgramFiles", r"C:\Program Files")),
        Path(os.environ.get("ProgramW6432", r"C:\Program Files")),
    ]
    for root in program_files:
        toolkit = root / "NVIDIA GPU Computing Toolkit" / "CUDA"
        try:
            yield from sorted(toolkit.glob("v12*/bin"), reverse=True)
        except OSError:
            pass

    # PyTorch and the NVIDIA pip wheels both ship them, and a machine used for
    # any ML work usually has one of the two.
    roots = [Path(sys.prefix)]
    for var in ("LOCALAPPDATA", "USERPROFILE", "APPDATA"):
        value = os.environ.get(var)
        if value:
            roots.append(Path(value))
    for root in roots:
        for pattern in (
            "**/site-packages/torch/lib",
            "**/site-packages/nvidia/cublas/bin",
        ):
            try:
                # Bounded on purpose: enough to reach a venv a level or two
                # down, not enough to become a whole-disk scan.
                yield from _bounded_glob(root, pattern, depth=6)
            except OSError:
                pass


def _bounded_glob(root: Path, pattern: str, depth: int) -> list[Path]:
    """glob without letting `**` wander the entire drive."""
    tail = pattern.split("**/", 1)[1]
    out: list[Path] = []
    prefix = ""
    for _ in range(depth):
        try:
            out.extend(p for p in root.glob(prefix + tail) if p.is_dir())
        except OSError:
            break
        prefix += "*/"
    return out


def find_add_on_source() -> Path | None:
    """A folder on this machine that already holds both libraries."""
    for directory in _search_dirs():
        if _has_required_dlls(directory):
            return directory
    return None


def install_add_on(source: Path) -> dict:
    """Copy the libraries into the add-on folder. Returns what was copied.

    Copying rather than pointing at the source: the source is usually inside
    someone else's package, which an update or a cleanup can remove without
    warning, and a GPU that stops working for no visible reason is worse than
    one that never started.
    """
    import shutil

    if not _has_required_dlls(source):
        raise FileNotFoundError(f"ไม่พบไฟล์ที่ต้องใช้ใน {source}")
    target = add_on_dir()
    target.mkdir(parents=True, exist_ok=True)
    copied = []
    for name in REQUIRED_CUDA_DLLS:
        destination = target / name
        if destination.resolve() != (source / name).resolve():
            shutil.copy2(source / name, destination)
        copied.append(name)
    return {"dir": str(target), "copied": copied}
