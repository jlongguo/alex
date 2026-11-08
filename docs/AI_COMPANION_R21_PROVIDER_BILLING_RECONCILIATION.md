# Alex R21 — provider statement import and conservative reconciliation

## Scope

R21 adds a provider-neutral import boundary for supplier usage statements and compares only quantities already measured by R20. No vendor API is assumed and no currency conversion or estimated invoice calculation is performed.

## Opt-in storage

Set both paths for local statement ingestion and local telemetry comparison:

```sh
export ALEX_SPEECH_PROVIDER_USAGE_FILE=/private/alex-state/provider-usage.jsonl
export ALEX_SPEECH_PROVIDER_BILLING_FILE=/private/alex-state/provider-billing.jsonl
```

The billing statement store can also be enabled independently for statement retention. Both are local append-only JSONL files, protected by restrictive directory/file creation modes and synchronous fsync. They are single-process stores, not multi-host databases.

## Normalized statement format

```json
{
  "schemaVersion": 1,
  "statementId": "vendor-invoice-or-export-id",
  "provider": "compatible-pcm-stream",
  "currency": "USD",
  "periodStart": "2026-11-01T00:00:00Z",
  "periodEnd": "2026-11-02T00:00:00Z",
  "items": [
    {
      "model": "voice-v1",
      "metric": "pcm_bytes",
      "quantity": 9600,
      "amountMinor": 12
    },
    {
      "model": "voice-v1",
      "metric": "characters",
      "quantity": 2500,
      "amountMinor": 8
    }
  ]
}
```

Amounts are integer minor currency units (for USD, cents). The statement must provide its actual currency and UTC billing period. Quantities are not converted between units. Supported metric labels are `request_count`, `pcm_bytes`, `audio_seconds`, `characters`, `input_tokens`, and `output_tokens`.

Only `pcm_bytes` is currently compared with R20. `request_count` is deliberately marked `not_comparable`: R20 records local request attempts, while the supplier's billable-request definition is not established. Other metrics are also explicitly returned as `not_comparable`. The importer does not guess a vendor's units, infer a rate, or manufacture a cost from PCM bytes.

## Parent-only local endpoints

- `POST /api/audio/provider-billing/statements` — import a normalized statement (body may be the statement itself or `{ "statement": ... }`).
- `GET /api/audio/provider-billing/statements` — list imported statements.
- `GET /api/audio/provider-billing/reconciliation` — compare supported metrics against R20 local provider telemetry.

All endpoints require local authentication and the parent role. The statement importer is disabled unless `ALEX_SPEECH_PROVIDER_BILLING_FILE` is configured. Reconciliation is available only when both the statement store and R20 usage journal are configured.

## Integrity and limitations

- Re-importing the same statement ID with identical normalized content is idempotent; reusing that ID with different content is rejected.
- Currency, period, model, metric, quantity and integer minor-unit amount are validated before append.
- Unrecognized input properties are discarded; raw uploads, credentials, learner IDs, transcripts and audio are not retained.
- Statement files are append-only and bounded. Corrupt history fails closed at startup.
- PCM byte comparison is limited to exact provider/model and statement start-time window for local request records. R20 currently has no vendor request ID linkage. Therefore this is an aggregate quantity comparison, not transaction-level proof.
- A variance is a difference in the same unit only. It is not a monetary credit, proof of overbilling, or evidence of a vendor error.
- Vendor-specific API/CSV adapters, signature verification, invoice tax/discount treatment, timezone-specific exports, and automatic reconciliation remain future work pending a named supplier and its official schema.

## Validation

```sh
node --test tests/r20-provider-usage-journal.test.mjs tests/r21-provider-billing-reconciliation.test.mjs
npm test
npm run sim:check
npm run sim:preflight
```

## R22 direction

Add a real adapter only after selecting the actual TTS supplier and obtaining its official usage export/API schema. Preserve the original statement reference and source provenance, map its documented usage dimensions into this normalized format, and add fixture tests using sanitized official examples. Then add a parent dashboard that displays each currency and unit separately, with explicit unmatched and not-comparable states.
