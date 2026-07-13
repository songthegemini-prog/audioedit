"""In-memory transcription jobs. One transcription runs at a time; the rest queue."""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, replace
from enum import StrEnum
from pathlib import Path

from collections.abc import Callable

from .align import Aligner, SegmentWords, audio_duration
from .align_script import align_script_lines, read_script, script_lines
from .asr import ASREngine
from .tokens import Token, segment_to_tokens


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    ERROR = "error"
    CANCELLED = "cancelled"


class JobCancelled(Exception):
    """Raised inside job loops when the user cancels — not an error."""


@dataclass
class Job:
    id: str
    path: Path
    kind: str = "transcribe"  # "transcribe" | "align_script" | "export" | "prepare"
    script_path: Path | None = None
    out_path: Path | None = None
    edl: list[tuple[float, float]] | None = None
    status: JobStatus = JobStatus.QUEUED
    progress: float = 0.0  # 0..1
    result: dict | None = None
    error: str | None = None
    cancelled: bool = False
    finished_at: float | None = None  # monotonic time it reached a terminal state

    def check_cancelled(self) -> None:
        if self.cancelled:
            raise JobCancelled()

    def to_dict(self) -> dict:
        return {
            "job_id": self.id,
            "status": self.status.value,
            "progress": round(self.progress, 3),
            "result": self.result,
            "error": self.error,
        }


class JobStore:
    def __init__(
        self,
        engine: ASREngine,
        aligner: Aligner | None = None,
        duration_fn: Callable[[Path], float] = audio_duration,
    ) -> None:
        self._engine = engine
        self._aligner = aligner
        self._duration_fn = duration_fn
        self._jobs: dict[str, Job] = {}
        self._jobs_lock = threading.Lock()
        self._run_lock = threading.Lock()  # one transcription at a time

    def submit(self, path: Path) -> Job:
        return self._submit(Job(id=uuid.uuid4().hex, path=path))

    def submit_align_script(self, path: Path, script_path: Path) -> Job:
        return self._submit(
            Job(id=uuid.uuid4().hex, path=path, kind="align_script", script_path=script_path)
        )

    def submit_export(
        self, path: Path, out_path: Path, edl: list[tuple[float, float]]
    ) -> Job:
        return self._submit(
            Job(id=uuid.uuid4().hex, path=path, kind="export", out_path=out_path, edl=edl)
        )

    def submit_download_models(self) -> Job:
        return self._submit(Job(id=uuid.uuid4().hex, path=Path("."), kind="download_models"))

    def submit_prepare(self, path: Path) -> Job:
        """Long-file mode: transcode to the canonical cache WAV + peaks."""
        return self._submit(Job(id=uuid.uuid4().hex, path=path, kind="prepare"))

    def cancel(self, job_id: str) -> bool:
        job = self.get(job_id)
        if job is None or job.status in (JobStatus.DONE, JobStatus.ERROR, JobStatus.CANCELLED):
            return False
        job.cancelled = True
        return True

    # keep memory flat across a long session: a transcription result can hold
    # tens of thousands of tokens, so don't retain every finished job forever
    # (Codex review — JobStore had no pruning)
    MAX_KEPT_JOBS = 40
    # a finished job must stay readable long enough for the frontend's ~1s poll
    # to observe its result before it can be pruned — otherwise /jobs/{id} 404s
    # and the UI shows "failed" for a job that succeeded (Codex re-review #2)
    PRUNE_GRACE_SEC = 30.0

    def _submit(self, job: Job) -> Job:
        with self._jobs_lock:
            self._jobs[job.id] = job
            self._prune_locked()
        threading.Thread(target=self._run, args=(job,), daemon=True).start()
        return job

    def _prune_locked(self) -> None:
        """Drop the oldest finished jobs once over the cap, but never one that
        finished within the grace window (the client may not have polled its
        result yet). Active jobs are always kept. Caller holds _jobs_lock."""
        if len(self._jobs) <= self.MAX_KEPT_JOBS:
            return
        now = time.monotonic()
        prunable = [
            jid
            for jid, j in self._jobs.items()
            if j.finished_at is not None and now - j.finished_at >= self.PRUNE_GRACE_SEC
        ]
        prunable.sort(key=lambda jid: self._jobs[jid].finished_at or 0.0)  # oldest first
        for jid in prunable[: len(self._jobs) - self.MAX_KEPT_JOBS]:
            del self._jobs[jid]

    def get(self, job_id: str) -> Job | None:
        with self._jobs_lock:
            return self._jobs.get(job_id)

    def _run(self, job: Job) -> None:
        with self._run_lock:
            job.status = JobStatus.RUNNING
            try:
                job.check_cancelled()  # cancelled while queued
                if job.kind == "align_script":
                    self._run_align_script(job)
                elif job.kind == "export":
                    self._run_export(job)
                elif job.kind == "prepare":
                    self._run_prepare(job)
                elif job.kind == "download_models":
                    self._run_download_models(job)
                else:
                    self._run_transcribe(job)
            except JobCancelled:
                job.status = JobStatus.CANCELLED
            except Exception as exc:  # surface the reason to the UI
                job.error = f"{type(exc).__name__}: {exc}"
                job.status = JobStatus.ERROR
            finally:
                # mark the finish time, then prune here too (not only on submit)
                # — a burst that all finishes without a later submit still stays
                # bounded; the grace window keeps just-finished results readable
                # (Codex re-review #2/#3)
                job.finished_at = time.monotonic()
                with self._jobs_lock:
                    self._prune_locked()

    def _run_export(self, job: Job) -> None:
        """Render the EDL into a new WAV — the source file is never touched."""
        from .render import render_export  # numpy/av import kept lazy

        assert job.out_path is not None and job.edl is not None
        job.check_cancelled()

        def on_progress(frac: float) -> None:
            job.progress = frac

        # streaming render: progress is real (seconds decoded / duration)
        # and cancel is checked on every chunk, even mid-hour-long files
        job.result = render_export(
            job.path,
            job.out_path,
            job.edl,
            on_progress=on_progress,
            check_cancelled=job.check_cancelled,
        )
        job.progress = 1.0
        job.status = JobStatus.DONE

    def _run_prepare(self, job: Job) -> None:
        """Transcode to the canonical WAV + peaks (idempotent, streaming)."""
        from .longfile import prepare  # numpy/av import kept lazy

        def on_progress(frac: float) -> None:
            job.progress = frac

        job.result = prepare(
            job.path, on_progress=on_progress, check_cancelled=job.check_cancelled
        )
        job.progress = 1.0
        job.status = JobStatus.DONE

    def _run_align_script(self, job: Job) -> None:
        """มีบทอยู่แล้ว: force-align the script line by line, no ASR at all."""
        assert self._aligner is not None and job.script_path is not None
        lines = script_lines(read_script(job.script_path))
        if not lines:
            raise ValueError("ไฟล์บทว่างเปล่า")

        def align_window(start: float, end: float, words: list[str]):
            return next(iter(self._aligner.align(job.path, [SegmentWords(start, end, words)])))

        def on_progress(frac: float) -> None:
            job.check_cancelled()
            job.progress = frac

        aligned = align_script_lines(
            lines, self._duration_fn(job.path), align_window, on_progress
        )
        tokens = [t for line in aligned for t in line.tokens]
        job.result = {
            "text": "".join(line.text for line in aligned),
            "segments": [
                {"text": line.text, "start": line.start, "end": line.end} for line in aligned
            ],
            "tokens": [t.to_dict() for t in tokens],
            "timestamps": "aligned",
            "alignError": None,
        }
        job.progress = 1.0
        job.status = JobStatus.DONE

    def _run_download_models(self, job: Job) -> None:
        """First-run installer: fetch both models (setup-time network only)."""
        from . import fetch_models

        def on_progress(frac: float) -> None:
            job.progress = frac

        fetch_models.download_all(progress=on_progress, abort_check=job.check_cancelled)
        job.result = {"downloaded": True}
        job.progress = 1.0
        job.status = JobStatus.DONE

    def _run_transcribe(self, job: Job) -> None:
        stream = self._engine.transcribe(job.path)
        asr_share = 0.7 if self._aligner else 1.0
        segments: list[dict] = []
        seg_tokens: list[list[Token]] = []
        for seg in stream.segments:
            job.check_cancelled()
            segments.append({"text": seg.text, "start": seg.start, "end": seg.end})
            seg_tokens.append(segment_to_tokens(seg.text, seg.start, seg.end))
            if stream.duration > 0:
                job.progress = asr_share * min(seg.end / stream.duration, 1.0)

        timestamps = "rough"
        align_error: str | None = None
        if self._aligner is not None and segments:
            try:
                self._align_tokens(job, segments, seg_tokens, asr_share)
                timestamps = "aligned"
            except JobCancelled:
                raise
            except Exception as exc:  # fall back to rough, never fail the job
                align_error = f"{type(exc).__name__}: {exc}"

        tokens = [t for toks in seg_tokens for t in toks]
        job.result = {
            # Thai has no spaces between words — join segments directly
            "text": "".join(s["text"].strip() for s in segments),
            "segments": segments,
            "tokens": [t.to_dict() for t in tokens],
            # "rough" timestamps are not alignment-refined: never cut from them
            "timestamps": timestamps,
            "alignError": align_error,
        }
        job.progress = 1.0
        job.status = JobStatus.DONE

    def _align_tokens(
        self,
        job: Job,
        segments: list[dict],
        seg_tokens: list[list[Token]],
        asr_share: float,
    ) -> None:
        assert self._aligner is not None
        seg_words = [
            SegmentWords(s["start"], s["end"], [t.text for t in toks])
            for s, toks in zip(segments, seg_tokens)
        ]
        total = len(seg_words)
        for i, spans in enumerate(self._aligner.align(job.path, seg_words)):
            job.check_cancelled()
            refined: list[Token] = []
            for token, span in zip(seg_tokens[i], spans):
                if span is None:
                    refined.append(replace(token, confidence=0.0))
                else:
                    refined.append(
                        replace(
                            token,
                            start=span.start,
                            end=span.end,
                            confidence=span.confidence,
                        )
                    )
            seg_tokens[i] = refined
            job.progress = asr_share + (1.0 - asr_share) * ((i + 1) / total)
