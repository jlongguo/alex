# Alex R10 — per-learner speech delivery budget (Coding batch 1)

## Goal and scope
Build on the existing **main** R9 implementation rather than introduce a parallel Provider. This batch adds a server-only daily PCM delivery allowance enforced immediately before a streaming speech session opens and again before each PCM block is released to the authenticated caller.

## Implementation
- `scripts/speech-delivery-budget.mjs` holds bounded non-content sample counters scoped by authenticated learner/parent principal. Each UTC day starts a new allowance.
- `StreamingSpeechSessions` checks the allowance on `start()` and charges **actual delivered sample counts** on `next()`. Concurrent unrelated learners do not share a budget. Existing backpressure and ordered ACK semantics are unchanged.
- `scripts/server.mjs` supports `ALEX_SPEECH_DAILY_DELIVERY_SECONDS` (default **120**, integer 1..86400); capabilities disclose the setting, and playback metrics return a **self-only** `deliveryBudget` snapshot.
- Privacy deletion clears corresponding non-content quota entries. This is not stored to disk.

## Critical limitation

**This is NOT a binding cloud vendor cost ceiling.** A supplier can already have generated or billed audio that Alex does not deliver, e.g. when a user interrupts an ongoing HTTP stream. A restart clears these in-memory counters. A different server instance has a separate allowance. Do not advertise this as a production financial cap, anti-abuse guarantee, or parental compliance proof.

The existing TTS output is user-initiated, not an autonomous duplex speech conversation. Provider, browser, and parental authorization require real-environment acceptance.

## Acceptance commands
```sh
node --test tests/r10-speech-budget.test.mjs
npm test
npm run sim:check
npm run sim:preflight
```

## Follow-up scope

Add an authoritative persisted, atomic usage reservation/settlement ledger and provider-side billing limits before public exposure. Next R10 batches should add cross-stage ASR->LLM->TTS orchestration, precise cancellation propagation, fail-closed consent rechecks and end-to-end latency instrumentation.
