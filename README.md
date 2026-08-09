<div align="center">

# ORRERY

### Sol, Terra and Luna — in exact motion.

**Architect-first orchestration for coding agents.**
Exact model pinning. Consented writes. Fail-closed, always.

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![MCP](https://img.shields.io/badge/MCP-2026--07--28-black?style=flat-square)](https://modelcontextprotocol.io)
[![Runtime](https://img.shields.io/badge/runtime-Bun-black?style=flat-square)](https://bun.sh)
[![Dependencies](https://img.shields.io/badge/runtime%20dependencies-0-black?style=flat-square)](#zero-dependencies)

</div>

---

## What this is

Orrery keeps **you** the architect.

Your main chat owns the requirements, the architecture, the decomposition, the diff review and the acceptance. It delegates implementation to three roles you pin yourself — a routine implementer, a high-complexity implementer, and a **read-only advisor** that returns exactly `ship`, `fix-first`, or `rethink`. Worker reports are treated as *claims* until you verify them.

An orrery is a clockwork model of the solar system: every body driven in exact, inspectable relation, nothing drifting on its own. That is the contract.

---

## The problem

Handing a whole feature to one agent and hoping is not engineering. But the fix — a lead agent that decomposes work and delegates to specialists — runs straight into two walls:

1. **Every client defines subagents differently.** One wants `.codex/agents/*.toml`, another `.cursor/agents/*.md`, another `.claude/agents/*.md`. They bind different things: some pin a model *and* reasoning effort *and* a sandbox, some pin only a model.
2. **A plugin that writes into your agent config is privileged.** If a prompt-injected model can talk it into writing an arbitrary file to an arbitrary path, you have handed an attacker your editor.

Orrery solves the first without ever conceding the second.

---

## How it works

```
        YOU
         │
         ▼
  ┌─────────────────────────────────────────────┐
  │  PARENT CHAT  =  ARCHITECT                  │
  │  inherits YOUR model and reasoning effort   │
  │                                             │
  │  owns: requirements · architecture ·        │
  │        decomposition · the actual diff ·    │
  │        re-running checks · acceptance       │
  └──────────────────┬──────────────────────────┘
                     │  delegates, then verifies
     ┌───────────────┼───────────────┐
     ▼               ▼               ▼
 ┌────────┐     ┌────────┐     ┌──────────┐
 │ROUTINE │     │  HIGH  │     │ ADVISOR  │
 │bounded │     │security│     │ read-only│
 │ wiring │     │concurr.│     │  ship /  │
 │ specs  │     │migrat. │     │fix-first/│
 │        │     │refactor│     │ rethink  │
 └────────┘     └────────┘     └──────────┘
```

The parent never types implementation code when a delegated lane can do it. Workers receive a **complete five-part specification** — objective, file ownership, interfaces, constraints, verification — and return structured evidence. The parent then inspects the working tree, confirms only in-scope files changed, and re-runs the verification commands **itself** before a fresh advisor is asked for a verdict.

A `ship` verdict is not the end of a conversation. It is the end of an audit.

---

## The one rule everything rests on

> ### The model can never choose where a file is written.

Destinations are **derived**, never supplied. Only a `workspace` path crosses the tool boundary; the plugin computes the three legal destinations from `(client, scope, workspace)` and a fixed filename table. There is no code path in which a caller names a target.

Everything else is built on top of that.

---

## Security model

| Control | How it is enforced |
|---|---|
| **Derived destinations** | Computed from client + scope + workspace. The write set is exactly three known paths, always. |
| **Allowlisted writes** | Every destination is re-checked against the workspace root (project scope) or the real home directory (user scope), and refused if any path component is a symlink. |
| **Exact consent** | A preview mints a **single-use token** bound to a digest of the planned content *and* the observed on-disk state. If anything changed since the preview, install refuses. Tokens expire in 10 minutes and do not survive a restart. |
| **Second consent for user scope** | A separate `INSTALL USER <nonce>` token bound to the same preview. A generic "yes" is never accepted. |
| **No silent clobbering** | An unmanaged file at a destination is refused outright. A managed file must still hash to its recorded value, and is quarantined — not deleted — with a device/inode identity check before replacement. |
| **Crash-safe transactions** | A fsynced write-ahead journal supports roll-forward and rollback. Rollback **refuses rather than overwrites** anything unexpected. Recovery re-derives the legal target set from the live profile, so a forged journal cannot redirect it. |
| **Serialized mutations** | An exclusive lock over the plugin data directory, published atomically via `link(2)` and reclaimed only through an atomic `rename(2)` claim, so two clients sharing one data directory cannot interleave. |
| **No credentials, ever** | Input is recursively scanned; any key matching `secret`, `token`, `password`, `api key`, `credential`, or `private key` is rejected. |
| **No injection into role files** | Carriage returns, newlines and NUL bytes are rejected in every string input, so no value can smuggle extra TOML keys or YAML frontmatter into a generated agent file. |
| **No unenforceable claims** | A client that cannot bind per-agent reasoning effort is **refused** when asked to store one, rather than persisting a comfortable lie. |

---

## Tool-surface consent

The unsolved attack against MCP servers is the **rug pull**: a server is approved with benign tool descriptions, then mutates them afterwards to smuggle instructions into every agent that trusts it. The published mitigation is to pin tool descriptions at approval time and re-prompt if they ever change.

Orrery implements it.

- `TOOLS_DIGEST` is the SHA-256 of the **complete** tool surface — every name, description, input schema, output schema and behaviour annotation.
- CI asserts it matches a checked-in pin, so no description can change without a deliberate, reviewable commit.
- Setup records the digest you approved.
- Any later mismatch reports status **`tools-changed`** and **blocks every stateful operation** until a human re-approves.

Call `get_setup_status` at any time and compare `toolsDigest` against `approvedToolsDigest`. If they differ, something moved — and nothing will happen until you say so.

---

## Supported clients

Orrery states exactly what each host can and cannot enforce, and refuses to store a setting the host will not honour.

| Client | Project adapter | User adapter | Advisor read-only | Binds effort |
|---|---|---|---|---|
| **Codex** | `.codex/agents/*.toml` | `~/.codex/agents/*.toml` | `os-sandbox` | yes |
| **Cursor** | `.cursor/agents/*.md` | `~/.cursor/agents/*.md` | `frontmatter-flag` | yes |
| **Claude Code** | `.claude/agents/*.md` | `~/.claude/agents/*.md` | `tool-allowlist` | no |
| **VS Code** | `.github/agents/*.agent.md` | `~/.copilot/agents/*.agent.md` | `prompt-only` | no |
| **GitHub Copilot** | `.github/agents/*.agent.md` | `~/.copilot/agents/*.agent.md` | `prompt-only` | no |
| **Kiro** | `.kiro/agents/*.md` | `~/.kiro/agents/*.md` | `prompt-only` | no |

**Read the read-only column carefully — this is the part most tools lie about.**

- `os-sandbox` — a read-only sandbox is *requested*. Only the **observed** sandbox policy proves isolation.
- `tool-allowlist` — the advisor is restricted to read tools. Real enforcement, but not an OS boundary.
- `frontmatter-flag` — a declared flag whose behaviour must be observed.
- `prompt-only` — a behavioural request with no enforcement at all.

Orrery reports the mechanism as `readOnlyMechanism` at preview time and will not describe any of them as stronger than they are.

---

## What it will not do

A short list, because it matters more than the feature list:

- It will **not** guess a model ID, normalise one, or pick a fallback. If your pinned model is unavailable, that lane stops.
- It will **not** claim a guarantee it cannot observe. If your client silently substitutes a model, Orrery never chose that — and says so plainly rather than pretending the pin held.
- It will **not** treat manifest conformance as evidence of runtime behaviour.
- It will **not** pretend the orchestration prompt layer is enforced. The MCP server enforces the *file-write* contract. It cannot enforce that a model genuinely read a diff.

---

## Quick start

**Requirements:** [Bun](https://bun.sh) on your client's PATH, and a compatible Agent Plugins v1 client.

Install the plugin through your client's plugin UI or local package mechanism, then simply ask for orchestration. Setup is **lazy** — nothing runs at install time, no hook is registered, and no file is written until you have seen an exact preview and repeated an exact token.

```text
Use Orrery to build this feature, verify it, and get the advisor verdict before reporting done.
```

On first use, the setup interview runs **in your main chat**, one question at a time:

1. Which client and scope (project or user)
2. The workspace directory that keys this profile
3. The **exact** native model IDs, copied from your client's model picker — never guessed
4. Reasoning effort, where the host actually binds it
5. Confirmation of the advisor's read-only mechanism for your client

Then you get a full preview: every destination, every byte of content, every warning, and a one-time token. Nothing is written until you repeat that token exactly.

---

## MCP tools

Eight tools over newline-delimited JSON-RPC 2.0. Every one declares a JSON Schema `outputSchema` and complete behaviour annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`). Nothing reaches the network, so `openWorldHint` is `false` throughout.

| Tool | Read-only | Destructive |
|---|:---:|:---:|
| `get_setup_status` | ● | |
| `get_preferences` | ● | |
| `validate_configuration` | ● | |
| `save_preferences` | | |
| `render_client_adapter` | | |
| `install_client_adapter` | | ● |
| `uninstall_client_adapter` | | ● |
| `reset_configuration` | | ● |

Protocol revisions `2026-07-28`, `2025-06-18` and `2025-03-26` are negotiated. Under the `2026-07-28` stateless core a request needs no `initialize` handshake — it may carry its own protocol version in `_meta`, and list results carry `ttlMs` and `cacheScope`. An explicitly declared but unsupported revision is **refused**, never silently downgraded.

---

## Zero dependencies

The published plugin has **no runtime dependencies**. The MCP server is a single Bun file with nothing between it and the standard library. Releases ship a CycloneDX SBOM hashing every packaged file — if it lists a runtime dependency, the artifact is not ours.

Every release carries build provenance and a keyless signature verified in-workflow before publishing.

```sh
shasum -a 256 -c orrery-*.tar.gz.sha256
gh attestation verify orrery-*.tar.gz --repo DivyamTalwar/ORRERY
cosign verify-blob orrery-*.tar.gz \
  --bundle orrery-*.tar.gz.cosign.bundle \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/DivyamTalwar/ORRERY/\.github/workflows/release\.yml@refs/tags/'
```

---

## Development

```sh
bun install --frozen-lockfile
bun run typecheck     # strict TypeScript, checked index access
bun run test
bun run validate      # manifests, skills, links, pinned schemas, pinned tool surface
bun run ci            # everything, plus the packaged-artifact end-to-end check
```

`bun run ci` builds a flattened archive, extracts it, **starts the extracted MCP server** with an isolated HOME and data directory, drives a full save → preview → install → uninstall cycle against it, and asserts the packaged artifact exposes exactly the pinned tool surface. The thing that ships is the thing that is tested.

---

## Why "Orrery"

An orrery is a precision clockwork model of the solar system — every body driven in exact, knowable relation, nothing drifting on its own.

Two things make it the right name. The mechanism it models is transparent by construction: every gear is visible, every relation inspectable, nothing hidden inside the case. And the bodies it drives are the ones you are actually orchestrating.

Auditability is not a feature here. It is the whole machine.

---

## License

MIT © [Divyam Talwar](https://github.com/DivyamTalwar)
