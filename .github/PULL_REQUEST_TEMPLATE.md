## What this changes

<!-- One or two sentences. What is different after this merges? -->

## Why

<!-- The problem. If this is a fix, what was actually wrong. -->

## Evidence

`bun run ci` is offline: it calls no model and writes nothing outside a temporary
directory. Paste the real output, not a claim that you ran it.

```
$ bun run ci
```

- [ ] New behaviour has a test that fails without the change
- [ ] Docs updated if this changes what a command does or promises
- [ ] `tools/schema/*.sha256` and `tools.digest` regenerated if the tool surface moved

## Invariants

- [ ] **Destinations stay derived** — no code path lets a caller name a target path
- [ ] **Fail closed** — no new fallback picks a different model, host, or destination,
      and no refusal was downgraded to a warning
- [ ] **Prove, don't label** — anything reported as verified was read back from observed
      runtime evidence, not inferred from a manifest or a role file
- [ ] **Refuse rather than overwrite** — an unmanaged or drifted destination is still
      refused, and no failure path leaves a partial mutation
- [ ] **One pin, one place** — a role's model, effort and sandbox live in its profile and
      are not duplicated into a script, doc, or prompt
- [ ] **No unenforceable claims** — a guarantee the host cannot honour is refused, not
      stored and not described as enforced
- [ ] **No secrets, no tool attribution**

## Tool-surface consent

If this changes any tool name, description, input schema, output schema, or annotation,
it changes `TOOLS_DIGEST` and every existing user will be shown `tools-changed` until they
re-approve.

- [ ] This PR does not move the tool surface, **or** the digest change is deliberate and
      called out here for review
