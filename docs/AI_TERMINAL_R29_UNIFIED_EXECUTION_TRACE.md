# Alex R29 — parent-only unified execution trace (read-only)

## Project alignment

Alex is a generic, extensible, family-safe AI terminal. English, story, voice output, virtual movement, supplier telemetry and hardware integration are separate modules. R29 makes existing **allowlisted** Plan → Skill → Virtual Device execution inspectable without giving the AI an arbitrary tool-execution endpoint.

## Design

`ExecutionTraceProjector` is a read-only view over the persisted R7 PlanOrchestrator, R6 WorkflowOrchestrator and R28 DeviceGateway records. There is **no new write-side orchestrator** and no duplicate database. The authoritative execution state remains in each existing component.

A trace contains:
- Execution ID (`plan-...` or `wf-...`), type, parent request ID, virtual device ID, status, start/update time and stop reason.
- Step IDs, dependencies, skill IDs for allowlisted skill steps and status.
- Deterministic Gateway dispatch request key for each device step.
- Exact Gateway job ID, capability, status, timestamps, outcome reason and matching R28 event metadata.
- R7 Plan event records, where retained.
- Explicit `missing` or `conflict` markers when job metadata cannot be securely joined.
- Explicit bounded-event retention warning, rather than inventing old events.

The projection **does not include child text, device action parameters, audio, tokens, memory or model messages**. Old gateway JSON state may contain virtual audio text; this release does not migrate or erase that existing field.

## Local parent-only APIs

```
GET /api/executions?kind=plan&limit=25&deviceId=dev-...
GET /api/executions/plan-<uuid>
GET /api/executions/wf-<uuid>
```

The list is capped at 100 records. Invalid type, ID, limit or device filters receive HTTP 400. Unauthorized callers cannot read a family's execution history. The Device Gateway still authenticates device feedback separately.

## Read-only task console

Agent / Task Center contains a new execution explorer that presents recent plans and workflows. Selecting one displays its correlated Skill and Device steps, job request ID and number of retained events, with an explicit warning if event retention has truncated history.

Only read endpoints are used. No replay, approval, cancellation or dispatch occurs from this explorer. The existing parent-approved command path is unchanged.

## Reliability and limitations

- Trace projection reconstructs from **current durable snapshots**. It does not guarantee an atomic, distributed cross-store snapshot, nor prove exactly-once physical execution.
- A missing or truncated R28 event cannot be invented or counted as evidence. Old plan events may also be bounded.
- Matching requires same virtual device and exact deterministic dispatch request key; a stored job ID with conflicting metadata is rejected.
- Restarts still stop unfinished work, and trace inspection does not resume it.
- This milestone is not ROS2/Nav2 runtime acceptance, physical robot safety, general autonomous agents or a full tracing standard (OpenTelemetry).

## Validation

```sh
node --test tests/r29-execution-trace-projector.test.mjs tests/r29-execution-trace-integration.test.mjs tests/r29-execution-trace-http.test.mjs tests/r29-execution-trace-console.test.mjs
npm test
npm run sim:check
npm run sim:preflight
```

## R30 next milestone

Add explicit bounded trace pagination by stable sequence/creation cursor and durable attempt records across retries, then multi-device workload/fault testing and parent workflow drill-down. Next integrate a strictly permissioned generic Skill extension lifecycle without granting unreviewed third-party code access to family data or physical motors. Validate ROS Jazzy/Gazebo/Nav2 separately with runtime evidence.
