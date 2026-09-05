import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tools, TOOLS_DIGEST } from "../plugins/orrery/mcp/server";

export const POLICY_ANNOTATIONS = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
] as const;

export type PolicyAnnotation = (typeof POLICY_ANNOTATIONS)[number];

type RegisteredTool = {
  name: string;
  inputSchema: { properties?: Record<string, unknown> };
  annotations: Partial<Record<PolicyAnnotation, boolean>>;
};

export type ToolPolicyEntry = {
  name: string;
  arguments: string[];
  annotations: Record<PolicyAnnotation, boolean>;
};

export type ToolPolicySnapshot = {
  schema: 1;
  surfaceDigest: string;
  tools: ToolPolicyEntry[];
};

export type PolicyChange = {
  severity: "critical" | "high" | "review" | "low";
  code:
    | "tool-added"
    | "tool-removed"
    | "argument-added"
    | "argument-removed"
    | "annotation-changed"
    | "contract-content-changed";
  tool?: string;
  field?: string;
  before?: boolean | string;
  after?: boolean | string;
  detail: string;
};

export type ToolPolicyReview = {
  schema: 1;
  beforeDigest: string;
  afterDigest: string;
  changed: boolean;
  permissionExpansion: boolean;
  requiresReapproval: boolean;
  changes: PolicyChange[];
};

/**
 * Build the small, human-reviewable security projection of the complete registry digest.
 * The digest remains authoritative; this snapshot explains permission-bearing changes.
 */
export function snapshotToolPolicy(
  registry: readonly RegisteredTool[],
  surfaceDigest: string,
): ToolPolicySnapshot {
  const names = new Set<string>();
  const projected = registry.map((tool) => {
    if (names.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`);
    names.add(tool.name);
    const annotations = Object.fromEntries(
      POLICY_ANNOTATIONS.map((key) => [key, tool.annotations[key] === true]),
    ) as Record<PolicyAnnotation, boolean>;
    return {
      name: tool.name,
      arguments: Object.keys(tool.inputSchema.properties ?? {}).sort(),
      annotations,
    };
  });
  return { schema: 1, surfaceDigest, tools: projected.sort((a, b) => a.name.localeCompare(b.name)) };
}

const change = (
  severity: PolicyChange["severity"],
  code: PolicyChange["code"],
  detail: string,
  context: Omit<PolicyChange, "severity" | "code" | "detail"> = {},
): PolicyChange => ({ severity, code, detail, ...context });

const severityForAnnotation = (
  key: PolicyAnnotation,
  before: boolean,
  after: boolean,
): PolicyChange["severity"] => {
  if (key === "readOnlyHint" && before && !after) return "critical";
  if ((key === "destructiveHint" || key === "openWorldHint") && !before && after) return "high";
  if (key === "idempotentHint" && before && !after) return "review";
  return "low";
};

/** Compare two policy projections without treating MCP annotations as enforcement. */
export function compareToolPolicies(
  before: ToolPolicySnapshot,
  after: ToolPolicySnapshot,
): ToolPolicyReview {
  if (before.schema !== 1 || after.schema !== 1) throw new Error("unsupported tool policy schema");
  const changes: PolicyChange[] = [];
  const oldTools = new Map(before.tools.map((tool) => [tool.name, tool]));
  const newTools = new Map(after.tools.map((tool) => [tool.name, tool]));

  for (const name of [...newTools.keys()].sort()) {
    const current = newTools.get(name)!;
    const prior = oldTools.get(name);
    if (!prior) {
      const writable = !current.annotations.readOnlyHint;
      changes.push(change(writable ? "high" : "review", "tool-added", `Added ${writable ? "stateful" : "read-only"} tool ${name}.`, { tool: name }));
      continue;
    }
    for (const argument of current.arguments.filter((item) => !prior.arguments.includes(item)).sort()) {
      changes.push(change("high", "argument-added", `Tool ${name} accepts new argument ${argument}.`, { tool: name, field: argument }));
    }
    for (const argument of prior.arguments.filter((item) => !current.arguments.includes(item)).sort()) {
      changes.push(change("low", "argument-removed", `Tool ${name} no longer accepts argument ${argument}.`, { tool: name, field: argument }));
    }
    for (const key of POLICY_ANNOTATIONS) {
      const oldValue = prior.annotations[key];
      const newValue = current.annotations[key];
      if (oldValue === newValue) continue;
      changes.push(change(
        severityForAnnotation(key, oldValue, newValue),
        "annotation-changed",
        `Tool ${name} changed ${key} from ${oldValue} to ${newValue}.`,
        { tool: name, field: key, before: oldValue, after: newValue },
      ));
    }
  }
  for (const name of [...oldTools.keys()].filter((name) => !newTools.has(name)).sort()) {
    changes.push(change("low", "tool-removed", `Removed tool ${name}.`, { tool: name }));
  }

  if (before.surfaceDigest !== after.surfaceDigest && changes.length === 0) {
    changes.push(change(
      "review",
      "contract-content-changed",
      "The full contract digest changed without a permission projection change; review descriptions and schemas.",
    ));
  }
  const changed = before.surfaceDigest !== after.surfaceDigest || changes.length > 0;
  return {
    schema: 1,
    beforeDigest: before.surfaceDigest,
    afterDigest: after.surfaceDigest,
    changed,
    permissionExpansion: changes.some((item) => item.severity === "critical" || item.severity === "high"),
    requiresReapproval: changed,
    changes,
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--baseline") {
    throw new Error("usage: bun tools/tool-surface-review.ts --baseline <policy.json>");
  }
  const baseline = JSON.parse(readFileSync(resolve(args[1]!), "utf8")) as ToolPolicySnapshot;
  const current = snapshotToolPolicy(tools, TOOLS_DIGEST);
  console.log(JSON.stringify(compareToolPolicies(baseline, current), null, 2));
}

if (import.meta.main) main();
