/**
 * Safe, complete rebrand of this plugin.
 *
 * A hand-run find-and-replace silently breaks this repository, because several values
 * are *derived* from the very text you are replacing:
 *
 *   - `tools/schema/tools.digest` is the sha256 of the exposed MCP tool surface, whose
 *     descriptions contain the product name.
 *   - `scripts/install-agents.sh` and `scripts/verify.sh` pin the byte-exact sha256 of
 *     the legacy v0.2.0 role templates, whose bodies contain the role identifiers.
 *
 * This tool performs the rename and then recomputes every derived digest, so the
 * repository stays internally consistent and CI stays meaningful.
 *
 *   bun tools/rebrand.ts --name nova-advisor --display "Nova Advisor" \
 *     --author-name "Ada Lovelace" --author-url https://github.com/ada \
 *     --repo https://github.com/ada/nova-advisor            # dry run
 *   bun tools/rebrand.ts ... --apply                        # write changes
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dir, "..");

const OLD_KEBAB = "orrery";
const OLD_SNAKE = "orrery";
const OLD_DISPLAY = "Orrery";
const OLD_AUTHOR_NAME = "Divyam Talwar";
const OLD_AUTHOR_HANDLE = "DivyamTalwar";
const OLD_REPO = "https://github.com/DivyamTalwar/ORRERY";

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".github/workflows/.cache"]);
const BINARY_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf", ".gz", ".zip", ".tar"]);

/**
 * The LICENSE copyright line is a legal statement about who authored this work, not a
 * brand string. A rename must never quietly reassign it.
 */
const SKIP_CONTENT_FILES = new Set(["LICENSE"]);

// Replacement values are spliced into TypeScript, JSON, TOML, YAML and Markdown, so the
// character set is restricted rather than escaped per-format. Anything that could close
// a string, open a template, or start a comment is refused outright.
const SAFE_TEXT = /^[A-Za-z0-9][A-Za-z0-9 ._&-]{0,79}$/;
const SAFE_URL = /^https:\/\/[A-Za-z0-9._~:/?#@!$&()*+,;=%-]{3,200}$/;

type Options = {
  name: string;
  display: string;
  authorName?: string;
  authorUrl?: string;
  repo?: string;
  apply: boolean;
};

function usage(message: string): never {
  console.error(`ERROR: ${message}

usage: bun tools/rebrand.ts --name <kebab-name> --display "<Display Name>"
                            [--author-name "<Name>"] [--author-url <url>]
                            [--repo <url>] [--apply]

  --name         New plugin id. Must be 1-64 lowercase alphanumeric/hyphen, no "--".
  --display      Human-facing product name used in prose.
  --author-name  Replaces "${OLD_AUTHOR_NAME}".
  --author-url   Replaces the author URL and "${OLD_AUTHOR_HANDLE}" references.
  --repo         Replaces "${OLD_REPO}".
  --apply        Write the changes. Without it, this is a dry run.`);
  process.exit(2);
}

function parseArgs(): Options {
  const argv = Bun.argv.slice(2);
  const read = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index < 0) return undefined;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) usage(`${flag} requires a value`);
    return value;
  };
  for (const arg of argv) {
    if (arg.startsWith("--") && !["--name", "--display", "--author-name", "--author-url", "--repo", "--apply"].includes(arg)) {
      usage(`unknown flag ${arg}`);
    }
  }

  const name = read("--name");
  const display = read("--display");
  if (!name) usage("--name is required");
  if (!display) usage("--display is required");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name) || name.includes("--")) {
    usage(`--name "${name}" is not a valid plugin id (1-64 lowercase alphanumeric or hyphen, no "--")`);
  }
  if (name === OLD_KEBAB) usage("--name matches the current name; nothing to do");
  if (!display.trim() || /[\r\n]/.test(display)) usage("--display must be a single non-empty line");

  if (!SAFE_TEXT.test(display)) {
    usage(`--display must match ${SAFE_TEXT} (no quotes, braces, backslashes or newlines)`);
  }

  const authorName = read("--author-name");
  if (authorName !== undefined && !SAFE_TEXT.test(authorName)) {
    usage(`--author-name must match ${SAFE_TEXT}`);
  }
  const repo = read("--repo");
  if (repo !== undefined && !SAFE_URL.test(repo)) usage("--repo must be a plain https URL");
  let authorUrl = read("--author-url");
  if (authorUrl !== undefined && !SAFE_URL.test(authorUrl)) usage("--author-url must be a plain https URL");

  // Without this, --repo alone leaves the bare owner handle and author.url pointing at
  // the original author's account.
  if (authorUrl === undefined && repo !== undefined) {
    authorUrl = repo.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
    if (!SAFE_URL.test(authorUrl)) usage("could not derive an author URL from --repo; pass --author-url");
  }

  return {
    name,
    display,
    ...(authorName ? { authorName } : {}),
    ...(authorUrl ? { authorUrl } : {}),
    ...(repo ? { repo } : {}),
    apply: argv.includes("--apply"),
  };
}

type Rule = { source: string; replacement: string };

const escapeLiteral = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Ordered rules; the first alternative that matches at a position wins.
 *
 * The subtle case is a single-word current name, where the kebab and snake forms are the
 * SAME string. A plain string map collapses them and one silently wins for every
 * occurrence, so a hyphenated new name would emit `plugins/new_name/` -- an invalid
 * plugin id. They are disambiguated by context instead: an occurrence followed by `_` is
 * a snake identifier, anything else is the kebab package or path form.
 */
function replacements(options: Options): Rule[] {
  const snake = options.name.replace(/-/g, "_");
  const rules: Rule[] = [];

  if (options.repo) rules.push({ source: escapeLiteral(OLD_REPO), replacement: options.repo });
  if (options.authorName) rules.push({ source: escapeLiteral(OLD_AUTHOR_NAME), replacement: options.authorName });
  if (options.authorUrl) {
    rules.push({
      source: escapeLiteral(`https://github.com/${OLD_AUTHOR_HANDLE}`),
      replacement: options.authorUrl,
    });
    rules.push({
      source: escapeLiteral(OLD_AUTHOR_HANDLE),
      replacement: basename(options.authorUrl.replace(/\/+$/, "")),
    });
  }
  rules.push({ source: escapeLiteral(OLD_DISPLAY.toUpperCase()), replacement: options.display.toUpperCase() });
  rules.push({ source: escapeLiteral(OLD_DISPLAY), replacement: options.display });

  if (OLD_KEBAB === OLD_SNAKE) {
    rules.push({ source: `${escapeLiteral(OLD_SNAKE)}(?=_)`, replacement: snake });
    rules.push({ source: escapeLiteral(OLD_KEBAB), replacement: options.name });
  } else {
    rules.push({ source: escapeLiteral(OLD_KEBAB), replacement: options.name });
    rules.push({ source: escapeLiteral(OLD_SNAKE), replacement: snake });
  }
  return rules;
}

/**
 * Replaces every token in ONE pass.
 *
 * Sequential passes are wrong here: a `--repo` value that legitimately contains the old
 * name would be rewritten again by a later rule. Each rule becomes a capture group so the
 * matching alternative -- not the matched text -- selects the replacement, which also
 * means lookaheads work and `$&`-style sequences in operator values are never treated as
 * replacement patterns.
 */
function applyText(text: string, rules: Rule[]): string {
  if (!rules.length) return text;
  const pattern = new RegExp(rules.map((rule) => `(${rule.source})`).join("|"), "g");
  return text.replace(pattern, (...args: unknown[]) => {
    const groups = args.slice(1, 1 + rules.length) as (string | undefined)[];
    const index = groups.findIndex((group) => group !== undefined);
    return index >= 0 ? rules[index]!.replacement : (args[0] as string);
  });
}

function countMatches(text: string, rules: Rule[]): number {
  if (!rules.length) return 0;
  const pattern = new RegExp(rules.map((rule) => `(?:${rule.source})`).join("|"), "g");
  return [...text.matchAll(pattern)].length;
}

/** Same-directory temp file plus rename, so an interrupted run cannot truncate a file. */
function atomicWrite(path: string, text: string): void {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, text, { encoding: "utf8" });
    renameSync(temp, path);
  } catch (error) {
    if (existsSync(temp)) rmSync(temp, { force: true });
    throw error;
  }
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

const isTextFile = (path: string): boolean => {
  const dot = path.lastIndexOf(".");
  const extension = dot < 0 ? "" : path.slice(dot).toLowerCase();
  if (BINARY_EXTENSIONS.has(extension)) return false;
  if (basename(path) === "bun.lock") return false;
  try {
    // A NUL byte in the first 8 KiB is the conventional binary heuristic.
    return !readFileSync(path).subarray(0, 8192).includes(0);
  } catch {
    return false;
  }
};

/** Extracts a shell heredoc body so its digest can be recomputed after renaming. */
function heredocBody(text: string, tag: string): string | undefined {
  const start = text.indexOf(`<<'${tag}'\n`);
  if (start < 0) return undefined;
  const bodyStart = start + `<<'${tag}'\n`.length;
  const end = text.indexOf(`\n${tag}\n`, bodyStart);
  if (end < 0) return undefined;
  return `${text.slice(bodyStart, end)}\n`;
}

async function main(): Promise<void> {
  const options = parseArgs();
  const pairs = replacements(options);

  const files = walk(root)
    .filter(isTextFile)
    .filter((path) => !SKIP_CONTENT_FILES.has(basename(path)));
  const contentChanges: { path: string; next: string; hits: number }[] = [];
  for (const path of files) {
    const text = readFileSync(path, "utf8");
    const next = applyText(text, pairs);
    if (next !== text) {
      const hits = countMatches(text, pairs);
      contentChanges.push({ path, next, hits });
    }
  }

  // Every file, plus every directory that contains one. The repository root itself is
  // never a candidate: renaming the checkout is the operator's job, not this tool's.
  const candidates = new Set<string>();
  for (const file of walk(root)) {
    candidates.add(file);
    for (let dir = dirname(file); dir.startsWith(root) && dir !== root; dir = dirname(dir)) {
      candidates.add(dir);
    }
  }

  // Deepest paths first so renaming a parent directory cannot invalidate a child path.
  const pathChanges = [...candidates]
    .filter((path) => {
      const rel = relative(root, path);
      return rel !== "" && !rel.startsWith("..");
    })
    .filter((path) => basename(path).includes(OLD_KEBAB) || basename(path).includes(OLD_SNAKE))
    .sort((a, b) => b.split(sep).length - a.split(sep).length)
    .map((path) => ({ from: path, to: join(dirname(path), applyText(basename(path), pairs)) }));

  console.log(`rebrand plan: ${OLD_KEBAB} -> ${options.name} ("${OLD_DISPLAY}" -> "${options.display}")\n`);
  console.log(`paths to rename (${pathChanges.length}):`);
  for (const change of pathChanges) console.log(`  ${relative(root, change.from)}  ->  ${relative(root, change.to)}`);
  console.log(`\nfiles to rewrite (${contentChanges.length}):`);
  for (const change of contentChanges) {
    console.log(`  ${relative(root, change.path)}  (${change.hits} occurrence${change.hits === 1 ? "" : "s"})`);
  }
  console.log(`\nnot touched (edit by hand if you intend to): ${[...SKIP_CONTENT_FILES].join(", ")}`);
  console.log("\nderived values that will be recomputed:");
  console.log("  tools/schema/tools.digest              (sha256 of the exposed MCP tool surface)");
  console.log("  scripts/install-agents.sh              (legacy v0.2.0 migration fingerprints)");
  console.log("  scripts/verify.sh                      (legacy v0.2.0 migration fingerprints)");

  if (!options.apply) {
    console.log("\nDRY RUN. Re-run with --apply to write these changes.");
    return;
  }

  for (const change of contentChanges) atomicWrite(change.path, change.next);
  for (const change of pathChanges) {
    if (!existsSync(change.from) || existsSync(change.to)) continue;
    renameSync(change.from, change.to);
  }

  // ---- Recompute derived digests -----------------------------------------
  const pluginDir = join(root, "plugins", options.name);
  const verifyPath = join(pluginDir, "scripts", "verify.sh");
  const installerPath = join(pluginDir, "scripts", "install-agents.sh");

  if (existsSync(verifyPath) && existsSync(installerPath)) {
    const verifyText = readFileSync(verifyPath, "utf8");
    const legacy: Record<string, string> = {};
    for (const [tag, key] of [
      ["LEGACY_TERRA", "legacy_terra_sha256"],
      ["LEGACY_LUNA", "legacy_luna_sha256"],
    ] as const) {
      const body = heredocBody(verifyText, tag);
      if (body) legacy[key] = createHash("sha256").update(body).digest("hex");
    }
    let nextVerify = verifyText;
    let nextInstaller = readFileSync(installerPath, "utf8");
    for (const [key, digest] of Object.entries(legacy)) {
      const pattern = new RegExp(`${key}=[0-9a-f]{64}`, "g");
      nextVerify = nextVerify.replace(pattern, `${key}=${digest}`);
      nextInstaller = nextInstaller.replace(pattern, `${key}=${digest}`);
      console.log(`  recomputed ${key}=${digest}`);
    }
    atomicWrite(verifyPath, nextVerify);
    atomicWrite(installerPath, nextInstaller);
  }

  const serverPath = join(pluginDir, "mcp", "server.ts");
  if (existsSync(serverPath) && statSync(serverPath).isFile()) {
    const module = (await import(serverPath)) as { TOOLS_DIGEST: string };
    const pin = `${module.TOOLS_DIGEST}  ${options.name}-tools-v1\n`;
    atomicWrite(join(root, "tools", "schema", "tools.digest"), pin);
    console.log(`  recomputed tool-surface digest ${module.TOOLS_DIGEST}`);
  }

  console.log(`
Rebrand applied.

NEXT STEPS
  1. bun run ci                 verify the renamed repository end to end
  2. Review plugin.json, .codex-plugin/plugin.json, and README.md by hand for any
     prose that a mechanical rename cannot fix.
  3. Update .agents/plugins/marketplace.json source path if you moved the package.

IMPORTANT
  The managed-file marker changed to "${options.name}-managed:v1". Adapter files
  installed by the previous build still carry the old marker, so this build will not
  recognise or remove them. Uninstall the old adapters with the previous build first,
  or delete them by hand before installing the renamed plugin.

  The retained legacy v0.2.0 migration lane now fingerprints renamed templates, which
  no real deployment ever shipped. If you are not migrating existing Codex users, the
  simplest correct action is to delete that lane from install-agents.sh and verify.sh.`);
}

await main();
