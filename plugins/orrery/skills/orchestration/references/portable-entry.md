# Portable entry and capability matrix

Use saved setup preferences and observable host capabilities. Never translate model
names, enumerate a supposedly universal catalog, guess tools, or infer behavior from
manifest conformance.

## Entry sequence

1. Call `get_setup_status`. Missing, schema-old, corrupt, or tools-changed state routes
   to the parent `setup` interview before orchestration. A `tools-changed` status means
   the approved tool-surface digest no longer matches; stop and report it.
2. Call `get_preferences` and keep the orchestrator on the parent chat's inherited
   model and effort.
3. Determine whether the current surface exposes the exact installed native role
   names and relevant routing/sandbox evidence.
4. If native bindings are unavailable, use prompt-only advisory behavior and state
   precisely which model, effort, cost-tier, or read-only properties are unenforceable.

| Client/surface | Adapter capability | Advisor read-only mechanism | Important limit |
|---|---|---|---|
| Codex CLI | Model + per-agent effort | `os-sandbox` | Only observed sandbox evidence proves isolation |
| Cursor | Model and optional native effort syntax | `frontmatter-flag` | Host may substitute a model; behavior must be observed |
| Claude Code | Model only | `tool-allowlist` (`Read, Grep, Glob`) | Real tool-level enforcement, not an OS boundary; effort is per session |
| VS Code / GitHub Copilot | Model only | `prompt-only` | Effort and parent cost tier are session constraints |
| Kiro IDE/CLI | Model only | `prompt-only` | Effort is session/per-model, not per-agent |
| ChatGPT Work web, Kiro web/mobile, skills-only surfaces | Parent-chat prompt guidance only; no stored native profile | none | No enforceable native role binding claimed |

The exact retained Codex native compatibility lane remains available when its
separately installed roles and routing preflight pass. The Luna / Max app-task lane is
separate, current-request opt-in only, and never a fallback.
