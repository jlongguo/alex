# Alex R37: Durable parent-approved Skill metadata apply

R37 implements a narrow, durable **single-process metadata transaction** for one parent-authorized package operation. All packages remain declarative metadata only. No external JS is loaded; nothing is delivered to physical devices.

## Operation

`POST /api/skills/packages` with `action:"apply"`, a unique `operationId`, registered package `id`, exact `version`, and the optimistic `expectedCurrentVersion` (or null).

1. Require verified local parent identity.
2. Require the registered Manifest and its R34 signed trust proof to be valid.
3. Inspect version, dependency, permission expansion, reference and dependent blockers. A pending version may be approved as part of this explicit operation, but no privilege-expanding upgrade or implicit rollback is allowed.
4. Durably persist a `prepared` transaction including the parent request ID, pinned version, expected previous pin, publisher ID, signed Manifest digest and artifact digest **before modifying the registry**.
5. Approve a pending Manifest, then install its metadata with the existing registry's serialized CAS, dependency and provenance controls.
6. Persist `committed` in the transaction WAL only after confirming the desired installed pin.

The WAL is a separate JSON file (`ALEX_SKILL_TRANSACTIONS_FILE`, default `.local/skill-transactions.json`). On server startup, prepare records are reconciled against the persisted registry, rechecking publisher trust and target pins before resuming. A crash after approval does not duplicate the review; a crash after installation does not duplicate the install. If a security gate or CAS fails, the record stays prepared and parent review is required.

A repeated `operationId` with the same exact request is idempotent. Reusing an ID with different intent fails closed. The server exposes `GET /api/skills/transactions` to a local parent, returning public digest and phase details without private keys, package payloads or executable content. A parent may explicitly request `action:"recover"`.

## Limits

- The WAL bridges an application-level sequence of metadata writes. It is **not** an atomic multi-file commit: publisher trust, package registry, workflow/plan and transaction journal are distinct stores. Crashes can temporarily expose an approved-but-not-installed package, and external changes can leave operations needing manual review.
- No cross-process/distributed lock or multi-host election; run one Alex server instance against these files.
- The coordinator does not change R34's publisher trust state and does not manage real Plan/Workflow device jobs.
- The WAL hash chain provides local corruption evidence, not external tamperproof logging. Anyone with write access to the entire file can recalculate its hashes.
- Only one prepared transaction is accepted at a time; a persistent unresolved intent blocks new applications until resolved. The fixed 400-record capacity requires future rotation/archiving.
- Offline package content is not installed or executed. Parent authorization is mandatory for write endpoints. Real Gazebo/Nav2 runtime acceptance is a separate gate.

Test coverage: restart before review, restart after review, restart after install but before WAL commit, denied publisher recovery, tampered WAL, idempotence and role isolation.
