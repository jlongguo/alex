# Alex R11 — verified-text voice turn orchestration (draft)

This stage extends the existing mainline R8/R9/R10 ASR, companion text, and TTS subsystems without adding another speech provider.

## Explicit, conservative execution

1. The verified learner or parent submits **reviewed text** and an existing conversation ID through POST `/api/voice/turn/start`.
2. The existing `CompanionConversations.streamTurn` generates and commits its assistant reply, observing its original privacy/Skill/model policies. Provisional LLM deltas are **never** forwarded to TTS.
3. Server rechecks the output authorization, then calls the existing `StreamingSpeechSessions.start` using up to 500 characters of the committed reply.
4. The endpoint returns the existing speech session and committed conversation. The browser user explicitly clicks **发送并朗读（R11 实验）**. Its gesture-activated WebAudio bridge consumes the preopened session through the existing PCM pull/ACK transport; the server does not independently autoplay.
5. An authenticated owner may call POST `/api/voice/turn/status` or `/api/voice/turn/cancel`. Cancel stops in-flight model work and (if opened) associated speech provider resources; other learners cannot inspect or cancel its turn.

GET `/api/voice/turn/capabilities` reports whether this experimental pathway is configured and permitted. All routes require `AUTH_MODE=local`, session-bound principal and Host/Origin checks. This route does not accept raw PCM or implicit microphone recognition.

## Important non-goals and limitations

- This is **not** full-duplex realtime dialogue or incrementally spoken provisional LLM output.
- Chat text is committed **before** cloud TTS opening. If TTS fails or the user cancels after commit, the assistant's text remains in chat, accurately reflecting a completed text turn, not a played voice turn.
- Streaming ASR requires manual transcript review. There is no voice auto-submit.
- Existing audio playback ACK is client-claimed, not proof a child heard the words.
- The browser now has a separate explicit R11 send-and-speak action; ordinary text-only submit remains independent. R11 requires an already-open companion conversation and will not implicitly create or submit an ASR transcript.
- Cloud provider live compatibility, costs, latency and mobile-browser playback remain unverified. The R10 memory-only delivered-samples budget is **not** a vendor invoice cap.

## API

| Method | Route | Description |
| --- | --- | --- |
| GET | `/api/voice/turn/capabilities` | Available/auth status, explicit input semantics |
| POST | `/api/voice/turn/start` | `{conversationId,text}` returns turn, committed assistant, speech session |
| POST | `/api/voice/turn/status` | `{id}` owner-only phase and non-content metadata |
| POST | `/api/voice/turn/cancel` | `{id}` or current owner's turn; abort model & owned speech session |

States: `thinking` -> `opening-speech` -> `ready`; cancel/failure release the turn. Ready turns expire after 75 seconds. No raw audio or provisional text is saved in the orchestrator.

## Follow-up

Complete real-browser and vendor acceptance of the preopened-session playback, true latency counters, persistent supplier spending limits, and then a separate consent-approved full-duplex model pipeline. Keep simulation and robotics actuation outside voice turn scope.
