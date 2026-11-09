# Alex R30 — Multi-device orchestration and stable execution trace paging

## Direction

Alex remains a modular, family-controlled AI terminal with simulated devices; speech and English learning are pluggable skills, not the whole product. R30 extends the *existing* Plan/Workflow/Gateway/Trace architecture instead of creating another scheduler.

## Keyset pagination

`GET /api/executions?limit=25&cursor=<opaque>&kind=plan&deviceId=dev-...`

- `cursor` is optional; responses include `executions`, `hasMore`, `nextCursor` and `simulationOnly`.
- The URL-safe cursor describes the last returned immutable (creation timestamp, execution ID) sort key. New executions inserted above that point do not repeat previously returned rows.
- Cursors carry their bound kind and device filter; mixing cursor scopes is rejected with 400.
- Invalid, oversized and noncanonical cursors fail closed. The cursor is **not a security token**; each request still requires server-side local parent authentication.
- In-memory Plan/Workflow retention is bounded. A deleted older execution cannot be reconstructed by pagination. This is not a permanent audit log or snapshot isolation.
- The parent Task Center now offers **加载更多执行记录**, keeps fetched records deduplicated by execution ID, and allows resetting the window.

## Device reservation

A workflow cannot start on a virtual device already carrying a queued/running *direct Gateway job*. Existing plan-vs-workflow shared busy checks remain in place. Device capability authorization and online checks are unchanged.

## Scenarios covered

- Two approved virtual devices independently handle a Plan and Workflow; their skill, navigation and output traces remain associated with the correct device.
- Concurrent Plan and Workflow requests for the **same** device may not both reserve it.
- A direct Gateway task blocks a new workflow on that device until cancelled/completed.
- Device revocation stops only the affected work; other devices stay active.
- Restart stops unfinished work and does not repeat virtual navigation or output commands.
- Cursor paging across identical timestamps, new insertions, filters, malformed input, and client deduplication.

No arbitrary LLM tool execution, real motor command, or unreviewed skill extension has been introduced. No ROS2/Nav2 runtime acceptance is claimed: `sim:check` and `sim:preflight` are repository-level checks.

## Validation

```sh
node --test tests/r30-trace-pagination.test.mjs tests/r30-multidevice-faults.test.mjs
npm test
npm run sim:check
npm run sim:preflight
```

## R31 next

Continue with real cross-module failure injection and family-facing trace diagnostics, then add a versioned, parent-approved Skill extension protocol in which imported modules cannot directly reach child data or physical actuators. Real ROS/Jazzy/Gazebo/Nav2 runtime and browser acceptance remain separate gates.
