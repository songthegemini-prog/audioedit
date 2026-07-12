# AGENTS.md — instructions for AI coding agents (Codex, etc.)

This project is developed with more than one AI agent. **`CLAUDE.md` is the
full project brief — read it first.** This file mirrors the non-negotiables so
any agent (Codex/GPT, Claude, …) follows the same rules.

## What this project is
Offline desktop app for editing Thai speech by editing its transcript
("text-based audio editing", Thai-first, like Descript but fully offline).
Pipeline: AI transcribe + forced-align → human corrects transcript in-app on
tokens → cut audio by highlighting/deleting words → export edited audio + a
.docx of the edited content. Everything runs locally; no audio/text leaves the
machine.

## Hard constraints (MUST follow — same as CLAUDE.md)
- **FULLY OFFLINE.** Never call any cloud/network API for ASR, alignment, or
  LLM inference at runtime. All models run locally and are bundled.
- **NON-DESTRUCTIVE editing.** Never modify the source audio in place. All edits
  are an edit-decision list (EDL); audio is rendered only on export.
- **Never cut a word's tail.** Cut points snap to silence / zero-crossing and
  stay adjustable on BOTH waveform and spectrogram.
- **Display and playback must consume the SAME PCM** (see FIXES.md #7/#13) — a
  structural rule, not a coincidence. Playback stays on a media element; the
  WebAudio backend is banned.
- Core data model = token list `{text,start,end,isFiller,docCharRange,
  confidence}` + edits `{editedText,excludeFromDoc}` + EDL cuts. Three distinct
  user actions, never conflated: fix spelling / exclude-from-doc / cut. **When a
  change affects this data model, PAUSE and ask before proceeding.**

## Tech + layout
- Frontend: TypeScript + Vite (vanilla), Tauri v2 shell (Rust) in `src-tauri/`.
- Backend: Python 3.12 FastAPI on localhost only (`backend/`). Dev port 8000
  (uvicorn), packaged sidecar port 8756.
- Keep audio-sync logic pure and unit-tested. Small, focused modules.

## Commands
- Frontend dev: `npm run dev`  · tests: `npm test` (vitest)
- Backend dev: `cd backend && .venv/bin/uvicorn app.main:app --reload`
- Backend tests: `cd backend && .venv/bin/pytest`
- Type-check before committing: `npx tsc --noEmit`
- Desktop build: `npm run tauri build`

## Working agreement (IMPORTANT for multi-agent)
- **Always run the full test suites + `tsc --noEmit` before committing.** Both
  suites must pass (currently 58 vitest + 81 pytest).
- **`FIXES.md` is the regression log.** Read it before touching seek/click
  behavior, waveform/spectrogram, playback, model selection, or the filler
  lexicon — and APPEND an entry (symptom / cause / fix / prevention) every time
  you fix a reported bug.
- Prefer the simplest thing that works; build in phases, each phase runnable.
- **Do not commit secrets or large model weights.** Models live in a per-user
  data dir; document how to fetch them, don't check them in.
- Commit messages: short imperative subject + why in the body.

## Avoiding conflicts between agents (git hygiene)
- Pull latest before starting; commit small and often so the other agent can
  rebase cleanly.
- Prefer working on a feature branch, then merge — avoid two agents editing the
  same files on `main` at the same time.
- The default branch is `main`; releases are cut by pushing a `v*` tag, which
  triggers the GitHub Actions build + Release (`.github/workflows/build.yml`).
