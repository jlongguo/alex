# Alex R38 — In-process transaction isolation and safe upgrade preview

R38 extends R37's **metadata-only** Skill registry and durable WAL. All changes continue to require local parent authentication; third-party package execution, device commands and external code loading remain disabled.

## Transaction isolation

The registry now checks a coordinator-supplied guard **inside each serialized write**, not merely at HTTP request entry. When a prepared WAL entry exists, unrelated `submit`, `review`, `install`, `rollback`, `uninstall`, or `reference` mutations fail with `SKILL_TRANSACTION_ISOLATED`. The coordinator's own `review`/`install` mutations are scoped to the prepared operation ID and the exact pinned package version via an in-process asynchronous context. The lock is released when the WAL commits.

This guards in-process writes only. Do **not** run multiple Alex server processes pointing at the same local state; R38 does not supply distributed locking or filesystem leases.

## Safe abandonment and conflict recovery

The parent can inspect `GET /api/skills/transactions` for the WAL capacity and pending intent details. A parent may request `POST /api/skills/packages` with `action:"abandon"` and an `operationId`.

The coordinator refuses abandonment if the prepared operation already approved its target package or changed its installed pin, as there is no safe implicit rollback across separate JSON files. It can mark an untouched prepared intent `blocked`, unlocking new parent operations; the record remains in the WAL. After any partial effect, the parent must use recovery or inspect the conflicting state. A revoked publisher or changed CAS state remains fail-closed.

## Multi-package upgrade planner

`POST /api/skills/packages` with `action:"upgrade-plan"` and `targets: [{id,version}, ...]` returns a read-only advisory plan of up to 12 unique target packages. It checks:
- Registered and approved targets, current signature trust
- Version downgrades, privilege/actor expansion and pinned references
- Exact dependent package pins and dependency-first sequencing
- Cyclic/unsatisfiable sequencing (returns **no executable partial steps**)
- A projected final pin set

The plan **does not execute**; a future batch transaction engine must revalidate its assumptions before each step and enforce all-or-nothing rollback semantics, rather than treating an advisory order as approval. Existing R37 per-package apply operations remain explicit.

## WAL limits

Capacity is 400 transaction records and now exposed in the parent console. At capacity the WAL fails closed. Automatic pruning/archiving is **not** implemented because dropping committed request IDs could enable unsafe replay. Future R39 needs an external or checkpoint-anchored, lineage-preserving archival design before rotation.

## Acceptance boundary

`npm test`, `npm run sim:check` and `npm run sim:preflight` are mandatory CI gates. These are *not* real Gazebo/Nav2 runtime acceptance, nor proof of secure third-party code isolation.
