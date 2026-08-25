from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .align import CTCAligner, SegmentWords
from .align_script import line_tokens
from .asr import FasterWhisperEngine
from .jobs import JobStore
from .tokens import segment_words

APP_VERSION = "1.4.5"

# Only the Tauri webview may talk to this backend — it must never be
# reachable from anywhere outside the local app.
ALLOWED_ORIGINS = [
    "http://localhost:1420",  # tauri dev (vite)
    "http://localhost:1421",  # vite-debug preview (dev only, still localhost)
    "tauri://localhost",  # tauri production (macOS/Linux)
    "http://tauri.localhost",  # tauri production (Windows)
]

app = FastAPI(title="Thai Audio Text-Editor backend", version=APP_VERSION)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

_job_store: JobStore | None = None
_aligner: CTCAligner | None = None


def get_aligner() -> CTCAligner:
    global _aligner
    if _aligner is None:
        _aligner = CTCAligner()
    return _aligner


def get_job_store() -> JobStore:
    global _job_store
    if _job_store is None:
        _job_store = JobStore(FasterWhisperEngine(), aligner=get_aligner())
    return _job_store


class TranscribeRequest(BaseModel):
    path: str


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "version": APP_VERSION}


def _dir_size_bytes(path: Path) -> int:
    if not path.is_dir():
        return 0
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


@app.get("/models_status")
def models_status() -> dict:
    """First-run check: are the AI models installed on this machine?

    Also reports where they live and how big they are. Uninstalling the app
    deliberately LEAVES the models in place so an update does not re-download
    4.4GB — but the team only discovered that by accident (feedback
    2026-08-20), so the app now says it out loud and offers to delete them.
    """
    from . import config

    models_root = config.DATA_ROOT / "models"
    return {
        "asr": config.model_present(config.model_dir()),
        "align": config.model_present(config.align_model_dir()),
        "dataDir": str(config.DATA_ROOT),
        "modelsDir": str(models_root),
        "modelsBytes": _dir_size_bytes(models_root),
        # GPU acceleration is optional and opt-in via an add-on folder; the UI
        # needs to know whether it is active to explain the speed difference.
        "gpu": _gpu_status(),
    }


def _gpu_status() -> dict:
    """Never let a GPU probe break /models_status — that endpoint gates the
    whole first-run flow (FIXES.md #32)."""
    try:
        from . import gpu

        body = gpu.status()
        body["device"] = _config().device()
        return body
    except Exception as err:  # pragma: no cover - defensive only
        return {"available": False, "error": str(err), "device": "cpu"}


def _config():
    from . import config

    return config


@app.post("/delete_models")
def delete_models() -> dict:
    """Remove the downloaded models to reclaim the disk they use.

    Scoped to DATA_ROOT/models and nothing else: a custom AUDIOEDIT_MODEL_DIR
    may point anywhere (including inside a repo checkout), and this endpoint
    must never delete a folder the user pointed us at rather than one we
    created.
    """
    import shutil

    from . import config

    models_root = config.DATA_ROOT / "models"
    if not models_root.is_dir():
        return {"deleted": False, "freedBytes": 0, "modelsDir": str(models_root)}
    freed = _dir_size_bytes(models_root)
    shutil.rmtree(models_root)
    return {"deleted": True, "freedBytes": freed, "modelsDir": str(models_root)}


@app.post("/download_models")
def download_models(store: JobStore = Depends(get_job_store)) -> dict[str, str]:
    """First-run installer: download both models (~4.4GB, setup-time only)."""
    job = store.submit_download_models()
    return {"job_id": job.id}


# --- long-file mode (Phase 9): canonical cache WAV + peaks + PCM windows ---


@app.get("/audio_info")
def audio_info(path: str) -> dict:
    """Fast metadata probe (no decode) — the frontend picks short/long mode."""
    from . import longfile

    p = Path(path).expanduser()
    if not p.is_file():
        raise HTTPException(status_code=404, detail=f"file not found: {p}")
    return longfile.probe(p)


class PrepareRequest(BaseModel):
    path: str


@app.post("/prepare_audio")
def prepare_audio(
    req: PrepareRequest, store: JobStore = Depends(get_job_store)
) -> dict[str, str]:
    """Long-file mode: stream-transcode to the canonical WAV (job)."""
    path = Path(req.path).expanduser()
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"file not found: {path}")
    job = store.submit_prepare(path)
    return {"job_id": job.id}


@app.get("/audio_file")
def audio_file(path: str, request: Request) -> Response:
    """Serve the canonical WAV with HTTP Range so the media element can
    stream + seek without the frontend ever holding the file in memory."""
    from . import longfile

    p = Path(path).expanduser()
    if not p.is_file():
        raise HTTPException(status_code=404, detail=f"file not found: {p}")
    wav = longfile.wav_path_for(p)
    if not wav.exists():
        raise HTTPException(status_code=404, detail="not prepared — call /prepare_audio")
    size = wav.stat().st_size
    rng = longfile.parse_range(request.headers.get("range"), size)
    headers = {"Accept-Ranges": "bytes"}

    def stream(start: int, end: int):  # inclusive end
        with wav.open("rb") as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                block = f.read(min(1 << 20, remaining))
                if not block:
                    break
                remaining -= len(block)
                yield block

    if rng is None:
        headers["Content-Length"] = str(size)
        return StreamingResponse(
            stream(0, size - 1), media_type="audio/wav", headers=headers
        )
    start, end = rng
    headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    headers["Content-Length"] = str(end - start + 1)
    return StreamingResponse(
        stream(start, end), status_code=206, media_type="audio/wav", headers=headers
    )


@app.get("/peaks")
def peaks(path: str) -> Response:
    """Precomputed min/max pairs (float32) for drawing the waveform."""
    from . import longfile

    p = Path(path).expanduser()
    try:
        data = longfile.read_peaks(p)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="not prepared — call /prepare_audio")
    return Response(content=data, media_type="application/octet-stream")


@app.get("/pcm")
def pcm(path: str, start: float, end: float) -> Response:
    """Float32 mono window from the canonical WAV — feeds spectrogram/snap.
    Read straight from the same bytes the media element plays (same-PCM)."""
    from . import longfile

    p = Path(path).expanduser()
    try:
        data, rate = longfile.read_pcm_window(p, start, end)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="not prepared — call /prepare_audio")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"X-Sample-Rate": str(rate)},
    )


@app.post("/transcribe")
def transcribe(
    req: TranscribeRequest, store: JobStore = Depends(get_job_store)
) -> dict[str, str]:
    path = Path(req.path).expanduser()
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"file not found: {path}")
    job = store.submit(path)
    return {"job_id": job.id}


class AlignScriptRequest(BaseModel):
    path: str
    script_path: str


@app.post("/align_script")
def align_script(
    req: AlignScriptRequest, store: JobStore = Depends(get_job_store)
) -> dict[str, str]:
    """มีบทอยู่แล้ว: force-align a known script to the audio — no ASR."""
    path = Path(req.path).expanduser()
    script = Path(req.script_path).expanduser()
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"file not found: {path}")
    if not script.is_file():
        raise HTTPException(status_code=404, detail=f"script not found: {script}")
    job = store.submit_align_script(path, script)
    return {"job_id": job.id}


class RealignRequest(BaseModel):
    path: str
    text: str
    start: float
    end: float
    # Where the aligner may LOOK, when that has to be wider than the segment.
    #
    # A script built from an incomplete transcription ends each line early, so
    # the segment ends early too and the audio for the missing words sits
    # OUTSIDE it. Typing those words back in then gives them nowhere to go and
    # they pile up against the closing boundary — reported 2026-08-25,
    # "ตัวเทคด้านหลังที่เติมเข้าไปมองเป็นก้อนเดียว". Measured on the team's own
    # file: 10 added words squeezed into 1.63s at confidence 0.07, and the same
    # words across 3.43s at 0.82 once the window could reach the audio.
    #
    # The caller sends this ONLY when the text grew, and sizes it from the
    # words actually added. Widening by default is not an option: the same
    # measurement with a blanket +/-15s window took mean error on UNCHANGED
    # text from 26ms to 922ms — a loose window lets alignment wander, which is
    # the whole lesson of FIXES.md #62.
    search_start: float | None = None
    search_end: float | None = None


@app.post("/realign")
def realign(req: RealignRequest, aligner: CTCAligner = Depends(get_aligner)) -> dict:
    """แก้ทั้งวรรค: re-align edited segment text within its time range (sync).

    Accurate, and for a structural reason worth stating: this aligns ONE
    paragraph inside the time range that paragraph already has. That is the
    tight-window condition forced alignment wants — the window holds almost
    exactly the words being aligned, there is no cursor, and nothing can
    accumulate. It is the same reason transcription never drifted while whole-
    file script alignment did (FIXES.md #62, #63).

    Measured on 10 segments spread through the team's own programme, comparing
    word starts against the alignment already in the project:

      retyped identically      100.0% within 50ms,  mean 0.0ms
      one word corrected        99.6% within 50ms,  mean 0.8ms
      10% of the words removed  99.3% within 50ms,  mean 11.2ms

    The outliers sit at the point where the text actually changed, which is
    where they belong. WITHOUT the alignment model none of this applies: the
    times are spread evenly and marked confidence 0 — see the fallback below.
    """
    path = Path(req.path).expanduser()
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"file not found: {path}")
    if req.end <= req.start:
        raise HTTPException(status_code=400, detail="invalid time range")
    words = segment_words(req.text)
    if not words:
        raise HTTPException(status_code=400, detail="ข้อความว่างเปล่า")

    # Never fail for want of the alignment model. The editors who retype a
    # paragraph are the ones WITHOUT it: the machine that owns the models
    # produces the transcript and hands the project on, and from there the
    # editor must still be able to fix both the audio and the words (2026-08-24).
    #
    # What แก้ทั้งวรรค genuinely needs is Thai word segmentation, which is
    # pythainlp and ships inside the sidecar on every machine. The model only
    # refines the TIMES; without it the words are spread across the segment's
    # own range and marked confidence 0, exactly as a line that refuses to
    # align already is — flagged red for review, never silently wrong.
    spans = None
    aligned = False
    try:
        look_start = req.search_start if req.search_start is not None else req.start
        look_end = req.search_end if req.search_end is not None else req.end
        got = next(iter(aligner.align(path, [SegmentWords(look_start, look_end, words)])))
        if any(s is not None for s in got):
            spans = got
            aligned = True
    except Exception:
        spans = None  # no model, or it failed — proportional times instead
    tokens = line_tokens(req.text, req.start, req.end, spans)
    return {
        "text": req.text,
        "start": tokens[0].start,
        "end": tokens[-1].end,
        "tokens": [t.to_dict() for t in tokens],
        # False when the times are spread evenly rather than heard. The UI says
        # so, because these words must not be cut from as if they were exact.
        "aligned": aligned,
    }


class EdlCut(BaseModel):
    start: float
    end: float


class ExportAudioRequest(BaseModel):
    path: str
    out_path: str
    edl: list[EdlCut]
    # "wav" keeps the source's own bit depth (see app/audiofmt.py); "mp3" is a
    # deliberately lossy hand-off format the team asked for.
    format: Literal["wav", "mp3"] = "wav"
    # None = match the source. Only meaningful for wav.
    bits: Literal[16, 24, 32] | None = None


@app.post("/export_audio")
def export_audio(
    req: ExportAudioRequest, store: JobStore = Depends(get_job_store)
) -> dict[str, str]:
    """Render the EDL into a NEW audio file — the source is never modified."""
    path = Path(req.path).expanduser()
    out_path = Path(req.out_path).expanduser()
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"file not found: {path}")
    if not out_path.parent.is_dir():
        raise HTTPException(status_code=400, detail=f"no such folder: {out_path.parent}")
    if out_path.resolve() == path.resolve():
        raise HTTPException(status_code=400, detail="ห้ามเขียนทับไฟล์ต้นฉบับ")
    job = store.submit_export(
        path,
        out_path,
        [(c.start, c.end) for c in req.edl],
        export_format=req.format,
        export_bits=req.bits,
    )
    return {"job_id": job.id}


class AnalyzeRequest(BaseModel):
    """Measure one file, optionally through an EDL.

    To verify an export, call this TWICE: once with the source plus the
    project's EDL, once with the exported file and no EDL. Comparing a source
    against an export without the EDL always disagrees — the export is
    deliberately shorter.
    """

    path: str
    edl: list[EdlCut] = []


@app.post("/analyze_audio")
def analyze_audio(req: AnalyzeRequest) -> dict:
    """Peak/RMS of a file, so the editors can prove we changed no levels."""
    path = Path(req.path).expanduser()
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"file not found: {path}")
    from .analyze import measure  # numpy/av import kept lazy

    cuts = [(c.start, c.end) for c in req.edl]
    return measure(path, cuts or None).as_dict()


class CompareRequest(BaseModel):
    source_path: str
    edited_path: str
    edl: list[EdlCut] = []


@app.post("/compare_audio")
def compare_audio(req: CompareRequest) -> dict:
    """Full verdict: did the export preserve the source's energy?"""
    source = Path(req.source_path).expanduser()
    edited = Path(req.edited_path).expanduser()
    for candidate in (source, edited):
        if not candidate.is_file():
            raise HTTPException(status_code=404, detail=f"file not found: {candidate}")
    from .analyze import compare, measure

    cuts = [(c.start, c.end) for c in req.edl]
    return compare(measure(source, cuts or None), measure(edited))


class PackProjectRequest(BaseModel):
    """Copy the source audio into a self-contained project folder.

    Why a FOLDER and not a zip (team decision 2026-08-20): the audio is often
    hundreds of MB, and a zip would have to be extracted before the app could
    open it. A folder can be opened straight away, and the team zips it
    themselves when they need to send it.
    """

    audio_path: str
    out_dir: str


@app.post("/pack_project")
def pack_project(req: PackProjectRequest) -> dict:
    """Create `out_dir` and copy the source audio into it, unchanged.

    Only the audio moves here — the caller writes the .json beside it with a
    BARE FILENAME as audioPath, which is what makes the folder portable.
    """
    import shutil

    audio = Path(req.audio_path).expanduser()
    out_dir = Path(req.out_dir).expanduser()
    if not audio.is_file():
        raise HTTPException(status_code=404, detail=f"file not found: {audio}")
    if out_dir.exists() and not out_dir.is_dir():
        raise HTTPException(status_code=400, detail=f"มีไฟล์ชื่อนี้อยู่แล้ว: {out_dir}")
    out_dir.mkdir(parents=True, exist_ok=True)

    destination = out_dir / audio.name
    # Copying a file onto itself truncates it — that would destroy the very
    # source we are trying to package (CLAUDE.md: never modify the source).
    if destination.resolve() == audio.resolve():
        raise HTTPException(status_code=400, detail="ปลายทางเป็นไฟล์ต้นฉบับเอง")
    shutil.copy2(audio, destination)

    return {
        "out_dir": str(out_dir),
        "audio_name": audio.name,
        "audio_path": str(destination),
        "bytes": destination.stat().st_size,
    }


class ExportDocxRequest(BaseModel):
    out_path: str
    lines: list[str]


@app.post("/export_docx")
def export_docx(req: ExportDocxRequest) -> dict:
    """Write the EDITED content (computed by the frontend) as a .docx."""
    out_path = Path(req.out_path).expanduser()
    if not out_path.parent.is_dir():
        raise HTTPException(status_code=400, detail=f"no such folder: {out_path.parent}")
    from docx import Document  # python-docx

    doc = Document()
    for line in req.lines:
        doc.add_paragraph(line)
    doc.save(str(out_path))
    return {"out_path": str(out_path), "paragraphs": len(req.lines)}


@app.delete("/jobs/{job_id}")
def cancel_job(job_id: str, store: JobStore = Depends(get_job_store)) -> dict:
    if store.get(job_id) is None:
        raise HTTPException(status_code=404, detail="job not found")
    return {"cancelled": store.cancel(job_id)}


@app.get("/jobs/{job_id}")
def get_job(job_id: str, store: JobStore = Depends(get_job_store)) -> dict:
    job = store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return job.to_dict()
