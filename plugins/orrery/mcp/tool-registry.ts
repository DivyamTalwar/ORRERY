import { canonicalJson, sha256 } from "./integrity";

type RegisteredTool = {
  name: string;
  inputSchema: { properties?: Record<string, unknown> };
  annotations: { readOnlyHint?: boolean };
};

export type ToolPolicy = {
  digest: string;
  readOnly: ReadonlySet<string>;
  recovery: ReadonlySet<string>;
  argumentsByTool: ReadonlyMap<string, readonly string[]>;
};

/** Compile every derived security index from the exposed registry. */
export function compileToolPolicy(
  tools: readonly RegisteredTool[],
  recoveryTools: readonly string[],
): ToolPolicy {
  const argumentsByTool = new Map<string, readonly string[]>();
  const readOnly = new Set<string>();
  for (const tool of tools) {
    if (argumentsByTool.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`);
    argumentsByTool.set(tool.name, Object.freeze(Object.keys(tool.inputSchema.properties ?? {})));
    if (tool.annotations.readOnlyHint) readOnly.add(tool.name);
  }

  const recovery = new Set<string>();
  for (const name of recoveryTools) {
    if (!argumentsByTool.has(name)) throw new Error(`unknown recovery tool: ${name}`);
    recovery.add(name);
  }

  return Object.freeze({
    digest: sha256(canonicalJson(tools)),
    readOnly,
    recovery,
    argumentsByTool,
  });
}
