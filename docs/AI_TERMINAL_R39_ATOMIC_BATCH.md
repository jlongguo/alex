# Alex R39 — Atomic Multi-Package Metadata Pin Commit

R39 builds upon R38's read-only dependency upgrade planner and R37's *single-package* WAL. It introduces a different, deliberately constrained operation: one all-or-nothing **registry file** snapshot commit for up to twelve approved, signed Skill package version pins.

## R39 behavior

- `POST /api/skills/packages` `action:"atomic-plan"` returns a read-only final-state proposal. Unlike sequential R38 planning, it can handle a simultaneous upgrade where two packages change exact dependency pins together and no valid intermediate order exists.
- `action:"atomic-batch"` accepts `targets:[{id,version}]` and `expectedPins:[{id,version}]` representing the **entire installed pin state** seen by the parent before confirmation.
- The registry serializes the batch with other writes, checks the R38 transaction guard, verifies the entire expected pin set as CAS, rechecks approved manifests and R34 publisher signatures, disallows implicit downgrades and privilege/actor expansion, refuses references pinned to replaced versions and verifies **every installed package's dependencies in the final state**.
- On success, all target pins and one hash-linked `batch-install` journal entry are saved via one JsonStateStore atomic rename. No partial intermediate pin state is exposed.
- On an invalid plan, changed parent trust, stale CAS, or failed disk save, the operation leaves the registry snapshot and in-memory state unchanged.
- The parent UI displays changes and blockers, retains the original CAS snapshot, disables the commit button until a valid plan exists and demands confirmation.

**Scope:** No external package content is loaded, no new execution permissions are granted, no device command is dispatched, and no Plan/Workflow files are rewritten.

## Critical boundary and next backlog

- This is *single-file atomicity*, not an atomic write across the separate publisher trust file, R37 WAL, Plan/Workflow or device state. R39 batch writes do not use the single-package WAL. There is no durable batch prepare/recovery log, distributed lock or multi-process protection.
- The state file's hash chain is local and not externally tamperproof. Do not assert independent immutable audit or tamper resistance to an attacker who can rewrite local files.
- WAL stays at its 400-record fail-closed limit; no unsafe history pruning or unverified archive rotation is introduced in R39. Next backlog: durable batch-intent WAL and recovery, safely persistent idempotency keys, independent trust checkpoint anchoring and multi-process fencing.
- Real Gazebo/Nav2 runtime acceptance is independent of `sim:check` and `sim:preflight`.

## Required acceptance

Run the full `npm test`, `npm run sim:check`, and `npm run sim:preflight` on the exact final branch head. Include signed HTTP role and CAS regressions; injected storage failures; dependency cycles and mutually pinned upgrades; and restart validation of the single registry snapshot.
