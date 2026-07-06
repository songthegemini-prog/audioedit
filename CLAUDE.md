# CLAUDE.md — Thai Offline Audio Text-Editor

## What this project is
An offline desktop app for editing Thai speech by editing its transcript
("text-based audio editing", like Descript but fully offline and Thai-first).

Pipeline (decided 2026-07-04, supersedes the older .docx-first flow): AI
transcribes audio + forced alignment → the human corrects the transcript
IN THE APP, directly on tokens (fix spelling; mark non-content tokens such as
fillers/sneezes/bird sounds as excluded-from-doc WITHOUT cutting audio) → the
user cuts audio by highlighting and deleting words → export the edited audio
plus a .docx of the edited content (content only — never the raw transcript).
Importing an externally corrected .docx is an OPTIONAL secondary path, not the
primary flow. Everything runs locally; no audio or text ever leaves the machine.

## Hard constraints (YOU MUST follow)
- FULLY OFFLINE. Never call any cloud or network API for transcription,
  alignment, or LLM inference at runtime. All models run locally and are bundled.
- Editing is NON-DESTRUCTIVE. Never modify the source audio in place. Represent
  all edits as an edit decision list (EDL); render audio only on export.
- NEVER cut a word's tail. Cut points snap to nearest silence / zero-crossing and
  must be adjustable by the user on BOTH the waveform and the spectrogram.
- The app must show a spectrogram view (not only a waveform) for precise cut
  placement, plus sample-level zoom for finalizing a cut.

## Architecture at a glance
- Desktop shell: Tauri (preferred, lighter) or Electron.
- Frontend: WaveSurfer.js for waveform + its spectrogram plugin; a transcript
  panel kept in sync with audio through a single word-to-time map.
- Local backend: a Python (FastAPI) service on localhost that runs ASR and
  forced alignment. The frontend talks to it over local HTTP/IPC only.
- Core data structure (the spine of the whole app): a token list where each
  token = { text, start, end, isFiller, docCharRange, confidence }, plus
  editing state = { editedText, excludeFromDoc }. Three distinct user actions,
  never conflated: (1) fix spelling → editedText, audio untouched;
  (2) exclude from doc (filler/noise) → excludeFromDoc=true, audio untouched;
  (3) cut → EDL entry, removes audio AND text on export. This map links
  transcript ↔ audio ↔ .docx and drives search, highlight, cut, and export.
  When a change affects this data model, PAUSE and ask before proceeding.

## Rules: ASR + alignment (Thai)
- ASR engine: faster-whisper (CTranslate2) with a Thai fine-tuned model
  (e.g. Typhoon Whisper Large-v3, Thonburian Whisper, or Pathumma-Whisper).
  Keep the model behind a clean interface so it can be swapped.
- Word segmentation: use PyThaiNLP (newmm). Thai has NO spaces between words —
  never assume whitespace marks a word boundary.
- Two passes, always: (1) Whisper gives a rough transcript with timestamps;
  (2) forced alignment refines them. Whisper's native word timestamps are NOT
  reliable — never cut audio from them without an alignment pass.
- Forced alignment: prefer Montreal Forced Aligner (MFA) for boundary accuracy;
  WhisperX is acceptable for a faster first pass. Align at PHONEME level where
  possible so word tails (ส/ฟ/ช) are tight.
- Long audio: chunk with VAD before ASR/alignment; stitch results back onto one
  global timeline.
- (Optional .docx-import path only) Corrected .docx ≠ AI transcript. Run a
  text-to-text alignment (edit distance / Needleman–Wunsch) between the AI
  tokens and the corrected words to (a) map corrected spelling onto tokens and
  (b) flag tokens with no match. Not needed for the primary in-app editing flow.
- Fillers (อ่า, อือ, อึม): keep them as tokens with isFiller=true so they can be
  located and cut. Tokens absent from the corrected .docx are filler/error
  candidates — surface them for the user to confirm, never auto-delete.
- Show alignment confidence; route low-confidence spans to the human for review
  instead of trusting them silently.

## Rules: audio editing
- A "cut" = marking a token span deleted in the EDL. It removes the token's
  [start,end] region from the render, never from the source file.
- Snap every cut boundary to the nearest zero-crossing or silence gap; apply a
  short crossfade (about 5–15 ms) at each join so there is no click.
- The user can drag the highlight boundary on the waveform AND on the
  spectrogram; both edit the same token times.
- "Test cut": let the user preview the result (skip the deleted region on
  playback) WITHOUT committing, then keep or discard.
- Search: searching text jumps between matching tokens and highlights the
  matching audio region.
- Undo/redo works on the EDL history, so any cut is reversible.

## Rules: export
- Export audio by rendering the EDL against the source (with the crossfades),
  never by editing the source in place.
- Export a .docx of the EDITED CONTENT: use editedText where present, omit
  excludeFromDoc tokens and cut tokens. The exported audio and .docx must tell
  the same story — same content, same order.

## Tech + code style
- Frontend: TypeScript. Keep the audio-sync logic pure and unit-tested.
- Backend: Python 3.11+, type hints, FastAPI.
- .docx via python-docx; keep a stable mapping between doc character offsets and
  audio tokens so import/export round-trip cleanly.
- Small, focused modules. Never commit secrets. Document how to fetch/place model
  weights instead of committing large files.

## Commands (fill in as they become real)
- Frontend dev:  `npm run dev`
- Backend dev:   `uvicorn app.main:app --reload`
- Tests:         `npm test`  /  `pytest`

## Bug history
- FIXES.md is the regression log. Read it before changing seek/click behavior,
  waveform display, model selection, or the filler lexicon — and append an
  entry (symptom / cause / fix / prevention) every time a reported bug is fixed.

## How I want you to work
- Before any large change, use plan mode and show me the plan first.
- Build in phases. Do NOT scaffold the whole app at once. Make each phase run
  before moving to the next.
- Prefer the simplest thing that works; we iterate.
