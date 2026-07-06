// Packaged app runs the sidecar on 8756; dev uvicorn uses 8000.
// The first successful /health locks the choice in.
const BACKEND_CANDIDATES = ["http://127.0.0.1:8756", "http://127.0.0.1:8000"];
let backendUrl: string | null = null;

function apiBase(): string {
  return backendUrl ?? BACKEND_CANDIDATES[0];
}

/** Core token structure (CLAUDE.md): links transcript ↔ audio ↔ .docx. */
export interface Token {
  text: string;
  start: number;
  end: number;
  isFiller: boolean;
  docCharRange: [number, number] | null;
  /** Alignment confidence 0–1; null = not aligned, 0 = could not align. */
  confidence: number | null;
}

export interface Segment {
  text: string;
  start: number;
  end: number;
}

export interface TranscribeResult {
  text: string;
  segments: Segment[];
  tokens: Token[];
  /** "rough" = whisper times, not alignment-refined — never cut audio from these. */
  timestamps: "rough" | "aligned";
  /** Set when alignment failed and times fell back to rough. */
  alignError: string | null;
}

export interface ExportAudioResult {
  out_path: string;
  duration: number;
  sample_rate: number;
  channels: number;
}

export interface JobState {
  job_id: string;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  progress: number;
  result: TranscribeResult | ExportAudioResult | null;
  error: string | null;
}

export async function health(): Promise<{ version: string } | null> {
  // Re-probe in priority order EVERY time: the packaged sidecar (8756) must
  // win even if a stale dev uvicorn on 8000 answered first while the sidecar
  // was still booting (FIXES.md #14 — locking in the wrong backend gave 404s).
  for (const base of BACKEND_CANDIDATES) {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        backendUrl = base;
        return await res.json();
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export interface ModelsStatus {
  asr: boolean;
  align: boolean;
  dataDir: string;
}

export async function modelsStatus(): Promise<ModelsStatus | null> {
  try {
    const res = await fetch(`${apiBase()}/models_status`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** First-run installer: download both AI models (~4.4GB, job). */
export async function startDownloadModels(): Promise<string> {
  const res = await fetch(`${apiBase()}/download_models`, { method: "POST" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).job_id;
}

export async function startTranscribe(path: string): Promise<string> {
  const res = await fetch(`${apiBase()}/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null))?.detail;
    throw new Error(detail ?? `HTTP ${res.status}`);
  }
  return (await res.json()).job_id;
}

export async function getJob(jobId: string): Promise<JobState> {
  const res = await fetch(`${apiBase()}/jobs/${jobId}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** มีบทอยู่แล้ว: force-align a known script file (.txt/.docx) — no ASR. */
export async function startAlignScript(path: string, scriptPath: string): Promise<string> {
  const res = await fetch(`${apiBase()}/align_script`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, script_path: scriptPath }),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null))?.detail;
    throw new Error(detail ?? `HTTP ${res.status}`);
  }
  return (await res.json()).job_id;
}

export interface RealignResponse {
  text: string;
  start: number;
  end: number;
  tokens: Token[];
}

/** Render the EDL into a NEW wav file (job). The source is never modified. */
export async function startExportAudio(
  path: string,
  outPath: string,
  edl: { start: number; end: number }[],
): Promise<string> {
  const res = await fetch(`${apiBase()}/export_audio`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, out_path: outPath, edl }),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null))?.detail;
    throw new Error(detail ?? `HTTP ${res.status}`);
  }
  return (await res.json()).job_id;
}

/** Write the edited content as .docx (sync). */
export async function exportDocx(outPath: string, lines: string[]): Promise<void> {
  const res = await fetch(`${apiBase()}/export_docx`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ out_path: outPath, lines }),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null))?.detail;
    throw new Error(detail ?? `HTTP ${res.status}`);
  }
}

export async function cancelJob(jobId: string): Promise<void> {
  await fetch(`${apiBase()}/jobs/${jobId}`, { method: "DELETE" });
}

/** แก้ทั้งวรรค: re-align edited segment text inside its time range (sync). */
export async function realign(
  path: string,
  text: string,
  start: number,
  end: number,
): Promise<RealignResponse> {
  const res = await fetch(`${apiBase()}/realign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, text, start, end }),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null))?.detail;
    throw new Error(detail ?? `HTTP ${res.status}`);
  }
  return res.json();
}
