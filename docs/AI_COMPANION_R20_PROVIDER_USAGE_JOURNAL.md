# Alex R20 — provider response usage journal

## Purpose

R19 records Alex's local PCM delivery reservations. R20 adds a separate, opt-in operational journal for upstream TTS requests and PCM returned by the configured provider. It does **not** claim to measure the vendor invoice, billed characters, token count, or money charged.

Three different quantities must remain separate:

1. Provider response PCM bytes/samples: what the upstream HTTP response actually yielded to Alex.
2. Alex local delivery reservations: what R19 reserved before attempting to return PCM to the authenticated browser.
3. Vendor invoice usage/charges: authoritative figures supplied by the provider's billing or usage API/export. This is not implemented by R20.

## Enable

```sh
export ALEX_SPEECH_PROVIDER_USAGE_FILE=/private/alex-state/provider-usage.jsonl
```

This is independent from `ALEX_SPEECH_DELIVERY_LEDGER_FILE`. Both can be enabled together. Omitting this variable preserves the current unmetered provider wrapper behavior.

## Journal and API

The append-only local JSONL journal records:
- Random upstream request ID
- Provider kind and configured model identifier
- Request open time and finish time
- Number of response PCM frames, response bytes and derived samples
- Completed, cancelled, failed or still-inflight outcome
- A normalized error code for failed requests

It deliberately does not store prompts, generated text, PCM, credentials, authorization headers, learner identifiers, profile IDs or conversation IDs. A request per committed sentence is recorded separately when segmented playback is enabled.

Parent-only local endpoint:

```
GET /api/audio/provider-usage
```

The summary reports provider request counts, in-flight requests, response bytes/samples and model-level aggregates. Learner sessions cannot read the family-wide supplier usage summary. The endpoint is disabled when the journal path is not configured.

## Failure and accounting semantics

- Journal events are synchronously appended and fsynced before the upstream frame is handed to the next layer. A journal write failure fails the TTS read closed.
- Request-open records without finish records are shown as inflight after a process restart. Do not automatically reinterpret them as completed or failed.
- Completed means the upstream reader reported end-of-stream; cancelled means the wrapper was closed before normal completion; failed means the upstream open/read failed.
- Response PCM counts measure bytes consumed from the provider reader, not bytes heard by a person and not necessarily bytes charged by the provider.
- The append-only journal is local operational telemetry, not a distributed database. Back it up and protect the parent directory. Do not share the same file across hosts or network filesystems.
- A malformed journal fails startup closed rather than silently discarding accounting history.
- The file grows over time; archive/rotation tooling and a vendor-specific invoice importer remain future work. Do not manually edit records.

## Validation

```sh
node --test tests/r20-provider-usage-journal.test.mjs
npm test
npm run sim:check
npm run sim:preflight
```

## R21 direction

Implement vendor-specific usage/invoice importers only after choosing a supported provider and confirming its official usage API/export schema. Reconcile by provider request ID when the vendor exposes one; otherwise use documented time/model/usage dimensions and mark unmatched records as estimates. Add parent reports that compare provider response PCM, Alex reserved/downstream PCM and official billed units without converting unlike units into a false single total. Add retention/rotation and backup/restore drills before enabling on a production family installation.
