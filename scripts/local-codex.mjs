import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { gatewayRunning, readSettings } from "./local-tools.mjs";

try {
  const settings = await readSettings();
  if (!await gatewayRunning(settings.origin)) {
    console.error("The local MCP gateway is not running. Run pnpm run local:onboard or start the installed service first.");
    process.exit(1);
  }
  console.log(`Opening Codex CLI with the local Amazon MCP at ${settings.origin}/mcp. The token stays in the child process environment.`);
  // Probe without displaying private existing settings. A disabled entry still
  // needs a transport, so only disable amazon if it was already registered.
  const existing = spawnSync("codex", ["mcp", "get", "amazon", "--json"], { encoding: "utf8", timeout: 10_000 });
  if (existing.error) throw new Error("Codex CLI is unavailable.");
  const child = spawn("codex", [
    // A separate entry avoids inheriting a stale literal Authorization header
    // from an older manual setup. Disable that duplicate for this session only.
    ...(existing.status === 0 ? ["-c", "mcp_servers.amazon.enabled=false"] : []),
    "-c", `mcp_servers.amazon_local={url=${JSON.stringify(`${settings.origin}/mcp`)},bearer_token_env_var="MCP_TOKEN"}`,
    ...process.argv.slice(2),
  ], { stdio: "inherit", env: { ...process.env, MCP_TOKEN: settings.env.MCP_TOKEN } });
  const [code] = await once(child, "exit");
  process.exitCode = code ?? 1;
} catch {
  console.error("Could not open Codex. Run local:onboard and check that the Codex CLI is installed. No private error details were printed.");
  process.exitCode = 1;
}
