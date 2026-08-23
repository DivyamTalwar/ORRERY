import { describe, expect, test } from "bun:test";
import { compileToolPolicy } from "./tool-registry";

const tool = (name: string, properties: Record<string, unknown> = {}, readOnlyHint = false) => ({
  name,
  inputSchema: { type: "object", properties },
  annotations: { readOnlyHint },
});

describe("compiled tool policy", () => {
  test("derives argument allowlists and readonly state from schemas", () => {
    const policy = compileToolPolicy(
      [tool("status", {}, true), tool("install", { workspace: {}, confirmationToken: {} })],
      ["install"],
    );
    expect(policy.argumentsByTool.get("status")).toEqual([]);
    expect(policy.argumentsByTool.get("install")).toEqual(["workspace", "confirmationToken"]);
    expect(policy.readOnly.has("status")).toBeTrue();
    expect(policy.recovery.has("install")).toBeTrue();
    expect(policy.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("refuses duplicate names and unknown recovery capabilities", () => {
    expect(() => compileToolPolicy([tool("same"), tool("same")], [])).toThrow("duplicate tool name");
    expect(() => compileToolPolicy([tool("status")], ["missing"])).toThrow("unknown recovery tool");
  });

  test("digest is independent of object key insertion order", () => {
    const left = compileToolPolicy([tool("x", { alpha: {}, beta: {} })], []);
    const right = compileToolPolicy([tool("x", { beta: {}, alpha: {} })], []);
    expect(left.digest).toBe(right.digest);
  });
});
