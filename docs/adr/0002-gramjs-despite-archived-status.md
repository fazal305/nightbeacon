# ADR 0002: Use `telegram` (GramJS) despite its archived status

**Status:** Accepted (v1), tracked risk

**Context:** The GramJS GitHub repository is archived and no longer
maintained; development continues in `teleproto`, described by GramJS's own
README as an actively maintained, largely-compatible fork.

**Decision:** Start with `telegram` (GramJS), pinned to an exact version in
`server/package.json`.

**Reasoning:** MTProto is a stable protocol that doesn't change often;
GramJS is currently the more widely documented implementation, and pinning
the version means no surprise breakage from upstream changes (there won't be
any, by definition, since it's archived). `teleproto` is newer and less
independently vetted.

**Consequences:** if GramJS breaks against a future Telegram API change, or
if `teleproto` proves itself stable over time, migrate. This is documented in
`docs/SECURITY.md` as a known dependency risk, not silently accepted.
