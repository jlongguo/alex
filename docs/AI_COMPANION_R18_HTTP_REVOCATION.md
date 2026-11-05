# Alex R18 — localhost revocation and stale playback regression

Base: merged R17 `main` at `1259cbb036cb6531a9ec344787528ee95cb539ca`.

## Implementation and tests

- Fix the existing authenticated `/api/audio/playback/start` disconnect lifecycle. A stale HTTP request now cancels **only its own newly created speech session ID**, rather than calling the mutable principal-wide current-session cancel hook. The request unregisters its close listener on exit. It also rechecks connection state before returning an upstream TTS session.
- Use a test-only preload fixture to simulate a real local HTTP server whose cloud TTS vendor is stalled in a PCM stream and **does not cooperate with AbortSignal**. The fixture never talks to the real Internet.
- Add an authenticated, parent/learner localhost test. Grant voice output, begin a pending `/next`, revoke cloud audio output, release the test vendor barrier, then verify no HTTP 200 PCM is returned, no claimed ACK exists, no delivered audio quota is charged, and the learner can no longer use the endpoint.
- Add server-session tests proving that a non-cooperative provider's late PCM buffer is zeroed without charging quota, and that an older canceled request cannot corrupt a newer session owned by the same learner.
- Add browser tests where a late PCM response arrives after user interruption. It must not schedule a WebAudio buffer or generate an ACK from the stale epoch. Existing speaker/player and PCM framing code are unchanged.

## Non-goals and honest limitations

The localhost test uses a mocked, deliberately stalled TTS provider in a forked **actual Node HTTP server**. It is not a live commercial supplier, acoustic proof of sound, or cross-platform Chrome/Safari test. Browser tests use a simulated AudioContext and do not verify real speaker or microphone hardware.

The supplier may continue processing requests after cancellation, and local PCM-delivery counters are **not** the provider's final invoice. Delayed upstream TTS billing and persistent reservations are not solved in this batch. R18 does not authorize provisional model text or change the explicit review and parental consent gates.

## Validation

```sh
node --test tests/r18-http-stalled-revocation.test.mjs tests/r18-browser-stale-frame.test.mjs tests/r18-stale-pcm-zeroization.test.mjs
npm test
npm run sim:check
npm run sim:preflight
```

## Next stage

R19 should add atomic persisted per-principal supplier usage reservations and reconciliation, independent from PCM usage, plus real Chrome/Safari and vendor latency acceptance. A separately audited signed-segment commit protocol would be needed before any safe pre-commit LLM speech.
