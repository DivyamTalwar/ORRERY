import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("compatibility doctor", () => {
  test("reports requested-vs-observed boundaries and missing adapters", () => {
    const report = diagnoseCompatibility("codex", workspace(), "linux");
    expect(report.status).toBe("not-installed");
    expect(report.runtimeTested).toBeTrue();
    expect(report.adapterFiles).toHaveLength(3);
    expect(report.unobservedClaims).toContain("actual-model");
    expect(report.warnings.at(-1)).toContain("cannot prove");
  });

  test("accepts only three regular managed adapter files", () => {
    const root = workspace();
    const target = join(root, ".codex", "agents");
    mkdirSync(target, { recursive: true });
    for (const role of ["routine", "high", "advisor"]) {
      writeFileSync(join(target, `orrery_${role}.toml`), "# orrery-managed:v1\n");
    }
    expect(diagnoseCompatibility("codex", root).status).toBe("ready");
    rmSync(join(target, "orrery_advisor.toml"));
    symlinkSync(join(target, "orrery_high.toml"), join(target, "orrery_advisor.toml"));
    expect(diagnoseCompatibility("codex", root).status).toBe("unsafe");
  });

  test("does not claim Windows runtime proof", () => {
    const report = diagnoseCompatibility("claude-code", workspace(), "win32");
    expect(report.runtimeTested).toBeFalse();
    expect(report.warnings.some((warning) => warning.includes("not continuously tested"))).toBeTrue();
  });
});
