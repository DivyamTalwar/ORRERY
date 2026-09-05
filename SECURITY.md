# Security Policy

Orrery writes files into your editor's agent configuration directory. That makes it
a privileged component, and this document states exactly what it guarantees, what it
does not, and how to verify what you installed.

## Reporting a vulnerability

Report privately through GitHub Security Advisories on
[the repository](https://github.com/DivyamTalwar/ORRERY/security/advisories/new).
Please do not open a public issue for an exploitable finding.

Include the plugin version (`plugin.json`), the host client and version, the tool call or
file state that triggers it, and the observed versus expected behaviour. We aim to
acknowledge within 5 working days and to ship a fix or a documented mitigation within 30
days for anything that permits an unconsented write, a write outside the allowlist, or a
silent capability claim.

## Supported versions

| Version | Supported |
|---|---|
| 0.6.x | Yes |
| < 0.6.0 | No — upgrade. 0.6.0 added tool-surface consent and cross-process locking. |

## Threat model

The primary adversary is **the agent itself**: a model that has been prompt-injected, has
misread its instructions, or is driving a compromised server. Everything below is designed
so that a fully hostile caller still cannot cause an **out-of-bounds** write: it cannot
name a destination, escape the allowlist, clobber a file it does not own, or leave the
managed state inconsistent.

**What a consent token is, and what it is not.** The install token makes a write *exact*
and *reviewable*: it pins the precise bytes and the precise destinations, and it goes
stale the moment anything on disk changes. It is **not** proof that a human saw the
preview. It is returned to the caller in the `render_client_adapter` result, so an agent
acting alone can chain preview into install without a human turn. The human-in-the-loop
control is your **host's tool-call approval** for `install_client_adapter` and
`uninstall_client_adapter`, both of which are annotated `destructiveHint: true` precisely
so hosts prompt for them. If you auto-approve those tools, you have removed that control
and only the out-of-bounds guarantees remain.

### What is enforced in code

| Control | Mechanism |
|---|---|
| The caller can never name a write destination | Destinations are derived from `(client, scope, workspace)` and a fixed filename table. Only `workspace` crosses the tool boundary. |
| Writes stay inside an allowlist | Every destination is re-checked against the workspace root (project scope) or the real home directory (user scope), and refused if any path component is a symlink. |
| Nothing is written without an exact plan | `render_client_adapter` mints a single-use token bound to a digest of both the planned content *and* the observed on-disk target state. If anything changed since preview, install refuses. Tokens expire after 10 minutes and do not survive a server restart. This makes the write exact and stale-proof; it is not a human-presence proof (see above). |
| User-scope writes need a second token | A separate `INSTALL USER <nonce>` carrying an **independent** nonce, so it cannot be derived from the install token. |
| Existing files are never silently clobbered | An unmanaged file at a destination is refused outright. A managed file must still hash to its recorded value, and is quarantined (not deleted) with a device/inode identity check before replacement. |
| Partial failure cannot corrupt state | A fsynced write-ahead journal supports roll-forward and rollback. Rollback refuses rather than overwrites anything unexpected. Recovery re-derives the legal target set from the live profile, so a forged journal cannot redirect it. |
| Concurrent clients cannot interleave | All mutations run under an exclusive lock over `PLUGIN_DATA`. The lock is published by `link(2)` from a fully written staging file, so it is created atomically and is never observable empty. An abandoned lock is reclaimed only after an atomic `rename(2)` claim, so two processes cannot both remove and both re-acquire it. Release only unlinks a record still carrying the caller's owner nonce. Liveness is checked before age, so a running holder is never robbed. If a reclaim does lift a live lock in the microseconds between judging it and renaming it, the record is handed back stamped ambiguous and expires on a grace timer rather than outliving its owner. |
| Crash recovery cannot run behind your back | Recovery deletes and renames files, so it runs only inside a tool that already declares destructive intent (`install_client_adapter`, `uninstall_client_adapter`, `reset_configuration`) while holding the lock. Every other tool reports `pendingRecovery` instead of performing one, so a tool documented as writing nothing to disk never does. |
| Configuration cannot carry credentials | Input is recursively scanned and any key matching `secret`, `token`, `password`, `api key`, `credential`, or `private key` is rejected. |
| Generated role files cannot be injected into | Carriage returns, newlines, and NUL bytes are rejected in every string input, so no value can smuggle extra TOML keys or YAML frontmatter. |
| Unenforceable claims are never persisted | A client that cannot bind per-agent reasoning effort is refused when asked to store one. |
| A changed tool surface voids consent | See below. |

### Tool-surface pinning (rug-pull defence)

The published mitigation for MCP rug-pull and tool-poisoning attacks is to pin tool
descriptions at approval time and re-prompt if they ever change. Orrery implements
this:

- `TOOLS_DIGEST` is the SHA-256 of the canonicalised, complete tool surface — every name,
  description, input schema, output schema, and annotation.
- CI asserts it matches `tools/schema/tools.digest`, so no description can change without
  a deliberate, reviewable commit.
- `tools/schema/tools.policy.json` is the human-readable security projection. Run
  `bun run tools:review` to classify added arguments, new stateful tools, and weakened
  annotations before updating either pin. Annotations are review signals, not proof that
  a host enforces the advertised behaviour.
- `save_preferences` records the digest you approved.
- Any later mismatch reports status `tools-changed` and **blocks every stateful
  operation** until a human re-runs the setup interview.

You can check this yourself at any time by calling `get_setup_status` and comparing
`toolsDigest` with `approvedToolsDigest` and with the pinned value in the repository.

### What is NOT guaranteed

These are limits of the hosts, not of this plugin, and it will not pretend otherwise.

- **Advisor read-only is not uniformly OS-enforced.** Codex requests a read-only sandbox;
  only the *observed* sandbox policy type proves isolation. Claude Code enforces a tool
  allowlist, which is real but is not an OS boundary. Cursor exposes a frontmatter flag.
  VS Code, GitHub Copilot, and Kiro offer no enforcement — the request is behavioural.
- **Model pinning can be overridden by the host.** Cursor documents that it may substitute
  a compatible model when a pin is unavailable or restricted. Orrery never chooses a
  fallback and cannot detect or prevent a host-chosen one.
- **Manifest conformance is packaging conformance,** not evidence of runtime behaviour.
- **Skills are advisory.** The orchestration methodology is prompt-level guidance. The MCP
  server enforces the file-write contract; it does not enforce that a model actually
  reviewed a diff.
- **A consent token does not prove a human approved anything.** It is handed to the caller
  in a prior tool result. An agent acting without supervision can complete the whole
  preview-then-install sequence on its own; your host's approval prompt is the control that
  stops it.
- **The `tools-changed` alarm is self-clearable by the caller.** Re-running the setup
  interview records the new digest, and `save_preferences` needs no token. The alarm makes
  a changed tool surface *visible and blocking*; it does not stop an unsupervised agent
  from acknowledging it.
- **`PLUGIN_DATA` privacy depends on the host.** Orrery validates the directory and
  refuses to run if it is world- or group-readable, but never changes its permissions.

## Verifying a release

Every tagged release ships four artifacts: the tarball, its SHA-256, a CycloneDX SBOM,
and a Sigstore bundle. Releases also carry GitHub build provenance.

```sh
tag=v0.6.0
gh release download "$tag" --repo DivyamTalwar/ORRERY

# 1. Integrity
shasum -a 256 -c orrery-*.tar.gz.sha256

# 2. Build provenance (who built it, from which commit and workflow)
gh attestation verify orrery-*.tar.gz --repo DivyamTalwar/ORRERY

# 3. Signature, bound to the release workflow identity
cosign verify-blob orrery-*.tar.gz \
  --bundle orrery-*.tar.gz.cosign.bundle \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/DivyamTalwar/ORRERY/\.github/workflows/release\.yml@refs/tags/'

# 4. Contents, file by file
#    The SBOM lists every packaged file with SHA-256 and SHA-512.
```

The plugin has **zero runtime dependencies**. If the SBOM lists a runtime dependency, the
artifact is not ours.

## Hardening recommendations

- Give `PLUGIN_DATA` mode `0700`, on a path with no symlinked ancestor, and never point it
  at `/`, your home directory, or the plugin root. The server refuses all of these.
- Prefer **project scope**. User scope writes into your home directory and requires a
  second, independent token.
- Do not auto-approve `install_client_adapter` or `uninstall_client_adapter` in your host.
  They are annotated destructive so that you get asked, and that prompt is the only step
  that establishes a human actually saw the preview.
- Inspect the full preview before repeating an install token. A generic "yes" is never
  accepted, by design.
- Uninstall managed adapters through `uninstall_client_adapter` rather than deleting files,
  so the ownership manifest stays truthful.
- After upgrading, run `get_setup_status`. A `tools-changed` result means the tool surface
  moved; read the diff before re-approving.
