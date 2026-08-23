#!/usr/bin/env bun
import { compileToolPolicy } from "../plugins/orrery/mcp/tool-registry";
import { tools } from "../plugins/orrery/mcp/server";

const iterations = 10_000;
const started = performance.now();
let digest = "";
for (let index = 0; index < iterations; index += 1) {
  digest = compileToolPolicy(tools, [
    "install_client_adapter",
    "uninstall_client_adapter",
    "reset_configuration",
  ]).digest;
}
const elapsedMs = performance.now() - started;
console.log(JSON.stringify({
  iterations,
  elapsedMs: Number(elapsedMs.toFixed(3)),
  microsecondsPerCompile: Number(((elapsedMs * 1000) / iterations).toFixed(3)),
  digest,
}, null, 2));
