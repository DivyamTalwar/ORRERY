---
name: setup
description: "Run Orrery's first-use or reconfiguration interview in the parent chat, validate exact client-native model choices, persist logical preferences, preview native adapter files, and install only after explicit confirmation."
---

# Orrery setup

Run this interview in the parent/main chat. Never delegate it. Orchestration must call
`get_setup_status` before doing anything else and route here when status is `missing`,
`schema-old`, `corrupt`, or `tools-changed`. Plugin installation does not run this
interview and does not install a hook; setup is lazy on the first orchestration
invocation.

## Tool-surface approval

`get_setup_status` returns `toolsDigest`, the content address of the entire exposed MCP
tool surface. Completing this interview records it as `approvedToolsDigest`.

A `tools-changed` status means the tool surface differs from the one the user approved.
Treat it as a security event, not a routine prompt: state plainly that the tool
descriptions or schemas changed since approval, show both digests, and ask the user to
review the change before re-approving. Do not re-approve on the user's behalf, and do not
proceed with orchestration until the status is `ready`.

Ask one focused question at a time:

1. Client: `codex`, `cursor`, `claude-code`, `vscode`, `github-copilot`, or `kiro`.
2. Scope: `project` or `user`. Explain that user scope needs separate consent.
3. Ask for the explicit existing workspace directory used to key this profile and to
   compute allowlisted adapter destinations.
4. Ask the user to open the client's model picker or `/model` and copy the **exact
   native model ID** for routine implementation, high-complexity implementation, and
   advisor. Never enumerate, normalize, guess, or silently substitute model IDs.
5. Where supported, ask for the exact native reasoning setting. Codex and Cursor may
   store per-role effort. Claude Code, VS Code/GitHub Copilot, and Kiro adapters store
   model only; explain the session-level constraint. The server refuses to persist an
   effort value a client cannot bind, so do not offer one for those clients.
6. Confirm the advisor is requested as read-only, and state the exact mechanism the
   chosen client offers, which `render_client_adapter` reports as `readOnlyMechanism`:
   - `os-sandbox` (Codex): a read-only sandbox is requested; only the observed sandbox
     policy type proves isolation.
   - `tool-allowlist` (Claude Code): the advisor is restricted to `Read, Grep, Glob`.
     Real enforcement, but tool-level, not an OS boundary.
   - `frontmatter-flag` (Cursor): a declared flag whose behaviour must be observed.
   - `prompt-only` (VS Code, GitHub Copilot, Kiro): behavioral request only.
7. Confirm fail-closed behavior: no fallback roles or models.
8. Preserve the optional Codex app-task lane separately. Enable Luna / Max only after
   explicit opt-in; it is never a fallback or a routine native role.

Offer these current Codex recommendations as editable defaults, not universal IDs:

- routine: `gpt-5.6-terra`, effort `high`
- high: `gpt-5.6-terra`, effort `high`
- advisor: `gpt-5.6-sol`, effort `high`, requested read-only
- orchestrator: always `inherit`; recommend selecting Sol / High in the main chat

Call `save_preferences` only after showing the complete logical preference object.
Use no secrets. For an unsupported execution surface (ChatGPT Work web, Kiro web/mobile, or a
skills-only client), do not claim or store a native profile: those surfaces are not in
the client enum. Use parent-chat prompt guidance only and say role bindings are not
enforceable there.

For native adapter installation, require an explicit existing workspace directory.
Call `render_client_adapter`, then show every exact destination, full content,
warning, and confirmation token. Do not pass an arbitrary write path: only the
workspace goes to the MCP server, which computes allowlisted destinations. Call
`install_client_adapter` only after the user repeats the exact install token; user
scope additionally requires the exact separate user-scope token. Never treat “yes”
as either token.

After install, tell the user to start a new chat or reload the client. Reconfiguration
repeats the interview and exact preview. Uninstall first previews its managed files
and exact token, then removes only the unchanged managed files after confirmation.
