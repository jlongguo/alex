# Alex R16 — verified sentence receipts and commit-gated model staging

Built from merged R15 `main` `0cfbe1a3ae20fc94e65ad58fb2ed1fc2ad7fa459`.

## Delivered in this batch

### 1. Pre-commit LLM text is not an audio authority

`ProvisionalTurnText` accumulates at most 1200 characters of model deltas **only in memory**. Its `push` reports a non-content counter, with `speechPermitted:false`. When the existing `CompanionConversations.streamTurn` has committed the authoritative reply, `commit(authoritative)` discards the provisional buffer and segments **only that authoritative string**. If the preview differs, it never takes precedence. Error/cancellation discards provisional content. No stage writes audio or text to a file.

The existing user-initiated R11 voice turn, consent checks, R15 one-session multi-sentence audio, and explicit browser gesture remain the authority. This does **not** auto-submit ASR transcript, allow pre-commit LLM speech, or make the system full-duplex.

### 2. Sentence-level PCM receipts inside existing speech sessions

R15 `SegmentedPcmSpeechProvider` attaches an ordinal sentence index (0..3) and count to each PCM frame. Existing `StreamingSpeechSessions` stores up to four per-sentence metadata counters: frames and 24kHz samples delivered, plus frames and samples with a *client-claimed* playback ACK. A receipt is issued only after the authorized next-frame call and recorded only in the owner-bound in-memory speech session. Cancel/expiry/erase clears it; no words, audio, or segment content in receipts.

The existing loopback-only PCM endpoint adds `X-Alex-Speech-Sentence-Index` and `X-Alex-Speech-Sentence-Count`. The browser validates bounds, monotonic indexes and stable counts before scheduling audio. ACKs verify the sentence index if the server returns it; older single-sentence sources without new headers still work. Browser snapshots include the current/claimed sentence ordinal. The same R9 WebAudio playback queue is retained.

### Explicit safety and accounting limitations

- An `onended` callback is **not** proof of acoustic playback or comprehension.
- The new sentence receipts are **volatile**, disappear when sessions end, and are not invoices.
- Upstream TTS may generate or bill audio after interruption despite best-effort cancellation.
- The currently implemented flow still waits for a **complete authoritative LLM reply** before speaking; R16 does not yet lower first-audio latency by speaking provisional sentences.
- The current 4-sentence limit is intentionally bounded. Text beyond the selected sentences remains in the committed conversation but may not be spoken.
- Requires real Chrome/Safari + model/TTS provider + microphone/speaker acceptance before production use.

## Validation commands

```sh
node --test tests/r16-sentence-receipts.test.mjs \
  tests/r16-browser-sentence-progress.test.mjs \
  tests/r16-provisional-commit.test.mjs
npm test
npm run sim:check
npm run sim:preflight
```

## Next R17

- Add sentence-boundary timestamps and aggregate gap distributions without retaining transcripts.
- Extend server/client integration tests for revocation between sentence boundaries, including late source replies.
- Build a separate opt-in, policy-reviewed and provenance-checked path for incrementally committed segments before attempting any provider-level full duplex. Merely observing punctuation in a provisional response is insufficient.
- Persist actual vendor-side usage and reserve spending atomically before public release.
