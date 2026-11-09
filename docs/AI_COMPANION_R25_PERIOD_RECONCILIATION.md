# Alex R25 — billing period and provider reconciliation filters

## Outcome

R25 adds parent-only UTC period/provider filters to R21 invoice reconciliation and a grouped summary that **does not convert currencies**. Billing is still official invoice data imported by a parent; no upstream supplier API or payment processor is connected.

## Filters

`GET /api/audio/provider-billing/reconciliation?from=2026-11-01T00%3A00%3A00.000Z&to=2026-12-01T00%3A00%3A00.000Z&provider=compatible-pcm-stream`

- UTC `from` inclusive / `to` exclusive. Both must be supplied together.
- Results include full statements whose billing periods overlap the requested window. **Amounts are not prorated to partial periods**.
- If no period filter is supplied all statements are included; provider filter is optional and exact-match.
- Input validates UTC ISO 8601 timestamp and parent/local authorization before exposing data.

## Summary

`summary.currencyTotals`: total imported amount in **integer minor units**, separated by currency, with source statement IDs.

`summary.groups`: supplier, currency, model, billing unit, imported quantity and amount. Only uniquely matched local `pcm_bytes` is eligible to be shown as comparable. Multiple statement lines or overlapping source windows could count the same local samples twice, so such groups are marked `not_comparable` and local amounts/variance remain null.

Invoice charges are **not** vendor API usage, payments, or inferred retail cost. They can include fees/taxes, and should not be interpreted as reconciled spend without vendor-specific billing semantics. Request counts and other vendor-defined units remain unverified.

## Console

The Family & Settings supplier panel adds start date, end date and optional provider fields. The end date entered in the UI is inclusive and becomes a UTC exclusive upper bound internally. The cost summary is independent of the all-time local telemetry tiles; do not misread them as having the same filter.

## Tests

```sh
node --test tests/r25-provider-period-reconciliation.test.mjs
npm test
npm run sim:check
npm run sim:preflight
```

Scope excluded: official supplier adapters, verified signatures, cross-host storage, currency exchange, partial-period proration, financial forecasting, ROS runtime acceptance, and real device tests.
