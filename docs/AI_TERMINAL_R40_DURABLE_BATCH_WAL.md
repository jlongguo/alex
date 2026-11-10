# Alex R40: Durable atomic batch metadata WAL

R40 extends R39's single-JSON-snapshot atomic multi-Skill version change with a **separate durable batch write-ahead log**. It does not imply distributed atomicity, executable plugins, or a device workflow transaction.

## Protocol

- Parent-only `POST /api/skills/packages` `action:"atomic-batch"` requires a stable `operationId`, up to 12 exact signed package `targets` and complete `expectedPins` CAS.
- The coordinator checks a trusted publisher attestation for each target, validates the final package graph and writes a `prepared` WAL record containing target versions, expected pins, publisher IDs, Manifest/artifact hashes and an audit checkpoint of the existing registry state.
- After preparing the WAL, it executes one R39 atomic registry `batch-install` mutation. The registry rechecks the installed pin CAS, all signatures, permissions and graph invariants inside its serialized mutation queue.
- It confirms the registry's hash-chained `batch-install` event, exact previous snapshot digest, sequence/previous event hash and expected final pins before marking WAL `committed`.
- On restart, **before any HTTP requests**, pending batch operations are reconciled: a matching unchanged base snapshot permits one application; a provably already-applied registry commit is acknowledged without re-executing it; a conflict or changed signature is flagged for parent review.
- Identical `operationId` and request parameters are idempotent; an ID reused with a different request is rejected.
- A parent can inspect `GET /api/skills/batch-transactions`, explicitly request `batch-recover`, or `batch-abandon` only when the original registry checkpoint remains unchanged.

## Safety bounds

- The batch WAL, R37 single-Skill WAL, publisher trust and other durable stores remain **separate files**. The feature is crash-recoverable for the specified batch registry mutation, not a true cross-file atomic commit. A failed confirmation can leave a committed registry state plus an uncommitted WAL record pending reconciliation.
- In-process guards block unrelated registry writes during a pending batch operation. They are not locks across processes, machines or devices. Only **one Alex process** may use the given state files.
- The journal holds at most 400 records, fails closed at capacity and retains the original request IDs to preserve replay detection. There is no automatic or proven-safe archival rotation in R40.
- Hashes are local corruption evidence, **not externally anchored tamperproof audit evidence**.
- A target is declarative metadata only. No package payload is imported or executed; no hardware command, Plan or Workflow state changes are made.
- `sim:check` and `sim:preflight` do not prove real Gazebo/Nav2 runtime acceptance.

## Verification

R40 tests cover prepared-before-registry crash, committed-before-WAL crash, restart with trusted evidence drift, unmodified abandon, altered-WAL rejection, duplicate IDs, stale CAS, HTTP parent/child isolation and parent console rendering.
