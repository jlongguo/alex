# Console navigation (superseded by Console v2)

The former four-link implementation in PR #16 was an intermediate UI step. It made sidebar links clickable but inadvertently hid active controls and success feedback. **Do not use the four-route CSS mapping as the reference architecture.**

The current six-workspace navigation, safety visibility, parent/child authorization boundary, task/skills/device ownership and testing contract are documented in [CONSOLE_V2.md](CONSOLE_V2.md).

Legacy bookmarks still work for `#overview`, `#devices`, `#skills`, and `#events`; new destinations are `#tasks` and `#family`.
