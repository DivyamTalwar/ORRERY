# Installing Orrery in Cursor

Cursor officially supports loading Agent Plugins from `~/.cursor/plugins/local`, but two
host defects in Cursor 3.15.6 break the Agent Plugins v1 MCP runtime contract:

- it rejects a local plugin whose resolved target is outside the local-plugin directory;
- its plugin MCP process cannot resolve the portable bare `bun` command, even when Cursor
  is launched with Bun on `PATH`.

Both are Cursor issues, so the canonical package is **not** bent around them. Orrery ships
a guarded compatibility bridge instead. It leaves `plugins/orrery` untouched, makes a
physical copy, disables only the failing MCP entry *in that copy*, and registers an
equivalent project-scoped MCP server using absolute, locally discovered paths.

> **macOS only.** The installer refuses to run on any other platform rather than guess at
> equivalent paths.

---

## What it actually does

| Step | Effect |
|---|---|
| Copy the package | `plugins/orrery` → `~/.cursor/plugins/local/orrery` (a real directory, never a symlink) |
| Neutralise the failing entry | Sets `mcpServers` to `{}` in **the copy's** `mcp.json` only |
| Register a working server | Adds an `orrery` entry to `<workspace>/.cursor/mcp.json` with the absolute `bun` path, `cwd`, and `PLUGIN_DATA` |
| Isolate plugin data | `PLUGIN_DATA` = `<workspace>/.cursor/orrery-dev-data`, created `0700` |
| Record a receipt | `.orrery-cursor-local.json` inside the copy, carrying a full recursive tree hash |

Project scope is required. The installer **never** edits `~/.cursor/mcp.json`.

### What it refuses

It fails closed rather than repairing an ambiguous state:

- an existing `orrery` entry in the workspace MCP config that it did not write;
- a symlink anywhere in the Cursor root, the local-plugin root, the managed copy, the
  workspace `.cursor` directory, or `PLUGIN_DATA`;
- a `PLUGIN_DATA` directory that is not private (`0700`) or not inside the workspace;
- a managed copy whose tree hash no longer matches its receipt;
- a workspace MCP config that changed between read and write;
- an interrupted uninstall, which must be recovered through the uninstaller first;
- a missing or non-executable `bun`.

---

## Install

```sh
bun install --frozen-lockfile
bun run ci

workspace="$(pwd -P)"          # the project that should receive the MCP overlay
bun run cursor:local -- install --workspace "$workspace"
```

Then, in Cursor:

1. Open that exact folder and run **Developer: Reload Window**.
2. Open **Customize → MCPs**. Use Customize's *own* scope dropdown to select that exact
   workspace — the project shown in Cursor Agents can be different, so do not pick a
   similarly named repository.
3. Open `orrery` and explicitly enable its workspace source. Cursor keeps new or recreated
   project MCP sources disabled until you consent, which is an intentional security
   boundary.
4. Confirm the source reports **Local — Connected** with all eight tools enabled:
   `get_setup_status`, `get_preferences`, `save_preferences`, `render_client_adapter`,
   `install_client_adapter`, `uninstall_client_adapter`, `validate_configuration`,
   `reset_configuration`.

If the source stays **Disconnected**, or Cursor's shared MCP process leaves every server
disconnected, fully quit Cursor — not just the window — reopen the exact workspace, return
to its Customize scope, and enable the source again. A window reload alone does not always
recover that shared process. Preserve the failure logs before restarting.

Do not change the command, paths, permissions, or the canonical plugin manifest to force a
connection. If it will not connect under the documented configuration, that is a host
finding worth recording, not a reason to weaken the package.

---

## First run

Start a new Agent chat and ask:

```text
Run the Orrery setup skill in this parent chat. Use Cursor project scope for this exact
workspace. Ask one question at a time. I will copy exact model IDs from Cursor's model
picker. Show the full adapter preview and stop before installation until I repeat the
exact token.
```

Copy exact model IDs from Cursor's model picker. Where the model supports it, choose an
effort such as `high`; the generated Cursor value uses Cursor's documented
`model-id[effort=high]` syntax.

Before confirming, verify the preview lists only these three destinations:

```text
<workspace>/.cursor/agents/orrery-routine.md
<workspace>/.cursor/agents/orrery-high.md
<workspace>/.cursor/agents/orrery-advisor.md
```

Confirm the preview was non-mutating, then repeat the exact `INSTALL <nonce>` token — never
a generic "yes":

```sh
for name in routine high advisor; do
  test ! -e "$workspace/.cursor/agents/orrery-$name.md"
done
```

After installing, reload Cursor. The roles become invocable as `/orrery-routine`,
`/orrery-high`, and `/orrery-advisor`.

> **Cursor may substitute a model** when a pin is unavailable or restricted. Orrery never
> chooses that fallback and cannot detect or prevent it. Treat any substitution as an
> observed host limitation, not as successful exact-model routing.

---

## Verifying the install

```sh
for name in routine high advisor; do
  test -f "$workspace/.cursor/agents/orrery-$name.md"
done
test "$(find "$workspace/.cursor/agents" -maxdepth 1 -type f | wc -l | tr -d ' ')" = 3
grep -l 'orrery-managed:v1' "$workspace"/.cursor/agents/*.md
```

Then confirm behaviour, not just files:

1. Invoke `/orrery-routine` to create a file with one known line. Confirm its subagent
   details show the configured model, or record any fallback warning.
2. Invoke `/orrery-high` to append a second line while checking a described edge case.
3. Capture `git status --short`, invoke `/orrery-advisor` to review without changing
   anything, then confirm `git status --short` is byte-identical.
4. Ask for full orchestration and confirm setup does not repeat, the parent stays the
   orchestrator, and the configured roles are used.
5. Ask Orrery to call `get_setup_status` and `validate_configuration` for that exact
   workspace. Both should report a ready, valid project profile.

---

## Uninstall

Remove the adapter files through the plugin first, so its ownership manifest stays truthful:

```text
Use the Orrery setup skill to uninstall this active project adapter. Preview the managed
files first and do not remove anything until I repeat the exact uninstall token.
```

Then remove the bridge:

```sh
bun run cursor:local -- uninstall --workspace "$workspace"
```

Uninstall removes only an unchanged managed copy and the exact project MCP entry it
installed. It preserves other servers already present in `.cursor/mcp.json`, and it
**deliberately preserves** `<workspace>/.cursor/orrery-dev-data` so a local test cannot
silently destroy preferences. Delete that directory yourself when you are certain.
