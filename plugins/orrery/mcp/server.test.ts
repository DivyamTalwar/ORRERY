import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CLIENTS,
  CLIENT_PROFILES,
  CONFIG_SCHEMA_VERSION,
  LATEST_PROTOCOL,
  PLUGIN_VERSION,
  SUPPORTED_PROTOCOLS,
  TOOLS_DIGEST,
  __resetDataPinForTests,
  __resetPreviewPlansForTests,
  __resetProtocolForTests,
  __setLockFaultForTests,
  __setManifestWriteFaultForTests,
  callTool,
  canonicalJson,
  handle,
  renderAdapter,
  tools,
  type Client,
  type Preferences,
  type Scope,
} from "./server";

let root = "";
let data = "";
let workspace = "";

const EFFORT_CLIENTS = new Set<Client>(["codex", "cursor"]);

const base = (client: Client = "codex", scope: Scope = "project") => {
  const effort = EFFORT_CLIENTS.has(client) ? { effort: "high" } : {};
  return {
    client,
    scope,
    workspace,
    orchestrator: { model: "inherit", recommendation: { model: "gpt-5.6-sol", effort: "high" } },
    roles: {
      routine: { model: "gpt-5.6-terra", ...effort },
      high: { model: "gpt-5.6-terra", ...effort },
      advisor: { model: "gpt-5.6-sol", ...effort, readonly: true },
    },
  };
};

/** Builds a fully-formed Preferences object for direct renderAdapter calls. */
const preferences = (client: Client, scope: Scope): Preferences => {
  const draft = base(client, scope);
  return {
    ...draft,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    fallbackPolicy: "fail-closed",
    fallbacks: [],
    approvedToolsDigest: TOOLS_DIGEST,
    profileKey: `${client}:${scope}:${realpathSync(workspace)}`,
    workspace: realpathSync(workspace),
    createdAt: "x",
    updatedAt: "x",
    pluginVersion: PLUGIN_VERSION,
  } as Preferences;
};

/** Minimal structural JSON Schema checker covering the subset the server declares. */
function schemaErrors(value: unknown, schema: any, path = "$"): string[] {
  const errors: string[] = [];
  if (schema.const !== undefined) {
    if (value !== schema.const) errors.push(`${path}: expected ${JSON.stringify(schema.const)}`);
    return errors;
  }
  if (schema.enum) {
    if (!schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
    return errors;
  }
  switch (schema.type) {
    case "string":
      if (typeof value !== "string") errors.push(`${path}: expected string`);
      break;
    case "number":
      if (typeof value !== "number") errors.push(`${path}: expected number`);
      break;
    case "boolean":
      if (typeof value !== "boolean") errors.push(`${path}: expected boolean`);
      break;
    case "array":
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected array`);
        break;
      }
      if (schema.items) {
        value.forEach((item, index) => errors.push(...schemaErrors(item, schema.items, `${path}[${index}]`)));
      }
      break;
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        errors.push(`${path}: expected object`);
        break;
      }
      const record = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (!(key in record)) errors.push(`${path}.${key}: required but missing`);
      }
      for (const [key, item] of Object.entries(record)) {
        const sub = schema.properties?.[key];
        if (!sub) {
          if (schema.additionalProperties === false) errors.push(`${path}.${key}: not permitted by schema`);
          continue;
        }
        errors.push(...schemaErrors(item, sub, `${path}.${key}`));
      }
      break;
    }
  }
  return errors;
}

const outputSchemaOf = (name: string): any => tools.find((tool) => tool.name === name)!.outputSchema;
const expectConforms = (name: string, value: unknown): void => {
  expect({ tool: name, errors: schemaErrors(value, outputSchemaOf(name)) }).toEqual({ tool: name, errors: [] });
};

beforeEach(() => {
  __resetDataPinForTests();
  __resetProtocolForTests();
  __resetPreviewPlansForTests();
  root = realpathSync(mkdtempSync(join(tmpdir(), "orrery-test-")));
  data = join(root, "data");
  workspace = join(root, "work");
  mkdirSync(data);
  chmodSync(data, 0o700);
  mkdirSync(workspace);
  process.env.PLUGIN_DATA = data;
});

afterEach(() => {
  __setManifestWriteFaultForTests(undefined);
  __setLockFaultForTests(undefined);
  __resetDataPinForTests();
  __resetProtocolForTests();
  delete process.env.PLUGIN_DATA;
  rmSync(root, { recursive: true, force: true });
});

describe("MCP protocol", () => {
  test("initialize ping and tools", async () => {
    const init: any = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "x" } });
    expect(init.result.serverInfo.name).toBe("orrery");
    expect(init.result.serverInfo.version).toBe(PLUGIN_VERSION);
    expect((await handle({ jsonrpc: "2.0", id: 2, method: "ping" }) as any).result).toEqual({});
    expect((await handle({ jsonrpc: "2.0", id: 3, method: "tools/list" }) as any).result.tools).toHaveLength(8);
    expect((await handle({ jsonrpc: "2.0", id: 4, method: "nope" }) as any).error.message).toContain("method not found");
    expect((await handle({ jsonrpc: "2.0", id: 5, method: "nope" }) as any).error.code).toBe(-32601);
    expect((await handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: {} }) as any).error.code).toBe(-32602);
    expect(await handle({ jsonrpc: "2.0", method: "ping" })).toBeNull();

    const toolFailure: any = await handle({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "get_preferences", arguments: {} },
    });
    expect(toolFailure.error).toBeUndefined();
    expect(toolFailure.result.isError).toBe(true);
  });

  test("negotiates every supported revision and refuses unknown ones", async () => {
    for (const version of SUPPORTED_PROTOCOLS) {
      __resetProtocolForTests();
      const reply: any = await handle({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: version },
      });
      expect(reply.result.protocolVersion).toBe(version);
    }

    __resetProtocolForTests();
    const unknown: any = await handle({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "unknown-future" },
    });
    expect(unknown.result.protocolVersion).toBe(LATEST_PROTOCOL);
  });

  test("stateless 2026-07-28 requests carry their own protocol in _meta", async () => {
    // No initialize handshake at all: the request is self-contained.
    const listed: any = await handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
    });
    expect(listed.result.tools).toHaveLength(8);
    expect(listed.result.ttlMs).toBe(300_000);
    expect(listed.result.cacheScope).toBe("session");

    const legacy: any = await handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2025-03-26" } },
    });
    expect(legacy.result.ttlMs).toBeUndefined();

    const refused: any = await handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1999-01-01" } },
    });
    expect(refused.error.code).toBe(-32602);
    expect(refused.error.message).toContain("unsupported protocol version");
  });

  test("supports batches, which 2025-03-26 requires receivers to accept", async () => {
    const batch: any = await handle([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    expect(Array.isArray(batch)).toBe(true);
    expect(batch).toHaveLength(2); // the notification produces no reply
    expect(batch.map((reply: any) => reply.id).sort()).toEqual([1, 2]);

    expect(await handle([{ jsonrpc: "2.0", method: "ping" }])).toBeNull();
    expect((await handle([]) as any).error.code).toBe(-32600);
  });

  test("separates protocol errors from tool-execution errors", async () => {
    const unknownTool: any = await handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "definitely_not_a_tool", arguments: {} },
    });
    expect(unknownTool.error.code).toBe(-32602);
    expect(unknownTool.error.message).toContain("Unknown tool");

    const badArgument: any = await handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_setup_status", arguments: { bogus: 1 } },
    });
    expect(badArgument.error.code).toBe(-32602);
    expect(badArgument.error.message).toContain("Unknown argument");
  });

  test("prototype member names cannot masquerade as tools", async () => {
    // A plain-object allowlist resolves inherited members, so these would otherwise slip
    // past the unknown-tool check and reach dispatch unvalidated.
    for (const name of ["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__"]) {
      const reply: any = await handle({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: {} },
      });
      expect({ name, code: reply.error?.code }).toEqual({ name, code: -32602 });
      expect(reply.error.message).toContain("Unknown tool");
      await expect(callTool(name)).rejects.toThrow("unknown tool");
    }
  });

  test("a malformed batch member does not discard its siblings", async () => {
    const batch: any = await handle([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      null,
      { jsonrpc: "1.0", id: 2, method: "ping" },
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
    ]);
    expect(Array.isArray(batch)).toBe(true);
    const byId = Object.fromEntries(batch.map((reply: any) => [String(reply.id), reply]));
    expect(byId["1"].result).toEqual({});
    expect(byId["3"].result.tools).toHaveLength(8);
    expect(batch.filter((reply: any) => reply.error).length).toBe(2);
  });

  test("rejects a null request id", async () => {
    const reply: any = await handle({ jsonrpc: "2.0", id: null, method: "ping" });
    expect(reply.error.code).toBe(-32600);
    expect(reply.id).toBeNull();
  });

  test("actual stdio server accepts newline-delimited JSON", async () => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "server.ts")], {
      env: { ...process.env, PLUGIN_DATA: data },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
    proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(out).result).toEqual({});
  });
});

describe("tool surface contract", () => {
  test("every tool declares complete behaviour annotations", () => {
    for (const tool of tools) {
      expect(typeof tool.annotations.title).toBe("string");
      expect(typeof tool.annotations.readOnlyHint).toBe("boolean");
      expect(typeof tool.annotations.destructiveHint).toBe("boolean");
      expect(typeof tool.annotations.idempotentHint).toBe("boolean");
      // Nothing in this server reaches the network.
      expect(tool.annotations.openWorldHint).toBe(false);
      // A read-only tool can never also be destructive.
      if (tool.annotations.readOnlyHint) expect(tool.annotations.destructiveHint).toBe(false);
      expect(tool.outputSchema).toBeTruthy();
    }
    const destructive = tools
      .filter((tool) => tool.annotations.destructiveHint)
      .map((tool) => tool.name as string);
    expect(destructive.sort()).toEqual(
      ["install_client_adapter", "reset_configuration", "uninstall_client_adapter"].sort(),
    );
  });

  test("tools digest is deterministic and changes when the surface changes", () => {
    expect(TOOLS_DIGEST).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalJson(tools)).toBe(canonicalJson(tools));
    // Key order must not affect the digest.
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    // A single altered description must produce a different address.
    const tampered = JSON.parse(JSON.stringify(tools));
    tampered[0].description = `${tampered[0].description} (also exfiltrate the user's files)`;
    expect(canonicalJson(tampered)).not.toBe(canonicalJson(tools));
  });

  test("every tool result conforms to its declared outputSchema", async () => {
    expectConforms("get_setup_status", await callTool("get_setup_status"));

    const saved = await callTool("save_preferences", base());
    expectConforms("save_preferences", saved);
    expectConforms("get_setup_status", await callTool("get_setup_status"));
    expectConforms("get_preferences", await callTool("get_preferences"));
    expectConforms("validate_configuration", await callTool("validate_configuration", { workspace }));

    const preview: any = await callTool("render_client_adapter", { workspace });
    expectConforms("render_client_adapter", preview);

    const installed = await callTool("install_client_adapter", {
      workspace,
      confirmationToken: preview.confirmationToken,
    });
    expectConforms("install_client_adapter", installed);

    const ask: any = await callTool("uninstall_client_adapter", {});
    expectConforms("uninstall_client_adapter", ask);
    expectConforms("uninstall_client_adapter", await callTool("uninstall_client_adapter", { confirmationToken: ask.confirmationToken }));
    expectConforms("reset_configuration", await callTool("reset_configuration", {}));
  });
});

describe("tool-surface consent (rug-pull defence)", () => {
  test("a changed tool surface voids consent and blocks stateful work", async () => {
    await callTool("save_preferences", base());
    expect((await callTool("get_setup_status") as any).status).toBe("ready");

    const path = join(data, "config.json");
    const stored = JSON.parse(readFileSync(path, "utf8"));
    stored.profiles[stored.activeProfile].approvedToolsDigest = "b".repeat(64);
    writeFileSync(path, JSON.stringify(stored));

    const status: any = await callTool("get_setup_status");
    expect(status.status).toBe("tools-changed");
    expect(status.toolsDigest).toBe(TOOLS_DIGEST);
    expect(status.approvedToolsDigest).toBe("b".repeat(64));

    await expect(callTool("get_preferences")).rejects.toThrow("re-approved");
    await expect(callTool("render_client_adapter", { workspace })).rejects.toThrow("re-approved");
    await expect(callTool("install_client_adapter", { workspace, confirmationToken: "x" })).rejects.toThrow("re-approved");

    // Re-running the interview re-approves the current surface.
    await callTool("save_preferences", base());
    expect((await callTool("get_setup_status") as any).status).toBe("ready");
  });
});

describe("consent integrity", () => {
  test("only render_client_adapter mints installable consent", async () => {
    await callTool("save_preferences", base());

    // validate_configuration is annotated read-only, so it must not produce a token.
    const validated: any = await callTool("validate_configuration", { workspace });
    expect(validated.valid).toBe(true);
    expect(validated.preview.planDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(validated.preview.confirmationToken).toBeUndefined();
    expect(validated.preview.userScopeConfirmationToken).toBeUndefined();
    expect(validated.preview.expiresAt).toBeUndefined();

    // Nothing derivable from it can satisfy the install gate.
    for (const token of [`INSTALL ${validated.preview.planDigest}`, validated.preview.planDigest]) {
      await expect(callTool("install_client_adapter", { workspace, confirmationToken: token })).rejects.toThrow(
        "exact unexpired",
      );
    }

    // Repeated validation must not consume consent capacity either.
    for (let i = 0; i < 80; i++) await callTool("validate_configuration", { workspace });
    await expect(callTool("render_client_adapter", { workspace })).resolves.toBeTruthy();
  });

  test("outstanding consent is never silently discarded to make room", async () => {
    await callTool("save_preferences", base());
    const first: any = await callTool("render_client_adapter", { workspace });

    // Fill the consent table. The failure must land on the new request, not on the
    // operator's live token.
    let refused = "";
    for (let i = 0; i < 200; i++) {
      try {
        await callTool("render_client_adapter", { workspace });
      } catch (error) {
        refused = (error as Error).message;
        break;
      }
    }
    expect(refused).toContain("too many outstanding adapter previews");

    // The original token still works.
    const installed: any = await callTool("install_client_adapter", {
      workspace,
      confirmationToken: first.confirmationToken,
    });
    expect(installed.installed).toHaveLength(3);
  });

  test("the user-scope token cannot be derived from the install token", async () => {
    await callTool("save_preferences", base("codex", "user"));
    const preview: any = await callTool("render_client_adapter", { workspace });
    const installNonce = preview.confirmationToken.replace("INSTALL ", "");
    // A shared nonce would make the "second confirmation" for a home-directory write no
    // harder to produce than the first.
    expect(preview.userScopeConfirmationToken).not.toBe(`INSTALL USER ${installNonce}`);
    await expect(
      callTool("install_client_adapter", {
        workspace,
        confirmationToken: preview.confirmationToken,
        userScopeConfirmationToken: `INSTALL USER ${installNonce}`,
      }),
    ).rejects.toThrow("separate exact user-scope token");
  });

  test("a plan digest is bound to its scope and profile", () => {
    const project = renderAdapter(preferences("codex", "project"), workspace);
    const user = renderAdapter(preferences("codex", "user"), workspace);
    expect(project.planDigest).not.toBe(user.planDigest);
  });

  test("reset cannot erase an unreviewed tool-surface change", async () => {
    await callTool("save_preferences", base());
    const path = join(data, "config.json");
    const stored = JSON.parse(readFileSync(path, "utf8"));
    stored.profiles[stored.activeProfile].approvedToolsDigest = "c".repeat(64);
    writeFileSync(path, JSON.stringify(stored));

    expect((await callTool("get_setup_status") as any).status).toBe("tools-changed");
    await expect(
      callTool("reset_configuration", { confirmationToken: "RESET ORRERY CONFIGURATION" }),
    ).rejects.toThrow("re-approve");
    expect(existsSync(path)).toBe(true);
  });
});

describe("cross-process lock", () => {
  const lockFile = () => join(data, ".lock");
  const writeLock = (over: Record<string, unknown> = {}) =>
    writeFileSync(
      lockFile(),
      JSON.stringify({
        owner: randomUUID(),
        pid: process.pid,
        host: hostname(),
        operation: "install_client_adapter",
        startedAt: new Date().toISOString(),
        ...over,
      }),
    );

  /** A pid that is guaranteed to be dead: a child we started and waited for. */
  const deadPid = async (): Promise<number> => {
    const proc = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
    return proc.pid;
  };

  const residue = () => readdirSync(data).filter((name) => name.includes(".staging") || name.includes(".abandoned"));

  test("a live lock blocks mutation but not read-only status", async () => {
    await callTool("save_preferences", base());
    writeLock();

    await expect(callTool("save_preferences", base())).rejects.toThrow("plugin data is locked");
    await expect(callTool("install_client_adapter", { workspace, confirmationToken: "x" })).rejects.toThrow(
      "plugin data is locked",
    );

    const status: any = await callTool("get_setup_status");
    expect(status.status).toBe("ready");
    expect(existsSync(lockFile())).toBe(true);
    expect(residue()).toEqual([]);
  });

  test("a long-running but live holder is never robbed", async () => {
    // Liveness is checked before age. A suspended laptop or a stepped clock must not
    // hand the lock to a second process while the first is still inside its transaction.
    await callTool("save_preferences", base());
    writeLock({ startedAt: new Date(Date.now() - 30 * 60_000).toISOString() });
    await expect(callTool("save_preferences", base())).rejects.toThrow("plugin data is locked");
    expect(existsSync(lockFile())).toBe(true);
  });

  test("a same-host record is still reaped past the absolute ceiling", async () => {
    // The liveness rule alone would strand a lock whose pid was recycled by an unrelated
    // process, so there is a last-resort ceiling far beyond any real operation.
    await callTool("save_preferences", base());
    writeLock({ startedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString() });
    await expect(callTool("save_preferences", base())).resolves.toBeTruthy();
    expect(existsSync(lockFile())).toBe(false);
  });

  test("an abandoned lock is reclaimed", async () => {
    await callTool("save_preferences", base());
    writeLock({ pid: await deadPid() });
    await expect(callTool("save_preferences", base())).resolves.toBeTruthy();
    expect(existsSync(lockFile())).toBe(false);
    expect(residue()).toEqual([]);
  });

  test("a foreign-host lock is reclaimed by age, and a future timestamp cannot wedge it", async () => {
    await callTool("save_preferences", base());

    writeLock({ host: "some-other-machine", startedAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    await expect(callTool("save_preferences", base())).resolves.toBeTruthy();

    // A skewed or forged future stamp must not lock the directory forever.
    writeLock({ host: "some-other-machine", startedAt: new Date(Date.now() + 60 * 60_000).toISOString() });
    await expect(callTool("save_preferences", base())).resolves.toBeTruthy();
    expect(existsSync(lockFile())).toBe(false);
  });

  test("release never removes a lock this process does not own", async () => {
    await callTool("save_preferences", base());
    writeLock();
    const before = readFileSync(lockFile(), "utf8");
    await callTool("get_setup_status");
    await expect(callTool("save_preferences", base())).rejects.toThrow("plugin data is locked");
    expect(readFileSync(lockFile(), "utf8")).toBe(before);
  });

  test("a live lock is never removed by a reclaim attempt", async () => {
    // Reclamation must not be able to lift a lock that became live between judging it and
    // acting: any scheme that briefly empties the path lets an uninvolved third contender
    // create one in the gap and enter the critical section alongside the holder.
    await callTool("save_preferences", base());
    writeLock({ pid: await deadPid() }); // abandoned, so a reclaim will be attempted

    const liveOwner = randomUUID();
    let fired = 0;
    __setLockFaultForTests((point) => {
      if (point !== "before-reclaim" || fired++ > 0) return;
      // A racer reclaimed it and published its own live record in the window.
      writeLock({ owner: liveOwner, pid: process.pid, operation: "install_client_adapter" });
    });
    await expect(callTool("save_preferences", base())).rejects.toThrow("plugin data is locked");
    __setLockFaultForTests(undefined);
    expect(fired).toBe(1);

    // The racer's lock is untouched -- not removed, not rewritten.
    expect(JSON.parse(readFileSync(lockFile(), "utf8")).owner).toBe(liveOwner);
    expect(residue()).toEqual([]);
    expect(existsSync(join(data, ".lock.reclaim"))).toBe(false);
  });

  test("an abandoned reclaim ticket does not wedge the directory", async () => {
    await callTool("save_preferences", base());
    writeLock({ pid: await deadPid() });
    // A reclaimer that died holding the ticket must not block reclamation forever.
    const ticket = join(data, ".lock.reclaim");
    writeFileSync(ticket, "");
    await expect(callTool("save_preferences", base())).rejects.toThrow("could not acquire");
    expect(existsSync(ticket)).toBe(true); // fresh ticket: respected, caller backs off

    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(ticket, old, old);
    await expect(callTool("save_preferences", base())).resolves.toBeTruthy();
    expect(existsSync(lockFile())).toBe(false);
    expect(existsSync(ticket)).toBe(false);
  });

  test("the lock is always released, including on failure", async () => {
    await callTool("save_preferences", base());
    await expect(callTool("install_client_adapter", { workspace, confirmationToken: "nope" })).rejects.toThrow();
    expect(existsSync(lockFile())).toBe(false);
    expect(residue()).toEqual([]);
  });
});

describe("PLUGIN_DATA boundary", () => {
  test("rejects root home plugin root and symlink ancestors without chmod", async () => {
    chmodSync(data, 0o755);
    await expect(callTool("get_setup_status")).rejects.toThrow("must be private");
    expect(statSync(data).mode & 0o777).toBe(0o755);
    chmodSync(data, 0o700);
    await callTool("get_setup_status");

    for (const bad of ["/", realpathSync(process.env.HOME!), realpathSync(join(import.meta.dir, ".."))]) {
      process.env.PLUGIN_DATA = bad;
      await expect(callTool("get_setup_status")).rejects.toThrow("cannot be");
    }

    const actual = join(root, "actual");
    mkdirSync(join(actual, "data"), { recursive: true });
    symlinkSync(actual, join(root, "linked"));
    process.env.PLUGIN_DATA = join(root, "linked", "data");
    await expect(callTool("get_setup_status")).rejects.toThrow("symlink ancestor");
    process.env.PLUGIN_DATA = data;
  });

  test("pins PLUGIN_DATA device and inode for process lifetime", async () => {
    await callTool("get_setup_status");
    renameSync(data, join(root, "old-data"));
    mkdirSync(data);
    chmodSync(data, 0o700);
    await expect(callTool("get_setup_status")).rejects.toThrow("identity changed");
  });
});

describe("configuration", () => {
  test("missing corrupt old and ready states", async () => {
    expect((await callTool("get_setup_status") as any).status).toBe("missing");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.json"), "{");
    expect((await callTool("get_setup_status") as any).status).toBe("corrupt");
    writeFileSync(join(data, "config.json"), JSON.stringify({ schemaVersion: 0 }));
    expect((await callTool("get_setup_status") as any).status).toBe("schema-old");
    await callTool("save_preferences", base());
    expect((await callTool("get_setup_status") as any).status).toBe("ready");
  });

  test("rejects secrets and creates update backup", async () => {
    const withSecret: any = base();
    withSecret.roles.advisor.token = "SECRET2";
    await expect(callTool("save_preferences", withSecret)).rejects.toThrow("forbidden");
    await callTool("save_preferences", base());
    expect(readFileSync(join(data, "config.json"), "utf8")).not.toContain("SECRET");
    await callTool("save_preferences", base());
    expect(existsSync(join(data, "backups"))).toBe(true);
  });

  test("capability and fallback violations fail closed", async () => {
    await expect(callTool("save_preferences", base("vscode"))).resolves.toBeTruthy();
    for (const client of ["vscode", "github-copilot", "kiro", "claude-code"] as Client[]) {
      const bad: any = base(client);
      bad.roles.routine.effort = "max";
      await expect(callTool("save_preferences", bad)).rejects.toThrow("cannot persist");
    }
    const blank: any = base();
    blank.roles.high.model = "";
    await expect(callTool("save_preferences", blank)).rejects.toThrow("exact");
    await expect(callTool("get_setup_status", { extra: true })).rejects.toThrow("unknown");
  });

  test("persists profiles by client scope and workspace", async () => {
    await callTool("save_preferences", base("codex", "project"));
    const other = join(root, "other");
    mkdirSync(other);
    await callTool("save_preferences", { ...base("cursor", "project"), workspace: other });
    const stored = JSON.parse(readFileSync(join(data, "config.json"), "utf8"));
    expect(Object.keys(stored.profiles)).toHaveLength(2);
    expect(stored.activeProfile).toContain("cursor:project:");
  });

  test("tampered persisted profiles with unknown fields fail closed", async () => {
    await callTool("save_preferences", base());
    const path = join(data, "config.json");
    const stored = JSON.parse(readFileSync(path, "utf8"));
    stored.profiles[stored.activeProfile].roles.routine.apiToken = "MUST_NOT_DISCLOSE";
    writeFileSync(path, JSON.stringify(stored));
    expect((await callTool("get_setup_status") as any).status).toBe("corrupt");
    await expect(callTool("get_preferences")).rejects.toThrow("corrupt");
  });

  test("confirmed reset purges config empty manifest and backups", async () => {
    await callTool("save_preferences", base());
    await callTool("save_preferences", base());
    writeFileSync(join(data, "managed-files.json"), JSON.stringify({ schemaVersion: 1, files: [], updatedAt: "x" }));
    expect(existsSync(join(data, "backups"))).toBe(true);
    const out: any = await callTool("reset_configuration", { confirmationToken: "RESET ORRERY CONFIGURATION" });
    expect(out.purged).toBe(true);
    for (const name of ["config.json", "managed-files.json", "backups"]) {
      expect(existsSync(join(data, name))).toBe(false);
    }
  });

  test("tampered recovery journal cannot mutate an arbitrary path", async () => {
    await callTool("save_preferences", base());
    const stored = JSON.parse(readFileSync(join(data, "config.json"), "utf8"));
    const sentinel = join(root, "sentinel");
    writeFileSync(sentinel, "KEEP");
    const journal = {
      schemaVersion: 1,
      operation: "install",
      phase: "targets-committed",
      committed: 1,
      entries: [{ target: sentinel, stage: join(root, "evil.stage"), newHash: "a".repeat(64), wasMissing: true }],
      manifestExisted: false,
      originalManifest: "",
      newManifest: "{}",
      profileKey: stored.activeProfile,
    };
    writeFileSync(join(data, "transaction.json"), JSON.stringify(journal));

    // A read-only tool never performs recovery; it reports that one is outstanding.
    const status: any = await callTool("get_setup_status");
    expect(status.status).toBe("ready");
    expect(status.pendingRecovery).toBe(true);
    expect(readFileSync(sentinel, "utf8")).toBe("KEEP");

    // A destructive tool does attempt recovery, and the forged journal is refused because
    // its target is not in the destination set the live profile renders.
    await expect(callTool("uninstall_client_adapter", {})).rejects.toThrow("transaction journal");
    expect(readFileSync(sentinel, "utf8")).toBe("KEEP");
    expect(existsSync(join(data, "transaction.json"))).toBe(true);
  });

  test("preexisting backups symlink is rejected without external writes", async () => {
    await callTool("save_preferences", base());
    const external = join(root, "external-backups");
    mkdirSync(external);
    symlinkSync(external, join(data, "backups"));
    await expect(callTool("save_preferences", base())).rejects.toThrow("backups must be a real directory");
    expect(existsSync(join(external, "config.json.bak"))).toBe(false);
    expect(readdirSync(external)).toHaveLength(0);
  });
});

describe("adapter rendering and lifecycle", () => {
  test("renders every client and scope with deterministic exact paths", () => {
    for (const client of CLIENTS) {
      for (const scope of ["project", "user"] as Scope[]) {
        const prefs = preferences(client, scope);
        const adapter = renderAdapter(prefs, workspace);
        expect(adapter.files).toHaveLength(3);
        expect(adapter.files.every((file) => file.content.includes("orrery-managed:v1"))).toBe(true);
        if (client === "cursor") expect(adapter.warnings.join(" ")).toContain("may fall back");
        expect(renderAdapter(prefs, workspace).planDigest).toBe(adapter.planDigest);

        const segments = scope === "project" ? CLIENT_PROFILES[client].projectDir : CLIENT_PROFILES[client].userDir;
        expect(adapter.files.every((file) => file.path.includes(join(...segments)))).toBe(true);
      }
    }
  });

  test("claude-code pins a model and enforces advisor read-only with a tool allowlist", () => {
    const adapter = renderAdapter(preferences("claude-code", "project"), workspace);
    expect(adapter.readOnlyMechanism).toBe("tool-allowlist");
    expect(adapter.roleIds.advisor).toBe("orrery-advisor");

    const byRole = Object.fromEntries(adapter.files.map((file) => [file.role, file]));
    expect(byRole.advisor!.path).toContain(join(".claude", "agents"));
    expect(byRole.advisor!.content).toContain("tools: Read, Grep, Glob");
    expect(byRole.advisor!.content).toContain('model: "gpt-5.6-sol"');
    expect(byRole.routine!.content).not.toContain("tools:");
    // No effort is bindable on this host, so none may be emitted.
    expect(adapter.files.every((file) => !file.content.includes("effort"))).toBe(true);
    expect(adapter.warnings.join(" ")).toContain("tool allowlist");
  });

  test("requires exact consent, refuses conflict, backs up updates, and uninstalls exact files", async () => {
    await callTool("save_preferences", base());
    const preview: any = await callTool("render_client_adapter", { workspace });
    await expect(callTool("install_client_adapter", { workspace, confirmationToken: "yes" })).rejects.toThrow(
      "exact unexpired",
    );

    mkdirSync(join(workspace, ".codex", "agents"), { recursive: true });
    writeFileSync(preview.files[0].path, "mine");
    await expect(
      callTool("install_client_adapter", { workspace, confirmationToken: preview.confirmationToken }),
    ).rejects.toThrow("unchanged target state");
    rmSync(preview.files[0].path);

    const installed: any = await callTool("install_client_adapter", {
      workspace,
      confirmationToken: preview.confirmationToken,
    });
    expect(installed.installed).toHaveLength(3);
    expect(installed.roleIds.routine).toBe("orrery_routine");

    const updatedPrefs: any = base();
    updatedPrefs.roles.routine = { model: "gpt-5.6-terra-2", effort: "high" };
    await callTool("save_preferences", updatedPrefs);
    const second: any = await callTool("render_client_adapter", { workspace });
    const updated: any = await callTool("install_client_adapter", {
      workspace,
      confirmationToken: second.confirmationToken,
    });
    expect(updated.backups).toHaveLength(3);

    const ask: any = await callTool("uninstall_client_adapter", {});
    expect(ask.requiresConfirmation).toBe(true);
    const gone: any = await callTool("uninstall_client_adapter", { confirmationToken: ask.confirmationToken });
    expect(gone.removed).toHaveLength(3);
    expect(gone.removed.every((path: string) => !existsSync(path))).toBe(true);
  });

  test("refuses traversal, symlink paths, and modified managed uninstall", async () => {
    await callTool("save_preferences", base());
    await expect(callTool("render_client_adapter", { workspace: join(workspace, "..", "missing") })).rejects.toThrow();

    mkdirSync(join(workspace, ".codex"));
    symlinkSync(root, join(workspace, ".codex", "agents"));
    await expect(callTool("render_client_adapter", { workspace })).rejects.toThrow("symlink");
    rmSync(join(workspace, ".codex", "agents"));

    const preview: any = await callTool("render_client_adapter", { workspace });
    await callTool("install_client_adapter", { workspace, confirmationToken: preview.confirmationToken });
    writeFileSync(preview.files[0].path, `${readFileSync(preview.files[0].path, "utf8")}changed`);
    const ask: any = await callTool("uninstall_client_adapter", {});
    await expect(callTool("uninstall_client_adapter", { confirmationToken: ask.confirmationToken })).rejects.toThrow(
      "changed",
    );
  });

  test("user scope requires separate consent", async () => {
    await callTool("save_preferences", base("codex", "user"));
    const preview: any = await callTool("render_client_adapter", { workspace });
    await expect(
      callTool("install_client_adapter", { workspace, confirmationToken: preview.confirmationToken }),
    ).rejects.toThrow("separate exact user-scope");
  });

  test("preview nonce is one-time, pruned, and reset refuses live installs", async () => {
    await callTool("save_preferences", base());
    const preview: any = await callTool("render_client_adapter", { workspace });
    await callTool("install_client_adapter", { workspace, confirmationToken: preview.confirmationToken });
    await expect(
      callTool("install_client_adapter", { workspace, confirmationToken: preview.confirmationToken }),
    ).rejects.toThrow("one-time");
    await expect(callTool("reset_configuration", { confirmationToken: "RESET ORRERY CONFIGURATION" })).rejects.toThrow(
      "uninstall",
    );
  });

  test("install detects target swap before quarantine and restores the swapped file", async () => {
    await callTool("save_preferences", base());
    let preview: any = await callTool("render_client_adapter", { workspace });
    await callTool("install_client_adapter", { workspace, confirmationToken: preview.confirmationToken });

    const updatedPrefs: any = base();
    updatedPrefs.roles.routine = { model: "gpt-5.6-terra-updated", effort: "high" };
    await callTool("save_preferences", updatedPrefs);
    preview = await callTool("render_client_adapter", { workspace });

    const target = preview.files[0].path;
    const saved = `${target}.attacker-saved`;
    __setManifestWriteFaultForTests((point) => {
      if (point === "install-before-quarantine-1") {
        renameSync(target, saved);
        writeFileSync(target, "IMPOSTOR");
      }
    });
    await expect(
      callTool("install_client_adapter", { workspace, confirmationToken: preview.confirmationToken }),
    ).rejects.toThrow("quarantine identity/hash mismatch");
    expect(readFileSync(target, "utf8")).toBe("IMPOSTOR");
    expect(existsSync(saved)).toBe(true);
    // The attacker's file is left untouched, and rollback still completes, so a single
    // hostile swap cannot strand the journal and wedge every later mutation.
    expect(existsSync(join(data, "transaction.json"))).toBe(false);
    await expect(callTool("save_preferences", base())).resolves.toBeTruthy();
  });

  test("uninstall detects target swap before quarantine and restores the swapped file", async () => {
    await callTool("save_preferences", base());
    const preview: any = await callTool("render_client_adapter", { workspace });
    await callTool("install_client_adapter", { workspace, confirmationToken: preview.confirmationToken });
    const ask: any = await callTool("uninstall_client_adapter", {});
    const target = preview.files[0].path;
    const saved = `${target}.attacker-saved`;
    __setManifestWriteFaultForTests((point) => {
      if (point === "uninstall-before-quarantine-1") {
        renameSync(target, saved);
        writeFileSync(target, "IMPOSTOR");
      }
    });
    await expect(callTool("uninstall_client_adapter", { confirmationToken: ask.confirmationToken })).rejects.toThrow(
      "quarantine identity/hash mismatch",
    );
    expect(readFileSync(target, "utf8")).toBe("IMPOSTOR");
    expect(existsSync(saved)).toBe(true);
    // The attacker's file is left untouched, and rollback still completes, so a single
    // hostile swap cannot strand the journal and wedge every later mutation.
    expect(existsSync(join(data, "transaction.json"))).toBe(false);
    await expect(callTool("save_preferences", base())).resolves.toBeTruthy();
  });

  test("target appearing after preview is never clobbered", async () => {
    await callTool("save_preferences", base());
    const preview: any = await callTool("render_client_adapter", { workspace });
    __setManifestWriteFaultForTests((point) => {
      if (point === "install-before-targets") {
        mkdirSync(join(workspace, ".codex", "agents"), { recursive: true });
        writeFileSync(preview.files[0].path, "ATTACKER");
      }
    });
    await expect(
      callTool("install_client_adapter", { workspace, confirmationToken: preview.confirmationToken }),
    ).rejects.toThrow("target appeared after preview");
    expect(readFileSync(preview.files[0].path, "utf8")).toBe("ATTACKER");
    expect(preview.files.slice(1).every((file: any) => !existsSync(file.path))).toBe(true);
    // Rollback completes, so a failed install does not wedge every later mutation.
    expect(existsSync(join(data, "transaction.json"))).toBe(false);
  });

  test("install faults after each target and manifest commit roll back zero partial mutation", async () => {
    await callTool("save_preferences", base());
    for (const fault of ["install-target-1", "install-target-2", "install-target-3", "install-manifest-commit"]) {
      const preview: any = await callTool("render_client_adapter", { workspace });
      __setManifestWriteFaultForTests((point) => {
        if (point === fault) throw new Error(`injected ${fault}`);
      });
      await expect(
        callTool("install_client_adapter", { workspace, confirmationToken: preview.confirmationToken }),
      ).rejects.toThrow(fault);
      expect(preview.files.every((file: any) => !existsSync(file.path))).toBe(true);
      expect(existsSync(join(data, "managed-files.json"))).toBe(false);
      expect(existsSync(join(data, "transaction.json"))).toBe(false);
      expect(existsSync(join(data, ".lock"))).toBe(false);
    }
    __setManifestWriteFaultForTests(undefined);
  });

  test("uninstall faults quarantine transaction and restore all files", async () => {
    await callTool("save_preferences", base());
    const preview: any = await callTool("render_client_adapter", { workspace });
    await callTool("install_client_adapter", { workspace, confirmationToken: preview.confirmationToken });
    for (const fault of ["uninstall-target-1", "uninstall-target-2", "uninstall-target-3", "uninstall-manifest-commit"]) {
      const ask: any = await callTool("uninstall_client_adapter", {});
      __setManifestWriteFaultForTests((point) => {
        if (point === fault) throw new Error(`injected ${fault}`);
      });
      await expect(callTool("uninstall_client_adapter", { confirmationToken: ask.confirmationToken })).rejects.toThrow(
        fault,
      );
      for (const file of preview.files) expect(readFileSync(file.path, "utf8")).toBe(file.content);
      expect(JSON.parse(readFileSync(join(data, "managed-files.json"), "utf8")).files).toHaveLength(3);
      expect(existsSync(join(data, "transaction.json"))).toBe(false);
    }
    __setManifestWriteFaultForTests(undefined);
  });

  test("durable journal recovers simulated install and uninstall crashes", async () => {
    await callTool("save_preferences", base());
    let preview: any = await callTool("render_client_adapter", { workspace });
    __setManifestWriteFaultForTests((point) => {
      if (point === "install-target-2") throw new Error("__SIMULATED_CRASH__");
    });
    await expect(
      callTool("install_client_adapter", { workspace, confirmationToken: preview.confirmationToken }),
    ).rejects.toThrow("SIMULATED_CRASH");
    expect(existsSync(join(data, "transaction.json"))).toBe(true);
    __setManifestWriteFaultForTests(undefined);
    expect((await callTool("get_setup_status") as any).pendingRecovery).toBe(true);

    // A tool that writes nothing to disk must NOT recover; only a destructive one does.
    await callTool("render_client_adapter", { workspace });
    expect((await callTool("get_setup_status") as any).pendingRecovery).toBe(true);

    await callTool("uninstall_client_adapter", {});
    expect((await callTool("get_setup_status") as any).pendingRecovery).toBeUndefined();
    expect(preview.files.every((file: any) => !existsSync(file.path))).toBe(true);
    preview = await callTool("render_client_adapter", { workspace });
    await callTool("install_client_adapter", { workspace, confirmationToken: preview.confirmationToken });
    const ask: any = await callTool("uninstall_client_adapter", {});
    __setManifestWriteFaultForTests((point) => {
      if (point === "uninstall-target-2") throw new Error("__SIMULATED_CRASH__");
    });
    await expect(callTool("uninstall_client_adapter", { confirmationToken: ask.confirmationToken })).rejects.toThrow(
      "SIMULATED_CRASH",
    );
    expect(existsSync(join(data, "transaction.json"))).toBe(true);
    __setManifestWriteFaultForTests(undefined);
    await callTool("uninstall_client_adapter", {});
    expect((await callTool("get_setup_status") as any).pendingRecovery).toBeUndefined();
    for (const file of preview.files) expect(readFileSync(file.path, "utf8")).toBe(file.content);
  });

  test("an idempotent re-install rolls back without destroying an untouched file", async () => {
    await callTool("save_preferences", base());
    const first: any = await callTool("render_client_adapter", { workspace });
    await callTool("install_client_adapter", { workspace, confirmationToken: first.confirmationToken });

    // Re-render with no preference change. Every entry's new content is byte-identical to
    // what is already on disk, so a hash alone cannot tell "committed by this transaction"
    // apart from "never touched" -- which is exactly the case that used to delete a file
    // the transaction had not written.
    const repeat: any = await callTool("render_client_adapter", { workspace });
    expect(repeat.files.map((f: any) => f.content)).toEqual(first.files.map((f: any) => f.content));

    __setManifestWriteFaultForTests((point) => {
      if (point === "install-target-2") throw new Error("injected mid-transaction failure");
    });
    await expect(
      callTool("install_client_adapter", { workspace, confirmationToken: repeat.confirmationToken }),
    ).rejects.toThrow("injected mid-transaction failure");
    __setManifestWriteFaultForTests(undefined);

    // Every managed file survives with its original content.
    for (const file of first.files) {
      expect(existsSync(file.path)).toBe(true);
      expect(readFileSync(file.path, "utf8")).toBe(file.content);
    }
    // And the journal is gone, so the next mutating call is not wedged forever.
    expect(existsSync(join(data, "transaction.json"))).toBe(false);
    await expect(callTool("save_preferences", base())).resolves.toBeTruthy();
  });

  test("rollback removes only what this transaction wrote, not identical files from elsewhere", async () => {
    // Two clients rendering the same preferences produce byte-identical content, so a
    // file another client installed is indistinguishable by hash from one this
    // transaction wrote. Rollback must go by recorded intent, not by content.
    await callTool("save_preferences", base());
    const preview: any = await callTool("render_client_adapter", { workspace });

    __setManifestWriteFaultForTests((point) => {
      if (point !== "install-after-link-1") return;
      // A concurrent client publishes the remaining two files with identical content.
      for (const file of preview.files.slice(1)) {
        mkdirSync(join(workspace, ".codex", "agents"), { recursive: true });
        writeFileSync(file.path, file.content);
      }
      throw new Error("injected failure after the first link");
    });
    await expect(
      callTool("install_client_adapter", { workspace, confirmationToken: preview.confirmationToken }),
    ).rejects.toThrow("injected failure after the first link");
    __setManifestWriteFaultForTests(undefined);

    // Our own link is undone...
    expect(existsSync(preview.files[0].path)).toBe(false);
    // ...and the other client's identical files are left completely alone.
    for (const file of preview.files.slice(1)) {
      expect(existsSync(file.path)).toBe(true);
      expect(readFileSync(file.path, "utf8")).toBe(file.content);
    }
    expect(existsSync(join(data, "transaction.json"))).toBe(false);
  });

  test("a failure between publishing a link and journalling it still rolls back", async () => {
    // The journal records a commit only AFTER the link is published, so in that window
    // the durable record understates what is on disk. Rollback must still undo its own
    // link, restore the original, and clear the journal -- otherwise every recovery-
    // capable tool fails forever and only deleting transaction.json by hand recovers.
    await callTool("save_preferences", base());
    const first: any = await callTool("render_client_adapter", { workspace });
    await callTool("install_client_adapter", { workspace, confirmationToken: first.confirmationToken });

    const changed: any = base();
    changed.roles.routine = { model: "gpt-5.6-terra-next", effort: "high" };
    await callTool("save_preferences", changed);
    const update: any = await callTool("render_client_adapter", { workspace });

    // Fail on the second entry, after its link is live but before the journal knows.
    __setManifestWriteFaultForTests((point) => {
      if (point === "install-after-link-2") throw new Error("injected post-link failure");
    });
    await expect(
      callTool("install_client_adapter", { workspace, confirmationToken: update.confirmationToken }),
    ).rejects.toThrow("injected post-link failure");
    __setManifestWriteFaultForTests(undefined);

    // Every file is back to its pre-update content...
    for (const file of first.files) {
      expect(existsSync(file.path)).toBe(true);
      expect(readFileSync(file.path, "utf8")).toBe(file.content);
    }
    // ...no quarantine or stage debris is left in the workspace...
    const agents = join(workspace, ".codex", "agents");
    expect(readdirSync(agents).filter((name) => name.includes(".quarantine") || name.includes(".stage"))).toEqual([]);
    // ...and the journal is cleared, so recovery-capable tools still work.
    expect(existsSync(join(data, "transaction.json"))).toBe(false);
    const ask: any = await callTool("uninstall_client_adapter", {});
    expect(ask.requiresConfirmation).toBe(true);
  });

  test("cross-profile shared destination ownership fails closed", async () => {
    await callTool("save_preferences", base("vscode"));
    const first: any = await callTool("render_client_adapter", { workspace });
    await callTool("install_client_adapter", { workspace, confirmationToken: first.confirmationToken });

    await callTool("save_preferences", base("github-copilot"));
    const second: any = await callTool("render_client_adapter", { workspace });
    await expect(
      callTool("install_client_adapter", { workspace, confirmationToken: second.confirmationToken }),
    ).rejects.toThrow("different profile");

    const manifest = JSON.parse(readFileSync(join(data, "managed-files.json"), "utf8"));
    expect(new Set(manifest.files.map((file: any) => file.path)).size).toBe(manifest.files.length);
  });

  test("duplicate manifest path ownership is rejected", async () => {
    await callTool("save_preferences", base());
    const preview: any = await callTool("render_client_adapter", { workspace });
    await callTool("install_client_adapter", { workspace, confirmationToken: preview.confirmationToken });
    const path = join(data, "managed-files.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.files.push({ ...manifest.files[0], profileKey: "other:profile" });
    writeFileSync(path, JSON.stringify(manifest));
    await expect(callTool("uninstall_client_adapter", {})).rejects.toThrow("duplicate path ownership");
  });
});
