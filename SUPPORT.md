# Support

## Where to go

| You want to | Go here |
|---|---|
| Ask how to install or configure it | [Discussions → Installation help](https://github.com/DivyamTalwar/ORRERY/discussions) |
| Argue with a design decision | [Discussions → Design criticism](https://github.com/DivyamTalwar/ORRERY/discussions) |
| Report behaviour that contradicts the docs | [Open a bug](https://github.com/DivyamTalwar/ORRERY/issues/new?template=bug_report.yml) |
| Propose a capability | [Open a feature request](https://github.com/DivyamTalwar/ORRERY/issues/new?template=feature_request.yml) |
| Report a vulnerability | [Private advisory](https://github.com/DivyamTalwar/ORRERY/security/advisories/new) — never a public issue |

## Before opening a bug: is it a refusal?

Orrery refuses more than most tools, deliberately. Several things that look like
failures are the product working:

| What you see | What it means |
|---|---|
| `tools-changed` | The MCP tool surface no longer matches the content address you approved. This is the rug-pull alarm. Report both digests. Do not re-approve to clear it. |
| A destination was refused as unmanaged | Something Orrery did not write is sitting at a managed path. It will not clobber it. |
| A managed file was refused as drifted | The file changed since Orrery recorded its hash. |
| Consent token expired or replayed | Tokens are single-use and expire in 10 minutes, and do not survive a restart. Re-preview. |
| A lane stopped because a model was unavailable | There is no fallback by design. An unavailable pin stops its lane rather than silently substituting another model. |
| A lane stopped on routing evidence | The observed model or effort did not match the selected lane. That is a substituted worker, and it stops even when the work looks correct. |

If one of these is *wrong* — the guarantee did not hold, or the refusal was
incorrect — that is exactly the bug worth reporting. Paste the exact output.

## Diagnostics to include

```sh
bun run ci        # the full offline gate
bun run doctor    # read-only compatibility report
```

Both are offline: they call no model and write nothing outside a temporary
directory. Redact absolute paths and identifiers before pasting; never paste a
credential or token.

## What is not supported

- Bending the canonical package around a host defect. Where a client is broken, the
  defect is documented and a guarded bridge is offered separately — see
  [docs/cursor-local-install.md](docs/cursor-local-install.md).
- A universal install command. Orrery does not claim one.
- Any guarantee a host cannot enforce. If your client cannot bind reasoning effort,
  Orrery refuses to store one rather than pretending it held.
