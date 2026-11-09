# Alex R31 — trusted Skill governance and version review

R31 returns Alex to the product goal of a **generic modular family AI terminal**. The existing TypeScript `SkillRegistry` already has built-in Skill manifests, in-process invocation and actor/capability checks. This batch adds **persistent, parent-controlled activation**, not a general third-party execution system.

## What is implemented

- Trusted built-in Skills: `learning.english`, `story.interactive`, `quiz.science`, `home.status`.
- Parent can enable/disable any trusted Skill. Each update requires the current manifest version as a reviewed `expectedVersion`; a stale version returns `SKILL_VERSION_REVIEW_REQUIRED`.
- Each decision is saved to the local JSON state file before runtime permission changes are applied. The state persists across process restart.
- Startup checks every saved Skill ID, exact version, state boolean, uniqueness and schema. Unexpected versions fail startup instead of silently turning a changed Skill back on.
- The existing `SkillRegistry.invoke` and Plan/Workflow local Skill step respect `enabled=false`.
- Companion English, Story and Quiz text sessions also reject new opens, turns and streams for disabled Skills. Disabling a Skill aborts currently tracked companion generation operations; it does not erase prior learner history.
- A parent-only API and Family Settings panel expose Skill names, exact versions, roles, capabilities and enabled states.
- Internally, trusted in-process plugin upgrades must use increasing semantic versions. No HTTP route exists for uploading or executing new plugin code.

## Configuration

```sh
export ALEX_SKILL_GOVERNANCE_FILE=/private/alex-state/skill-governance.json
```

Default: `.local/skill-governance.json`. Use `AUTH_MODE=local`; the parent-only control endpoints deliberately reject demo mode.

## API

```text
GET  /api/skills/governance
POST /api/skills/governance
```

Example POST body:

```json
{"id":"story.interactive","enabled":false,"expectedVersion":"0.2.0"}
```

The server, not a hidden browser control, enforces the parent role. Disabled companion sessions return `SKILL_DISABLED` on new open/turn/stream attempts.

## Important limitations

- These are **trusted, bundled in-process Skills**. Third-party JavaScript, user-supplied code, remote package installation, sandbox execution, capability delegation and independent device actuator access are not provided.
- A Skill's declared capability list is descriptive and checked by the existing policy, not a full OS-level sandbox. A future external plugin runner needs process isolation and scoped IPC.
- Existing companion content and device tasks may have separate lifecycle semantics; disabling a Skill does not retroactively delete content or reverse completed actions.
- The version pin is an exact-manifest review gate, not a cryptographic package signature.
- This release does not constitute real Gazebo/Nav2/robot motor acceptance.

## Verify

```sh
npm test
npm run sim:check
npm run sim:preflight
```

R32 should build a **declarative Skill package registry**, signed metadata, parent review of capability changes, and explicit project/lesson usage references. It must not grant arbitrary code or children’s private data access before a sandbox and permission model have been verified.
