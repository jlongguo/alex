# Alex R17 — per-sentence latency and fail-closed delivery authorization

This batch starts from merged R16 `main` (`4d7b18882e6ca68940c87cba5a95f9d62df6334a`) and extends **the existing R9–R16 voice stack**. No parallel ASR, LLM, TTS provider or WebAudio player is introduced.

## Implemented

1. The existing `SpeechLatencyObserver` now includes bounded, per-authenticated-principal windows for:
   - `sentenceFirstDeliveryMs`: start of the speech session to the first PCM frame delivered for each sentence (all values share the same session origin).
   - `sentenceHandoffMs`: previous sentence's most recently delivered PCM block to first PCM block of the next sentence, as observed by the local server.
   - `sentenceFirstAckMs`: session start to first client-claimed playback ACK for each sentence.
   - `sentenceAckTransitionMs`: previous acknowledged PCM frame to first ACK of the new sentence.
2. Existing owner-only `GET /api/audio/playback/metrics` returns the new P50/P95/count/max under `latency`; no public child or family-level aggregate endpoint is added.
3. The existing `AlexStreamingSpeechBridge` reports the browser's 16-sample rolling P50/P95 of **scheduled PCM buffer gaps between sentences**. It resets on user interrupt and does not measure actual audible sound.
4. `StreamingSpeechSessions` accepts a server-owned `authorizeDelivery(principal)` callback. The running server uses the **existing** parent/child TTS authorization policy. It checks before pulling any frame and **again after awaiting an upstream PCM read**, before charging daily allowances or returning bytes.
5. If authorization fails before the next read, the session is released immediately; if it fails after a provider read, the undelivered PCM is zeroed before releasing the session. A failed mid-flight authorization releases the session and its prefetched upstream sources. Parent scope erasure clears all associated latency windows through the existing `eraseScope` mechanism.
6. Deterministic tests cover timing, P50/P95, revocation during an unresolved provider read, revocation between sentences, cancellation, privacy erasure and configuration validation.

## Interpretation limits

These are **server-observed request/ACK timings**, not continuous acoustic gaps or proof that audio reached a child's ears. An authorized browser can have its own playback buffers and must be stopped/revoked separately. The existing browser/player interruptions and privacy endpoints remain in use. The TTS supplier may continue upstream work after local cancellation, and supplier-billed usage is not derived from delivered PCM samples.

R17 does not begin playback before the whole model response has been authoritatively committed. That still requires a separately designed, policy-vetted incremental commit protocol and explicit permission. There is no fabricated full-duplex capability or simulated real microphone acceptance.

## Validation

```sh
node --test tests/r17-sentence-latency-consent.test.mjs tests/r17-browser-sentence-gaps.test.mjs
npm test
npm run sim:check
npm run sim:preflight
```

## R18 proposals

Test actual permission revocations in authenticated localhost HTTP fixtures, including a pending /next request; add provider-generated vs delivered usage settlement with persistent atomic reservation as a separate finance/compliance workstream. Keep the existing resource cap of 4 committed sentences and one prefetched TTS provider source.
