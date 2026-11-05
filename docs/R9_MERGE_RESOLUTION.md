# R9 divergent branch merge resolution

This record documents the resolution of the two R9 speech development branches.

- Canonical main tree before merge: `447c641c78ecb5bd4653d1b21a24d1e542de7831`.
- Historical branch head: `b6c7a9f59697cc3a1bc69f5fd0a676eee93c04b9` (`feat/alex-r9-streaming-playback-core-20261105`).
- Merge commit: `817bdeb9750cc71c4aee57a774e9d1b0fc3b7283`, with both heads as parents and **the exact canonical main tree**.
- Previous main retained at `backup/main-before-r9-conflict-merge-20261106`.

## Resolution strategy

The newer `main` implements streamed speech via
`StreamingPcmSpeechProvider`, `StreamingSpeechSessions`,
`speech-playback-session.js`, and authenticated per-learner HTTP endpoints.
The alternate older feature branch implements a separate, incompatible
provider/session/browser protocol. Combining corresponding files would regress
the currently tested functionality.

All overlapping implementation files and test files were resolved in favor
of **main**. The older branch's commits remain reachable through the second
merge parent, but its obsolete implementation is **not** deployed. No code
from either branch has been silently reinterpreted as equivalent.

## Validation and future work

The canonical main source tree has a successful GitHub Actions Verify run
`42060505568`. Validate the merge through its own CI run as well.
Continue all future R9 changes on fresh branches from the resulting main.
Test real TTS vendor acceptance, latency, browser audio playback and parent
consent separately; a successful CI does not prove these production behaviors.
