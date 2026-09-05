<div align="center">

# ORRERY

### Astra, Sol, Terra and Luna — in exact motion.

**Architect-first orchestration for coding agents.**
Exact model pinning. Consented writes. Fail-closed, always.

[![CI](https://github.com/DivyamTalwar/ORRERY/actions/workflows/ci.yml/badge.svg)](https://github.com/DivyamTalwar/ORRERY/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg?style=flat-square)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-2026--07--28-black?style=flat-square)](https://modelcontextprotocol.io)
[![Runtime](https://img.shields.io/badge/runtime-Bun-black?style=flat-square)](https://bun.sh)
[![Dependencies](https://img.shields.io/badge/runtime%20dependencies-0-black?style=flat-square)](#zero-dependencies)
[![Tests](https://img.shields.io/badge/tests-73%20offline-black?style=flat-square)](#development)
[![Gate](https://img.shields.io/badge/gate-fail--closed-black?style=flat-square)](#what-it-will-not-do)

</div>

---

## Contents

**Start here** — [What this is](#what-this-is) · [The four bodies](#the-four-bodies) · [The problem](#the-problem)

**How it runs** — [How it works](#how-it-works) · [The flow](#the-flow) · [Orchestration semantics](#orchestration-semantics) · [Routing reference](docs/routing.md)

**What it guarantees** — [The one rule](#the-one-rule-everything-rests-on) · [Security model](#security-model) · [Tool-surface consent](#tool-surface-consent) · [Supported clients](#supported-clients) · [What it will not do](#what-it-will-not-do) · [Interrogate it yourself](#interrogate-it-yourself) · [When not to use this](#when-not-to-use-this)

**Using it** — [Quick start](#quick-start) · [MCP tools](#mcp-tools) · [Preview and consent](#preview-consent-reconfigure-and-uninstall) · [Development](#development)

---

## What this is

Orrery keeps **you** the architect.

Your main chat owns the requirements, the architecture, the decomposition, the diff review and the acceptance. It delegates implementation to three roles you pin yourself — a routine implementer, a high-complexity implementer, and a **read-only advisor** that returns exactly `ship`, `fix-first`, or `rethink`. Worker reports are treated as *claims* until you verify them.

The two implementation roles are genuinely different workers, not one worker with two names. That distinction is the entire point of routing, so they are pinned to different models at different reasoning budgets — and the pin is checked against observed runtime routing before the parent accepts a result.

The same rule applies to client adapters: rendered files express requested model, effort, and read-only behavior, but only a live host observation can prove that a client honored them. See the [compatibility evidence matrix](docs/compatibility.md).

An orrery is a clockwork model of the solar system: every body driven in exact, inspectable relation, nothing drifting on its own. That is the contract.

---

## The four bodies

Each body has one job and one pin. Nothing is selected by price, and nothing falls back to something else when it is unavailable — an unavailable body stops its lane.

| Body | Pin | Orbit |
|---|---|---|
| **Astra** | `gpt-6-astra` · `xhigh` | Security and authorization logic, concurrency and ordering, non-trivial algorithms, hard debugging, migrations, wide blast radius. |
| **Terra** | `gpt-5.6-terra` · `high` | Bounded, mechanical, fully specified work, where the specification already resolves the hard parts. |
| **Sol** | `gpt-5.6-sol` · `high` · read-only | The fresh final review. Returns exactly `ship`, `fix-first`, or `rethink`, and never implements its own fixes. |
| **Luna** | `gpt-5.6-luna` · `max` | The explicit opt-in, user-visible Codex app-task lane. Never a fallback, never activated implicitly. |

The parent is the centre they orbit. It inherits *your* model and reasoning effort, and it keeps architecture, decomposition, diff review, rerun verification and acceptance for itself.

**Astra and Terra are the two implementation lanes, and choosing between them is a decision with consequences.** Ties break toward Astra. Over-spending reasoning on a bounded edit costs latency; under-spending it on a migration costs correctness, and only the first is recoverable after the fact.

Routing is enforced at acceptance, not merely requested. If the parent selects Astra and observes Terra, that is a substituted worker and the lane stops — even when the work looks correct — because the selection was made on stated evidence, and quietly serving it from the other lane discards the decision instead of executing it.

![Four bodies orbiting one parent: Astra pinned to gpt-6-astra at xhigh and Terra pinned to gpt-5.6-terra at high are alternatives, one chosen per delegation; Sol at gpt-5.6-sol high runs the read-only review; Luna at gpt-5.6-luna max is the explicit opt-in app-task lane; the parent inherits your model and keeps routing, verification and acceptance](docs/images/constellation.png)

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
 ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
 │   ROUTINE    │ │     HIGH     │ │   ADVISOR    │
 │  terra·high  │ │ astra·xhigh  │ │   sol·high   │
 ├──────────────┤ ├──────────────┤ ├──────────────┤
 │ bounded      │ │ security     │ │ read-only    │
 │ wiring       │ │ concurrency  │ │   ship /     │
 │ full specs   │ │ algorithms   │ │   fix-first /│
 │              │ │ migrations   │ │   rethink    │
 └──────────────┘ └──────────────┘ └──────────────┘
```

The parent never types implementation code when a delegated lane can do it. Workers receive a **complete five-part specification** — objective, file ownership, interfaces, constraints, verification — and return structured evidence. The parent then inspects the working tree, confirms only in-scope files changed, and re-runs the verification commands **itself** before a fresh advisor is asked for a verdict.

A `ship` verdict is not the end of a conversation. It is the end of an audit.

---

## The flow

There is a trap in the question "how do all four models work together", and it is worth naming before the diagram: **they never all run at once.** The four bodies are a roster, not a pipeline.

- **Astra ⊕ Terra** — mutually exclusive. Exactly one implementer per delegation.
- **Native lane ⊕ Luna lane** — mutually exclusive. Luna is opt-in only and is never a fallback.

The most that is ever live in a single run is three bodies, and only when the parent is Sol.

![One delegation end to end: you hand in a goal, the parent inherits your model, the setup gate and preflight can each stop the run, the route picks exactly one of Terra at high or Astra at xhigh, the routing proof stops on a mismatched worker, the parent inspects the diff and re-runs the checks itself, a read-only Sol review returns ship, fix-first or rethink, and fix-first loops back to implementation](docs/images/flow.png)

### The native lane

```
              YOU
               │  goal + constraints
               ▼
   ┌───────────────────────────┐
   │  PARENT CHAT = ARCHITECT  │   inherits YOUR model
   │  (Sol / High recommended, │   ← a recommendation only,
   │   never required)         │     never a gate
   └─────────────┬─────────────┘
                 │
      ┌──────────▼──────────┐
      │  0. SETUP GATE      │  get_setup_status → get_preferences
      │     tools-changed?  │  ── STOP. A security event, not a nuisance.
      └──────────┬──────────┘
                 │
      ┌──────────▼──────────┐
      │  1. PREFLIGHT       │  install-agents.sh --check → must exit 0
      │                     │  all three agent_type names exposed?
      └──────────┬──────────┘
                 │
      ┌──────────▼──────────┐
      │  2. ROUTE           │  the parent decides, on stated evidence
      └─────┬─────────┬─────┘
            │         │
   bounded, │         │  security · concurrency · algorithms
   specified│         │  hard debugging · migrations · wide radius
            ▼         ▼
      ┌─────────┐ ┌──────────┐
      │  TERRA  │ │  ASTRA   │   ← exactly one of these
      │  high   │ │  xhigh   │
      └────┬────┘ └────┬─────┘
           └─────┬─────┘
                 │  five-part specification in, evidence out
      ┌──────────▼──────────┐
      │  3. ROUTING PROOF   │  observed model/effort == the lane selected?
      │                     │  ── mismatch is a substituted worker. STOP.
      └──────────┬──────────┘
                 │
      ┌──────────▼──────────┐
      │  4. PARENT VERIFIES │  inspect the diff · in-scope files only ·
      │     (not the worker)│  RERUN the verification commands itself
      └──────────┬──────────┘
                 │
      ┌──────────▼──────────┐
      │  5. SOL — read-only │  fresh context, never implements its own fixes
      └──────────┬──────────┘
                 │
        ship ────┴──── fix-first ──▶ re-delegate, verify, obtain a NEW review
          │              rethink  ──▶ revise architecture, do not report done
          ▼
       ACCEPT
```

### Sol appears three times

| Where | What it is |
|---|---|
| **The parent** | `gpt-5.6-sol` / High is the *recommended* orchestrator, and purely advisory. The skill must never block because the parent is not Sol, never change it, and never claim it changed it. |
| **Commitment-boundary consult** | Before a consequential architecture decision, migration, public API, or wide refactor — and always before accepting Astra-lane work, since that lane is selected precisely when the blast radius is wide. |
| **Final review** | Always. Returns exactly `ship`, `fix-first`, or `rethink`. |

Sol reviewing Sol-authored work is **context-clean, not model-family-independent.** That distinction is stated rather than glossed, because it is the limit of what this lane can honestly claim.

### The Luna lane

Entered only when the current request explicitly authorizes it — *"Use the Luna task lane for this feature."*

```
PARENT ──list_projects──▶ pick projectId, check isGitRepository
   │
   ├──create_thread──▶  LUNA   gpt-5.6-luna · thinking: max
   │                    a user-visible Codex app task, own worktree
   │                    ⚠ clientThreadId is a SETUP HANDLE, not a task id
   │                       → correlate a real threadId + hostId first
   │
   ├──wait_threads──▶ monitor
   ├──read_thread───▶ handoff
   │
   ├── PARENT inspects the actual branch, diff and checks itself
   │
   ├──send_message_to_thread──▶ corrections go to the SAME task
   │                             then wait, read, and re-review again
   │
   └── PARENT authorizes the PR ──▶ only now may the child push
```

Two things differ sharply from the native lane. **No Sol is spawned** — the parent performs the final review and acceptance itself. And **the child receives a complete packet**, because a new user-visible task inherits none of the parent's context.

Worktree isolation is explicitly not merge safety. Dependent and shared-file stacks stay serial.

### What is live per delegation

| Run | Astra | Terra | Sol | Luna |
|---|:--:|:--:|:--:|:--:|
| Native · routine | | ● | ● review *(+ parent)* | |
| Native · high-complexity | ● | | ● consult + review *(+ parent)* | |
| Luna · explicit opt-in | | | *parent only* | ● |

### Every arrow can stop

No step in either lane degrades to a warning.

| Condition | Result |
|---|---|
| `tools-changed` | Every stateful operation blocked until a human re-approves |
| `install-agents.sh --check` non-zero | That lane stops; no substitution |
| A required `agent_type` is missing | Stop; never fall back to a built-in or similarly named role |
| A pinned model is unavailable | That lane stops |
| Routing unobservable or inconsistent | That lane stops |
| Observed lane ≠ selected lane | Treated as a substituted worker — stops even when the work looks correct |
| Sandbox broadened where hard isolation was required | Review stops; the observed policy is reported, never assumed |
| A required Luna app tool, Luna, or Max is unavailable | Stop without falling back to a native lane |

The parent keeps requirements, architecture, decomposition, diff inspection, rerun verification and acceptance in **every** flow. Those are never delegated.

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
| **Exact plans** | A preview mints a single-use token bound to a digest of the planned content *and* the observed on-disk state. If anything changed since the preview, install refuses. Tokens expire in 10 minutes and do not survive a restart. |
| **Second token for user scope** | A separate `INSTALL USER <nonce>` carrying an independent nonce, so it cannot be derived from the install token. A generic "yes" is never accepted. |
| **No silent clobbering** | An unmanaged file at a destination is refused outright. A managed file must still hash to its recorded value, and is quarantined — not deleted — with a device/inode identity check before replacement. |
| **Crash-safe transactions** | A fsynced write-ahead journal records intent before publishing a link. Rollback is driven by that record, never by comparing content hashes, so an idempotent re-install cannot make it delete a file the transaction never wrote. |
| **Serialized mutations** | An exclusive lock over the plugin data directory. Acquisition is a plain exclusive create, so a live lock is never lifted; the only removal happens while holding a separate reclaim ticket, so at most one process is ever between removing a stale lock and creating its own. |
| **Scoped recovery** | Crash recovery deletes and renames files, so it runs only inside a tool that already declares destructive intent. Every other tool reports `pendingRecovery` instead. |
| **No credentials, ever** | Input is recursively scanned; any key matching `secret`, `token`, `password`, `api key`, `credential`, or `private key` is rejected. |
| **No injection into role files** | Carriage returns, newlines and NUL bytes are rejected in every string input, so no value can smuggle extra TOML keys or YAML frontmatter into a generated agent file. |
| **No unenforceable claims** | A client that cannot bind per-agent reasoning effort is **refused** when asked to store one, rather than persisting a comfortable lie. |

---

## Tool-surface consent

The unsolved attack against MCP servers is the **rug pull**: a server is approved with benign tool descriptions, then mutates them afterwards to smuggle instructions into every agent that trusts it. The published mitigation is to pin tool descriptions at approval time and re-prompt if they ever change.

Orrery implements it.

- `TOOLS_DIGEST` is the SHA-256 of the **complete** tool surface — every name, description, input schema, output schema and behaviour annotation.
- CI asserts it matches a checked-in pin, so no description can change without a deliberate, reviewable commit.
- `tools/schema/tools.policy.json` projects the permission-bearing part into a readable baseline; `bun run tools:review` classifies added arguments, stateful tools, and annotation changes instead of asking reviewers to compare opaque hashes.
- Setup records the digest you approved.
- Any later mismatch reports status **`tools-changed`** and **blocks every stateful operation** until a human re-approves.

Call `get_setup_status` at any time and compare `toolsDigest` against `approvedToolsDigest`. If they differ, something moved.

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

**Read the read-only column carefully — this is the part most tools overstate.**

- `os-sandbox` — a read-only sandbox is *requested*. Only the **observed** sandbox policy proves isolation.
- `tool-allowlist` — the advisor is restricted to read tools. Real enforcement, but not an OS boundary.
- `frontmatter-flag` — a declared flag whose behaviour must be observed.
- `prompt-only` — a behavioural request with no enforcement at all.

`render_client_adapter` reports the mechanism as `readOnlyMechanism` and the exact native role identifiers as `roleIds`.

ChatGPT Work web, Kiro web/mobile, and skills-only surfaces are not native client profiles and cannot be saved through `save_preferences`. Use parent-chat prompt guidance only; role binding is not enforceable there.

---

## What it will not do

A short list, because it matters more than the feature list:

- It will **not** guess a model ID, normalise one, or pick a fallback. If your pinned model is unavailable, that lane stops.
- It will **not** claim a guarantee it cannot observe. If your client silently substitutes a model, Orrery never chose that — and says so plainly rather than pretending the pin held.
- It will **not** treat manifest conformance as evidence of runtime behaviour.
- It will **not** pretend the orchestration prompt layer is enforced. The MCP server enforces the *file-write* contract. It cannot enforce that a model genuinely read a diff.
- It will **not** claim a consent token proves a human saw the preview. The token makes a write *exact* and *stale-proof*, but it is handed back to the caller, so an unsupervised agent can chain preview into install on its own. The install and uninstall tools are annotated `destructiveHint: true` so your host prompts for them, and **that prompt is the human-in-the-loop control**.

![The same install command run twice: one run installs Astra, Sol and Terra and reports INSTALL PASSED with no legacy Luna file remaining; the other stops with ERROR, Astra destination is conflict and will not be replaced, and exits 1 having overwritten nothing and left nothing half-written](docs/images/refusal.png)

---

## Interrogate it yourself

Every claim on this page is checkable, offline, before you trust any of it. Three read-only commands answer the three questions that actually matter, at the three moments they matter.

| Moment | Question | Command |
|---|---|---|
| **Before you pick a client** | Which host can actually honour the contract I need? | `bun run plan` |
| **After you install** | What is really on disk right now, and does it still match? | `bun run doctor` |
| **When the tool surface moves** | What changed, and is any of it permission-bearing? | `bun run tools:review` |

None of them writes anything. None of them calls a model. All three refuse to flatter you:

```sh
# Refuses any client that would silently weaken the effort or isolation you asked for
bun run plan -- --require-effort --minimum-readonly tool-allowlist --scope project

# Parses role ids, requested models and effort, and advisor controls — not just markers
bun run doctor -- --workspace /absolute/project

# Classifies added arguments, new stateful tools and weakened annotations
bun run tools:review
```

What each one will **not** do is the point:

- **`plan`** will not hand you a host that binds fewer guarantees than you asked for. A path-only portability matrix would tell you six clients "work"; the planner tells you which ones would quietly downgrade your advisor isolation and refuses them.
- **`doctor`** will not report a marker-only or weakened managed file as healthy, and will not present a *declaration* as a live-host *proof*. It separates what it observed on disk from what it cannot know about runtime behaviour, and says which is which.
- **`tools:review`** will not ask you to diff opaque hashes. `TOOLS_DIGEST` tells you something moved; this tells you whether what moved can take a new argument, hold state, or has quietly dropped a `readOnlyHint`.

If any of the three disagrees with this README, the README is wrong. Please open an issue.

---

## When not to use this

Delegation is not free, and this repository will not pretend otherwise.

Cognition's argument against multi-agent systems is the sharpest one available, and it is correct: parallel agents **miscommunicate subtasks** and **make conflicting implicit decisions**, because every action carries a decision the other agent cannot see. ([source](https://cognition.com/blog/dont-build-multi-agents))

Orrery does not dispute it. It is shaped around it:

- **One implementer at a time.** Astra and Terra are mutually exclusive per delegation. There is no fan-out of implementers over the same work, so there are no conflicting implicit decisions to reconcile.
- **Decisions are made before the spawn.** Architecture, interfaces and decomposition never leave the parent. A worker receives a settled specification, not an open question.
- **The parent re-runs verification itself.** A worker's report is a claim. If the parent would have to do the work anyway to check it, delegation bought nothing.

Concurrency is permitted only for genuinely independent, non-overlapping file sets; shared-file and dependent work stays serial.

**Do not use this when:**

- The change is a single bounded edit in one file. The preflight, routing proof and review round trip cost more than the edit.
- You want a fire-and-forget agent. The parent must inspect the diff and re-run the checks; that is not optional, and it is most of the value.
- Your host cannot bind per-role models and effort. On prompt-only surfaces Orrery will tell you plainly that the bindings are unenforceable — which is honest, but it means you are buying much less.
- You want the tool to resolve ambiguity for you. It refuses and asks instead. That is the product.

---

## Quick start

**Requirements:** [Bun](https://bun.sh) on your client's PATH, a compatible Agent Plugins v1 client, and an absolute, existing, private `${PLUGIN_DATA}` directory supplied by the host.

Setup is **lazy** — installing the plugin runs no interview, registers no hook, and writes no file. Nothing is written until you have seen an exact preview and repeated an exact token.

### Codex

```sh
codex plugin marketplace add DivyamTalwar/ORRERY --ref main
codex plugin add orrery@orrery
```

Start a new chat, then request orchestration:

```text
Use $orrery:orchestration to build this feature, verify it, and obtain the configured advisor review before reporting done.
```

Update an existing installation with `codex plugin marketplace upgrade orrery`.

### Cursor

Cursor 3.15.6 rejects a symlinked local plugin and cannot resolve the portable bare `bun` command from its plugin MCP process. Both are host defects, so the canonical package is not bent around them. Use the guarded compatibility bridge instead — see **[docs/cursor-local-install.md](docs/cursor-local-install.md)**.

### Other clients

Install `plugins/orrery` as the plugin root through that client's documented Agent Plugins v1 UI or local package mechanism. Orrery does not claim a universal install command.

After any adapter install, update, or uninstall, start a new chat or reload the client so native role discovery observes the new state.

### First-use interview

The interview stays in your main chat and asks one question at a time: client, scope, workspace, and three **exact** native model IDs copied from your client's picker or `/model`.

| Role | Purpose | Current Codex recommendation |
|---|---|---|
| Routine implementer | Bounded, mechanical, fully specified work | `gpt-5.6-terra`, `high` |
| High-complexity implementer | Security, concurrency, algorithms, hard debugging, migrations, wide refactors | `gpt-6-astra`, `xhigh` |
| Advisor | Commitment review and final diff/evidence verdict; requested read-only | `gpt-5.6-sol`, `high` |
| Orchestrator | Parent ownership and verification | `inherit` |

These are editable recommendations, not a universal model catalogue. Orrery never guesses, normalises, silently falls back, or claims a model exists in another client.

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

Configuration is schema-versioned and written atomically. Secret-like fields are rejected recursively; model IDs and effort values cannot contain control characters.

---

## Preview, consent, reconfigure, and uninstall

`render_client_adapter` returns exact destinations, full contents, a SHA-256 plan digest, target-state hashes, host warnings, and a short-lived one-time confirmation token. It computes destinations from an existing workspace and the selected client and scope; the parent never hands the server an arbitrary destination path. User scope requires a second exact token.

Installation rejects traversal, symlink ancestors and targets, unmanaged conflicts, drifted managed files, expired or replayed consent, and target changes since preview. Managed files carry the exact `orrery-managed:v1` marker and are recorded with hashes. Updates create private backups.

Reconfiguration repeats the interview and preview:

```text
Use $orrery:setup to reconfigure my Orrery client, scope, workspace, and exact native role choices.
```

Adapter uninstall previews the current profile's managed files and its confirmation token, then removes only unchanged managed files. It does **not** uninstall the plugin package. `reset_configuration` requires its own exact token, is refused while managed files are installed, and is refused while the tool surface is unapproved so it cannot erase an unreviewed alarm.

---

## Orchestration semantics

The parent owns the specification, architecture, decomposition, actual diff review, rerun verification, correction loops, and acceptance. Routine versus high routing is based on task complexity, never price alone. Worker reports are claims until the parent verifies the working tree and checks. The advisor remains behaviorally read-only unless the client exposes evidence of OS-enforced isolation; Orrery reports the observed guarantee rather than inventing one.

The historical exact Codex native lane remains compatible: separately installed Astra / xhigh and Terra / high implementation lanes and a fresh Sol / high reviewer. It does not use a Luna custom-agent TOML. The Luna lane instead uses app task tools and is outside native subagent V2.

| Mode | Worker | Parent ownership |
|---|---|---|
| Native lane | Saved routine/high role, then saved advisor role | Architecture, diff/check verification, corrections, acceptance |
| Luna task (explicit opt-in) | User-visible `gpt-5.6-luna` / Max task | Monitoring, diff review, corrections, PR authorization, dependent ordering |

Use the Luna task lane only with current-request authorization such as: **“Use the Luna task lane for this feature.”** It requires `list_projects`, `list_threads`, `create_thread`, `wait_threads`, `read_thread`, and `send_message_to_thread`. A pending `clientThreadId` is a setup handle, not a ready task ID. Missing tools, Luna, or Max stop without fallback. The native lane remains the default for the exact retained Codex compatibility workflow and does not use a Luna companion file.

### Requirements common to both modes

- Bun available for portable MCP runtime.
- A compatible plugin client and exact user-selected model access.
- Parent ownership of verification and acceptance.

### Additional native-mode requirements

- Codex native custom-agent support and the separately installed exact roles.
- Observable runtime routing; no unverified model/effort claim.
- `jq` for the retained companion lookup/install script.

### Additional Luna task-mode requirements

- Explicit authorization in the current request.
- Luna / Max availability and all six app task tools.

The native companion installation can be skipped for Luna-only use. Luna tasks do not require native subagents, Terra access, or companion TOML files. Luna-only users do not need to run `scripts/install-agents.sh`.

### Retained Codex companion lane

For exact legacy-compatible native use:

```sh
plugin_dir="$(codex plugin list --json | jq -r '.installed[] | select(.pluginId == "orrery@orrery") | .source.path')"
sh "$plugin_dir/scripts/install-agents.sh"
sh "$plugin_dir/scripts/install-agents.sh" --check
```

Start a fresh task afterward. The installer refuses conflicting or symlinked files and retains the byte-exact v0.2.0 migration. Runtime routing may be inspected with:

```sh
sh "$plugin_dir/scripts/inspect-agent-runtime.sh" <native-subagent-thread-id>
```

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

Running the full gate additionally needs `jq` and Python 3.11 or newer: the packaging
verification script parses the role templates with `tomllib`, which is 3.11+ only. The
plugin itself needs neither at runtime.

```sh
bun install --frozen-lockfile
bun run typecheck     # strict TypeScript, checked index access
bun run test
bun run validate      # manifests, skills, links, pinned schemas, pinned tool surface
bun run tools:review  # explain permission-bearing changes against the reviewed baseline
bun run sbom
bun run ci            # everything, plus the packaged-artifact end-to-end check
```

`bun run ci` builds a flattened archive, extracts it, **starts the extracted MCP server** with an isolated HOME and data directory, drives a full save → preview → install → uninstall cycle against it, and asserts the packaged artifact exposes exactly the pinned tool surface. The thing that ships is the thing that is tested.

Contributor workflow and trust-boundary rules are documented in [CONTRIBUTING.md](CONTRIBUTING.md).

The three read-only diagnostics — `plan`, `doctor` and `tools:review` — are described under [Interrogate it yourself](#interrogate-it-yourself). The planner has its own reference at [docs/capability-planner.md](docs/capability-planner.md).

### Renaming or forking

Several values are *derived* from the product name, including the pinned tool-surface digest and the byte-exact legacy migration fingerprints. A manual find-and-replace will silently break them, so use the guarded tool, which recomputes every derived digest and prints a dry run first:

```sh
bun run rebrand -- --name my-advisor --display "My Advisor" \
  --author-name "Your Name" --repo https://github.com/you/my-advisor
bun run rebrand -- ... --apply
bun run ci
```

Uninstall any managed adapter files with the previous build before renaming: the managed marker changes with the name, so a renamed build will not recognise the old files.

---

## Why "Orrery"

An orrery is a precision clockwork model of the solar system — every body driven in exact, knowable relation, nothing drifting on its own.

Two things make it the right name. The mechanism it models is transparent by construction: every gear is visible, every relation inspectable, nothing hidden inside the case. And the bodies it drives are the ones you are actually orchestrating.

Auditability is not a feature here. It is the whole machine.

---

## Prior art

The shape of this project — a client plugin that ships exact native role files, a fail-closed installer that refuses rather than overwrites, and an orchestration skill that keeps architecture and acceptance in the parent — follows the path cut by [sol-advisor](https://github.com/DannyMac180/sol-advisor) (MIT), which established that discipline for Codex on a single model family.

Orrery keeps that spine and changes three things: destinations are **derived** rather than supplied, so no caller can name a target path; the tool surface is **content-addressed and consented**, so a rug pull becomes a visible `tools-changed` stop; and the two implementation lanes are pinned to **different models at different reasoning budgets**, so routing has a consequence rather than a label.

---

## Security

Found a vulnerability? See **[SECURITY.md](SECURITY.md)** for the threat model, the enforced-versus-unguaranteed split, and private reporting.

## License

MIT © [Divyam Talwar](https://github.com/DivyamTalwar)
