# Alex R9 — Streaming speech core (experimental)

This batch implements two independent, disabled-by-default building blocks:

1. `StreamingSpeechProvider`: HTTPS binary 24 kHz mono PCM16 TTS streaming adapter. Handles arbitrary network fragmentation, 100 ms frames, output and text limits, abort, callback backpressure, and parent authorization checks before emitting each frame. API credentials stay server-side.
2. `AlexStreamingSpeechPlayer`: browser AudioContext PCM16 queue with explicit gesture-led `begin()`, ordered frames, a 1.5-second scheduled-audio bound, cancellation of active source nodes, owner/turn isolation, and completion after playback callbacks.

## Explicit limits

This **does not yet implement an HTTP speech-stream endpoint, audio transport, chat-to-TTS wiring, R8 ASR barge-in, network-side abort propagation, actual audible-word acknowledgment, cost budgets, or a fully duplex assistant**. The provider contract assumes a trusted service returns header `application/octet-stream` and headerless little-endian 24 kHz PCM16; validate a real provider's wire format before enabling. R8 still requires a user to review and manually send transcribed text.

The playback `onended` callback is a browser event, not reliable proof of what a child heard; only mark it as playback scheduling completion, not learning evidence or guaranteed audible output.

## Verification

Run `node --test tests/r9-streaming-speech.test.mjs` and `npm test` on the branch. This code has not been evaluated against real microphone, speakers, mobile browsers or third-party TTS APIs. Before enabling, add server-side learner permission checks, explicit opt-in, transport lifecycle, billing limits, transport-level cancellation and latency benchmarks.
