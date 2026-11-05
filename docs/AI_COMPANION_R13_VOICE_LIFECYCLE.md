# Alex R13 — bounded voice-turn lifecycle, scoped telemetry and cancellation

## Scope

This R13 batch is based on verified `main` including R12. It extends the existing R11 `VoiceTurnOrchestrator`; it does **not** introduce a new ASR, LLM, speech provider, playback queue or new automatic microphone capture mode.

### Changes

- **Cancellation is promptly observable:** voice-turn waits race the session's AbortSignal, so a cloud promise that ignores cancellation cannot keep the local request open forever. Upstream providers may still do work until their own timeout; no false claim of zero supplier charges.
- **Late TTS cleanup:** if speech creation finishes after cancellation, the returned *owned* speech session is canceled. Never use an undefined session ID to cancel an unrelated new voice turn.
- **Request-to-turn ownership:** the HTTP request registers its exact turn ID. Disconnect cancels that specific turn, preventing an older disconnected request from aborting a newer turn owned by the same learner.
- **Stage observability:** `modelCommitMs`, `speechOpenMs`, `readyMs`, `cancelMs`, and `failureMs`. Data are per-authenticated-principal duration samples only; 128-sample rolling windows, nearest-rank P50/P95. No model text, raw audio, secrets or session IDs in telemetry.
- **Privacy handling:** parent erasure and learner deletion clear the relevant telemetry in memory.
- **Endpoint:** `GET /api/voice/turn/metrics`, requiring authenticated local access and returning only `scope:self` metadata.

### Explicit limits

R11 still requires reviewed text and explicit opt-in for output. R13 is not automatic ASR-to-LLM submission, realtime duplex, or incremental audible provisional text. Conversation text is committed independently of voice playback; canceling after commit does not roll back the chat.

A model/TTS request that ignores AbortSignal may continue upstream after the Alex request has been rejected. A successful provider cancellation is not proof of refund, nor are client playback events proof of hearing. P50/P95 here are simulated or live backend durations, not acoustic latencies measured by physical equipment. Observations are in memory and do not persist across restarts.

### Verification

```bash
node --test tests/r13-voice-turn-lifecycle.test.mjs
npm test
npm run sim:check
npm run sim:preflight
```

### Next implementation gap

R14 should add explicit end-to-end user-permission checks around ASR-final preview submission and a provider-agnostic, cancellable, sentence-boundary speech staging pipeline. Preserve commit semantics and avoid exposing provisional model tokens to children as authoritative speech. Persist actual vendor spending separately from delivered PCM budget before public production use.
