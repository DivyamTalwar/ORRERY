# Changelog

All notable changes to Orrery are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Semantic Versioning.

## [Unreleased]

### Added

- **Astra, the high-complexity implementation lane.** `orrery-astra-implementer.toml`
  pins GPT-6 Astra at `xhigh` reasoning and takes security and authorization logic,
  concurrency and ordering, non-trivial algorithms, difficult debugging, data and
  schema migrations, and refactors with a wide blast radius. Its prompt requires the
  worker to state the invariant, failure mode, and ordering guarantee before editing.
- A routing reference at `docs/routing.md` covering lane selection, why ties break
  toward Astra, and what to do when a route turns out to be wrong.
- A `verify.sh` regression test that seeds a real v0.6.0 install, upgrades it, and
  asserts Terra migrated, Astra was added, Sol was untouched, and `--check` passes.

### Changed

- **Terra is now the routine lane.** It keeps `gpt-5.6-terra` at `high` and takes
  bounded, mechanical, fully specified work. Its prompt now requires it to stop and
  escalate rather than absorb work that turns out to be above its lane.
- The setup interview recommends `gpt-6-astra` / `xhigh` for the high-complexity
  role. It previously recommended `gpt-5.6-terra` / `high` for both implementation
  roles, so a user accepting the defaults configured two identical lanes.
- Observed routing is now checked against the *selected* lane. Seeing the other
  implementation lane is treated as a substituted worker and stops the lane, even
  when the work looks correct.
- The installer accepts a set of superseded template digests rather than a single
  one, so both the v0.2.0 and v0.6.0 Terra files migrate instead of being refused as
  conflicts.

### Fixed

- The stale-claim guard in `verify.sh` scanned line by line, but these documents are
  hard wrapped at ~80 columns, so the sentence it existed to catch was split across a
  newline and never matched. It now matches with newlines flattened.

## [0.6.0] - 2026-08-09

### Added

- Claude Code as a first-class native client (`.claude/agents/*.md`), pinning a model per
  role and enforcing the advisor's read-only posture with a `Read, Grep, Glob` tool
  allowlist. `render_client_adapter` now reports `readOnlyMechanism` and the exact
  `roleIds` for the configured host.
- Content-addressed tool-surface consent. `TOOLS_DIGEST` covers every tool name,
  description, input schema, output schema, and annotation; it is pinned in
  `tools/schema/tools.digest` and asserted by CI and by the packaged-artifact check.
  `save_preferences` records the approved digest and any later mismatch reports the new
  `tools-changed` status, which blocks every stateful operation until a human re-approves.
  This is the published mitigation for MCP rug-pull and tool-poisoning attacks.
- MCP `2026-07-28` support alongside `2025-06-18` and `2025-03-26`. Requests may carry
  `io.modelcontextprotocol/protocolVersion` in `_meta` with no `initialize` handshake, and
  `tools/list` results carry `ttlMs` and `cacheScope` on the new revision. An explicitly
  declared but unsupported revision is refused rather than silently downgraded.
- Complete behaviour annotations and JSON Schema `outputSchema` on all eight tools. A test
  validates every tool's real output against its declared schema.
- An exclusive `O_EXCL` lock over `${PLUGIN_DATA}` around every mutation and every crash
  recovery, with liveness- and age-based reclamation of abandoned locks.
- Strict TypeScript checking (`bun run typecheck`) wired into CI, plus a `tsconfig.json`
  with `strict` and `noUncheckedIndexedAccess`.
- CycloneDX 1.6 SBOM generator hashing every packaged file, GitHub build provenance,
  keyless Sigstore signing verified in-workflow before publish, and Dependabot coverage
  for actions and dev dependencies.
- `SECURITY.md` with the threat model, the enforced-versus-unguaranteed split, and
  release verification commands.
- `bun run rebrand`, a guarded rename that recomputes every derived digest, because a
  manual find-and-replace silently breaks the tool-surface and legacy migration pins.
- Cursor local-clone installation guide plus developer smoke-test procedure with guarded setup, evidence, and cleanup steps.
- Guarded macOS TypeScript installer for Cursor's project-scoped local MCP compatibility bridge, including workspace-isolated data, receipt validation, concurrent-edit refusal, crash recovery, and lifecycle tests.

### Changed

- Configuration schema version 2. Existing configuration reports `schema-old` and must be
  re-approved through the setup interview, because tool-surface consent did not exist
  before this release.
- The runtime reads its version from `plugin.json` instead of a hardcoded literal, and
  `bun run validate` asserts parity across all three manifests.
- `mcp/server.ts` was expanded from its compressed one-statement-per-operation style into
  reviewable, commented code. Behaviour is unchanged and covered by the existing suite.
- Consent tokens are pruned on expiry, use, and a bounded cache size.
- `verify.sh` derives the expected Codex manifest version from `plugin.json` rather than a
  hardcoded literal.

### Security

- **Lock reclamation is now atomic.** Two processes that both judged an abandoned lock
  stale could both remove it and both acquire it, then drive the same transaction journal
  and the same three targets concurrently — leaving the managed-file manifest describing
  files that are not on disk while still reporting a successful install. A two-process
  harness reproduced manifest/disk divergence in 11 of 12 runs before the fix and 0 of 180
  after. Acquisition is now `link(2)` from a fully written staging file, reclamation is
  claimed through an atomic `rename(2)`, the claimed record is checked against the record
  that was judged stale (a lock reclaimed by a racer in that window is handed back rather
  than destroyed), and release only unlinks a record still carrying the caller's owner
  nonce.
- Liveness is now checked before age, so a running holder is never robbed after a laptop
  suspend or a stepped clock. A far-future timestamp from another host is treated as
  stale so a skewed or forged record cannot wedge the directory permanently.
- The lock file is never observable empty, closing a window in which a concurrent process
  read a half-written record, judged it corrupt, and stole a live lock.
- `validate_configuration` no longer mints installable consent. `renderPlan` computes the
  plan with no side effects and is used by validation, install verification, uninstall,
  and journal recovery; only `render_client_adapter` mints a token.
- Consent tokens are now bound to the scope and profile they were minted under, and the
  plan digest covers both.
- Read-only tools no longer run crash recovery. Recovery deletes and renames files, so it
  runs only inside a mutating tool holding the lock; outstanding work is reported as
  `pendingRecovery`.
- `reset_configuration` is refused while the tool surface is unapproved, so a reset cannot
  erase an unreviewed rug-pull alarm.
- Every GitHub Action is pinned by commit SHA rather than a mutable tag.
- **Rollback no longer infers what it wrote from a hash.** When a re-install rendered
  content byte-identical to what was already on disk, an entry the transaction never
  touched was indistinguishable from one it had committed, so rollback deleted a valid
  file and then threw -- stranding the journal and wedging every later mutation. The
  journal's committed counter is now the only authority, for both install and uninstall.
- **Lock reclamation is serialized, and nothing ever lifts a live lock.** Reclaiming an
  abandoned lock by renaming it aside briefly empties the path, which let an uninvolved
  third contender create one in the gap and enter the critical section alongside the
  holder; a six-process soak reproduced manifest/disk divergence in 2 of 250 rounds.
  Acquisition is now purely an exclusive create, and the only removal happens while
  holding a separate reclaim ticket, so at most one process is ever between removing a
  stale lock and creating its own. Because a lock file's existence blocks creation and no
  other process may remove one, a record judged stale under the ticket cannot have become
  live. That also removes the earlier orphaned-lock failure by construction rather than
  mitigating it. The same soak is now 0 of 300.
- Tool names are resolved through a `Map`, so an inherited `Object.prototype` member such
  as `toString`, `constructor`, or `__proto__` can no longer masquerade as a tool and
  bypass the unknown-tool protocol error.
- Crash recovery is restricted to tools that already declare destructive intent, so a tool
  documented as writing nothing to disk never deletes or renames a file.
- Journal validation accepts a `tools-changed` profile, removing a deadlock in which an
  outstanding journal plus an unapproved tool surface failed every mutating call.
- A same-host lock is reaped after an absolute ceiling, so a recycled pid cannot strand it,
  and an out-of-range pid is no longer reported as alive.
- One malformed member of a JSON-RPC batch no longer discards its siblings' replies.
- The SBOM carries a content-derived `serialNumber` and self-validates before writing;
  without it the release attestation step rejects the document and no release publishes.
- **Rollback survives a failure between publishing a link and journalling it.** The
  committed counter is persisted only after `link(2)`, so a crash in that window left an
  entry live on disk but uncommitted in the journal; rollback then refused to undo its own
  link, threw `rollback target reappeared`, and stranded the journal so every
  recovery-capable tool failed permanently. Reproduced with a real `SIGKILL` and with a
  same-user write to the staging file.

  The journal now carries a write-ahead `attempted` counter, recorded immediately before
  the link publishes content and nowhere earlier: the pre-flight checks and the
  self-restoring quarantine identity check put everything back themselves, so claiming
  those entries would strand the journal over an attack the transaction successfully
  refused. Rollback goes by that recorded intent, never by a content hash -- which is what
  lets it tell its own link apart from a byte-identical file another client installed
  concurrently, a case a 50-run six-process soak caught and a regression test now pins.
- The user-scope confirmation token carries an independent nonce; it was previously
  derivable from the install token by string concatenation.
- `rebrand` no longer collapses the kebab and snake forms of a single-word name, which
  would have emitted an invalid underscored plugin id for any hyphenated new name.
- Staging files are removed during rollback without a content check, since they are
  private siblings this transaction created; refusing on a mismatch stranded the journal.

### Documentation

- The threat model no longer claims a hostile caller cannot cause an *unconsented* write.
  Out-of-bounds writes are code-enforced; a consent token is returned to the caller and is
  not a human-presence proof. The host's approval prompt for the destructive tools is now
  named as the control that establishes one, and the `tools-changed` alarm is documented
  as self-clearable.

### Fixed

- Consent capacity now fails closed on the new request instead of evicting a live,
  unredeemed token, which previously let a caller deny an install by requesting previews.
- JSON-RPC batches are accepted, as `2025-03-26` requires of receivers.
- `tools/call` returns `-32602` for an unknown tool or unknown argument instead of
  reporting a protocol error as a tool-execution result.
- A request with a null id is rejected rather than executed.
- Preference values are type-checked, not just key-name checked, so persisted state cannot
  violate the published output schema.
- `save_preferences` no longer claims to be idempotent; it writes a fresh backup per call.
- `rebrand` validates every operator-supplied value, replaces tokens in a single pass so a
  value containing the old name is not rewritten twice, derives the owner handle from
  `--repo`, writes atomically, and no longer rewrites the LICENSE copyright holder.
- The consent-token map grew without bound over a long-lived server process.
- Cursor 3.15.6 local installation now uses a verified directory copy instead of an externally resolved symlink.
- Replaced the ineffective GUI `PATH` relaunch workaround with a project-native MCP bridge after live testing showed Cursor's plugin MCP process cannot resolve the canonical bare `bun` command.
- Documented Cursor 3.15.6's independent Customize workspace selector, repeated source-consent boundary, and full-process restart fallback when a window reload leaves the shared MCP process disconnected.

## [0.5.0] - 2026-08-07

### Added

- Canonical Agent Plugins v1 manifest alongside the Codex adapter manifest.
- Lazy parent-chat setup interview and fail-closed setup gate.
- Cross-client configuration and native adapters for Codex, Cursor, VS Code/Copilot, and Kiro.
- Bun stdio MCP server with safe preview, consent, install, validation, reset, and uninstall tools.
- Durable, private configuration state and transactional managed-file recovery.
- Pinned plugin/MCP schemas, CI, tag parity, flattened release gates, and comprehensive security/runtime tests.
- Explicit user-visible Luna / Max app-task lane with parent-owned review and acceptance.

### Changed

- The orchestrator now inherits the parent chat's selected model and effort.
- Routine, high-complexity, and advisor roles use exact user-selected native IDs.
- Retained native Codex delivery on Terra / High with a fresh Sol / High review.
- Retired the Luna native companion role while preserving exact legacy migration.
