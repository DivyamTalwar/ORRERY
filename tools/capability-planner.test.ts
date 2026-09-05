import { describe, expect, test } from "bun:test";
import { planCapabilities } from "./capability-planner";

describe("capability planner", () => {
  test("returns every client for the weakest portable contract", () => {
    const plan = planCapabilities({ requireEffort: false, minimumReadOnly: "prompt-only", scope: "project" });
    expect(plan.compatible).toHaveLength(6);
    expect(plan.bestFit).toBe("codex");
    expect(plan.refused).toEqual([]);
  });

  test("fails closed when both effort and OS isolation are required", () => {
    const plan = planCapabilities({ requireEffort: true, minimumReadOnly: "os-sandbox", scope: "project" });
    expect(plan.compatible).toEqual(["codex"]);
    expect(plan.refused).toHaveLength(5);
    expect(plan.decisions.find((item) => item.client === "claude-code")?.losses.map((loss) => loss.code)).toEqual([
      "effort-unbound",
      "readonly-too-weak",
    ]);
  });

  test("distinguishes tool allowlists from flags and prompt-only requests", () => {
    const plan = planCapabilities({
      requireEffort: false,
      minimumReadOnly: "tool-allowlist",
      scope: "project",
    });
    expect(plan.compatible).toEqual(["codex", "claude-code"]);
    expect(plan.refused).toEqual(["cursor", "vscode", "github-copilot", "kiro"]);
  });

  test("keeps selection deterministic and reports user adapter directories", () => {
    const plan = planCapabilities({
      requireEffort: false,
      minimumReadOnly: "prompt-only",
      scope: "user",
      clients: ["kiro", "codex", "kiro"],
    });
    expect(plan.decisions.map((item) => item.client)).toEqual(["codex", "kiro"]);
    expect(plan.decisions.map((item) => item.adapterDirectory)).toEqual([".codex/agents", ".kiro/agents"]);
  });
});
