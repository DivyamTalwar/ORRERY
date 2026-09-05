# Contributing to Orrery

Orrery's value depends on its guarantees staying literal. A change is ready for
review only when its documentation, exposed MCP surface, validation, and tests
agree with each other.

The fastest way to have a change rejected is to make a claim the code cannot back.
The second fastest is to add a fallback.

## The invariants

These are not style preferences. A change that weakens one is a different product,
and needs to argue for that rather than slip it in.

**The model can never choose where a file is written.** Destinations are derived
from `(client, scope, workspace)` and a fixed filename table. Only a `workspace`
path crosses the tool boundary. There must be no code path in which a caller names
a target.

**Fail closed.** An unavailable pinned model stops its lane. An unmanaged file at a
destination is refused rather than clobbered. A drifted managed file is refused. An
expired or replayed consent token is refused. Nothing degrades to a warning to keep
a flow moving.

**No unenforceable claims.** If a host cannot bind per-role reasoning effort,
Orrery refuses to store one rather than persisting a comfortable lie. The advisor's
read-only guarantee is reported as `readOnlyMechanism`, and only `os-sandbox` with
an observed `read-only` policy is OS-enforced isolation.

**Prove, don't label.** Manifest conformance is never evidence of runtime
behaviour. Anything reported as verified must have been read back from observed
runtime metadata, not inferred from a role file.

**No partial mutation.** Every failure path leaves the filesystem as it found it.

## Repository map

| Path | What lives there |
|---|---|
| `plugins/orrery/mcp/` | The zero-dependency MCP server. Roles here are generic `routine` / `high` / `advisor`; models are user-supplied. |
| `plugins/orrery/agents/` | The shipped Codex companion TOMLs — Astra, Terra, Sol. |
| `plugins/orrery/skills/` | The orchestration and setup skills, and the role contracts. |
| `plugins/orrery/scripts/` | The fail-closed installer, the verifier, and the runtime inspector. |
| `tools/` | Repository tooling: validate, sbom, rebrand, cursor-local, compatibility doctor. |
| `tools/schema/` | Pinned schemas and content-address digests. |

## Development gate

Install Bun 1.3.13 or newer, then:

```bash
bun install --frozen-lockfile
bun run ci
```

`bun run ci` is offline. It calls no model and writes nothing outside a temporary
directory. It runs, in order:

| Step | What it proves |
|---|---|
| `verify.sh` | The three-role companion set installs, migrates, checks, and refuses correctly, and the shipped docs contain no stale claims. |
| `typecheck` | Strict TypeScript across the server and tooling. |
| `test` | The MCP server, tool registry, cursor-local bridge, and compatibility doctor. |
| `validate` | Manifests, packaged-archive contents, and documentation links. |
| `sbom` | The packaged file set and its dependency count. |
| `release:check` | Release invariants and tag parity. |

Runtime compatibility tests also run on Linux and macOS in GitHub Actions. Windows
remains renderer-tested but is not yet runtime-tested, because POSIX permission-bit
guarantees require a native ACL implementation.

## Changing a shipped role template

This one has a trap in it.

The installer compares a destination against the current template. Anything that
matches neither the current template nor a **known superseded digest** classifies as
`conflict` and is refused. So if you edit the bytes of a file in
`plugins/orrery/agents/`, every existing exact install stops upgrading — the
installer will correctly, and unhelpfully, refuse all of them.

When you change a shipped template:

1. Capture the digest of the version you are replacing, from the tag that shipped it:

   ```bash
   git show v0.6.0:plugins/orrery/agents/orrery-terra-implementer.toml | shasum -a 256
   ```

2. Add it to that role's superseded set in `install-agents.sh`. The set is
   space-separated, and old entries are never removed — a user upgrading from any
   prior exact release must still migrate.

3. Add a `verify.sh` fixture that seeds the superseded tree, upgrades it, and
   asserts the migration happened and `--check` then passes.

Adding a *new* role file needs no digest, because there is no prior version to
migrate from.

## Changing the tool surface

Any change to a tool name, description, input schema, output schema, or annotation
rotates `TOOLS_DIGEST`. Every existing user is then shown `tools-changed`, and every
stateful operation is blocked until a human re-approves.

That is the intended mitigation for MCP rug-pull attacks, so it is working as
designed — but it is a real cost to real users. Regenerate the pins in
`tools/schema/`, and call the change out explicitly in your pull request so the
consequence is reviewed rather than discovered.

## Documentation rules

- `release:check` enforces **link containment**: a relative link may not contain
  `..`, and may not escape the package. Cross-package links use absolute URLs.
- Do not describe a guarantee in a doc that the code does not enforce. If the honest
  sentence is "requested, and must be observed", write that.
- `verify.sh` fails the build on stale claims — sentences that were true before a
  capability landed and are false after. It matches with newlines flattened, so
  hard-wrapped text cannot hide a claim across a line break.

## Pull requests

- Keep each pull request focused on one trust boundary or capability.
- Add a regression test for every behaviour or security invariant changed. The test
  should fail without your change.
- Use conventional commit subjects (`feat:`, `fix:`, `docs:`, `chore:`, `ci:`,
  `refactor:`, `perf:`, `test:`, `build:`). The prefix drives release tooling.
- Write a body a reviewer can act on: the problem, the root cause for a fix, the
  approach and its trade-offs, what you ran to verify it, and the user-facing impact.
- Update `README.md`, `SECURITY.md`, and `docs/compatibility.md` when a
  supported-client claim changes.
- Never claim an observed model, effort, sandbox, or verification result without a
  receipt from the host integration that observed it.

## Reporting security issues

Do not open a public issue. Use the repository's private vulnerability-reporting
flow described in [SECURITY.md](SECURITY.md).
