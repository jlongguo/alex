# Alex R28 — durable virtual-device execution event timeline

## Product direction

R28 returns to the **generic modular family AI terminal**. Voice teaching and provider billing are optional capabilities, not the definition of the product. This batch establishes a common metadata execution timeline for the existing parent-approved workflows/plans and virtual devices; it does not introduce arbitrary LLM tool execution or physical motor control.

## Event store

The existing `DeviceGateway` JSON snapshot now contains an optional backward-compatible `eventSeq` and a bounded `events` array of at most 500 records. Each accepted state change is sequenced **with the same persisted snapshot** used for device jobs, preserving restart recovery of the job/event relationship.

Events include:
- Monotonic sequence number, UTC timestamp, event kind
- Virtual device ID, gateway job ID, dispatch request ID (which can correlate to an allowlisted workflow or plan step)
- Job state

Recorded events: `job.queued`, `job.updated`, `navigation.feedback`, `presentation.rendered`, `job.cancelled`, and `job.stopped` on expiry/revocation/restart.

No audio text, memory, credentials, token, PCM, full parameters or telemetry coordinates are copied into **the new event records**. The existing gateway job snapshot remains unchanged and can still contain virtual audio output text; securing or minimizing that separate preexisting storage requires its own migration.

## Parent-only API

```
GET /api/gateway/events?after=0&limit=100
```

Requires local parent authentication. `after` is an exclusive sequence cursor, and `limit` must be 1–500. Response contains `latestSeq`, `oldestSeq`, `cursorExpired` and a sequence-ordered `events` list. An old cursor that falls before the bounded retention window is marked as expired; truncated history is not fabricated. Requests with invalid cursors return HTTP 400.

The existing Family/Devices console shows the latest 20 events. It pages through up to 100 newly persisted records per refresh and explicitly notes when older history was truncated. Values are escaped before insertion into HTML; the server, not the UI, enforces parent access.

## Compatibility and safety

- Existing schema v1 gateway snapshots without `events` remain readable.
- Corrupted event sequences, duplicated/out-of-order sequence numbers, invalid identifiers and unexpected event properties fail closed at load.
- No device action is replayed on restart. Previously running gateway jobs are stopped and recorded as stopped.
- The allowlist remains virtual navigation, simulated facial expression and simulated audio only.
- This is **not** real ROS2/Nav2 runtime acceptance, motor control, a tamper-evident audit ledger, or full model/tool provenance. Operator access to JSON state can modify it; it is a local prototype.

## Validation

```sh
node --test tests/r28-device-event-journal.test.mjs tests/r28-gateway-events-http.test.mjs tests/r28-gateway-events-console.test.mjs
npm test
npm run sim:check
npm run sim:preflight
```

## Next R29

Add explicit parent-visible correlation of plan step IDs and gateway job IDs, bound event batching and retention independently of device job snapshots, plus end-to-end two-device workflow tests with fault injection. Full ROS2/Jazzy/Nav2/Gazebo acceptance remains an explicit separate environment test.
