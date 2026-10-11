import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readSettings } from "./local-tools.mjs";

export const serviceLabel = "com.mikeharty.amazon-mcp";
const xml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
export function servicePlist(root, node) {
  const values = [node, join(root, "scripts/local-start.mjs")].map((value) => `<string>${xml(value)}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${serviceLabel}</string>
<key>ProgramArguments</key><array>${values}</array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(join(root, ".local/logs/amazon-mcp.stdout.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(root, ".local/logs/amazon-mcp.stderr.log"))}</string>
</dict></plist>\n`;
}

export async function manageService(action, root = process.cwd(), options = {}) {
  if ((options.platform ?? process.platform) !== "darwin") throw new Error("Background service management is currently macOS only. Use pnpm run local:start on this platform.");
  if (!["install", "start", "stop", "restart", "status"].includes(action)) throw new Error("Use local:service install, start, stop, restart, or status.");
  root = resolve(root);
  const domain = `gui/${options.uid ?? process.getuid()}`;
  const target = `${domain}/${serviceLabel}`;
  const plist = join(options.homeDirectory ?? homedir(), "Library/LaunchAgents", `${serviceLabel}.plist`);
  const executeCommand = options.executeCommand ?? spawnSync;
  const command = (args) => executeCommand("launchctl", args, { encoding: "utf8" });
  const loaded = command(["print", target]).status === 0;
  let present = false;
  try {
    const stat = await lstat(plist);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
    present = true;
  } catch (error) { if (error.code !== "ENOENT") throw new Error("Background service configuration must be a regular private file."); }
  if (present) {
    const existing = executeCommand("plutil", ["-extract", "WorkingDirectory", "raw", "-o", "-", plist], { encoding: "utf8" });
    if (existing.status !== 0 || resolve(existing.stdout.trim()) !== root)
      throw new Error("A background service belongs to another checkout. Run local:service from that checkout; this command will not replace it.");
  } else if (loaded) throw new Error("A loaded service has no matching local configuration. Inspect it before installing another.");
  if (action === "status") {
    console.log(`macOS service: ${loaded ? "loaded" : "stopped"}; configuration: ${present ? "installed" : "absent"}.`);
    console.log("Use pnpm run local:doctor to check gateway and worker readiness. Amazon sign-in is checked separately.");
    return;
  }
  const execute = (args) => { if (command(args).status !== 0) throw new Error("macOS service command failed. Check local:service status and .local/logs; no private details were printed."); };
  if (action === "stop") {
    if (loaded) execute(["bootout", target]);
    console.log("Background service stopped. Database and browser session are preserved.");
    return;
  }
  await readSettings(root);
  if (action === "install") {
    await readFile(join(root, "dist/apps/gateway/main.js")).catch(() => { throw new Error("Build the application first: pnpm run build."); });
    await mkdir(dirname(plist), { recursive: true });
    await mkdir(join(root, ".local/logs"), { recursive: true, mode: 0o700 });
    if (loaded) {
      console.log("Background service is already loaded for this checkout. Configuration preserved; use local:service restart after rebuilding.");
      return;
    }
    const temporary = `${plist}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, servicePlist(root, process.execPath), { mode: 0o600, flag: "wx" });
      await rename(temporary, plist);
    } finally { await unlink(temporary).catch(() => undefined); }
    execute(["bootstrap", domain, plist]);
  } else if (!present) throw new Error("No service installed. Run pnpm run local:service install first.");
  else if (!loaded) execute(["bootstrap", domain, plist]);
  else if (action === "restart") execute(["kickstart", "-k", target]);
  console.log("Background service requested. Verify readiness with pnpm run local:doctor; logs are in .local/logs/.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await manageService(process.argv[2] ?? "status"); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
