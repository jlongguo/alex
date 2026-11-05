# Alex R15 — ordered multi-sentence PCM playback

## Implementation

Based directly on the verified `main` after R14 PR #54 merge. The R15 adapter `SegmentedPcmSpeechProvider` wraps the existing `StreamingPcmSpeechProvider`. It does **not** create a second browser player or change ASR. All voice turns remain user-initiated with reviewed text, authenticated local sessions and existing family authorization checks.

A voice turn now chooses **up to four** sentences from its **committed** assistant reply and forwards them into a single `StreamingSpeechSessions` instance. The PCM source reads one sentence after another, with **current + one prefetched provider source** as the only allowed concurrent upstream sources. The resulting PCM blocks use the existing single sequence number, WebAudio buffer, playback ACK protocol, per-learner concurrency limit, daily delivered-sample budget and R12/R13 latency metrics.

The legacy manual speak endpoint still supplies `{text}` only. User-controlled HTTP input cannot directly inject an arbitrary `segments` array into privileged voice-turn sequencing. `text` must equal the first selected committed segment. A full assistant reply is retained in conversation history even if only four sentences are synthesized.

## Cancellation and resource limits

- Per turn: 1–4 selected segments; each ≤500 characters; total ≤1200 characters.
- At most two upstream TTS response sources are live at once.
- Cancellation aborts the shared controller, disposes current/prefetched streams, and rejects pending PCM reads.
- If a slow or non-cooperative provider returns a prefetched stream after cancellation, the adapter closes it rather than delivering old audio.
- When no segments are supplied, the wrapper delegates unchanged to the original provider.
- Existing `StreamingSpeechSessions` still enforces absolute session expiry, inactivity, PCM framing, per-child rate limits, budgets and ACK sequence.

## Explicit limitations

This is multi-sentence playback **after the entire model text has been committed**, not speech from uncommitted partial model tokens. The next sentence's HTTP provider can still introduce an audible gap despite one-ahead prefetch. No new claims of truly gapless cross-vendor audio, full duplex, independent vendor-billed credit ceilings, or acoustic proof of hearing are made. Physical microphone, speaker, mobile browser and real supplier acceptance remain pending.

Additional language-aware sentence splitting (abbreviations, decimal punctuation, quotations) and persisted provider usage reconciliation remain important follow-ups.

## Acceptance

```bash
node --test tests/r15-segmented-stream.test.mjs tests/r15-voice-turn-multisentence.test.mjs
npm test
npm run sim:check
npm run sim:preflight
```

## R16 recommended

Implement safe, bounded **turn-scoped generated text staging** with a commit gate, turn-level segment receipts, non-content latency spans for each TTS sentence and ACK, and cross-stage abort/parent-revocation integration. Do not enable pre-commit audio; a partial LLM token stream is not an authoritative completed response. Stage under feature flag and verify exact provider/browser API compatibility.
