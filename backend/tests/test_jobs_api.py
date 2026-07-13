import time
from collections.abc import Iterator
from pathlib import Path

from fastapi.testclient import TestClient

from app.align import SegmentWords
from app.align_spans import WordSpan
from app.asr import ASRSegment, TranscribeStream
from app.jobs import JobStore
from app.main import app, get_aligner, get_job_store


class FakeEngine:
    def transcribe(self, audio_path: Path) -> TranscribeStream:
        segs = [
            ASRSegment("สวัสดีครับ", 0.0, 1.0),
            ASRSegment("อ่าทดสอบ", 1.0, 2.0),
        ]
        return TranscribeStream(duration=2.0, segments=iter(segs))


class FakeAligner:
    """Shifts every word 0.5s later with confidence 0.9; last word unalignable."""

    def align(
        self, audio_path: Path, segments: list[SegmentWords]
    ) -> Iterator[list[WordSpan | None]]:
        for i, seg in enumerate(segments):
            spans: list[WordSpan | None] = [
                WordSpan(seg.start + 0.5, seg.start + 0.6, 0.9) for _ in seg.words
            ]
            if i == len(segments) - 1:
                spans[-1] = None
            yield spans


class FailingAligner:
    def align(self, audio_path: Path, segments: list[SegmentWords]):
        raise FileNotFoundError("alignment model not found")
        yield  # pragma: no cover — make this a generator


def make_client(aligner=None) -> TestClient:
    store = JobStore(FakeEngine(), aligner=aligner, duration_fn=lambda p: 60.0)
    app.dependency_overrides[get_job_store] = lambda: store
    if aligner is not None:
        app.dependency_overrides[get_aligner] = lambda: aligner
    return TestClient(app)


def teardown_function() -> None:
    app.dependency_overrides.clear()


def wait_for_done(client: TestClient, job_id: str, timeout: float = 5.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        body = client.get(f"/jobs/{job_id}").json()
        if body["status"] in ("done", "error", "cancelled"):
            return body
        time.sleep(0.02)
    raise AssertionError("job did not finish in time")


def test_jobstore_prunes_old_finished_jobs_but_keeps_running() -> None:
    from app.jobs import Job, JobStatus

    store = JobStore(FakeEngine())
    # fill past the cap with already-finished jobs + one still "running"
    running = Job(id="run", path=Path("."), status=JobStatus.RUNNING)
    store._jobs["run"] = running
    for i in range(JobStore.MAX_KEPT_JOBS + 10):
        store._jobs[f"done{i}"] = Job(
            id=f"done{i}", path=Path("."), status=JobStatus.DONE
        )
    store._prune_locked()
    assert len(store._jobs) <= JobStore.MAX_KEPT_JOBS
    assert "run" in store._jobs  # active job must survive pruning
    assert "done0" not in store._jobs  # oldest finished dropped first


def test_jobstore_prunes_as_jobs_finish_without_new_submit(tmp_path: Path) -> None:
    # Codex re-review #3: a burst of jobs is all active at submit time (nothing
    # to prune then); once they FINISH the store must shrink on its own, with
    # no further submit. Real lifecycle, not a staged dict.
    audio = tmp_path / "a.wav"
    audio.write_bytes(b"fake")
    store = JobStore(FakeEngine(), duration_fn=lambda p: 60.0)
    n = JobStore.MAX_KEPT_JOBS + 15
    ids = [store.submit(audio).id for _ in range(n)]
    deadline = time.monotonic() + 15.0
    while time.monotonic() < deadline:
        if all(
            (j := store.get(i)) is None
            or j.status in ("done", "error", "cancelled")
            for i in ids
        ):
            break
        time.sleep(0.02)
    with store._jobs_lock:
        assert len(store._jobs) <= JobStore.MAX_KEPT_JOBS


def test_transcribe_rejects_missing_file() -> None:
    client = make_client()
    res = client.post("/transcribe", json={"path": "/no/such/file.wav"})
    assert res.status_code == 404


def test_unknown_job_is_404() -> None:
    client = make_client()
    assert client.get("/jobs/deadbeef").status_code == 404


def test_transcribe_job_lifecycle(tmp_path: Path) -> None:
    audio = tmp_path / "a.wav"
    audio.write_bytes(b"fake")
    client = make_client()

    res = client.post("/transcribe", json={"path": str(audio)})
    assert res.status_code == 200
    job_id = res.json()["job_id"]

    body = wait_for_done(client, job_id)
    assert body["status"] == "done"
    assert body["progress"] == 1.0

    result = body["result"]
    assert result["timestamps"] == "rough"
    assert result["alignError"] is None
    assert result["text"] == "สวัสดีครับอ่าทดสอบ"  # no spaces injected between segments
    texts = [t["text"] for t in result["tokens"]]
    assert "สวัสดี" in texts
    fillers = [t for t in result["tokens"] if t["isFiller"]]
    assert any(t["text"] == "อ่า" for t in fillers)
    # every token has the core schema fields
    assert all(
        set(t) == {"text", "start", "end", "isFiller", "docCharRange", "confidence"}
        for t in result["tokens"]
    )


def test_aligner_refines_times_and_confidence(tmp_path: Path) -> None:
    audio = tmp_path / "a.wav"
    audio.write_bytes(b"fake")
    client = make_client(aligner=FakeAligner())

    job_id = client.post("/transcribe", json={"path": str(audio)}).json()["job_id"]
    body = wait_for_done(client, job_id)

    result = body["result"]
    assert result["timestamps"] == "aligned"
    assert result["alignError"] is None
    first = result["tokens"][0]
    assert first["start"] == 0.5  # refined, not the rough 0.0
    assert first["confidence"] == 0.9
    # unalignable word keeps rough time but gets confidence 0
    last = result["tokens"][-1]
    assert last["confidence"] == 0.0


def test_align_script_job_skips_asr_entirely(tmp_path: Path) -> None:
    audio = tmp_path / "a.wav"
    audio.write_bytes(b"fake")
    script = tmp_path / "script.txt"
    script.write_text("สวัสดีครับ\nวันนี้อากาศดี\n", encoding="utf-8")
    client = make_client(aligner=FakeAligner())

    res = client.post(
        "/align_script", json={"path": str(audio), "script_path": str(script)}
    )
    assert res.status_code == 200
    body = wait_for_done(client, res.json()["job_id"])

    assert body["status"] == "done"
    result = body["result"]
    assert result["timestamps"] == "aligned"
    assert len(result["segments"]) == 2  # one per script line
    assert result["segments"][0]["text"] == "สวัสดีครับ"
    assert [t["text"] for t in result["tokens"]][:2] == ["สวัสดี", "ครับ"]


def test_align_script_validates_files(tmp_path: Path) -> None:
    audio = tmp_path / "a.wav"
    audio.write_bytes(b"fake")
    client = make_client(aligner=FakeAligner())
    res = client.post(
        "/align_script", json={"path": str(audio), "script_path": "/no/script.txt"}
    )
    assert res.status_code == 404


def test_realign_returns_refined_tokens(tmp_path: Path) -> None:
    audio = tmp_path / "a.wav"
    audio.write_bytes(b"fake")
    client = make_client(aligner=FakeAligner())

    res = client.post(
        "/realign",
        json={"path": str(audio), "text": "สวัสดีทุกคน", "start": 4.0, "end": 8.0},
    )
    assert res.status_code == 200
    body = res.json()
    tokens = body["tokens"]
    assert [t["text"] for t in tokens] == ["สวัสดี", "ทุกคน"]
    assert tokens[0]["start"] == 4.5  # FakeAligner shifts +0.5 from range start
    assert tokens[0]["confidence"] == 0.9


def test_realign_rejects_empty_text(tmp_path: Path) -> None:
    audio = tmp_path / "a.wav"
    audio.write_bytes(b"fake")
    client = make_client(aligner=FakeAligner())
    res = client.post(
        "/realign", json={"path": str(audio), "text": "  ", "start": 0, "end": 1}
    )
    assert res.status_code == 400


def test_export_audio_job_renders_new_wav(tmp_path: Path) -> None:
    import wave

    import numpy as np

    from app.render import write_wav

    src = tmp_path / "src.wav"
    sine = np.sin(2 * np.pi * 50 * np.arange(2000) / 1000).astype(np.float32)[:, None]
    write_wav(src, sine * 0.5, 1000)
    out = tmp_path / "out.wav"
    client = make_client()

    res = client.post(
        "/export_audio",
        json={"path": str(src), "out_path": str(out), "edl": [{"start": 0.5, "end": 1.0}]},
    )
    assert res.status_code == 200
    body = wait_for_done(client, res.json()["job_id"])
    assert body["status"] == "done"
    with wave.open(str(out)) as w:
        assert abs(w.getnframes() - (2000 - 500 - 10)) <= 2  # cut 0.5s, 10ms fade
    # the source is byte-for-byte untouched (written before, still identical size)
    assert src.stat().st_size > 0


def test_export_audio_refuses_overwriting_source(tmp_path: Path) -> None:
    src = tmp_path / "a.wav"
    src.write_bytes(b"fake")
    client = make_client()
    res = client.post(
        "/export_audio", json={"path": str(src), "out_path": str(src), "edl": []}
    )
    assert res.status_code == 400


def test_export_docx_writes_paragraphs(tmp_path: Path) -> None:
    out = tmp_path / "out.docx"
    client = make_client()
    res = client.post(
        "/export_docx", json={"out_path": str(out), "lines": ["บรรทัดหนึ่ง", "บรรทัดสอง"]}
    )
    assert res.status_code == 200
    from docx import Document

    texts = [p.text for p in Document(str(out)).paragraphs]
    assert texts == ["บรรทัดหนึ่ง", "บรรทัดสอง"]


def test_models_status_shape() -> None:
    client = make_client()
    body = client.get("/models_status").json()
    assert set(body) == {"asr", "align", "dataDir"}
    assert isinstance(body["asr"], bool) and isinstance(body["align"], bool)


def test_download_models_job(monkeypatch) -> None:
    from app import fetch_models

    def fake_download_all(progress=None, abort_check=None):
        if progress:
            progress(1.0)

    monkeypatch.setattr(fetch_models, "download_all", fake_download_all)
    client = make_client()
    job_id = client.post("/download_models").json()["job_id"]
    body = wait_for_done(client, job_id)
    assert body["status"] == "done"
    assert body["result"] == {"downloaded": True}


def test_cancel_job(tmp_path: Path) -> None:
    class SlowEngine:
        def transcribe(self, audio_path: Path) -> TranscribeStream:
            def gen():
                for i in range(50):
                    time.sleep(0.05)
                    yield ASRSegment(f"ท่อน{i}", i * 1.0, i + 1.0)

            return TranscribeStream(duration=50.0, segments=gen())

    store = JobStore(SlowEngine(), aligner=None, duration_fn=lambda p: 50.0)
    app.dependency_overrides[get_job_store] = lambda: store
    client = TestClient(app)

    audio = tmp_path / "a.wav"
    audio.write_bytes(b"fake")
    job_id = client.post("/transcribe", json={"path": str(audio)}).json()["job_id"]
    time.sleep(0.15)  # let it start
    res = client.delete(f"/jobs/{job_id}")
    assert res.status_code == 200 and res.json()["cancelled"] is True

    body = wait_for_done(client, job_id)
    assert body["status"] == "cancelled"
    assert body["error"] is None  # cancel is not an error


def test_failed_alignment_falls_back_to_rough(tmp_path: Path) -> None:
    audio = tmp_path / "a.wav"
    audio.write_bytes(b"fake")
    client = make_client(aligner=FailingAligner())

    job_id = client.post("/transcribe", json={"path": str(audio)}).json()["job_id"]
    body = wait_for_done(client, job_id)

    assert body["status"] == "done"  # alignment failure must not fail the job
    result = body["result"]
    assert result["timestamps"] == "rough"
    assert "FileNotFoundError" in result["alignError"]
    assert result["tokens"][0]["start"] == 0.0  # rough times kept
