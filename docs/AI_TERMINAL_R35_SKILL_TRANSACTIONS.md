# Alex R35 — Metadata Lifecycle Transactions and Review

R35 continues from merged R34. Skill packages remain **metadata-only**. Neither rollback nor install executes arbitrary package code or grants device capabilities.

## What R35 adds

The SkillPackageRegistry state moves from schemaVersion 1 to 2. An existing valid v1 snapshot loads without losing its package catalog, installed pins or manual reference records. The next mutation persists the migrated v2 snapshot. Every successful registry mutation is serialized and writes its updated catalog, installed pins, manual references and hash-chained operation history in **one** JsonStateStore atomic rename. The history has before/after SHA-256 snapshots, sequence, operation, target and previous-event hash. Failed authorization, signature, dependency, CAS or persistence validation does not commit the in-memory mutation or append an event. This is a local tamper-evident chain, not independent tamper-proof logging. It has a fixed 2000-event capacity and fails closed when full; archiving/rotation is future work.

An authenticated parent can request `POST /api/skills/packages` with `action:"preview"`, `id`, `version` and `expectedCurrentVersion` to inspect:
- Current and candidate pinned versions and approved status
- Added/removed permissions and allowed actors
- Missing dependencies, current explicit references and dependent installed packages
- Current publisher-attestation validation errors and blockers
- Whether the candidate is an install, upgrade or rollback

Preview does not write state, and is advisory. Install and rollback independently recheck guards inside serialized writes to prevent stale-preview authorization.

`action:"rollback"` requires an *older* approved version, exact current installed version (optimistic concurrency/CAS), valid R34 publisher provenance, no privilege expansion, and no existing dependent/ref pin that would be broken. Ordinary `action:"install"` rejects implicit downgrades. Explicit rollback is recorded in the same atomic registry snapshot. There is no automatic rewriting of Plan/Workflow references.

The parent console now displays previews and asks for explicit confirmation before a rollback.

## Critical limits

The metadata and history are atomic **within one file only**. R34 publisher trust and family/Plan/Workflow state remain separate JSON files. R35 is not a true cross-file transaction coordinator, distributed transaction, complete dependency solver, automatic rollback of device commands, or a verified executable sandbox. An attacker who controls the local state file can rewrite both the state and its unanchored hash chain. Do not describe the local history as externally immutable.

## Validation gates

Full `npm test`, `npm run sim:check`, `npm run sim:preflight`, plus registry migration, conflict, rollback and UI/HTTP regression. Real Gazebo/Nav2 runtime verification remains a separate acceptance gate.
