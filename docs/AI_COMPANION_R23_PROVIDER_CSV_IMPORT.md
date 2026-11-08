# Alex R23 — mapped supplier CSV statement import

## Scope

R23 adds a bounded RFC4180-style CSV ingestion path to the R21 normalized statement store. It is a generic explicit-column-mapping adapter, not a vendor-specific parser. No vendor headers or billing semantics are guessed.

## Endpoint

Parent-only local endpoint:

```
POST /api/audio/provider-billing/csv
Content-Type: application/json

{
  "csv": "id,vendor,ccy,start,end,model,metric,qty,amount\n...",
  "mapping": {
    "statementId": "id",
    "provider": "vendor",
    "currency": "ccy",
    "periodStart": "start",
    "periodEnd": "end",
    "model": "model",
    "metric": "metric",
    "quantity": "qty",
    "amountMinor": "amount"
  }
}
```

Each CSV data row is one line item. One import must contain exactly one statement ID, provider, currency and billing period. Map all nine required normalized fields to distinct CSV headers. Multiple statements in one CSV are rejected; import each statement separately.

## Parser constraints

- Maximum 1 MiB CSV input, 5,000 data rows, 64 columns and 4,096 characters per field.
- Supports quoted fields, escaped double quotes, commas in quoted fields, LF and CRLF records, and UTF-8 BOM.
- Rejects malformed quoting, duplicate/empty headers, inconsistent row widths, missing mapping columns, duplicate mappings, blank or non-decimal numeric fields, and mixed statement metadata.
- The resulting normalized statement is passed through the same R21 schema, period, currency, quantity, amount and idempotency validation.
- The raw CSV and mapping are not persisted. Only the normalized statement is stored.
- The store remains bounded, append-only and single-process.

## Parent console

The Family & Settings supplier panel now supports both normalized JSON import and CSV import with explicit mapping. The default mapping example is a template only; actual provider exports must be mapped to their documented columns.

## Validation

```sh
node --test tests/r23-provider-billing-csv-importer.test.mjs tests/r23-provider-billing-csv-http.test.mjs
npm test
npm run sim:check
npm run sim:preflight
```

## R24 direction

After choosing the actual TTS supplier, add a dedicated adapter that supplies a pre-reviewed column mapping and documents each field's billing semantics. Use sanitized official export fixtures, preserve source provenance and verify currency/period conventions. Until then, CSV import remains explicitly mapped and does not claim vendor-specific compatibility.
