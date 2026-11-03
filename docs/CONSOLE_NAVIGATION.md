# Console navigation and access boundaries

The old sidebar labels were static `<div>` elements and had no navigation handlers. The console now uses four real keyboard-accessible links with hash routes:

| Hash route | View | Authorization boundary |
| --- | --- | --- |
| `#overview` | Dashboard, robot controls, command entry, workflows and plans | Actions remain enforced by server policies |
| `#devices` | Paired virtual devices, capabilities and gateway commands | Available only with a validated local parent session; demo and child roles see an explanation |
| `#skills` | Installed Skill Registry and permitted skill invocation | Skills are rendered from `/api/state`; each invocation still goes through `/api/skills/invoke` |
| `#events` | Local runtime event stream | Event access remains controlled by `/api/state` |

Navigation modifies only the browser view; it **never** changes the acting role, authentication, device grants or task safety decisions. The active route can be bookmarked or traversed via Back/Forward. Unknown routes fall back to the overview without interpreting the hash as HTML. A phone-sized viewport displays a fixed four-item bottom navigation bar; 621–950px viewports display an icon sidebar.

## Verification

```bash
npm test
node --test tests/v16-navigation.test.mjs
npm start
```

Open `http://127.0.0.1:4317`, click all four sidebar links, then test `/#devices`, `/#skills`, `/#events`, and browser Back/Forward. Repeat at 390px wide. In `AUTH_MODE=local`, log in as a parent to access device pairing. Child users and demo sessions must see an explicit explanation on the Devices view rather than a blank page.

The new script `/navigation.js` must be served under the same CSP as the main app; no inline event handler or new remote code dependency is introduced.
