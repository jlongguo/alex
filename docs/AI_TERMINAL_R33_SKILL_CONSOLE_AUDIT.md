# Alex R33 — Skill Package Console & Runtime Reference Audit

## Delivered

R33 adds a parent-private UI for the R32 **declarative package metadata registry**. Parents can paste a strict `alex.skill/v1` manifest, submit a pending version, approve or revoke it, and install or uninstall *metadata* with explicit version pins. Nothing about this panel executes package artifacts, supplies a sandbox or grants device permissions.

`GET /api/skills/usage` is available only to authenticated parents in `AUTH_MODE=local`. It projects references from the server's current trusted Skill registry, compiled Plan templates, fixed Workflow recipes, trusted course catalog, and persisted Plan, Workflow and learning-plan rows. These are real *references*, not a verified execution trace. Every row has a `source` and `provenance`, and manifests that only exist in the R32 metadata catalog stay `executable:false`. Explicit R32 parent-managed reference records appear separately as `parent-declared-unverified`. No claim is made that declared references originate from actually executing Plan/Workflow consumers.

R33 fixes the R32 package upgrade edge case: replacing a version is blocked when other installed packages pin it. Restart validation also rejects persisted installations with missing pinned dependencies.

## Acceptance

`npm test` runs audit unit, UI contract, HTTP parent/child authorization and package dependency regression tests, in addition to earlier suites. `npm run sim:check` and `npm run sim:preflight` remain separate CI gates. Real `sim:accept` on Gazebo + ROS2/Nav2 is **not** established by these static checks.

## Remaining

- Automatic reconciliation of package references to real consumer IDs and active usage, rather than explicit parent claims.
- A dedicated immutable approval journal including reviewer identity, source digest, and signed publisher metadata.
- Safe migration/rollback paths for consumers and locked dependent version chains.
- External package artifact verification, sandbox/proc isolation and capability enforcement before any executable extension can be enabled.
- Parent/child browser E2E on real target browsers.
