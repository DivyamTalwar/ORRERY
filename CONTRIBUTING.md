# Contributing to Orrery

Orrery's value depends on its guarantees staying literal. A change is ready for review only when its documentation, exposed MCP surface, validation, and tests agree.

## Development gate

Install Bun 1.3.13, then run:

```bash
bun install --frozen-lockfile
bun run ci
```

The full gate validates the packaged archive, strict TypeScript, tests, manifests, SBOM, and release invariants. Runtime compatibility tests also run on Linux and macOS in GitHub Actions. Windows remains renderer-tested but is not yet runtime-tested because POSIX permission-bit guarantees require a native ACL implementation.

## Pull requests

- Keep each pull request focused on one trust boundary or capability.
- Add regression tests for every behavior or security invariant changed.
- Treat tool names, descriptions, schemas, and annotations as a security-sensitive surface: changing them intentionally rotates `TOOLS_DIGEST` and requires users to re-approve configuration.
- Do not weaken preview/consent, path containment, lock, journal, rollback, or secret-rejection behavior to make a client integration easier.
- Update `README.md`, `SECURITY.md`, and `docs/compatibility.md` when a supported-client claim changes.
- Never claim an observed model, effort, sandbox, or verification result without a receipt from the host integration that observed it.

## Reporting security issues

Do not open a public issue. Use the repository's private vulnerability-reporting flow described in [SECURITY.md](SECURITY.md).
