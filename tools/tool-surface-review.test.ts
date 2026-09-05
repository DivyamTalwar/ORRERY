import { describe, expect, test } from "bun:test";
import { compareToolPolicies, snapshotToolPolicy, type ToolPolicySnapshot } from "./tool-surface-review";

const tool = (
  name: string,
  properties: Record<string, unknown> = {},
  annotations: Record<string, boolean> = { readOnlyHint: true },
) => ({ name, inputSchema: { properties }, annotations });

describe("tool-surface policy review", () => {
  test("projects a deterministic, explicit policy", () => {
    const snapshot = snapshotToolPolicy([
      tool("zeta", { beta: {}, alpha: {} }),
      tool("alpha", {}, { readOnlyHint: false, destructiveHint: true }),
    ], "abc");
    expect(snapshot.tools.map((entry) => entry.name)).toEqual(["alpha", "zeta"]);
    expect(snapshot.tools[1]!.arguments).toEqual(["alpha", "beta"]);
    expect(snapshot.tools[0]!.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  test("escalates a readonly downgrade and new arguments", () => {
    const before = snapshotToolPolicy([tool("read", {}, { readOnlyHint: true })], "before");
    const after = snapshotToolPolicy([tool("read", { path: {} }, { readOnlyHint: false })], "after");
    const review = compareToolPolicies(before, after);
    expect(review.permissionExpansion).toBeTrue();
    expect(review.requiresReapproval).toBeTrue();
    expect(review.changes.map((item) => [item.code, item.severity])).toEqual([
      ["argument-added", "high"],
      ["annotation-changed", "critical"],
    ]);
  });

  test("keeps description-only digest changes visible", () => {
    const policy = snapshotToolPolicy([tool("read")], "before");
    const after: ToolPolicySnapshot = { ...policy, surfaceDigest: "after" };
    const review = compareToolPolicies(policy, after);
    expect(review.permissionExpansion).toBeFalse();
    expect(review.changes).toHaveLength(1);
    expect(review.changes[0]!.code).toBe("contract-content-changed");
  });

  test("reports an unchanged approved policy without noise", () => {
    const policy = snapshotToolPolicy([tool("read")], "same");
    expect(compareToolPolicies(policy, policy)).toEqual({
      schema: 1,
      beforeDigest: "same",
      afterDigest: "same",
      changed: false,
      permissionExpansion: false,
      requiresReapproval: false,
      changes: [],
    });
  });
});
