# Alex R32 — Declarative Skill Package Governance (first batch)

R31's executable Skill Registry remains the only executable trusted built-in registry. R32 introduces a **separate metadata-only catalog**. Installing a package in this catalog **does not** invoke it, register it in HomeCore, grant audio/network/device access, execute uploaded code or enable third-party plugins.

## Manifest v1

`schemaVersion: alex.skill/v1` is mandatory, as are `id`, strict numeric `version`, `name`, `description`, `permissions`, `allowedActors`, `dependencies`, `inputSchema` and `outputSchema`. Arbitrary properties, executable strings, remote JSON Schema references and recursion are rejected. The limited I/O schema accepts bounded object properties of primitive types only with `additionalProperties: false`. These restrictions are deliberate, not full JSON Schema support.

## Parent-only API

In `AUTH_MODE=local` only, `GET /api/skills/packages` returns metadata, installed pins and reference relationships. `POST /api/skills/packages` accepts a JSON `action`:

- `submit`: `{action,manifest}` creates a pending version.
- `review`: `{action,id,version,decision:'approve'|'revoke'}`; revocation removes the affected installation and its direct references, and is blocked if installed packages depend on that version.
- `install`: `{action,id,version,expectedCurrentVersion:null|string}` checks approval and exact installed dependency versions. Permission or actor expansion requires explicit uninstall and re-install, never silent upgrading.
- `uninstall`: `{action,id,expectedVersion}`; blocked by references or installed dependents.
- `reference`: `{action,kind:'plan'|'workflow'|'learning',resourceId,skillId,version,enabled:boolean}`; reference must pin installed version.

The API manages catalog metadata only: it does not yet automatically discover live Plan or Workflow associations. Registration of a reference is explicit, parent-authorized, and is **not** proof that an underlying Plan/Workflow exists or executed. Future integration must reconcile real runtime state and protect active consumers.

State is stored in `ALEX_SKILL_PACKAGES_FILE` (default `.local/skill-packages.json`). On restart, unknown or malformed records fail loading; writes are serialized and durable-before-visible. This is a single-process local store, not a distributed transaction manager.

## Security limitations

No signed publisher identity, package artifact checksums, runtime sandbox, process-level resource quotas, third-party execution, permission grants, UI package catalog, automatic usage discovery, cloud sync or real Gazebo/Nav2 proof. Parent approval is a **metadata decision**, not execution consent. R32 cannot be declared closed until HTTP, UI, real usage discovery and end-to-end acceptance are done.

## CI

`npm test`, `npm run sim:check` and `npm run sim:preflight` are the PR merge gates. Simulation checks do **not** replace `sim:accept` on a real Gazebo/Nav2 host.
