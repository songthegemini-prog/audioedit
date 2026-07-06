from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .align import CTCAligner, SegmentWords
from .align_script import line_tokens
from .asr import FasterWhisperEngine
from .jobs import JobStore
from .tokens import segment_words

APP_VERSION = "1.0.0"

# Only the Tauri webview may talk to this backend — it must never be
# reachable from anywhere outside the local app.
ALLOWED_ORIGINS = [
    "http://localhost:1420",  # tauri dev (vite)
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


@app.get("/models_status")
def models_status() -> dict:
    """First-run check: are the AI models installed on this machine?"""
    from . import config

    return {
        "asr": config.model_present(config.model_dir()),
        "align": config.model_present(config.align_model_dir()),
        "dataDir": str(config.DATA_ROOT),
    }


@app.post("/download_models")
def download_models(store: JobStore = Depends(get_job_store)) -> dict[str, str]:
    """First-run installer: download both models (~4.4GB, setup-time only)."""
    job = store.submit_download_models()
    return {"job_id": job.id}


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


@app.post("/realign")
def realign(req: RealignRequest, aligner: CTCAligner = Depends(get_aligner)) -> dict:
    """แก้ทั้งวรรค: re-align edited segment text within its time range (sync)."""
    path = Path(req.path).expanduser()
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"file not found: {path}")
    if req.end <= req.start:
        raise HTTPException(status_code=400, detail="invalid time range")
    words = segment_words(req.text)
    if not words:
        raise HTTPException(status_code=400, detail="ข้อความว่างเปล่า")

    try:
        spans = next(iter(aligner.align(path, [SegmentWords(req.start, req.end, words)])))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}")
    if not any(s is not None for s in spans):
        spans = None  # nothing aligned — fall back to proportional times
    tokens = line_tokens(req.text, req.start, req.end, spans)
    return {
        "text": req.text,
        "start": tokens[0].start,
        "end": tokens[-1].end,
        "tokens": [t.to_dict() for t in tokens],
    }


class EdlCut(BaseModel):
    start: float
    end: float


class ExportAudioRequest(BaseModel):
    path: str
    out_path: str
    edl: list[EdlCut]


@app.post("/export_audio")
def export_audio(
    req: ExportAudioRequest, store: JobStore = Depends(get_job_store)
) -> dict[str, str]:
    """Render the EDL into a NEW wav — the source file is never modified."""
    path = Path(req.path).expanduser()
    out_path = Path(req.out_path).expanduser()
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"file not found: {path}")
    if not out_path.parent.is_dir():
        raise HTTPException(status_code=400, detail=f"no such folder: {out_path.parent}")
    if out_path.resolve() == path.resolve():
        raise HTTPException(status_code=400, detail="ห้ามเขียนทับไฟล์ต้นฉบับ")
    job = store.submit_export(path, out_path, [(c.start, c.end) for c in req.edl])
    return {"job_id": job.id}


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
