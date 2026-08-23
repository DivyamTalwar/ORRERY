#!/usr/bin/env bun
/**
 * Orrery MCP server.
 *
 * A zero-dependency newline-delimited JSON-RPC 2.0 stdio server whose only job is to
 * persist non-secret orchestration preferences and to install exactly three
 * client-native agent role files into an allowlisted destination.
 *
 * Design invariants (each one is enforced below, not merely documented):
 *   1. The caller never names a write destination. Destinations are derived from
 *      (client, scope, workspace) and a fixed filename table.
 *   2. Nothing is written without an exact, unexpired, one-time consent token bound to
 *      a plan digest that covers both the planned content and the observed target state.
 *   3. Every mutation runs inside a cross-process lock and a fsynced write-ahead journal
 *      that can roll forward or roll back, and refuses rather than clobbers.
 *   4. The server never claims a capability it cannot observe.
 *   5. The exposed tool surface is content-addressed. If it changes, previously granted
 *      consent is void until the operator re-approves (rug-pull defence).
 */
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson, sha256 as sha } from "./integrity";
import { compileToolPolicy } from "./tool-registry";

// ---------------------------------------------------------------------------
// Identity and protocol constants
// ---------------------------------------------------------------------------

const pluginRoot = resolve(import.meta.dir, "..");

/** Reads the packaged version so it can never drift from the shipped manifest. */
function readPluginVersion(): string {
  const raw: unknown = JSON.parse(readFileSync(join(pluginRoot, "plugin.json"), "utf8"));
  const version = (raw as { version?: unknown } | null)?.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("plugin.json must declare a semver version");
  }
  return version;
}

export const PLUGIN_VERSION = readPluginVersion();
export const SERVER_NAME = "orrery";
export const MANAGED_MARKER = "orrery-managed:v1";

/**
 * Config schema 2 adds `approvedToolsDigest`. Older configuration is reported as
 * `schema-old` and must be re-approved through the setup interview rather than
 * silently upgraded, because the tool-surface consent did not exist before.
 */
export const CONFIG_SCHEMA_VERSION = 2;

/** Newest MCP revision this server implements. */
export const LATEST_PROTOCOL = "2026-07-28";

/** Revisions this server will negotiate. Anything else is refused, never guessed. */
export const SUPPORTED_PROTOCOLS = ["2026-07-28", "2025-06-18", "2025-03-26"] as const;
export type ProtocolVersion = (typeof SUPPORTED_PROTOCOLS)[number];

/** Per-request protocol carrier introduced by the stateless 2026-07-28 core. */
const META_PROTOCOL_KEY = "io.modelcontextprotocol/protocolVersion";

/** How long a rendered plan stays installable. */
const PREVIEW_TTL_MS = 10 * 60_000;
/** Bound on retained consent tokens so a long-lived server cannot grow without limit. */
const PREVIEW_MAX_ENTRIES = 64;
/** A held lock older than this is treated as abandoned. */
const LOCK_STALE_MS = 5 * 60_000;
/** A reclaim ticket is held for microseconds; anything older is an abandoned reclaimer. */
const RECLAIM_STALE_MS = 30_000;
/** Last-resort reaper for a same-host record whose pid was recycled by another process. */
const LOCK_ABANDONED_CEILING_MS = 60 * 60_000;
/** Largest accepted JSON-RPC line. */
const MAX_LINE_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// Client capability registry
//
// This table is the single source of truth for what each host can actually bind.
// Orrery refuses to persist a setting a client cannot enforce, so the registry
// is a security control, not documentation.
// ---------------------------------------------------------------------------

export const CLIENTS = [
  "codex",
  "cursor",
  "claude-code",
  "vscode",
  "github-copilot",
  "kiro",
] as const;
export type Client = (typeof CLIENTS)[number];
export type Scope = "project" | "user";
export type RoleName = "routine" | "high" | "advisor";

type ReadOnlyMechanism = "os-sandbox" | "tool-allowlist" | "frontmatter-flag" | "prompt-only";

type ClientProfile = {
  /** Project-scope destination, relative to the workspace root. */
  projectDir: readonly string[];
  /** User-scope destination, relative to the real home directory. */
  userDir: readonly string[];
  extension: string;
  format: "toml" | "markdown";
  /** True only when the host binds reasoning effort per agent file. */
  bindsEffort: boolean;
  /** The strongest read-only guarantee the host actually offers for the advisor. */
  readOnly: ReadOnlyMechanism;
  /** Native role identifier style. */
  roleId: (role: RoleName) => string;
  /** Honest, host-specific limits surfaced at preview time. */
  warnings: readonly string[];
};

const hyphenRole = (role: RoleName): string => `orrery-${role}`;

export const CLIENT_PROFILES: Record<Client, ClientProfile> = {
  codex: {
    projectDir: [".codex", "agents"],
    userDir: [".codex", "agents"],
    extension: ".toml",
    format: "toml",
    bindsEffort: true,
    readOnly: "os-sandbox",
    roleId: (role) => `orrery_${role}`,
    warnings: [
      "Codex requests a read-only sandbox for the advisor. Only the observed sandbox policy type proves isolation.",
    ],
  },
  cursor: {
    projectDir: [".cursor", "agents"],
    userDir: [".cursor", "agents"],
    extension: ".md",
    format: "markdown",
    bindsEffort: true,
    readOnly: "frontmatter-flag",
    roleId: hyphenRole,
    warnings: [
      "Cursor may fall back when a pinned model is unavailable or restricted. Orrery never chooses that fallback and cannot detect or prevent host fallback.",
    ],
  },
  "claude-code": {
    projectDir: [".claude", "agents"],
    userDir: [".claude", "agents"],
    extension: ".md",
    format: "markdown",
    bindsEffort: false,
    readOnly: "tool-allowlist",
    roleId: hyphenRole,
    warnings: [
      "Claude Code binds a model per agent and enforces the advisor's read-only posture with a tool allowlist. That is tool-level enforcement, not OS-level sandbox isolation.",
      "Claude Code selects reasoning effort per session, so this adapter cannot pin a per-agent effort.",
    ],
  },
  vscode: {
    projectDir: [".github", "agents"],
    userDir: [".copilot", "agents"],
    extension: ".agent.md",
    format: "markdown",
    bindsEffort: false,
    readOnly: "prompt-only",
    roleId: hyphenRole,
    warnings: [
      "This client adapter can pin a model only. Reasoning effort and parent cost tier remain client/session constraints, not per-agent guarantees.",
    ],
  },
  "github-copilot": {
    projectDir: [".github", "agents"],
    userDir: [".copilot", "agents"],
    extension: ".agent.md",
    format: "markdown",
    bindsEffort: false,
    readOnly: "prompt-only",
    roleId: hyphenRole,
    warnings: [
      "This client adapter can pin a model only. Reasoning effort and parent cost tier remain client/session constraints, not per-agent guarantees.",
    ],
  },
  kiro: {
    projectDir: [".kiro", "agents"],
    userDir: [".kiro", "agents"],
    extension: ".md",
    format: "markdown",
    bindsEffort: false,
    readOnly: "prompt-only",
    roleId: hyphenRole,
    warnings: ["Kiro effort is session/per-model, not a per-agent binding."],
  },
};

/** Clients that cannot bind reasoning effort per agent, so must not persist the claim. */
const EFFORT_UNSUPPORTED_CLIENTS: readonly Client[] = CLIENTS.filter(
  (client) => !CLIENT_PROFILES[client].bindsEffort,
);

// ---------------------------------------------------------------------------
// Preference types
// ---------------------------------------------------------------------------

export type RolePreference = { model: string; effort?: string; readonly?: boolean };

export type Preferences = {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  client: Client;
  scope: Scope;
  orchestrator: { model: "inherit"; recommendation?: { model: string; effort?: string } };
  roles: { routine: RolePreference; high: RolePreference; advisor: RolePreference };
  fallbackPolicy: "fail-closed";
  fallbacks: string[];
  appTaskLane?: { enabled: boolean; model: "gpt-5.6-luna"; effort: "max" };
  /** Tool-surface digest the operator approved during setup. */
  approvedToolsDigest: string;
  profileKey: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  pluginVersion: string;
};

export type SetupStatus = "missing" | "ready" | "schema-old" | "corrupt" | "tools-changed";

export type ConfigState = {
  status: SetupStatus;
  preferences?: Preferences;
  detail?: string;
  toolsDigest: string;
  approvedToolsDigest?: string;
  pendingRecovery?: boolean;
};

type ManagedFile = { profileKey: string; path: string; hash: string; backup?: string };
type Manifest = { schemaVersion: 1; files: ManagedFile[]; updatedAt: string };

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

export { canonicalJson } from "./integrity";

function syncFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncDir(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(temp, 0o600);
    syncFile(temp);
    renameSync(temp, path);
    syncDir(dirname(path));
  } catch (error) {
    if (existsSync(temp)) rmSync(temp, { force: true });
    throw error;
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function currentHash(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) return undefined;
  return sha(readFileSync(path));
}

// ---------------------------------------------------------------------------
// PLUGIN_DATA boundary
//
// The host supplies this directory. It is validated on every access and its identity
// is pinned for the process lifetime so it cannot be swapped mid-session.
// ---------------------------------------------------------------------------

let pinnedDataDir: { lexical: string; real: string; dev: number; ino: number } | undefined;

export function __resetDataPinForTests(): void {
  pinnedDataDir = undefined;
}

function dataDir(): string {
  const raw = process.env.PLUGIN_DATA;
  if (!raw || !isAbsolute(raw)) {
    throw new Error("PLUGIN_DATA must be an explicit absolute existing directory");
  }
  const lexical = resolve(raw);
  const forbidden = new Set([resolve(sep), realpathSync(homedir()), pluginRoot]);
  if (forbidden.has(lexical)) {
    throw new Error("PLUGIN_DATA cannot be filesystem root, home, or plugin root");
  }

  let cursor = resolve(sep);
  for (const part of relative(resolve(sep), lexical).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`PLUGIN_DATA has symlink ancestor: ${cursor}`);
    }
  }

  if (!existsSync(lexical) || !lstatSync(lexical).isDirectory() || lstatSync(lexical).isSymbolicLink()) {
    throw new Error("PLUGIN_DATA must be an existing non-symlink directory");
  }

  const actual = realpathSync(lexical);
  const info = statSync(actual);
  if ((info.mode & 0o077) !== 0) {
    throw new Error("PLUGIN_DATA must be private (no group/world permission bits)");
  }

  const pinned = pinnedDataDir;
  if (
    pinned &&
    (pinned.lexical !== lexical || pinned.real !== actual || pinned.dev !== info.dev || pinned.ino !== info.ino)
  ) {
    throw new Error("PLUGIN_DATA identity changed during this server process");
  }
  if (!pinned) pinnedDataDir = { lexical, real: actual, dev: info.dev, ino: info.ino };
  return actual;
}

const configPath = (): string => join(dataDir(), "config.json");
const manifestPath = (): string => join(dataDir(), "managed-files.json");
const journalPath = (): string => join(dataDir(), "transaction.json");
const lockPath = (): string => join(dataDir(), ".lock");

function backupDir(): string {
  const root = dataDir();
  const path = join(root, "backups");
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("PLUGIN_DATA backups must be a real directory");
  }
  const actual = realpathSync(path);
  const rel = relative(root, actual);
  if (rel !== "backups" || isAbsolute(rel) || rel.startsWith("..")) {
    throw new Error("PLUGIN_DATA backups escapes the pinned data root");
  }
  if ((statSync(actual).mode & 0o077) !== 0) {
    throw new Error("PLUGIN_DATA backups must be private");
  }
  return actual;
}

// ---------------------------------------------------------------------------
// Cross-process lock
//
// PLUGIN_DATA may be shared by more than one client process. Without this, two
// concurrent installs would interleave through a single transaction journal.
// ---------------------------------------------------------------------------

type LockRecord = { owner: string; pid: number; host: string; operation: string; startedAt: string };

function readLockRecord(path: string): LockRecord | undefined {
  try {
    const raw = readJson(path) as Partial<LockRecord> | null;
    if (!raw || typeof raw.owner !== "string" || typeof raw.pid !== "number") return undefined;
    if (typeof raw.host !== "string" || typeof raw.operation !== "string" || typeof raw.startedAt !== "string") {
      return undefined;
    }
    return { owner: raw.owner, pid: raw.pid, host: raw.host, operation: raw.operation, startedAt: raw.startedAt };
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  // A pid outside the portable range cannot be signalled meaningfully; treating such a
  // value as "alive" would make a forged record permanently unreclaimable.
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by another user, which still counts.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function elapsedSince(timestamp: string): number | undefined {
  const age = Date.now() - Date.parse(timestamp);
  return Number.isFinite(age) ? age : undefined;
}

function lockIsStale(record: LockRecord | undefined): boolean {
  // A lock is hardlinked into place fully written, so it is never observably empty.
  // An unreadable record therefore means genuine corruption and may be reclaimed.
  if (!record) return true;

  const age = elapsedSince(record.startedAt);

  if (record.host === hostname()) {
    // On this machine liveness is checked BEFORE age. A running owner is never stale
    // merely because time passed, so a suspended laptop or a stepped clock cannot hand
    // its lock to a second process.
    if (!processIsAlive(record.pid)) return true;
    // Last-resort reaper for a pid recycled by an unrelated process, far beyond any real
    // operation so it cannot interrupt genuine work.
    return age === undefined || age > LOCK_ABANDONED_CEILING_MS;
  }

  // Another machine: age is the only available signal. A far-future timestamp is clock
  // skew or forgery and must not wedge the directory permanently.
  return age === undefined || age > LOCK_STALE_MS || age < -LOCK_STALE_MS;
}

function describeHolder(record: LockRecord | undefined): string {
  return record ? `${record.operation} (pid ${record.pid} on ${record.host})` : "another operation";
}

/**
 * Test seam for the reclaim window.
 *
 * The gap between judging a lock stale and renaming it away is microseconds wide, so the
 * interleave that matters cannot be produced reliably by running processes concurrently.
 * This hook makes it deterministic.
 */
let lockFaultForTests: ((point: string) => void) | undefined;

export function __setLockFaultForTests(fault: ((point: string) => void) | undefined): void {
  lockFaultForTests = fault;
}

/**
 * Serializes reclamation of an abandoned lock.
 *
 * Acquiring the lock is a plain exclusive create, so a live lock is never lifted off the
 * path. The only removal happens here, and only while holding a separate reclaim ticket,
 * so at most one process is ever between "remove the stale lock" and "create my own".
 *
 * That matters because any scheme that briefly empties the path -- renaming the lock
 * aside to inspect it, for instance -- lets an uninvolved third contender create one in
 * the gap and enter the critical section alongside the current holder. Re-reading the
 * record here under the ticket is safe: while a lock file exists nobody can create one,
 * and nobody else may remove one, so what was judged stale cannot have become live.
 */
function reclaimAbandonedLock(path: string, judged: LockRecord | undefined): void {
  const ticket = join(dirname(path), ".lock.reclaim");
  let fd: number | undefined;
  try {
    fd = openSync(ticket, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Another process is reclaiming, or one died holding the ticket.
    try {
      if (Date.now() - statSync(ticket).mtimeMs > RECLAIM_STALE_MS) rmSync(ticket, { force: true });
    } catch {
      // The ticket vanished under us, which is the outcome we wanted anyway.
    }
    return; // Back off; the caller re-contends.
  }

  try {
    if (!existsSync(path)) return; // Already reclaimed by someone else.
    const current = readLockRecord(path);
    if (!lockIsStale(current)) return; // Became live; leave it strictly alone.
    if (judged !== undefined && current !== undefined && current.owner !== judged.owner) {
      return; // A different record than the one judged; re-judge on the next pass.
    }
    rmSync(path, { force: true });
    syncDir(dirname(path));
  } finally {
    closeSync(fd);
    rmSync(ticket, { force: true });
  }
}

/**
 * Runs `body` while holding an exclusive advisory lock over PLUGIN_DATA.
 *
 * Acquisition is `link(2)` from a fully written staging file: atomic, and the published
 * lock is never observable in a half-written state. Nothing in this function removes a
 * lock it does not own -- reclamation of an abandoned one is delegated to
 * `reclaimAbandonedLock`, and release only unlinks a record still carrying this call's
 * owner nonce.
 *
 * `optional: true` skips the body instead of throwing when another process holds it.
 */
function withLock<T>(operation: string, body: () => T, optional = false): T | undefined {
  const path = lockPath();
  const owner = randomUUID();
  const staging = join(dirname(path), `.lock.${process.pid}.${owner}.staging`);
  const record: LockRecord = {
    owner,
    pid: process.pid,
    host: hostname(),
    operation,
    startedAt: new Date().toISOString(),
  };

  let held = false;
  try {
    writeFileSync(staging, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    syncFile(staging);

    for (let attempt = 0; attempt < 8 && !held; attempt++) {
      try {
        linkSync(staging, path);
        held = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      const holder = readLockRecord(path);
      if (!lockIsStale(holder)) {
        if (optional) return undefined;
        throw new Error(`plugin data is locked by ${describeHolder(holder)}; retry once it finishes`);
      }
      lockFaultForTests?.("before-reclaim");
      reclaimAbandonedLock(path, holder);
    }

    if (!held) {
      if (optional) return undefined;
      throw new Error("could not acquire the plugin data lock; retry shortly");
    }
    syncDir(dirname(path));
    return body();
  } finally {
    rmSync(staging, { force: true });
    if (held && readLockRecord(path)?.owner === owner) {
      rmSync(path, { force: true });
      try {
        syncDir(dirname(path));
      } catch {
        // The data directory disappearing during teardown is not a lock failure.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Preference validation
// ---------------------------------------------------------------------------

function exactString(value: unknown, field: string, errors: string[]): void {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || /[\r\n\0]/.test(value)) {
    errors.push(`${field} must be an exact, non-empty client-native identifier`);
  }
}

function rejectUnknownKeys(value: unknown, allowed: string[], label: string, errors: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (!allowed.includes(key)) errors.push(`${label} contains unknown field ${key}`);
  }
}

export function validatePreferences(value: unknown): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["preferences must be an object"];
  const prefs = value as Record<string, any>;

  rejectUnknownKeys(
    prefs,
    [
      "schemaVersion",
      "client",
      "scope",
      "orchestrator",
      "roles",
      "fallbackPolicy",
      "fallbacks",
      "appTaskLane",
      "approvedToolsDigest",
      "profileKey",
      "workspace",
      "createdAt",
      "updatedAt",
      "pluginVersion",
    ],
    "preferences",
    errors,
  );
  rejectUnknownKeys(prefs.orchestrator, ["model", "recommendation"], "orchestrator", errors);
  rejectUnknownKeys(prefs.orchestrator?.recommendation, ["model", "effort"], "orchestrator recommendation", errors);
  rejectUnknownKeys(prefs.roles, ["routine", "high", "advisor"], "roles", errors);
  for (const role of ["routine", "high", "advisor"] as RoleName[]) {
    rejectUnknownKeys(prefs.roles?.[role], ["model", "effort", "readonly"], `role ${role}`, errors);
  }
  rejectUnknownKeys(prefs.appTaskLane, ["enabled", "model", "effort"], "appTaskLane", errors);

  if (prefs.schemaVersion !== CONFIG_SCHEMA_VERSION) errors.push(`schemaVersion must be ${CONFIG_SCHEMA_VERSION}`);
  if (!CLIENTS.includes(prefs.client)) errors.push("client is unsupported");
  if (prefs.scope !== "project" && prefs.scope !== "user") errors.push("scope must be project or user");
  if (prefs.orchestrator?.model !== "inherit") errors.push("orchestrator must inherit the parent model and effort");
  if (prefs.fallbackPolicy !== "fail-closed" || !Array.isArray(prefs.fallbacks) || prefs.fallbacks.length !== 0) {
    errors.push("fallbacks must be empty with fail-closed policy");
  }

  for (const role of ["routine", "high", "advisor"] as RoleName[]) {
    const preference = prefs.roles?.[role];
    if (!preference || typeof preference !== "object") {
      errors.push(`roles.${role} is required`);
      continue;
    }
    exactString(preference.model, `roles.${role}.model`, errors);
    if (preference.effort !== undefined) exactString(preference.effort, `roles.${role}.effort`, errors);
    // Types are enforced here, not just key names, so persisted state can never violate
    // the output schema this server publishes for `get_preferences`.
    if (preference.readonly !== undefined && typeof preference.readonly !== "boolean") {
      errors.push(`roles.${role}.readonly must be a boolean`);
    }
  }
  if (prefs.roles?.advisor?.readonly !== true) errors.push("advisor readonly preference must be true");

  const recommendation = prefs.orchestrator?.recommendation;
  if (recommendation !== undefined) {
    if (!recommendation || typeof recommendation !== "object" || Array.isArray(recommendation)) {
      errors.push("orchestrator recommendation must be an object");
    } else {
      exactString(recommendation.model, "orchestrator.recommendation.model", errors);
      if (recommendation.effort !== undefined) {
        exactString(recommendation.effort, "orchestrator.recommendation.effort", errors);
      }
    }
  }

  if (typeof prefs.approvedToolsDigest !== "string" || !/^[a-f0-9]{64}$/.test(prefs.approvedToolsDigest)) {
    errors.push("approvedToolsDigest must be the sha256 of the approved tool surface");
  }
  if (typeof prefs.profileKey !== "string" || !prefs.profileKey || typeof prefs.workspace !== "string" || !isAbsolute(prefs.workspace)) {
    errors.push("profileKey and absolute workspace are required");
  }

  if (EFFORT_UNSUPPORTED_CLIENTS.includes(prefs.client)) {
    for (const role of ["routine", "high", "advisor"] as RoleName[]) {
      if (prefs.roles?.[role]?.effort !== undefined) {
        errors.push(`${prefs.client} cannot persist a per-agent effort claim for ${role}`);
      }
    }
  }

  if (
    prefs.appTaskLane !== undefined &&
    (prefs.appTaskLane.enabled !== true || prefs.appTaskLane.model !== "gpt-5.6-luna" || prefs.appTaskLane.effort !== "max")
  ) {
    errors.push("appTaskLane is an explicit opt-in gpt-5.6-luna/max lane only");
  }

  return errors;
}

function configState(): ConfigState {
  const toolsDigest = TOOLS_DIGEST;
  // Recovery is a mutation, so it only ever runs under a mutating tool holding the lock.
  // Read-only callers are told a rollback is outstanding rather than silently performing
  // one, which keeps `readOnlyHint` truthful.
  const pending = existsSync(journalPath()) ? { pendingRecovery: true as const } : {};
  if (!existsSync(configPath())) return { status: "missing", toolsDigest, ...pending };
  try {
    const raw = readJson(configPath()) as Record<string, any> | null;
    if (!raw || typeof raw !== "object" || raw.schemaVersion !== CONFIG_SCHEMA_VERSION) {
      return {
        status: "schema-old",
        detail: "Setup schema is absent or unsupported; rerun setup.",
        toolsDigest,
        ...pending,
      };
    }
    if (typeof raw.activeProfile !== "string" || !raw.profiles || typeof raw.profiles !== "object" || !raw.profiles[raw.activeProfile]) {
      return { status: "corrupt", detail: "active profile is missing", toolsDigest, ...pending };
    }
    const active = raw.profiles[raw.activeProfile] as Preferences;
    const errors = validatePreferences(active);
    if (errors.length) return { status: "corrupt", detail: errors.join("; "), toolsDigest, ...pending };

    if (active.approvedToolsDigest !== toolsDigest) {
      return {
        status: "tools-changed",
        preferences: active,
        approvedToolsDigest: active.approvedToolsDigest,
        toolsDigest,
        ...pending,
        detail:
          "The MCP tool surface changed since it was approved. Re-run the setup interview and re-approve before any further orchestration.",
      };
    }

    return {
      status: "ready",
      preferences: active,
      toolsDigest,
      approvedToolsDigest: active.approvedToolsDigest,
      ...pending,
    };
  } catch (error) {
    return { status: "corrupt", detail: String(error), toolsDigest, ...pending };
  }
}

function requireReady(state: ConfigState): Preferences {
  if (state.status !== "ready" || !state.preferences) {
    throw new Error(
      state.status === "tools-changed"
        ? "setup is tools-changed; the tool surface must be re-approved through the setup interview"
        : `setup is ${state.status}; run the parent-chat setup interview first`,
    );
  }
  return state.preferences;
}

// ---------------------------------------------------------------------------
// Destination derivation and rendering
// ---------------------------------------------------------------------------

function safeWorkspace(input: unknown): string {
  if (typeof input !== "string" || !isAbsolute(input)) {
    throw new Error("workspace must be an explicit absolute path to an existing directory");
  }
  const lexical = resolve(input);
  if (!existsSync(lexical) || !lstatSync(lexical).isDirectory() || lstatSync(lexical).isSymbolicLink()) {
    throw new Error("workspace must be an existing, non-symlink directory");
  }
  return realpathSync(lexical);
}

function destinationBase(client: Client, scope: Scope, workspace: string): string {
  const profile = CLIENT_PROFILES[client];
  const root = scope === "project" ? workspace : realpathSync(homedir());
  const segments = scope === "project" ? profile.projectDir : profile.userDir;
  return join(root, ...segments);
}

function filenames(client: Client): Record<RoleName, string> {
  const { extension } = CLIENT_PROFILES[client];
  return {
    routine: `orrery-routine${extension}`,
    high: `orrery-high${extension}`,
    advisor: `orrery-advisor${extension}`,
  };
}

function assertNoSymlinkPath(path: string, allowedRoot: string): void {
  const rel = relative(allowedRoot, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).some((part) => part === "..")) {
    throw new Error("destination escapes the client allowlist");
  }
  let cursor = allowedRoot;
  for (const part of rel.split(sep).slice(0, -1)) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`symlinked destination component refused: ${cursor}`);
    }
  }
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`symlink destination refused: ${path}`);
  }
}

function instructions(role: RoleName): string {
  if (role === "advisor") {
    return "Review the architecture, specification, actual diff, and verification evidence. Remain behaviorally read-only. Return ship, fix-first, or rethink; never implement fixes.";
  }
  if (role === "routine") {
    return "Implement bounded, well-specified, mechanical work. Preserve the settled architecture, owned files, interfaces, and concurrent edits. Run requested checks and report evidence.";
  }
  return "Implement complex, security-sensitive, algorithmic, debugging, or wide-blast-radius work within the settled architecture. Surface ambiguity, preserve concurrent edits, and report verification evidence.";
}

/** Tools a Claude Code advisor may use. Anything absent is unavailable to that agent. */
const CLAUDE_CODE_ADVISOR_TOOLS = "Read, Grep, Glob";

function renderOne(client: Client, role: RoleName, preference: RolePreference): string {
  const profile = CLIENT_PROFILES[client];
  const marker = profile.format === "toml" ? `# ${MANAGED_MARKER}` : `<!-- ${MANAGED_MARKER} -->`;
  const body = instructions(role);
  const name = profile.roleId(role);

  if (client === "codex") {
    const effortLine = preference.effort ? `model_reasoning_effort = ${JSON.stringify(preference.effort)}\n` : "";
    const sandboxLine = role === "advisor" ? 'sandbox_mode = "read-only"\n' : "";
    return (
      `${marker}\n` +
      `name = ${JSON.stringify(name)}\n` +
      `description = "Orrery ${role} role"\n` +
      `model = ${JSON.stringify(preference.model)}\n` +
      effortLine +
      sandboxLine +
      `\ndeveloper_instructions = ${JSON.stringify(body)}\n`
    );
  }

  if (client === "cursor") {
    const model = preference.model + (preference.effort ? ` [effort=${preference.effort}]` : "");
    const readonlyLine = role === "advisor" ? "readonly: true\n" : "";
    return (
      `---\nname: ${name}\ndescription: Orrery ${role} role\nmodel: ${JSON.stringify(model)}\n` +
      readonlyLine +
      `---\n${marker}\n\n${body}\n`
    );
  }

  if (client === "claude-code") {
    // Claude Code honours a `tools:` allowlist per agent, which is the strongest
    // read-only guarantee available on this host short of an OS sandbox.
    const toolsLine = role === "advisor" ? `tools: ${CLAUDE_CODE_ADVISOR_TOOLS}\n` : "";
    return (
      `---\nname: ${name}\ndescription: Orrery ${role} role\nmodel: ${JSON.stringify(preference.model)}\n` +
      toolsLine +
      `---\n${marker}\n\n${body}\n`
    );
  }

  return `---\nname: ${name}\ndescription: Orrery ${role} role\nmodel: ${JSON.stringify(preference.model)}\n---\n${marker}\n\n${body}\n`;
}

// ---------------------------------------------------------------------------
// Preview and consent
// ---------------------------------------------------------------------------

type PreviewPlan = {
  digest: string;
  expires: number;
  userToken?: string;
  used: boolean;
  createdAt: number;
  /** Bound so a plan minted for one scope/profile can never satisfy another. */
  scope: Scope;
  profileKey: string;
};

const previewPlans = new Map<string, PreviewPlan>();

export function __resetPreviewPlansForTests(): void {
  previewPlans.clear();
}

/**
 * Drops spent and expired consent, then refuses to mint if the table is still full.
 *
 * A live, unused, unexpired consent token is never evicted to make room: silently
 * discarding consent the operator is about to redeem would let a caller deny an install
 * simply by requesting previews. Failing closed on the new request is the safe direction.
 */
function prunePreviewPlans(): void {
  const now = Date.now();
  for (const [token, plan] of previewPlans) {
    if (plan.used || plan.expires < now) previewPlans.delete(token);
  }
  if (previewPlans.size >= PREVIEW_MAX_ENTRIES) {
    throw new Error(
      `too many outstanding adapter previews (${previewPlans.size}); install one or let them expire before requesting another`,
    );
  }
}

export type AdapterFile = { role: RoleName; path: string; content: string; hash: string };

/** The deterministic, side-effect-free description of what an install would do. */
export type AdapterPlan = {
  client: Client;
  scope: Scope;
  workspace: string;
  files: AdapterFile[];
  roleIds: Record<RoleName, string>;
  readOnlyMechanism: ReadOnlyMechanism;
  warnings: string[];
  planDigest: string;
  targetState: { path: string; state: string }[];
  afterInstall: string;
};

/** A plan plus a live, single-use consent token. Only `render_client_adapter` mints one. */
export type AdapterPreview = AdapterPlan & {
  expiresAt: string;
  confirmationToken: string;
  userScopeConfirmationToken?: string;
};

/**
 * Computes the exact install plan without minting consent.
 *
 * Every internal caller (install verification, uninstall, journal recovery, configuration
 * validation) uses this. Minting a token from any of those paths would mean a tool the
 * host was told is read-only could satisfy the consent gate.
 */
export function renderPlan(preferences: Preferences, workspaceInput: string): AdapterPlan {
  const errors = validatePreferences(preferences);
  if (errors.length) throw new Error(errors.join("; "));

  const workspace = safeWorkspace(workspaceInput);
  if (workspace !== preferences.workspace) {
    throw new Error("workspace does not match the active saved profile");
  }

  const profile = CLIENT_PROFILES[preferences.client];
  const base = destinationBase(preferences.client, preferences.scope, workspace);
  const names = filenames(preferences.client);
  const allowedRoot = preferences.scope === "project" ? workspace : realpathSync(homedir());

  const files: AdapterFile[] = (["routine", "high", "advisor"] as RoleName[]).map((role) => {
    const path = join(base, names[role]);
    assertNoSymlinkPath(path, allowedRoot);
    const content = renderOne(preferences.client, role, preferences.roles[role]);
    return { role, path, content, hash: sha(content) };
  });

  const warnings = [...profile.warnings];
  if (profile.readOnly !== "os-sandbox") {
    warnings.push(
      "Advisor read-only is a behavioral/client request; OS-enforced isolation is not guaranteed unless the client exposes evidence.",
    );
  }

  const targetState = files.map((file) => {
    if (!existsSync(file.path)) return { path: file.path, state: "missing" };
    const info = lstatSync(file.path);
    const safe = info.isFile() && !info.isSymbolicLink();
    return { path: file.path, state: safe ? sha(readFileSync(file.path)) : "unsafe" };
  });

  const planDigest = sha(
    canonicalJson({
      // Scope and profile are part of the digest so a plan can never be redeemed under
      // a different scope, even when the two would resolve to the same destinations.
      scope: preferences.scope,
      profileKey: preferences.profileKey,
      files: files.map(({ path, content }) => ({ path, content })),
      targetState,
    }),
  );

  return {
    client: preferences.client,
    scope: preferences.scope,
    workspace,
    files,
    roleIds: {
      routine: profile.roleId("routine"),
      high: profile.roleId("high"),
      advisor: profile.roleId("advisor"),
    },
    readOnlyMechanism: profile.readOnly,
    warnings,
    planDigest,
    targetState,
    afterInstall: "Start a new chat or reload the client so native role discovery sees the adapter files.",
  };
}

/**
 * Renders the plan and mints a single-use consent token bound to it.
 *
 * This is the only function in the server that creates installable consent, and it is
 * reachable from exactly one tool.
 */
export function renderAdapter(preferences: Preferences, workspaceInput: string): AdapterPreview {
  const plan = renderPlan(preferences, workspaceInput);
  // Independent nonces. Deriving the user-scope token from the install token by string
  // concatenation would make the "separate confirmation" for a home-directory write no
  // harder to produce than the first one.
  const confirmationToken = `INSTALL ${randomUUID()}`;
  const userScopeConfirmationToken = plan.scope === "user" ? `INSTALL USER ${randomUUID()}` : undefined;
  const now = Date.now();

  prunePreviewPlans();
  previewPlans.set(confirmationToken, {
    digest: plan.planDigest,
    expires: now + PREVIEW_TTL_MS,
    ...(userScopeConfirmationToken ? { userToken: userScopeConfirmationToken } : {}),
    used: false,
    createdAt: now,
    scope: plan.scope,
    profileKey: preferences.profileKey,
  });

  return {
    ...plan,
    expiresAt: new Date(now + PREVIEW_TTL_MS).toISOString(),
    confirmationToken,
    ...(userScopeConfirmationToken ? { userScopeConfirmationToken } : {}),
  };
}

// ---------------------------------------------------------------------------
// Managed-file manifest
// ---------------------------------------------------------------------------

function loadManifest(): Manifest {
  if (!existsSync(manifestPath())) {
    return { schemaVersion: 1, files: [], updatedAt: new Date().toISOString() };
  }
  let raw: any;
  try {
    raw = readJson(manifestPath());
  } catch (error) {
    throw new Error(`managed-file manifest is corrupt: ${String(error)}`);
  }
  if (raw?.schemaVersion !== 1 || !Array.isArray(raw.files)) {
    throw new Error("managed-file manifest schema is unsupported");
  }
  const seen = new Set<string>();
  for (const file of raw.files) {
    const valid =
      file &&
      typeof file.profileKey === "string" &&
      typeof file.path === "string" &&
      isAbsolute(file.path) &&
      typeof file.hash === "string" &&
      /^[a-f0-9]{64}$/.test(file.hash);
    if (!valid) throw new Error("managed-file manifest entry is invalid");
    if (seen.has(file.path)) {
      throw new Error(`managed-file manifest contains duplicate path ownership: ${file.path}`);
    }
    seen.add(file.path);
  }
  return raw as Manifest;
}

function requireExactManaged(path: string, hashValue: string): void {
  const text = readFileSync(path, "utf8");
  if (!text.includes(MANAGED_MARKER) || sha(text) !== hashValue) {
    throw new Error(`managed file changed; refusing: ${path}`);
  }
}

// ---------------------------------------------------------------------------
// Transaction journal
// ---------------------------------------------------------------------------

type TxEntry = {
  target: string;
  stage?: string;
  backup?: string;
  quarantine?: string;
  newHash: string;
  originalHash?: string;
  wasMissing?: boolean;
};

type TransactionJournal = {
  schemaVersion: 1;
  operation: "install" | "uninstall";
  phase: "prepared" | "targets-committed" | "manifest-committed";
  /**
   * Entries this transaction has begun to touch, persisted BEFORE the first mutation for
   * an entry. `committed` is only persisted afterwards, so it alone cannot tell an entry
   * that is live on disk from one that was never reached.
   */
  attempted?: number;
  committed: number;
  entries: TxEntry[];
  manifestExisted: boolean;
  originalManifest: string;
  newManifest: string;
  profileKey: string;
};

let transactionFaultForTests: ((point: string) => void) | undefined;

export function __setManifestWriteFaultForTests(fault: ((point: string) => void) | undefined): void {
  transactionFaultForTests = fault;
}

function writeJournal(tx: TransactionJournal): void {
  atomicWrite(journalPath(), `${JSON.stringify(tx, null, 2)}\n`);
}

function removeJournal(): void {
  if (existsSync(journalPath())) {
    rmSync(journalPath(), { force: true });
    syncDir(dirname(journalPath()));
  }
}

function removeExact(path: string, expected: string, label: string): void {
  if (currentHash(path) !== expected) throw new Error(`${label} hash mismatch: ${path}`);
  rmSync(path, { force: true });
  syncDir(dirname(path));
}

function restoreManifest(tx: TransactionJournal): void {
  const actual = currentHash(manifestPath());
  const originalHash = sha(tx.originalManifest);
  const newHash = sha(tx.newManifest);
  if (tx.manifestExisted) {
    if (actual === originalHash) return;
    if (actual !== newHash) throw new Error("manifest changed during rollback");
    atomicWrite(manifestPath(), tx.originalManifest);
    return;
  }
  if (existsSync(manifestPath())) {
    if (actual !== newHash) throw new Error("manifest changed during rollback");
    rmSync(manifestPath(), { force: true });
    syncDir(dirname(manifestPath()));
  }
}

function rollbackInstall(tx: TransactionJournal): void {
  for (let i = tx.entries.length - 1; i >= 0; i--) {
    const entry = tx.entries[i]!;

    // The staging file is a private, unguessable sibling this transaction created, so it
    // is always ours to remove. Refusing on a content mismatch would strand the journal
    // and wedge every later mutation over a file nobody else can even name.
    if (entry.stage && existsSync(entry.stage)) {
      const info = lstatSync(entry.stage);
      if (info.isFile() && !info.isSymbolicLink()) {
        rmSync(entry.stage, { force: true });
        syncDir(dirname(entry.stage));
      }
    }

    // Deciding what this transaction actually wrote is subtle in both directions.
    //
    // The committed counter alone is not enough: it is persisted AFTER the link is
    // published, so a crash in that window leaves an entry that is live on disk but
    // uncommitted in the journal.
    //
    // A content hash alone is not enough either: on an idempotent repair re-install the
    // new content equals what is already there, so an untouched target looks identical
    // to a committed one.
    //
    // The reliable discriminator is the quarantine. Its existence proves this transaction
    // renamed the original aside, so the target slot is ours; its absence on an update
    // proves the entry was never reached at all.
    // Write-ahead intent is the authority. `committed` is written after the link, so it
    // under-reports; a content hash over-reports, because on an idempotent re-install --
    // or when a concurrent client renders the same bytes -- an untouched file is
    // indistinguishable from one this transaction wrote.
    const attempted = typeof tx.attempted === "number" ? tx.attempted : tx.committed;
    const quarantined = entry.quarantine !== undefined && existsSync(entry.quarantine);
    const reached = quarantined || i < attempted;

    if (entry.wasMissing) {
      if (!reached) continue; // Never touched; a file here belongs to someone else.
      const actual = currentHash(entry.target);
      if (actual === entry.newHash) {
        rmSync(entry.target, { force: true });
        syncDir(dirname(entry.target));
      } else if (actual !== undefined) {
        throw new Error(`rollback refused changed target: ${entry.target}`);
      }
      continue;
    }

    if (!reached) continue; // Never touched by this transaction; leave it exactly as found.

    const actual = currentHash(entry.target);
    if (actual === entry.newHash) {
      // Our link landed, whether or not the journal recorded it yet.
      rmSync(entry.target, { force: true });
      syncDir(dirname(entry.target));
    } else if (actual !== undefined) {
      throw new Error(`rollback target reappeared: ${entry.target}`);
    }

    if (quarantined) {
      if (currentHash(entry.quarantine!) !== entry.originalHash) {
        throw new Error(`rollback quarantine hash mismatch: ${entry.target}`);
      }
      renameSync(entry.quarantine!, entry.target);
      syncDir(dirname(entry.target));
    }
  }
  restoreManifest(tx);
  removeJournal();
}

function rollbackUninstall(tx: TransactionJournal): void {
  for (let i = tx.entries.length - 1; i >= 0; i--) {
    const entry = tx.entries[i]!;

    if (entry.quarantine && existsSync(entry.quarantine)) {
      if (existsSync(entry.target)) throw new Error(`rollback target reappeared: ${entry.target}`);
      renameSync(entry.quarantine, entry.target);
      syncDir(dirname(entry.target));
      if (currentHash(entry.target) !== entry.originalHash) {
        throw new Error(`rollback hash mismatch: ${entry.target}`);
      }
      continue;
    }

    // Same rule as install: the committed counter is the authority. An entry this
    // transaction never quarantined was never touched, so rollback leaves it exactly as
    // found. Refusing here would strand the journal and wedge every later mutation over
    // a file the transaction is not responsible for; a later uninstall still refuses it
    // on the recorded hash.
    if (i < tx.committed && currentHash(entry.target) !== entry.originalHash) {
      throw new Error(`rollback refused changed target: ${entry.target}`);
    }
  }
  restoreManifest(tx);
  removeJournal();
}

/**
 * A journal is only actionable if every target it names is in the destination set the
 * live active profile would render right now. That is what stops a forged journal from
 * pointing recovery at an arbitrary path.
 */
function validateJournal(tx: unknown): asserts tx is TransactionJournal {
  const keysOf = (value: unknown): string[] =>
    value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value as object) : [];

  const topLevel = [
    "schemaVersion",
    "operation",
    "phase",
    "attempted",
    "committed",
    "entries",
    "manifestExisted",
    "originalManifest",
    "newManifest",
    "profileKey",
  ];
  const candidate = tx as any;
  const shapeValid =
    candidate &&
    !keysOf(candidate).some((key) => !topLevel.includes(key)) &&
    candidate.schemaVersion === 1 &&
    ["install", "uninstall"].includes(candidate.operation) &&
    ["prepared", "targets-committed", "manifest-committed"].includes(candidate.phase) &&
    Number.isInteger(candidate.committed) &&
    (candidate.attempted === undefined ||
      (Number.isInteger(candidate.attempted) &&
        candidate.attempted >= 0 &&
        candidate.attempted <= candidate.entries.length)) &&
    Array.isArray(candidate.entries) &&
    candidate.committed >= 0 &&
    candidate.committed <= candidate.entries.length &&
    typeof candidate.manifestExisted === "boolean" &&
    typeof candidate.originalManifest === "string" &&
    typeof candidate.newManifest === "string" &&
    typeof candidate.profileKey === "string";
  if (!shapeValid) throw new Error("transaction journal schema is invalid");

  // Accept any state that carries a valid profile, including `tools-changed`. Requiring
  // `ready` here would deadlock: an outstanding journal plus an unapproved tool surface
  // would fail every mutating call, including the one that re-approves it.
  const preferences = configState().preferences;
  if (!preferences || preferences.profileKey !== candidate.profileKey) {
    throw new Error("transaction journal does not match the active profile");
  }

  const expected = new Set(renderPlan(preferences, preferences.workspace).files.map((file) => file.path));
  const backupRoot = join(dataDir(), "backups");
  const entryKeys = ["target", "stage", "backup", "quarantine", "newHash", "originalHash", "wasMissing"];

  const journalTargets = new Set(candidate.entries.map((entry: any) => entry?.target));
  if (
    candidate.entries.length !== expected.size ||
    journalTargets.size !== expected.size ||
    [...expected].some((path) => !journalTargets.has(path))
  ) {
    throw new Error("transaction journal target set is incomplete or duplicated");
  }

  const validSibling = (value: unknown, target: string, suffix: string): boolean => {
    if (typeof value !== "string" || dirname(value) !== dirname(target)) return false;
    const name = basename(value);
    const prefix = `.${basename(target)}.`;
    const tail = `.${suffix}`;
    return name.startsWith(prefix) && name.endsWith(tail) && /^[0-9a-f-]{36}$/.test(name.slice(prefix.length, -tail.length));
  };

  for (const entry of candidate.entries as any[]) {
    const entryValid =
      entry &&
      !keysOf(entry).some((key) => !entryKeys.includes(key)) &&
      typeof entry.target === "string" &&
      expected.has(entry.target) &&
      typeof entry.newHash === "string" &&
      !(candidate.operation === "install" && !/^[a-f0-9]{64}$/.test(entry.newHash)) &&
      (entry.originalHash === undefined || /^[a-f0-9]{64}$/.test(entry.originalHash)) &&
      (entry.wasMissing === undefined || typeof entry.wasMissing === "boolean");
    if (!entryValid) throw new Error("transaction journal entry is invalid");
    if (entry.stage !== undefined && !validSibling(entry.stage, entry.target, "stage")) {
      throw new Error("transaction stage path is invalid");
    }
    if (entry.quarantine !== undefined && !validSibling(entry.quarantine, entry.target, "quarantine")) {
      throw new Error("transaction quarantine path is invalid");
    }
    if (entry.backup !== undefined && (typeof entry.backup !== "string" || dirname(entry.backup) !== backupRoot)) {
      throw new Error("transaction backup path is invalid");
    }
  }
}

function recoverTransaction(): void {
  if (!existsSync(journalPath())) return;
  let tx: TransactionJournal;
  try {
    tx = readJson(journalPath()) as TransactionJournal;
  } catch {
    throw new Error("transaction journal is corrupt; manual recovery required");
  }
  validateJournal(tx);

  if (tx.phase === "manifest-committed") {
    for (const entry of tx.entries) {
      if (entry.stage && existsSync(entry.stage)) removeExact(entry.stage, entry.newHash, "recovery stage");
      if (entry.quarantine && existsSync(entry.quarantine)) {
        removeExact(entry.quarantine, entry.originalHash!, "recovery quarantine");
      }
    }
    removeJournal();
    return;
  }
  if (tx.operation === "install") rollbackInstall(tx);
  else rollbackUninstall(tx);
}

// ---------------------------------------------------------------------------
// Install and uninstall
// ---------------------------------------------------------------------------

function rejectUnknown(value: unknown, allowed: string[], label: string): void {
  for (const key of Object.keys((value ?? {}) as Record<string, unknown>)) {
    if (!allowed.includes(key)) throw new Error(`unknown ${label} field: ${key}`);
  }
}

function installAdapter(args: Record<string, any>) {
  const preferences = requireReady(configState());
  rejectUnknown(args, ["workspace", "confirmationToken", "userScopeConfirmationToken"], "install");
  for (const key of ["workspace", "confirmationToken", "userScopeConfirmationToken"]) {
    if (typeof args[key] === "string" && /[\r\n\0]/.test(args[key])) {
      throw new Error(`${key} contains control characters`);
    }
  }

  // Resolve consent first, then recompute the plan with a function that cannot mint new
  // consent. The plan is re-derived rather than trusted, so anything that changed on disk
  // since the preview shows up as a digest mismatch.
  const plan = previewPlans.get(args.confirmationToken);
  const preview = renderPlan(preferences, args.workspace);
  const consentValid =
    plan !== undefined &&
    !plan.used &&
    plan.expires >= Date.now() &&
    plan.digest === preview.planDigest &&
    plan.scope === preview.scope &&
    plan.profileKey === preferences.profileKey;
  if (!consentValid) {
    throw new Error(
      "installation requires the exact unexpired one-time preview confirmation token and unchanged target state",
    );
  }
  if (preview.scope === "user" && args.userScopeConfirmationToken !== plan.userToken) {
    throw new Error("user-scope installation requires the separate exact user-scope token");
  }
  plan.used = true;

  const manifest = loadManifest();
  const previous = new Map(manifest.files.map((file) => [file.path, file]));
  for (const file of preview.files) {
    const known = previous.get(file.path);
    if (known && known.profileKey !== preferences.profileKey) {
      throw new Error(`adapter path is owned by a different profile; explicit uninstall required: ${file.path}`);
    }
    if (existsSync(file.path)) {
      if (!known) throw new Error(`unmanaged/conflicting file refused: ${file.path}`);
      requireExactManaged(file.path, known.hash);
    }
  }

  const originalManifest = existsSync(manifestPath()) ? readFileSync(manifestPath(), "utf8") : "";
  const targetState = new Map(preview.targetState.map((item) => [item.path, item.state]));
  const entries: TxEntry[] = [];
  const installed: ManagedFile[] = [];

  for (const file of preview.files) {
    const expected = targetState.get(file.path);
    const wasMissing = expected === "missing";
    const backup = wasMissing
      ? undefined
      : join(
          dataDir(),
          "backups",
          `${Date.now()}-${randomUUID()}-${basename(file.path)}-${String(expected).slice(0, 12)}.bak`,
        );
    const stage = join(dirname(file.path), `.${basename(file.path)}.${randomUUID()}.stage`);
    const quarantine = wasMissing
      ? undefined
      : join(dirname(file.path), `.${basename(file.path)}.${randomUUID()}.quarantine`);

    entries.push({
      target: file.path,
      stage,
      ...(backup ? { backup } : {}),
      ...(quarantine ? { quarantine } : {}),
      newHash: file.hash,
      ...(wasMissing ? {} : { originalHash: String(expected) }),
      wasMissing,
    });
    installed.push({
      profileKey: preferences.profileKey,
      path: file.path,
      hash: file.hash,
      ...(backup ? { backup } : {}),
    });
  }

  const retained = manifest.files.filter((file) => file.profileKey !== preferences.profileKey);
  const newManifest = `${JSON.stringify(
    { schemaVersion: 1, files: [...retained, ...installed], updatedAt: new Date().toISOString() },
    null,
    2,
  )}\n`;

  const tx: TransactionJournal = {
    schemaVersion: 1,
    operation: "install",
    phase: "prepared",
    committed: 0,
    entries,
    manifestExisted: existsSync(manifestPath()),
    originalManifest,
    newManifest,
    profileKey: preferences.profileKey,
  };
  writeJournal(tx);

  try {
    // Stage every payload and back up every replaced file before touching a target.
    for (const entry of entries) {
      mkdirSync(dirname(entry.target), { recursive: true });
      if (entry.backup) {
        const privateBackups = backupDir();
        if (dirname(entry.backup) !== privateBackups) {
          throw new Error("backup destination escaped private backup directory");
        }
        copyFileSync(entry.target, entry.backup);
        chmodSync(entry.backup, 0o600);
        syncFile(entry.backup);
        syncDir(dirname(entry.backup));
        if (currentHash(entry.backup) !== entry.originalHash) {
          throw new Error(`backup hash mismatch: ${entry.target}`);
        }
      }
      const content = preview.files.find((file) => file.path === entry.target)!.content;
      writeFileSync(entry.stage!, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      chmodSync(entry.stage!, 0o600);
      syncFile(entry.stage!);
      syncDir(dirname(entry.stage!));
    }

    transactionFaultForTests?.("install-before-targets");

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      assertNoSymlinkPath(
        entry.target,
        preferences.scope === "project" ? preferences.workspace : realpathSync(homedir()),
      );
      const actual = currentHash(entry.target);

      // Write-ahead marker. Recorded before the link publishes content; recording it any
      // earlier would claim entries the pre-flight or the self-restoring quarantine check
      // then refuses to touch.
      const declareIntent = (): void => {
        tx.attempted = i + 1;
        writeJournal(tx);
      };

      if (entry.wasMissing) {
        if (actual !== undefined || existsSync(entry.target)) {
          throw new Error(`target appeared after preview: ${entry.target}`);
        }
      } else {
        if (actual !== entry.originalHash) {
          throw new Error(`managed target changed after preview: ${entry.target}`);
        }
        const before = lstatSync(entry.target);
        transactionFaultForTests?.(`install-before-quarantine-${i + 1}`);
        if (existsSync(entry.quarantine!)) throw new Error(`install quarantine conflict: ${entry.quarantine}`);
        renameSync(entry.target, entry.quarantine!);
        syncDir(dirname(entry.target));

        // Prove the file we quarantined is the very inode we inspected, not a swap.
        const quarantined = lstatSync(entry.quarantine!);
        const identical =
          !quarantined.isSymbolicLink() &&
          quarantined.isFile() &&
          quarantined.dev === before.dev &&
          quarantined.ino === before.ino &&
          currentHash(entry.quarantine!) === entry.originalHash;
        if (!identical) {
          if (!existsSync(entry.target)) {
            renameSync(entry.quarantine!, entry.target);
            syncDir(dirname(entry.target));
          }
          throw new Error(`install quarantine identity/hash mismatch: ${entry.target}`);
        }
      }

      // The quarantine rename above is self-restoring: if its identity check fails it puts
      // the file back before throwing, so it needs no journal record. The link does not --
      // it publishes content that rollback must be able to recognise as its own. Declaring
      // intent here, and only here, is what closes the window between publishing the link
      // and recording the commit.
      declareIntent();
      linkSync(entry.stage!, entry.target);
      transactionFaultForTests?.(`install-after-link-${i + 1}`);
      rmSync(entry.stage!, { force: true });
      syncDir(dirname(entry.target));
      if (currentHash(entry.target) !== entry.newHash) {
        throw new Error(`committed target hash mismatch: ${entry.target}`);
      }
      tx.committed = i + 1;
      tx.phase = "targets-committed";
      writeJournal(tx);
      transactionFaultForTests?.(`install-target-${i + 1}`);
    }

    atomicWrite(manifestPath(), newManifest);
    transactionFaultForTests?.("install-manifest-commit");
    tx.phase = "manifest-committed";
    writeJournal(tx);
    transactionFaultForTests?.("install-journal-commit");
    for (const entry of entries) {
      if (entry.quarantine && existsSync(entry.quarantine)) {
        removeExact(entry.quarantine, entry.originalHash!, "committed quarantine");
      }
    }
    removeJournal();
  } catch (error) {
    if ((error instanceof Error && error.message === "__SIMULATED_CRASH__") || tx.phase === "manifest-committed") {
      throw error;
    }
    try {
      rollbackInstall(tx);
    } catch (rollbackError) {
      throw new Error(`${String(error)}; rollback incomplete: ${String(rollbackError)}`);
    }
    throw error;
  }

  return {
    installed: installed.map((file) => file.path),
    backups: installed.flatMap((file) => (file.backup ? [file.backup] : [])),
    roleIds: preview.roleIds,
    guidance: preview.afterInstall,
  };
}

function uninstallAdapter(args: Record<string, any>) {
  const preferences = requireReady(configState());
  const manifest = loadManifest();
  const selected = manifest.files.filter((file) => file.profileKey === preferences.profileKey);

  if (!selected.length) {
    return { requiresConfirmation: false, removed: [], guidance: "No managed adapter files are recorded for the active profile." };
  }

  const expected = new Set(renderPlan(preferences, preferences.workspace).files.map((file) => file.path));
  if (selected.some((file) => !expected.has(file.path)) || selected.length !== expected.size) {
    throw new Error("managed-file manifest destinations do not match the active client allowlist");
  }

  const token = `UNINSTALL ${sha(canonicalJson(selected.map((file) => ({ path: file.path, hash: file.hash }))))}`;
  if (args.confirmationToken !== token) {
    return { requiresConfirmation: true, confirmationToken: token, files: selected.map((file) => file.path) };
  }

  for (const file of selected) requireExactManaged(file.path, file.hash);

  const originalManifest = readFileSync(manifestPath(), "utf8");
  const newManifest = `${JSON.stringify(
    {
      schemaVersion: 1,
      files: manifest.files.filter((file) => file.profileKey !== preferences.profileKey),
      updatedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`;

  const entries: TxEntry[] = selected.map((file) => ({
    target: file.path,
    quarantine: join(dirname(file.path), `.${basename(file.path)}.${randomUUID()}.quarantine`),
    newHash: "",
    originalHash: file.hash,
  }));

  const tx: TransactionJournal = {
    schemaVersion: 1,
    operation: "uninstall",
    phase: "prepared",
    committed: 0,
    entries,
    manifestExisted: true,
    originalManifest,
    newManifest,
    profileKey: preferences.profileKey,
  };
  writeJournal(tx);

  try {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      assertNoSymlinkPath(
        entry.target,
        preferences.scope === "project" ? preferences.workspace : realpathSync(homedir()),
      );
      if (currentHash(entry.target) !== entry.originalHash) {
        throw new Error(`managed file changed before uninstall commit: ${entry.target}`);
      }
      const before = lstatSync(entry.target);
      transactionFaultForTests?.(`uninstall-before-quarantine-${i + 1}`);
      if (existsSync(entry.quarantine!)) throw new Error(`quarantine conflict: ${entry.quarantine}`);
      renameSync(entry.target, entry.quarantine!);
      syncDir(dirname(entry.target));

      const quarantined = lstatSync(entry.quarantine!);
      const identical =
        !quarantined.isSymbolicLink() &&
        quarantined.isFile() &&
        quarantined.dev === before.dev &&
        quarantined.ino === before.ino &&
        currentHash(entry.quarantine!) === entry.originalHash;
      if (!identical) {
        if (!existsSync(entry.target)) {
          renameSync(entry.quarantine!, entry.target);
          syncDir(dirname(entry.target));
        }
        throw new Error(`uninstall quarantine identity/hash mismatch: ${entry.target}`);
      }

      tx.committed = i + 1;
      tx.phase = "targets-committed";
      writeJournal(tx);
      transactionFaultForTests?.(`uninstall-target-${i + 1}`);
    }

    atomicWrite(manifestPath(), newManifest);
    transactionFaultForTests?.("uninstall-manifest-commit");
    tx.phase = "manifest-committed";
    writeJournal(tx);
    transactionFaultForTests?.("uninstall-journal-commit");
    for (const entry of entries) {
      if (entry.quarantine && existsSync(entry.quarantine)) {
        removeExact(entry.quarantine, entry.originalHash!, "committed quarantine");
      }
    }
    removeJournal();
  } catch (error) {
    if ((error instanceof Error && error.message === "__SIMULATED_CRASH__") || tx.phase === "manifest-committed") {
      throw error;
    }
    try {
      rollbackUninstall(tx);
    } catch (rollbackError) {
      throw new Error(`${String(error)}; rollback incomplete: ${String(rollbackError)}`);
    }
    throw error;
  }

  return {
    requiresConfirmation: false,
    removed: selected.map((file) => file.path),
    guidance: "Reload the client or start a new chat.",
  };
}

// ---------------------------------------------------------------------------
// Preferences persistence
// ---------------------------------------------------------------------------

function assertSafeInput(value: unknown, path = "input"): void {
  const forbidden = /(secret|token|password|api.?key|credential|private.?key)/i;
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (forbidden.test(key)) throw new Error(`forbidden secret-like field: ${path}.${key}`);
      assertSafeInput(item, `${path}.${key}`);
    }
  }
  if (typeof value === "string" && /[\r\n\0]/.test(value)) {
    throw new Error(`${path} contains control characters`);
  }
}

function savePreferences(args: Record<string, any>) {
  assertSafeInput(args);
  rejectUnknown(args, ["client", "scope", "workspace", "orchestrator", "roles", "appTaskLane"], "preference");
  rejectUnknown(args.orchestrator, ["model", "recommendation"], "orchestrator");
  for (const role of ["routine", "high", "advisor"] as RoleName[]) {
    rejectUnknown(args.roles?.[role], ["model", "effort", "readonly"], `role ${role}`);
  }

  const now = new Date().toISOString();
  const existing = configState();
  const workspace = safeWorkspace(args.workspace);
  const profileKey = `${args.client}:${args.scope}:${workspace}`;

  const role = (name: RoleName): RolePreference => {
    const source = args.roles?.[name];
    return {
      model: source?.model,
      ...(source?.effort !== undefined ? { effort: source.effort } : {}),
      ...(name === "advisor"
        ? { readonly: true }
        : source?.readonly !== undefined
          ? { readonly: source.readonly }
          : {}),
    };
  };

  const recommendation = args.orchestrator?.recommendation;
  const candidate: Preferences = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    client: args.client,
    scope: args.scope,
    orchestrator: {
      model: "inherit",
      ...(recommendation
        ? {
            recommendation: {
              model: recommendation.model,
              ...(recommendation.effort !== undefined ? { effort: recommendation.effort } : {}),
            },
          }
        : {}),
    },
    roles: { routine: role("routine"), high: role("high"), advisor: role("advisor") },
    fallbackPolicy: "fail-closed",
    fallbacks: [],
    ...(args.appTaskLane?.enabled === true
      ? { appTaskLane: { enabled: true as const, model: "gpt-5.6-luna" as const, effort: "max" as const } }
      : {}),
    // Completing the interview is the operator's approval of the current tool surface.
    approvedToolsDigest: TOOLS_DIGEST,
    profileKey,
    workspace,
    createdAt: existing.preferences?.profileKey === profileKey ? existing.preferences.createdAt : now,
    updatedAt: now,
    pluginVersion: PLUGIN_VERSION,
  };

  const errors = validatePreferences(candidate);
  if (errors.length) throw new Error(errors.join("; "));

  if (existsSync(configPath())) {
    const privateBackups = backupDir();
    const backup = join(privateBackups, `${Date.now()}-config.json.bak`);
    if (dirname(backup) !== backupDir()) throw new Error("config backup destination changed");
    copyFileSync(configPath(), backup);
    chmodSync(backup, 0o600);
    syncFile(backup);
    syncDir(privateBackups);
  }

  let profiles: Record<string, Preferences> = {};
  try {
    const old = readJson(configPath()) as any;
    if (old?.schemaVersion === CONFIG_SCHEMA_VERSION && old.profiles && typeof old.profiles === "object") {
      profiles = old.profiles;
    }
  } catch {
    // An unreadable or superseded config is replaced, never merged.
  }
  profiles[profileKey] = candidate;

  atomicWrite(
    configPath(),
    `${JSON.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, activeProfile: profileKey, profiles }, null, 2)}\n`,
  );
  return { saved: true, profileKey, approvedToolsDigest: TOOLS_DIGEST, preferences: candidate };
}

function resetConfiguration(args: Record<string, any>) {
  // Reset must stay available for a corrupt or superseded profile, but it must not be a
  // way to erase an unreviewed tool-surface change: purging the approved digest would
  // silently clear the very alarm that is firing.
  if (configState().status === "tools-changed") {
    throw new Error(
      "reset refused while the tool surface is unapproved; review the change and re-approve it through the setup interview first",
    );
  }
  const live = loadManifest().files;
  if (live.length) {
    throw new Error("reset refused while managed adapter files are installed; uninstall them first");
  }
  const token = "RESET ORRERY CONFIGURATION";
  if (args.confirmationToken !== token) {
    return { requiresConfirmation: true, confirmationToken: token };
  }
  for (const path of [configPath(), manifestPath(), join(dataDir(), "backups")]) {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  }
  previewPlans.clear();
  return { requiresConfirmation: false, reset: true, purged: true };
}

// ---------------------------------------------------------------------------
// Tool surface
//
// This array is content-addressed by TOOLS_DIGEST. Any change to a name, description,
// schema, or annotation changes the digest and voids previously granted consent.
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

const str: JsonSchema = { type: "string" };
const bool: JsonSchema = { type: "boolean" };
const stringArray: JsonSchema = { type: "array", items: { type: "string" } };

const objectSchema = (properties: Record<string, JsonSchema> = {}, required: string[] = []): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const roleSchema: JsonSchema = {
  type: "object",
  properties: { model: str, effort: str, readonly: bool },
  required: ["model"],
  additionalProperties: false,
};

const rolePreferenceOut: JsonSchema = {
  type: "object",
  properties: { model: str, effort: str, readonly: bool },
  required: ["model"],
  additionalProperties: false,
};

const preferencesSchema: JsonSchema = {
  type: "object",
  properties: {
    schemaVersion: { type: "number" },
    client: { type: "string", enum: [...CLIENTS] },
    scope: { type: "string", enum: ["project", "user"] },
    orchestrator: {
      type: "object",
      properties: {
        model: { const: "inherit" },
        recommendation: {
          type: "object",
          properties: { model: str, effort: str },
          required: ["model"],
          additionalProperties: false,
        },
      },
      required: ["model"],
      additionalProperties: false,
    },
    roles: {
      type: "object",
      properties: { routine: rolePreferenceOut, high: rolePreferenceOut, advisor: rolePreferenceOut },
      required: ["routine", "high", "advisor"],
      additionalProperties: false,
    },
    fallbackPolicy: { const: "fail-closed" },
    fallbacks: stringArray,
    appTaskLane: {
      type: "object",
      properties: { enabled: bool, model: str, effort: str },
      required: ["enabled", "model", "effort"],
      additionalProperties: false,
    },
    approvedToolsDigest: str,
    profileKey: str,
    workspace: str,
    createdAt: str,
    updatedAt: str,
    pluginVersion: str,
  },
  required: [
    "schemaVersion",
    "client",
    "scope",
    "orchestrator",
    "roles",
    "fallbackPolicy",
    "fallbacks",
    "approvedToolsDigest",
    "profileKey",
    "workspace",
    "createdAt",
    "updatedAt",
    "pluginVersion",
  ],
  additionalProperties: false,
};

const roleIdsSchema: JsonSchema = {
  type: "object",
  properties: { routine: str, high: str, advisor: str },
  required: ["routine", "high", "advisor"],
  additionalProperties: false,
};

const planProperties: Record<string, JsonSchema> = {
  client: { type: "string", enum: [...CLIENTS] },
  scope: { type: "string", enum: ["project", "user"] },
  workspace: str,
  files: {
    type: "array",
    items: {
      type: "object",
      properties: { role: { type: "string", enum: ["routine", "high", "advisor"] }, path: str, content: str, hash: str },
      required: ["role", "path", "content", "hash"],
      additionalProperties: false,
    },
  },
  roleIds: roleIdsSchema,
  readOnlyMechanism: { type: "string", enum: ["os-sandbox", "tool-allowlist", "frontmatter-flag", "prompt-only"] },
  warnings: stringArray,
  planDigest: str,
  targetState: {
    type: "array",
    items: {
      type: "object",
      properties: { path: str, state: str },
      required: ["path", "state"],
      additionalProperties: false,
    },
  },
  afterInstall: str,
};

const planRequired = [
  "client",
  "scope",
  "workspace",
  "files",
  "roleIds",
  "readOnlyMechanism",
  "warnings",
  "planDigest",
  "targetState",
  "afterInstall",
];

/** A plan carries no consent token; only `render_client_adapter` returns one. */
const planSchema: JsonSchema = {
  type: "object",
  properties: planProperties,
  required: planRequired,
  additionalProperties: false,
};

const previewSchema: JsonSchema = {
  type: "object",
  properties: {
    ...planProperties,
    expiresAt: str,
    confirmationToken: str,
    userScopeConfirmationToken: str,
  },
  required: [...planRequired, "expiresAt", "confirmationToken"],
  additionalProperties: false,
};

const setupStatusSchema: JsonSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["missing", "ready", "schema-old", "corrupt", "tools-changed"] },
    detail: str,
    toolsDigest: str,
    approvedToolsDigest: str,
    preferences: preferencesSchema,
    pendingRecovery: bool,
  },
  required: ["status", "toolsDigest"],
  additionalProperties: false,
};

export const tools = [
  {
    name: "get_setup_status",
    description:
      "Report missing, ready, schema-old, corrupt, or tools-changed setup state, plus the current and approved tool-surface digests.",
    inputSchema: objectSchema(),
    outputSchema: setupStatusSchema,
    annotations: {
      title: "Get setup status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "get_preferences",
    description: "Read the active non-secret logical preferences profile.",
    inputSchema: objectSchema(),
    outputSchema: preferencesSchema,
    annotations: {
      title: "Get preferences",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "save_preferences",
    description:
      "Validate and atomically save interview choices, and record approval of the current tool surface. Backs up any previous configuration.",
    inputSchema: objectSchema(
      {
        client: { type: "string", enum: [...CLIENTS] },
        scope: { type: "string", enum: ["project", "user"] },
        workspace: str,
        orchestrator: {
          type: "object",
          properties: {
            model: { const: "inherit" },
            recommendation: {
              type: "object",
              properties: { model: str, effort: str },
              required: ["model"],
              additionalProperties: false,
            },
          },
          required: ["model"],
          additionalProperties: false,
        },
        roles: {
          type: "object",
          properties: { routine: roleSchema, high: roleSchema, advisor: roleSchema },
          required: ["routine", "high", "advisor"],
          additionalProperties: false,
        },
        appTaskLane: {
          type: "object",
          properties: { enabled: { const: true } },
          required: ["enabled"],
          additionalProperties: false,
        },
      },
      ["client", "scope", "workspace", "orchestrator", "roles"],
    ),
    outputSchema: objectSchema(
      { saved: bool, profileKey: str, approvedToolsDigest: str, preferences: preferencesSchema },
      ["saved", "profileKey", "approvedToolsDigest", "preferences"],
    ),
    annotations: {
      title: "Save preferences",
      readOnlyHint: false,
      destructiveHint: false,
      // Each call stamps a new updatedAt and writes a fresh private backup.
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "render_client_adapter",
    description:
      "Preview the exact allowlisted native adapter destinations and contents, the observed target state, host limits, and a one-time consent token. Writes nothing to disk.",
    inputSchema: objectSchema({ workspace: str }, ["workspace"]),
    outputSchema: previewSchema,
    annotations: {
      title: "Preview client adapter",
      // Not read-only: each preview mints a single-use consent token that install consumes.
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "install_client_adapter",
    description:
      "Install only the exact previously previewed adapter files after the exact one-time token is supplied. Replaces managed files and records private backups.",
    inputSchema: objectSchema({ workspace: str, confirmationToken: str, userScopeConfirmationToken: str }, [
      "workspace",
      "confirmationToken",
    ]),
    outputSchema: objectSchema({ installed: stringArray, backups: stringArray, roleIds: roleIdsSchema, guidance: str }, [
      "installed",
      "backups",
      "roleIds",
      "guidance",
    ]),
    annotations: {
      title: "Install client adapter",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "uninstall_client_adapter",
    description:
      "Preview, then on exact confirmation remove, only the unchanged managed adapter files owned by the active profile.",
    inputSchema: objectSchema({ confirmationToken: str }),
    outputSchema: objectSchema(
      { requiresConfirmation: bool, confirmationToken: str, files: stringArray, removed: stringArray, guidance: str },
      ["requiresConfirmation"],
    ),
    annotations: {
      title: "Uninstall client adapter",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "validate_configuration",
    description: "Validate the saved setup and, when a workspace is supplied, that the adapter still renders.",
    inputSchema: objectSchema({ workspace: str }),
    outputSchema: objectSchema({ status: { type: "string" }, valid: bool, detail: str, preview: planSchema }, [
      "status",
      "valid",
    ]),
    annotations: {
      title: "Validate configuration",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "reset_configuration",
    description:
      "Purge logical configuration, the managed-file manifest, and private backups after the exact confirmation token. Refused while managed files are installed.",
    inputSchema: objectSchema({ confirmationToken: str }),
    outputSchema: objectSchema({ requiresConfirmation: bool, confirmationToken: str, reset: bool, purged: bool }, [
      "requiresConfirmation",
    ]),
    annotations: {
      title: "Reset configuration",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
] as const;

/**
 * Content address of the entire exposed tool surface.
 *
 * A malicious or compromised update that rewrites a tool description to smuggle
 * instructions changes this value. Setup records the digest the operator approved;
 * any later mismatch reports `tools-changed` and blocks every stateful operation until
 * a human re-approves. This is the documented mitigation for MCP rug-pull attacks.
 */
const TOOL_POLICY = compileToolPolicy(tools, [
  "install_client_adapter",
  "uninstall_client_adapter",
  "reset_configuration",
]);
export const TOOLS_DIGEST = TOOL_POLICY.digest;
const READ_ONLY_TOOLS = TOOL_POLICY.readOnly;
const TOOL_ARGUMENT_ALLOWLIST = TOOL_POLICY.argumentsByTool;
/** Tools permitted to perform crash recovery, which deletes and renames managed files. */
const RECOVERY_TOOLS = TOOL_POLICY.recovery;

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

export async function callTool(name: string, args: Record<string, any> = {}) {
  const allowed = TOOL_ARGUMENT_ALLOWLIST.get(name);
  if (!allowed) throw new Error(`unknown tool: ${name}`);
  rejectUnknown(args, [...allowed], name);

  if (name !== "save_preferences") {
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === "string" && /[\r\n\0]/.test(value)) {
        throw new Error(`${key} contains control characters`);
      }
    }
  }

  const readOnly = READ_ONLY_TOOLS.has(name);

  // Crash recovery deletes, renames, and rewrites files, so it is a mutation and only
  // runs inside a mutating tool holding the exclusive lock. A read-only tool never
  // triggers it -- that keeps `readOnlyHint` honest and removes any path on which a
  // status query could roll back an install that is still running. Outstanding recovery
  // is surfaced to the caller as `pendingRecovery`.
  const run = <T>(body: () => T): T => {
    if (readOnly) return body();
    return withLock(name, () => {
      // Only tools that already declare destructive intent may perform recovery, so a
      // tool documented as writing nothing to disk never deletes or renames a file.
      if (RECOVERY_TOOLS.has(name)) recoverTransaction();
      return body();
    }) as T;
  };

  switch (name) {
    case "get_setup_status":
      return run(() => configState());
    case "get_preferences":
      return run(() => requireReady(configState()));
    case "save_preferences":
      return run(() => savePreferences(args));
    case "render_client_adapter":
      return run(() => renderAdapter(requireReady(configState()), args.workspace));
    case "install_client_adapter":
      return run(() => installAdapter(args));
    case "uninstall_client_adapter":
      return run(() => uninstallAdapter(args));
    case "validate_configuration":
      return run(() => {
        const state = configState();
        return {
          status: state.status,
          valid: state.status === "ready",
          ...(state.detail ? { detail: state.detail } : {}),
          ...(state.status === "ready" && args.workspace
            ? { preview: renderPlan(state.preferences!, args.workspace) }
            : {}),
        };
      });
    case "reset_configuration":
      return run(() => resetConfiguration(args));
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC transport
// ---------------------------------------------------------------------------

function response(id: unknown, result?: unknown, error?: unknown, code = -32000) {
  if (error) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code, message: error instanceof Error ? error.message : String(error) },
    };
  }
  return { jsonrpc: "2.0", id, result };
}

function isSupportedProtocol(value: unknown): value is ProtocolVersion {
  return typeof value === "string" && (SUPPORTED_PROTOCOLS as readonly string[]).includes(value);
}

/**
 * Resolves the protocol revision in play.
 *
 * 2026-07-28 removed the initialize handshake, so each request may carry its own
 * version in `_meta`. Older clients still negotiate through `initialize`. An explicit
 * but unsupported version is refused rather than silently downgraded.
 */
function requestProtocol(message: any): ProtocolVersion | { error: string } {
  const declared = message?.params?._meta?.[META_PROTOCOL_KEY];
  if (declared === undefined) return negotiatedProtocol;
  if (!isSupportedProtocol(declared)) {
    return { error: `unsupported protocol version: ${String(declared)}` };
  }
  return declared;
}

let negotiatedProtocol: ProtocolVersion = LATEST_PROTOCOL;

export function __resetProtocolForTests(): void {
  negotiatedProtocol = LATEST_PROTOCOL;
}

/**
 * Separates protocol errors from tool-execution errors.
 *
 * The MCP tools specification requires an unknown tool name or invalid arguments to come
 * back as a JSON-RPC error, and reserves `isError: true` in a result for failures that
 * happen while a real tool actually runs.
 */
function toolCallProtocolError(params: any): string | undefined {
  const allowed = TOOL_ARGUMENT_ALLOWLIST.get(params.name);
  if (!allowed) return `Unknown tool: ${params.name}`;
  for (const key of Object.keys((params.arguments ?? {}) as Record<string, unknown>)) {
    if (!allowed.includes(key)) return `Unknown argument for ${params.name}: ${key}`;
  }
  return undefined;
}

async function handleSingle(message: any) {
  const idPresent = message !== null && typeof message === "object" && !Array.isArray(message) && "id" in message;
  // JSON-RPC 2.0 reserves a null id for responses whose request id could not be
  // determined, and the MCP base protocol requires a request id to be a string or number.
  const idValid = !idPresent || ["string", "number"].includes(typeof message.id);
  if (!message || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string" || !idValid) {
    return response(idValid ? (message?.id ?? null) : null, undefined, new Error("invalid JSON-RPC 2.0 request"), -32600);
  }

  if (message.method === "notifications/initialized") return null;
  if (!idPresent) return null;

  const protocol = requestProtocol(message);
  if (typeof protocol !== "string") {
    return response(message.id, undefined, new Error(protocol.error), -32602);
  }

  if (message.method === "initialize") {
    const requested = message.params?.protocolVersion;
    negotiatedProtocol = isSupportedProtocol(requested) ? requested : LATEST_PROTOCOL;
    return response(message.id, {
      protocolVersion: negotiatedProtocol,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: PLUGIN_VERSION },
    });
  }

  if (message.method === "ping") return response(message.id, {});

  if (message.method === "tools/list") {
    // Cacheable list results arrived with the 2026-07-28 stateless core. Older
    // revisions receive exactly the payload they received before.
    const cacheable = protocol === "2026-07-28" ? { ttlMs: 300_000, cacheScope: "session" } : {};
    return response(message.id, { tools, ...cacheable });
  }

  if (message.method === "tools/call") {
    const params = message.params;
    const paramsValid =
      params &&
      typeof params.name === "string" &&
      params.arguments !== null &&
      typeof (params.arguments ?? {}) === "object" &&
      !Array.isArray(params.arguments);
    if (!paramsValid) {
      return response(message.id, undefined, new Error("invalid tools/call parameters"), -32602);
    }
    const protocolError = toolCallProtocolError(params);
    if (protocolError) {
      return response(message.id, undefined, new Error(protocolError), -32602);
    }
    try {
      const value = await callTool(params.name, params.arguments ?? {});
      return response(message.id, {
        content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
        structuredContent: value,
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return response(message.id, { content: [{ type: "text", text }], isError: true });
    }
  }

  return response(message.id, undefined, new Error(`method not found: ${message.method}`), -32601);
}

/**
 * Entry point for one parsed JSON-RPC value.
 *
 * Batches are accepted because MCP `2025-03-26`, which this server still negotiates,
 * requires receivers to support them. Notifications inside a batch produce no reply, and
 * a batch made entirely of notifications produces no response at all.
 */
export async function handle(message: any) {
  if (!Array.isArray(message)) return handleSingle(message);
  if (!message.length) {
    return response(null, undefined, new Error("invalid JSON-RPC 2.0 batch"), -32600);
  }
  const replies: unknown[] = [];
  for (const item of message) {
    let reply: unknown;
    try {
      reply = await handleSingle(item);
    } catch (error) {
      // One failing member must not discard the replies its siblings already produced.
      const id =
        item && typeof item === "object" && !Array.isArray(item) && ["string", "number"].includes(typeof item.id)
          ? item.id
          : null;
      reply = response(id, undefined, error, -32603);
    }
    if (reply) replies.push(reply);
  }
  return replies.length ? replies : null;
}

async function main(): Promise<void> {
  let buffer = "";
  const emit = (value: unknown): void => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  };
  const oversize = () => response(null, undefined, new Error("JSON-RPC line exceeds 1 MiB"), -32700);

  for await (const chunk of Bun.stdin.stream()) {
    buffer += new TextDecoder().decode(chunk, { stream: true });
    if (buffer.length > MAX_LINE_BYTES && !buffer.includes("\n")) {
      emit(oversize());
      buffer = "";
      continue;
    }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const raw = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!raw.trim()) continue;
      if (raw.length > MAX_LINE_BYTES) {
        emit(oversize());
        continue;
      }
      let out: unknown;
      try {
        out = await handle(JSON.parse(raw));
      } catch (error) {
        out = response(null, undefined, error, -32700);
      }
      if (out) emit(out);
    }
  }

  if (buffer.trim()) {
    let out: unknown;
    try {
      out = await handle(JSON.parse(buffer));
    } catch (error) {
      out = response(null, undefined, error, -32700);
    }
    if (out) emit(out);
  }
}

if (import.meta.main) await main();
