# Compatibility evidence

Orrery distinguishes three different claims:

1. **Renderer-tested** — fixtures prove that Orrery emits the expected native file format.
2. **Runtime-tested** — the MCP server and tests pass on the operating system in CI.
3. **Live-client-tested** — a named client/version was driven end to end.

Only the first two are continuously enforced today. An adapter file is a request to a host, not proof that the host honored the requested model, effort, or sandbox.

| Client | Renderer fixture | Runtime CI | Live-client evidence | Important limit |
| --- | --- | --- | --- | --- |
| Codex | Yes | Linux, macOS | Not yet automated | Windows permission/ACL enforcement is not implemented; the observed sandbox policy, not the file alone, proves isolation. |
| Claude Code | Yes | Linux, macOS | Not yet automated | Effort is selected per session; the adapter cannot pin it per agent. |
| Cursor | Yes | Linux, macOS | Not yet automated | The local installer has a narrower version/platform boundary in `tools/cursor-local.ts`; host model fallback is not statically observable. |
| VS Code | Yes | Linux, macOS | Not yet automated | Read-only advisor behavior is prompt-only. |
| GitHub Copilot | Yes | Linux, macOS | Not yet automated | Read-only advisor behavior is prompt-only. |
| Kiro | Yes | Linux, macOS | Not yet automated | Effort is a session/model setting, not a per-agent binding. |

The roadmap is to replace “not yet automated” cells with versioned, machine-readable doctor receipts. Until then, the table intentionally avoids implying end-to-end enforcement.

## Compatibility Doctor

Inspect all six project-scope adapter destinations without writing anything:

```bash
bun run doctor -- --workspace /absolute/path/to/project
```

Narrow the report with `--client codex`, `--client claude-code`, or another supported client. The versioned JSON report distinguishes managed, missing, and unsafe files; reports the renderer's effort/read-only capabilities; and lists every claim it cannot observe. It deliberately does **not** call a missing adapter “broken” or a static role file “proof” of live model, effort, sandbox, or advisor behavior.
