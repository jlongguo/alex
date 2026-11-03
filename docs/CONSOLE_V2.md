# Alex Console v2 — functional rollback and workspace convergence

## Change strategy

PR #16 made four formerly static menu labels clickable, but CSS route selection hid action feedback, the simulated emergency stop and parts of the existing workflow. Console v2 is an **additive, non-history-rewriting corrective branch**: it keeps v0.15 robot and family backend semantics unchanged and restores all original API identifiers and actions.

## Six workspaces

| Hash | Role | Previously working capability |
| --- | --- | --- |
| `#overview` | All authenticated sessions and loopback demo | House map, direct navigation, command, robot progress and simulated obstacle |
| `#tasks` | Parent for workflow/plan/approval, child may propose | v0.6 workflow, v0.7 plans, v0.8 proposal+approval; no arbitrary motor commands |
| `#devices` | Verified local parent | Virtual device pairing, capability approval, dispatch and cancel, telemetry |
| `#skills` | Role-scoped | One interactive Skill Registry; results in global status line |
| `#events` | General session for home events; parent for audit | Up to 100 recent home events, search filter, separate parent audit |
| `#family` | Verified local parent | Learner profiles, opt-in memory, scoped erasure and JSON export |

The global **simulated** emergency stop, safety status and action message stay outside route containers, and remain available on every page. The stop is not a certified physical emergency stop and cannot replace hardware safety equipment. The `.hidden` state beats route-specific display CSS so unauthorized sections cannot appear merely by changing the URL hash. Server-side authorization remains mandatory for every mutation.

## Lifecycle

`launchConsole()` is called after `initAuth()` confirms the session. One timer polls the home state and the current workspace, and one EventSource triggers refresh. There are no redefined launch functions or repeated gateway/workflow/plan/proposal timers. Page changes schedule only the matching data reader. The client never relies on `actor` supplied in a request for a local-auth parent operation.

## Manual acceptance (real browser)

1. `npm test`; start with `AUTH_MODE=demo npm start`. Visit all six hash URLs, submit a permitted skill and confirm the global status updates; click simulated stop from a different workspace.
2. Restart with `AUTH_MODE=local`, `ALEX_PARENT_PASSWORD` and `ALEX_CHILD_PIN` set. Login as a child: create a proposal, do not see parent device pairing, plan approval, or family memory controls; attempt a parent-only API must return 403.
3. Login as a parent: pair a virtual device, approve declared capabilities, start a workflow, cancel a plan and review its events. Verify the device remains simulatable with the prior runtime; no ROS / physical motor commands are introduced.
4. Visit `#family`, add and delete a learner profile, save memory, export JSON, delete only a confirmed selected scope; verify audit records remain.
5. Visit `#events` with an event filter. Repeat navigation at 390 px and verify the six-button two-row mobile bar remains accessible and the global safety area visible.

## Rollback advice

Do not use `git reset --hard` on a working tree with uncommitted work. `git stash push -u -m 'alex-before-console-v2'`, then `git fetch origin` and `git switch` to the reviewed Console v2 branch. Alternatively `git revert` the menu-only commit on a fresh branch if a strict rollback is desired; that commit is already on remote `main` so rewriting remote history is inappropriate. Preserve `.local/` outside Git: it contains local simulation data.
