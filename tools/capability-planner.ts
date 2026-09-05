#!/usr/bin/env bun
import { CLIENT_PROFILES, CLIENTS, type Client, type Scope } from "../plugins/orrery/mcp/server";

export type ReadOnlyRequirement = "prompt-only" | "frontmatter-flag" | "tool-allowlist" | "os-sandbox";

export type CapabilityRequirements = {
  requireEffort: boolean;
  minimumReadOnly: ReadOnlyRequirement;
  scope: Scope;
  clients?: readonly Client[];
};

export type CapabilityDecision = {
  client: Client;
  eligible: boolean;
  bindsEffort: boolean;
  readOnlyMechanism: ReadOnlyRequirement;
  adapterDirectory: string;
  losses: Array<{ code: "effort-unbound" | "readonly-too-weak"; detail: string }>;
  warnings: string[];
};

export type CapabilityPlan = {
  schema: 1;
  requirements: CapabilityRequirements;
  bestFit: Client | null;
  compatible: Client[];
  refused: Client[];
  decisions: CapabilityDecision[];
  note: string;
};

const strength: Record<ReadOnlyRequirement, number> = {
  "prompt-only": 0,
  "frontmatter-flag": 1,
  "tool-allowlist": 2,
  "os-sandbox": 3,
};

function selectedClients(clients: readonly Client[] | undefined): Client[] {
  if (!clients) return [...CLIENTS];
  const unique = new Set<Client>();
  for (const client of clients) {
    if (!(CLIENTS as readonly string[]).includes(client)) throw new Error(`unsupported client: ${client}`);
    unique.add(client);
  }
  if (!unique.size) throw new Error("at least one client must be selected");
  return CLIENTS.filter((client) => unique.has(client));
}

export function planCapabilities(requirements: CapabilityRequirements): CapabilityPlan {
  if (!(requirements.minimumReadOnly in strength)) {
    throw new Error(`unsupported read-only requirement: ${requirements.minimumReadOnly}`);
  }
  if (requirements.scope !== "project" && requirements.scope !== "user") {
    throw new Error("scope must be project or user");
  }

  const decisions = selectedClients(requirements.clients).map((client): CapabilityDecision => {
    const profile = CLIENT_PROFILES[client];
    const losses: CapabilityDecision["losses"] = [];
    if (requirements.requireEffort && !profile.bindsEffort) {
      losses.push({
        code: "effort-unbound",
        detail: `${client} cannot bind reasoning effort per agent`,
      });
    }
    if (strength[profile.readOnly] < strength[requirements.minimumReadOnly]) {
      losses.push({
        code: "readonly-too-weak",
        detail: `${client} offers ${profile.readOnly}; ${requirements.minimumReadOnly} or stronger was required`,
      });
    }
    const segments = requirements.scope === "project" ? profile.projectDir : profile.userDir;
    return {
      client,
      eligible: losses.length === 0,
      bindsEffort: profile.bindsEffort,
      readOnlyMechanism: profile.readOnly,
      adapterDirectory: segments.join("/"),
      losses,
      warnings: [...profile.warnings],
    };
  });

  const compatible = decisions
    .filter((decision) => decision.eligible)
    .sort((left, right) => {
      const readonly = strength[right.readOnlyMechanism] - strength[left.readOnlyMechanism];
      if (readonly) return readonly;
      const effort = Number(right.bindsEffort) - Number(left.bindsEffort);
      if (effort) return effort;
      return CLIENTS.indexOf(left.client) - CLIENTS.indexOf(right.client);
    })
    .map((decision) => decision.client);

  return {
    schema: 1,
    requirements: { ...requirements, ...(requirements.clients ? { clients: [...requirements.clients] } : {}) },
    bestFit: compatible[0] ?? null,
    compatible,
    refused: decisions.filter((decision) => !decision.eligible).map((decision) => decision.client),
    decisions,
    note:
      "This is static capability negotiation. A compatible adapter is still a request to the host; only live observation proves the model, effort, and isolation actually used.",
  };
}

function parseCli(argv: string[]): CapabilityRequirements {
  const allowed = new Set(["--require-effort", "--minimum-readonly", "--scope", "--client"]);
  const clients: Client[] = [];
  let requireEffort = false;
  let minimumReadOnly: ReadOnlyRequirement = "prompt-only";
  let scope: Scope = "project";
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!allowed.has(flag)) throw new Error(`unknown argument: ${flag}`);
    if (flag === "--require-effort") {
      requireEffort = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    index += 1;
    if (flag === "--minimum-readonly") minimumReadOnly = value as ReadOnlyRequirement;
    else if (flag === "--scope") scope = value as Scope;
    else clients.push(value as Client);
  }
  return { requireEffort, minimumReadOnly, scope, ...(clients.length ? { clients } : {}) };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(planCapabilities(parseCli(process.argv.slice(2))), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
