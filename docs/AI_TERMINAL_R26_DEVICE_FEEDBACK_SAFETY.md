# Alex R26 — virtual device feedback lifecycle safety

## Mainline direction

R26 returns the focus to Alex's original **modular family AI terminal + virtual device simulator**. The product is not merely a speech or invoice console. No new physical motor transport or hardware permissions are added.

## Delivered source changes

The established `DeviceGateway` now verifies device freshness and job deadline **when accepting each device-originated state change**, rather than relying exclusively on its periodic housekeeping `expire()` tick.

1. A paired device with a stale heartbeat cannot change a queued job into `running` or a running job into `succeeded`.
2. A job whose deadline already passed is stopped when feedback arrives, even if the device heartbeat is current and the housekeeping tick has not run.
3. Protocol v2 navigation telemetry cannot be accepted after the device becomes stale or the task expires.
4. Protocol v3 presentation evidence cannot be recorded after expiry. Such late receipts cannot serve as success proof for `audio.output` or `display.face`.
5. Rejected feedback produces a durable `stopped` state and a `job.stopped` gateway notification; reloading persisted state will not resurrect the job.
6. Future-dated device heartbeats are rejected as presence evidence. This avoids treating an invalid negative clock age as fresh.

The existing parent-only dispatch, capability allowlist, device authentication, virtual actions, non-replay on restart, and simulated navigation protocol remain unchanged.

## Protocol behavior

Authenticated device feedback received after a timeout or stale heartbeat returns:

```json
{"ok":false,"message":"TASK_FEEDBACK_EXPIRED"}
```

The job transitions to `stopped`; subsequent feedback receives the existing terminal-task rejection. An on-time virtual-device response continues to work as before.

**No physical action authorization is implied**. The gateway still supports only simulated navigation, expression and virtual audio. This work does not establish real robot safety, navigation quality, vendor model behavior or production hardware certification.

## Verification

```sh
node --test tests/r26-device-feedback-lifecycle.test.mjs
npm test
npm run sim:check
npm run sim:preflight
```

Tests exercise stale/expired device results, stale v2 navigation telemetry, stale v3 presentation evidence, future-dated heartbeat, normal on-time result acceptance and durable restart recovery.

## R27 priorities

Add task-scoped event sequence numbers and bounded device feedback replay protection, a local browser device-health panel, and controlled virtual terminal skill execution that is independent of speech infrastructure. Run real ROS2/Nav2 acceptance separately in the correct Ubuntu/Gazebo environment; static simulator checks are not physical navigation evidence.
