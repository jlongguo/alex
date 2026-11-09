# Alex R27 — gateway feedback idempotency hardening

Based on the merged R26 virtual-device safety gate.

## Fix

The device result endpoint distinguishes two kinds of duplicate feedback:

- **Nonterminal `running` duplicate:** the heartbeat and original job deadline are revalidated first. A stale device or expired job is stopped and receives `TASK_FEEDBACK_EXPIRED` even if it had previously reported running.
- **Already-completed `succeeded` duplicate:** remains idempotent after its original successful completion. Repeating a terminal acknowledgement cannot trigger another action or reopen a stopped job.

The fix closes a narrow race in which an outdated device could receive a successful duplicate `running` acknowledgement without passing the new R26 freshness gate.

## Boundaries

Virtual device only; the gateway continues to allow only simulated navigation, virtual expression and virtual audio. The update does not authorize physical motion or treat virtual feedback as proof that a person saw/heard the output.

## Validation

```sh
node --test tests/r26-device-feedback-lifecycle.test.mjs
npm test
npm run sim:check
npm run sim:preflight
```

## Next direction

Extend correlation and replay protection to device protocol event IDs and inspect the browser parent control flow. Run real ROS/Gazebo/Nav2 acceptance separately; local CI preflight cannot certify navigation or hardware behavior.
