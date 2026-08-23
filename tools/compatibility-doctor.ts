#!/usr/bin/env bun
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { CLIENT_PROFILES, CLIENTS, MANAGED_MARKER, type Client, type RoleName } from "../plugins/orrery/mcp/server";

const roles: readonly RoleName[] = ["routine", "high", "advisor"];

export type CompatibilityReport = {
  schema: 1;
  client: Client;
  platform: NodeJS.Platform;
  runtimeTested: boolean;
  bindsEffort: boolean;
  readOnlyMechanism: string;
  status: "ready" | "not-installed" | "unsafe";
  adapterFiles: Array<{ role: RoleName; path: string; state: "managed" | "missing" | "unsafe" }>;
  warnings: string[];
  observedClaims: readonly ["adapter-path", "managed-marker"];
  unobservedClaims: readonly ["actual-model", "actual-effort", "actual-sandbox", "advisor-behavior"];
};

function existingFileState(path: string): "managed" | "missing" | "unsafe" {
  if (!existsSync(path)) return "missing";
  const lexical = lstatSync(path);
  if (lexical.isSymbolicLink() || !lexical.isFile()) return "unsafe";
  const content = readFileSync(path, "utf8");
  return content.includes(MANAGED_MARKER) ? "managed" : "unsafe";
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
  const adapterFiles = roles.map((role) => {
    const path = join(workspaceReal, ...profile.projectDir, `${profile.roleId(role)}${profile.extension}`);
    return { role, path, state: existingFileState(path) };
  });
  const status = adapterFiles.some((file) => file.state === "unsafe")
    ? "unsafe"
    : adapterFiles.every((file) => file.state === "managed")
      ? "ready"
      : "not-installed";
  const runtimeTested = platform === "linux" || platform === "darwin";
  const warnings = [
    ...profile.warnings,
    ...(!runtimeTested ? ["Orrery's stateful runtime is not continuously tested on this platform."] : []),
    "Static adapter inspection cannot prove the model, effort, sandbox, or advisor behavior a live host actually used.",
  ];
  return {
    schema: 1,
    client,
    platform,
    runtimeTested,
    bindsEffort: profile.bindsEffort,
    readOnlyMechanism: profile.readOnly,
    status,
    adapterFiles,
    warnings,
    observedClaims: ["adapter-path", "managed-marker"],
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
