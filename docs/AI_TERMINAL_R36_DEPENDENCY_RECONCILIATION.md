# Alex R36 — Dependency Integrity and Cross-Store Readiness

R36 strengthens the **metadata-only** Skill Package Registry, preserving the R34 signature gate and R35 single-file atomic lifecycle journal.

## What is implemented

- Deterministic, pinned-version dependency graph with transitive traversal, cycle and missing dependency detection, unapproved version checks and dangling explicit reference detection.
- On every registry mutation, check the full installed dependency graph before saving the package catalog and lifecycle journal together.
- On restart, verify that the last lifecycle journal `after` checksum actually matches the stored catalog, installed pins and references. Reject duplicate persisted references. Schema v1 snapshots continue to migrate as in R35.
- Parent-only `GET /api/skills/reconciliation` reads registry, publisher trust and runtime-usage projections and returns findings: missing attestation records, revoked publisher references, invalid installed version, unknown runtime Skill, missing dependencies and cycles.
- Parent-family settings display the health check. Neither the check nor the interface repairs state or authorizes executable Skill packages.

## Limits and next stage

The reconciliation is **read-only**: R36 does not implement transactional writes across `skill-trust.json`, `skill-packages.json`, Plan/Workflow files or a recovery log. This means a crash between distinct stores can produce a state that requires manual review. Do not imply that the cross-file atomicity or replay recovery work is finished.

The local hash journal is unanchored: a person with filesystem control may rewrite the entire file and recalculate hashes. There is no external tamperproof ledger, durable publisher attestation source, signed rollback permit, third-party sandbox or automatic device control.

`npm test`, `npm run sim:check`, `npm run sim:preflight` are required CI gates. They are not proof of real Gazebo/Nav2 runtime acceptance.

Next R37 should use an explicit durable transaction coordinator with prepare/commit/recover states and fault-injection tests, then bind approver identity and package digest to each action; leave third-party execution disabled.
