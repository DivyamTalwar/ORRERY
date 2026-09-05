#!/usr/bin/env bun
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { CLIENT_PROFILES, CLIENTS, MANAGED_MARKER, type Client, type RoleName } from "../plugins/orrery/mcp/server";
import { sha256 } from "../plugins/orrery/mcp/integrity";

const roles: readonly RoleName[] = ["routine", "high", "advisor"];
const claudeAdvisorTools = ["Glob", "Grep", "Read"];

export type DeclaredRoleContract = {
  roleId?: string;
  model?: string;
  effort?: string;
  advisorControl?: string;
};

export type AdapterInspection = {
  role: RoleName;
  path: string;
  state: "managed-valid" | "managed-invalid" | "missing" | "unsafe";
  hash?: string;
  declared?: DeclaredRoleContract;
  issues: string[];
};

export type CompatibilityReport = {
  schema: 2;
  client: Client;
  platform: NodeJS.Platform;
  runtimeTested: boolean;
  bindsEffort: boolean;
  readOnlyMechanism: string;
  status: "ready" | "drifted" | "not-installed" | "unsafe";
  adapterFiles: AdapterInspection[];
  warnings: string[];
  observedClaims: readonly ["adapter-path", "managed-marker", "declared-role-fields", "advisor-control"];
  unobservedClaims: readonly ["actual-model", "actual-effort", "actual-sandbox", "advisor-behavior"];
};

function decoded(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return trimmed.replace(/^['"]|['"]$/g, "");
}

function tomlField(content: string, name: string): string | undefined {
  return decoded(content.match(new RegExp(`^${name}\\s*=\\s*(.+)$`, "m"))?.[1]);
}

function frontmatterField(frontmatter: string, name: string): string | undefined {
  return decoded(frontmatter.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]);
}

function parseContract(client: Client, role: RoleName, content: string): { declared: DeclaredRoleContract; issues: string[] } {
  const profile = CLIENT_PROFILES[client];
  const expectedRole = profile.roleId(role);
  const issues: string[] = [];
  let roleId: string | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  let advisorControl: string | undefined;

  if (profile.format === "toml") {
    roleId = tomlField(content, "name");
    model = tomlField(content, "model");
    effort = tomlField(content, "model_reasoning_effort");
    const sandbox = tomlField(content, "sandbox_mode");
    if (role === "advisor" && sandbox === "read-only") advisorControl = "os-sandbox";
  } else {
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
    if (!frontmatter) {
      issues.push("missing or malformed YAML frontmatter");
    } else {
      roleId = frontmatterField(frontmatter, "name");
      const renderedModel = frontmatterField(frontmatter, "model");
      if (client === "cursor" && renderedModel) {
        const match = renderedModel.match(/^(.*) \[effort=([^\]]+)\]$/);
        model = match?.[1] ?? renderedModel;
        effort = match?.[2];
      } else {
        model = renderedModel;
      }
      if (role === "advisor" && client === "cursor" && frontmatterField(frontmatter, "readonly") === "true") {
        advisorControl = "frontmatter-flag";
      }
      if (role === "advisor" && client === "claude-code") {
        const tools = frontmatterField(frontmatter, "tools")
          ?.split(",")
          .map((item) => item.trim())
          .filter(Boolean)
          .sort();
        if (tools && JSON.stringify(tools) === JSON.stringify(claudeAdvisorTools)) {
          advisorControl = "tool-allowlist";
        }
      }
      if (role === "advisor" && profile.readOnly === "prompt-only") advisorControl = "prompt-only";
    }
  }

  if (roleId !== expectedRole) issues.push(`role id is ${roleId ?? "missing"}; expected ${expectedRole}`);
  if (!model || /[\r\n\0]/.test(model)) issues.push("model declaration is missing or invalid");
  if (profile.bindsEffort && effort !== undefined && (!effort || /[\r\n\0]/.test(effort))) {
    issues.push("effort declaration is invalid");
  }
  if (role === "advisor" && advisorControl !== profile.readOnly) {
    issues.push(`advisor control is ${advisorControl ?? "missing"}; expected ${profile.readOnly}`);
  }

  return {
    declared: {
      ...(roleId ? { roleId } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(advisorControl ? { advisorControl } : {}),
    },
    issues,
  };
}

function inspectFile(client: Client, role: RoleName, path: string): AdapterInspection {
  if (!existsSync(path)) return { role, path, state: "missing", issues: [] };
  const lexical = lstatSync(path);
  if (lexical.isSymbolicLink() || !lexical.isFile()) {
    return { role, path, state: "unsafe", issues: ["destination is not a regular non-symlink file"] };
  }
  const content = readFileSync(path, "utf8");
  const hash = sha256(content);
  if (!content.includes(MANAGED_MARKER)) {
    return { role, path, state: "unsafe", hash, issues: ["managed ownership marker is absent"] };
  }
  const parsed = parseContract(client, role, content);
  return {
    role,
    path,
    state: parsed.issues.length ? "managed-invalid" : "managed-valid",
    hash,
    declared: parsed.declared,
    issues: parsed.issues,
  };
}

export function diagnoseCompatibility(
  client: Client,
  workspaceInput: string,
  platform: NodeJS.Platform = process.platform,
): CompatibilityReport {
  const workspace = resolve(workspaceInput);
  if (!existsSync(workspace) || lstatSync(workspace).isSymbolicLink() || !statSync(workspace).isDirectory()) {
    throw new Error(`workspace must be an existing non-symlink directory: ${workspace}`);
  }
  const workspaceReal = realpathSync(workspace);
  const profile = CLIENT_PROFILES[client];
  const adapterFiles = roles.map((role) =>
    inspectFile(client, role, join(workspaceReal, ...profile.projectDir, `orrery-${role}${profile.extension}`)),
  );
  const status = adapterFiles.some((file) => file.state === "unsafe")
    ? "unsafe"
    : adapterFiles.some((file) => file.state === "managed-invalid")
      ? "drifted"
      : adapterFiles.every((file) => file.state === "managed-valid")
        ? "ready"
        : "not-installed";
  const runtimeTested = platform === "linux" || platform === "darwin";
  const warnings = [
    ...profile.warnings,
    ...(!runtimeTested ? ["Orrery's stateful runtime is not continuously tested on this platform."] : []),
    "Static adapter inspection proves declared file semantics, not the model, effort, sandbox, or advisor behavior a live host actually used.",
  ];
  return {
    schema: 2,
    client,
    platform,
    runtimeTested,
    bindsEffort: profile.bindsEffort,
    readOnlyMechanism: profile.readOnly,
    status,
    adapterFiles,
    warnings,
    observedClaims: ["adapter-path", "managed-marker", "declared-role-fields", "advisor-control"],
    unobservedClaims: ["actual-model", "actual-effort", "actual-sandbox", "advisor-behavior"],
  };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) {
  const workspace = argument("--workspace") ?? process.cwd();
  const requested = argument("--client");
  if (requested && !(CLIENTS as readonly string[]).includes(requested)) {
    throw new Error(`unsupported client: ${requested}`);
  }
  const selected = requested ? [requested as Client] : [...CLIENTS];
  console.log(JSON.stringify(selected.map((client) => diagnoseCompatibility(client, workspace)), null, 2));
}
