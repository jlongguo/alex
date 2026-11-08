# Alex R24 — provider statement source provenance

## Scope

R24 attaches source provenance to normalized R21 supplier statements without retaining raw CSV or original JSON uploads. The statement's business-content fingerprint remains independent from provenance so a duplicate import does not conflict merely because it was imported again at a later time or through a different path.

## Provenance record

Each newly imported statement stores:
- `source`: `json` or `csv`
- `importedAt`: normalized UTC timestamp
- `sourceDigest`: SHA-256 of the submitted JSON statement representation or exact CSV text
- `mappingDigest`: SHA-256 of the canonical nine-field column mapping for CSV, otherwise null

The CSV digest is computed over the submitted CSV string before parsing; the mapping digest uses the normalized field-to-header pairs in a stable field order. Only the digests and metadata are persisted, not the raw source or mapping.

## Integrity and compatibility

- Provenance is schema-validated on import and on restart.
- A malformed or tampered provenance record makes the append-only store fail closed.
- The normalized statement fingerprint does not include provenance. Re-importing the same statement ID and content remains idempotent; original provenance is preserved.
- Reusing a statement ID with changed normalized business content remains a conflict.
- Existing R21 statements without provenance remain readable and are displayed as legacy imports.
- SHA-256 is an integrity fingerprint, not a digital signature. It does not prove who issued the invoice or authenticate the supplier.

## Parent console

The imported-statement list now shows source type, import timestamp and a short digest prefix. Full digests remain in the local statement ledger.

## Validation

```sh
node --test tests/r24-provider-statement-provenance.test.mjs
npm test
npm run sim:check
npm run sim:preflight
```

## R25 direction

Add a vendor-specific adapter only after selecting the actual supplier and obtaining its official usage export/API specification. Verify official statement identifiers, timestamps, currency minor-unit rules and usage-unit semantics against sanitized fixtures. Add cryptographic signature verification only if the supplier provides a documented signature scheme; SHA-256 provenance alone is not authentication.
