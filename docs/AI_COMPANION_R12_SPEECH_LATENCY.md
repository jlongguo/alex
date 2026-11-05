# Alex R12 — speech latency observability (independent from R11 Draft)

## Baseline and scope

R12 is branched from **main** at `686bffad87554b49e859ce5c1ef7fa38d055f397`, which contains merged R10. PR #50 (R11) was still Draft when this branch was created, so no provisional R11 code is duplicated or silently pulled into main.

This batch extends the existing R9/R10 `StreamingSpeechSessions` and `AlexStreamingSpeechBridge` only. It does not create another TTS provider or turn orchestrator.

## Signals

The server records, by authenticated principal, strictly numerical observations:
- `firstChunkMs`: time from starting a speech session to producing the first output PCM frame.
- `firstPlaybackAckMs`: time to the **first client playback ACK**, not acoustic proof of hearing.
- `completionMs`: time until a fully delivered and client-ACKed session is released.

Each series uses a **128-sample in-memory rolling window** and calculates nearest-rank P50/P95, max and count. No utterance, transcript, session ID, audio buffer, or vendor token is stored.

These data appear in the existing per-user `GET /api/audio/playback/metrics` endpoint under `latency`. There is no family-wide public exposure or per-child leak. Learner deletion and parent privacy erasure remove the respective telemetry.

The browser `firstScheduledLatencyMs` is measured from the explicit user-request to the first AudioBuffer scheduled. This is **not the time an audible sound was verified**. The historical `firstAudioMs` remains an absolute client clock timestamp for compatibility.

## Constraints and caveats

- A session cancelled before any playback ACK does not contribute a completed-session sample.
- Clock calculations are monotonic only when the injected clock is; the existing server uses Date.now and is affected by wall-clock adjustments. Compare real P50/P95 only under stable clocks.
- The percentile window is volatile and restarts on server reboot; it is not billing evidence or immutable audit history.
- The metrics are not a guarantee of live-device network performance. Chrome/Safari, real supplier TTS, jitter, audio devices, p50/p95 end-to-end are still to be empirically tested.
- R11 is an independent PR and must be merged/rebased deliberately; do not merge duplicate server or browser implementations.

## Acceptance

```bash
node --test tests/r12-speech-latency.test.mjs tests/r12-browser-latency.test.mjs
npm test
npm run sim:check
npm run sim:preflight
```

## Next planned batch

R13 should instrument the cross-stage ASR -> committed-LLM -> TTS pipeline with a stable turn ID, deterministic cancellation/revocation tests, per-stage duration summaries, and browser-user gesture acceptance. Real duplex and low-latency partial utterance synthesis remain separate milestones.
