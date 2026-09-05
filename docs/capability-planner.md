# Capability negotiation planner

Cross-client portability is not just a path-conversion problem. A role that asks for a
per-agent effort and an OS read-only sandbox cannot be represented honestly by every
host. The planner evaluates that contract before any preference is saved or file is
written.

```bash
bun run plan -- --require-effort --minimum-readonly tool-allowlist --scope project
```

Use `--client` more than once to compare a subset. `--minimum-readonly` accepts, from
weakest to strongest, `prompt-only`, `frontmatter-flag`, `tool-allowlist`, and
`os-sandbox`.

The versioned JSON result separates compatible clients from refused clients and gives a
machine-readable loss for every refusal. `bestFit` is only the strongest static match,
with deterministic registry order as a tie-breaker. It is not a model recommendation and
does not claim the live host honored the adapter.

The command is read-only and performs no network access. It is intended for setup UIs,
CI policy checks, and migration planning before an operator commits to a client.
