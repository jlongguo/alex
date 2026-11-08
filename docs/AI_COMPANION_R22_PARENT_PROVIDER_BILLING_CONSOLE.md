# Alex R22 — parent supplier usage and billing console

## Purpose

R22 adds a parent-only view inside Family & Settings for upstream TTS usage and imported provider statements. It consumes the R20 and R21 local APIs; it does not duplicate accounting logic in the browser.

## Access

The panel is nested inside the existing parent-private family workspace. The server remains the authorization boundary: the three data endpoints and statement import require local authentication and the parent role. Hiding the panel in the browser is not treated as access control.

## Features

- Refresh upstream request counts, completion/failure/cancellation counts, PCM bytes, sample count and in-flight count.
- Import a normalized supplier statement as JSON through the existing server-side R21 validation.
- List previously imported statements.
- Display comparable PCM byte quantities and quantity variance.
- Display unsupported units as unverified rather than manufacturing a match.
- Keep each statement currency visible; amounts remain integer minor units and are not converted or summed across currencies.

## Configuration

Configure the two R21/R20 files on the local server:

```sh
ALEX_SPEECH_PROVIDER_USAGE_FILE=/private/alex-state/provider-usage.jsonl
ALEX_SPEECH_PROVIDER_BILLING_FILE=/private/alex-state/provider-billing.jsonl
```

If one or both are not configured, the console explains which accounting layer is unavailable. No secrets are sent to the browser.

## Validation

```sh
node --test tests/r22-provider-billing-console.test.mjs
npm test
npm run sim:check
npm run sim:preflight
```

The R22 test checks parent-private placement, API wiring, safe dynamic output escaping and responsive styles. Browser-level visual verification remains part of the local acceptance pass.

## R23 direction

Once the actual speech supplier is selected, implement a documented vendor-specific statement adapter with sanitized official fixtures and provenance metadata. Then add detailed period filters and currency-aware summaries without mixing units. Do not claim actual spend analytics until the supplier's billing schema and account usage export have been verified.
