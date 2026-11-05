# Alex R14 — sentence-safe speech staging

## Implemented in this batch

- A bounded sentence segmenter recognizes English and Chinese sentence terminators across arbitrary provider delta boundaries.
- A commit-gated speech queue supports ordered draining, maximum segment/character budgets, cancellation and erasure of staged text.
- The existing R11 voice-turn path now derives its spoken excerpt from the first complete sentence of the **committed** assistant response rather than cutting blindly at 500 characters.
- The complete assistant response remains in conversation history. Provisional model deltas are not passed to TTS.
- The existing browser playback protocol remains unchanged: one playback session per turn, explicit user gesture, PCM pull/ACK, and manual interruption.

## Deliberate limits

This is not yet incremental audible sentence playback while the LLM is generating. The current turn manager waits for the authoritative conversation commit, then selects the first sentence for the existing single TTS session. The queue is a tested foundation for the next batch; it is not yet wired to multiple concurrent provider sessions or browser-side sentence handoff.

The segmenter is deterministic punctuation-based, not a linguistic parser. Abbreviations, decimal numbers, quoted dialogue and languages without punctuation need provider/model-aware segmentation improvements. The 500-character TTS limit remains. No transcript or staged text is persisted by the new queue.

## Acceptance

```bash
node --test tests/r14-speech-sentence-staging.test.mjs tests/r14-voice-turn-sentence.test.mjs
npm test
npm run sim:check
npm run sim:preflight
```

## Next R15

Implement one server-owned speech turn containing ordered sentence sub-sessions, with bounded prefetch (one sentence ahead), per-sentence IDs/sequence, a single browser playback queue, cancellation propagation, and no audible output until each sentence passes the existing commit/safety gate. Measure first audible sentence and inter-sentence gap separately. Do not create unbounded provider sessions or claim full duplex.
