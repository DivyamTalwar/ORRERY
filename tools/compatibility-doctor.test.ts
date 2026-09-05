import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CLIENT_PROFILES,
  CLIENTS,
  PLUGIN_VERSION,
  TOOLS_DIGEST,
  renderPlan,
  type Client,
  type Preferences,
} from "../plugins/orrery/mcp/server";
import { diagnoseCompatibility } from "./compatibility-doctor";

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "orrery-doctor-"));
  roots.push(root);
  return root;
}

function preferences(client: Client, root: string): Preferences {
  const effort = CLIENT_PROFILES[client].bindsEffort ? { effort: "high" } : {};
  return {
    schemaVersion: 2,
    client,
    scope: "project",
    workspace: root,
    orchestrator: { model: "inherit" },
    roles: {
      routine: { model: "routine-model", ...effort },
      high: { model: "high-model", ...effort },
      advisor: { model: "advisor-model", ...effort, readonly: true },
    },
    fallbackPolicy: "fail-closed",
    fallbacks: [],
    approvedToolsDigest: TOOLS_DIGEST,
    profileKey: `${client}:project:test`,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    pluginVersion: PLUGIN_VERSION,
  };
}

function installRendered(client: Client, root: string): ReturnType<typeof renderPlan> {
  const plan = renderPlan(preferences(client, root), root);
  for (const file of plan.files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content);
  }
  return plan;
}

describe("compatibility doctor", () => {
  test("reports requested-vs-observed boundaries and exact missing adapter paths", () => {
    const root = workspace();
    const report = diagnoseCompatibility("codex", root, "linux");
    expect(report.schema).toBe(2);
    expect(report.status).toBe("not-installed");
    expect(report.runtimeTested).toBeTrue();
    expect(report.adapterFiles[0]?.path).toBe(join(root, ".codex", "agents", "orrery-routine.toml"));
    expect(report.unobservedClaims).toContain("actual-model");
    expect(report.warnings.at(-1)).toContain("not the model");
  });

  test("semantically validates the real renderer for every supported client", () => {
    for (const client of CLIENTS) {
      const root = workspace();
      installRendered(client, root);
      const report = diagnoseCompatibility(client, root);
      expect(report.status).toBe("ready");
      expect(report.adapterFiles.every((file) => file.state === "managed-valid")).toBeTrue();
      expect(report.adapterFiles.find((file) => file.role === "advisor")?.declared?.model).toBe("advisor-model");
    }
  });

  test("does not accept a marker-only or weakened advisor file as ready", () => {
    const root = workspace();
    const plan = installRendered("codex", root);
    const routine = plan.files.find((file) => file.role === "routine")!;
    writeFileSync(routine.path, "# orrery-managed:v1\n");
    expect(diagnoseCompatibility("codex", root).status).toBe("drifted");

    writeFileSync(routine.path, routine.content);
    const advisor = plan.files.find((file) => file.role === "advisor")!;
    writeFileSync(advisor.path, advisor.content.replace('sandbox_mode = "read-only"', 'sandbox_mode = "workspace-write"'));
    const report = diagnoseCompatibility("codex", root);
    expect(report.status).toBe("drifted");
    expect(report.adapterFiles.find((file) => file.role === "advisor")?.issues[0]).toContain("advisor control");
  });

  test("rejects symlinked role files and does not claim Windows runtime proof", () => {
    const root = workspace();
    const plan = installRendered("claude-code", root);
    const advisor = plan.files.find((file) => file.role === "advisor")!;
    rmSync(advisor.path);
    symlinkSync(plan.files[0]!.path, advisor.path);
    const report = diagnoseCompatibility("claude-code", root, "win32");
    expect(report.status).toBe("unsafe");
    expect(report.runtimeTested).toBeFalse();
    expect(report.warnings.some((warning) => warning.includes("not continuously tested"))).toBeTrue();
  });
});
