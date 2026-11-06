# Alex R19 — opt-in durable PCM delivery reservation ledger

## Scope

Built from merged R18 main `a26b0b0cccba6f9bf903e5eadec89a2be2a011d8`. This feature preserves R10's existing memory-only budget as the default and adds an **explicitly opt-in** file-backed budget implementation. There is no duplicate TTS provider or audio player.

To enable in an authenticated local Alex deployment:

```sh
export ALEX_SPEECH_DELIVERY_LEDGER_FILE=/private/alex-state/speech-delivery-ledger.json
export ALEX_SPEECH_DAILY_DELIVERY_SECONDS=120
```

Set the ledger path to a local writable filesystem with a protected parent directory. Use a **unique ledger file for one logical Alex service**. Keep a secure backup before changing the configured path or data volume; changing the path changes the accounting namespace.

## Reliability / limits

- **Atomic local reservations:** a PCM frame's 1–2400 samples are reserved and fsynced to a temporary same-directory JSON snapshot **before** the server returns the frame to the authenticated HTTP caller. A directory lock serializes writers, and each update reloads the latest persisted state under the lock. Rename replaces the ledger atomically. A concurrent writer encountering an existing lock fails closed rather than racing.
- **Restart recovery:** sessions, ACK state and provisional provider audio do not recover, but the last committed quota reservation is restored from the file. UTC date rollover resets the daily allowance.
- **Conservative accounting:** if HTTP disconnects after the reservation but before the frame is received by the browser, the reserved sample count is not refunded. This is intentional: decrementing after a network error could allow unbounded retries. `deliveredSamples` in the existing metric's backwards-compatible shape now means **reserved for attempted delivery**, not proven delivered.
- **Privacy:** only authenticated principal keys, UTC day indexes and sample counts are stored. No text, audio, tokens, provider keys, child names or transcripts. Existing principal erasure and family scope erasure remove persistent rows.
- **Strict corruption behavior:** invalid data, schema versions, duplicate principals and out-of-range values prevent startup. Write errors and file-lock contention deny new audio chunks; the HTTP route reports a server error instead of returning unaccounted media.
- **Lock lifecycle:** locks are held only during synchronous mutations. A process crash while holding the `.lock` directory can leave it behind. A trusted operator must verify no writer is still running and remove the stale lock manually; never blindly remove an active lock. The design targets local disks; NFS/network filesystems and multi-host/distributed locking remain unsupported.
- **Durability boundaries:** the file is written and fsynced before rename; directory fsync is best effort on platforms that support it. No promise of perfect recovery after power loss on every filesystem.
- **No vendor bill correlation:** supplier charges may arise from prefetched or canceled TTS even when zero PCM was returned to the browser. This ledger is **not** supplier invoicing, a refund system, a price ledger or financial settlement.
- **Security caveat:** this is an experimental local file feature; safeguard the configured directory from other OS users. It is not a production distributed billing or compliance control.

## CLI validation

```sh
node --test tests/r19-durable-speech-budget.test.mjs
npm test
npm run sim:check
npm run sim:preflight
```

## R20 recommended

Implement real authenticated localhost HTTP restart integration, dedicated read-only parent usage reports and a separate provider request/usage reconciliation protocol (without claiming provider invoices from PCM deliveries). For higher availability, migrate quota state to a transactional database with a uniqueness constraint and distributed idempotency key. Keep explicit consent and existing R18 mid-flight revocation behavior.
