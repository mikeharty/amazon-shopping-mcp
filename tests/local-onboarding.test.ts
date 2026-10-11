import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
// These scripts deliberately run before TypeScript dependencies are installed.
// @ts-expect-error Node-only onboarding helpers have no generated declaration file.
import { accessMode, readSettings, setAccessMode, supportedNode } from "../scripts/local-tools.mjs";
// @ts-expect-error Node-only service helper has no generated declaration file.
import { manageService, servicePlist } from "../scripts/local-service.mjs";

const roots: string[] = [];
async function fixture(extra = "") {
  const root = await mkdtemp(join(tmpdir(), "amazon onboarding "));
  roots.push(root);
  await writeFile(join(root, ".env"), `# Preserve my configuration\nMCP_TOKEN=${"m".repeat(40)}\nOWNER_TOKEN=${"o".repeat(40)}\nDATABASE_URL='postgres://private:opaque@localhost/example'\nPORT=3433\n${extra}`, { mode: 0o600 });
  return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("guided setup configuration", () => {
  it.each(["offline", "read-only", "purchasing"])("changes only access flags for %s", async (mode) => {
    const root = await fixture(" AMAZON_READ_ONLY=false\nexport AMAZON_READ_ONLY=true\nAMAZON_PURCHASING_ENABLED=true\nAMAZON_LIVE_ENABLED=true\nCUSTOM_VALUE='a=b # retained'\n");
    const before = (await readSettings(root)).env;
    await setAccessMode(mode, root);
    const text = await readFile(join(root, ".env"), "utf8");
    const after = parseEnv(text);
    expect(accessMode(after)).toBe(mode);
    for (const key of ["MCP_TOKEN", "OWNER_TOKEN", "DATABASE_URL", "PORT", "CUSTOM_VALUE"]) expect(after[key]).toBe(before[key]);
    expect(text).toContain("# Preserve my configuration");
    expect(text.match(/^AMAZON_READ_ONLY=/gm)).toHaveLength(1);
    if (process.platform !== "win32") expect((await stat(join(root, ".env"))).mode & 0o777).toBe(0o600);
  });

  it("rejects invalid modes before changing any private file", async () => {
    const root = await fixture();
    const before = await readFile(join(root, ".env"), "utf8");
    await expect(setAccessMode("buy-everything", root)).rejects.toThrow("Choose offline");
    expect(await readFile(join(root, ".env"), "utf8")).toBe(before);
  });

  it("does not follow a private configuration symlink", async () => {
    const root = await fixture();
    const target = join(root, "original.env");
    const before = await readFile(join(root, ".env"), "utf8");
    await writeFile(target, before);
    await rm(join(root, ".env"));
    await symlink(target, join(root, ".env"));
    await expect(setAccessMode("purchasing", root)).rejects.toThrow("regular private file");
    expect(await readFile(target, "utf8")).toBe(before);
  });

  it("does not rewrite access-looking text inside another multiline value", async () => {
    const root = await fixture('CUSTOM_VALUE="line one\nAMAZON_READ_ONLY=false\nline three"\n');
    const before = await readFile(join(root, ".env"), "utf8");
    await expect(setAccessMode("purchasing", root)).rejects.toThrow("multiline");
    expect(await readFile(join(root, ".env"), "utf8")).toBe(before);
  });

  it.each([["22.17.0", false], ["22.18.0", true], ["23.1.0", false], ["24.0.0", true], ["25.9.0", false], ["26.0.0", true]])("checks the selected runtime %s", (version, supported) => {
    expect(supportedNode(version)).toBe(supported);
  });
});

describe("setup entry points", () => {
  it("requires explicit noninteractive choices before installation", async () => {
    const root = await fixture();
    const before = await readFile(join(root, ".env"), "utf8");
    const result = spawnSync(process.execPath, [resolve("scripts/local-onboard.mjs")], { cwd: root, env: { ...process.env, npm_execpath: process.execPath }, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("specify both --mode and a startup choice");
    expect(await readFile(join(root, ".env"), "utf8")).toBe(before);
  });

  it("rejects conflicting startup choices before installation", async () => {
    const root = await fixture();
    const result = spawnSync(process.execPath, [resolve("scripts/local-onboard.mjs"), "--mode", "offline", "--foreground", "--background"], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("either foreground or background");
  });

  it("escapes service paths and stores no authentication values in the plist", () => {
    const text = servicePlist('/tmp/Mike & "Amazon"', "/path/<node>");
    expect(text).toContain("Mike &amp; &quot;Amazon&quot;");
    expect(text).toContain("/path/&lt;node&gt;");
    expect(text).not.toMatch(/MCP_TOKEN|OWNER_TOKEN|DATA_ENCRYPTION_KEY/);
    expect(text).toContain("scripts/local-start.mjs");
  });

  it.each(["registered", "fresh"])("launches %s Codex using a private environment token, preserving arguments and config files", async (kind) => {
    if (process.platform === "win32") return;
    const server = createServer((_request, response) => { response.setHeader("Content-Type", "application/json"); response.end('{"status":"running"}'); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No test port");
      const root = await fixture();
      await writeFile(join(root, ".env"), `PORT=${address.port}\nMCP_TOKEN=${"m".repeat(40)}\n`);
      const configBefore = await readFile(join(root, ".env"), "utf8");
      await writeFile(join(root, "codex"), `#!${process.execPath}\nif(process.argv[2]==='mcp')process.exit(${kind === "registered" ? 0 : 1});\nrequire('node:fs').writeFileSync('codex-call.json', JSON.stringify({args:process.argv.slice(2),token:process.env.MCP_TOKEN}));\n`, { mode: 0o700 });
      // Run asynchronously so this process can serve the local health request.
      const { spawn } = await import("node:child_process");
      const child = spawn(process.execPath, [resolve("scripts/local-codex.mjs"), "--help"], { cwd: root, env: { ...process.env, PATH: `${root}:${process.env.PATH}`, MCP_TOKEN: "wrong-inherited-token" }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (data) => { output += data; });
      child.stderr.on("data", (data) => { output += data; });
      const [code] = await once(child, "exit");
      expect(code, output).toBe(0);
      const call = JSON.parse(await readFile(join(root, "codex-call.json"), "utf8"));
      expect(call.token).toBe("m".repeat(40));
      expect(call.args.at(-1)).toBe("--help");
      if (kind === "registered") expect(call.args[1]).toBe("mcp_servers.amazon.enabled=false");
      else expect(call.args.join(" ")).not.toContain("amazon.enabled");
      const override = call.args[kind === "registered" ? 3 : 1];
      expect(override).toContain(`http://127.0.0.1:${address.port}/mcp`);
      expect(override).toContain('bearer_token_env_var="MCP_TOKEN"');
      expect(call.args.join(" ")).not.toContain(call.token);
      expect(output).not.toContain(call.token);
      expect(await readFile(join(root, ".env"), "utf8")).toBe(configBefore);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});

describe("macOS service installation", () => {
  it("installs a private service and requests startup without claiming readiness", async () => {
    const root = await fixture();
    await mkdir(join(root, "dist/apps/gateway"), { recursive: true });
    await writeFile(join(root, "dist/apps/gateway/main.js"), "// synthetic compiled app");
    const homeDirectory = await mkdtemp(join(tmpdir(), "amazon service home "));
    roots.push(homeDirectory);
    const calls: string[][] = [];
    await manageService("install", root, { platform: "darwin", uid: 123, homeDirectory,
      executeCommand: (command: string, args: string[]) => { calls.push([command, ...args]); return { status: args[0] === "print" ? 1 : 0 }; },
    });
    const file = join(homeDirectory, "Library/LaunchAgents/com.mikeharty.amazon-mcp.plist");
    const plist = await readFile(file, "utf8");
    expect(plist).toContain(root);
    expect(plist).not.toContain("m".repeat(40));
    expect(calls.at(-1)?.slice(0, 3)).toEqual(["launchctl", "bootstrap", "gui/123"]);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("refuses to replace or stop a service from another checkout", async () => {
    const root = await fixture();
    const homeDirectory = await mkdtemp(join(tmpdir(), "amazon service home "));
    roots.push(homeDirectory);
    await mkdir(join(homeDirectory, "Library/LaunchAgents"), { recursive: true });
    const file = join(homeDirectory, "Library/LaunchAgents/com.mikeharty.amazon-mcp.plist");
    await writeFile(file, servicePlist("/another/checkout", process.execPath));
    const before = await readFile(file, "utf8");
    const calls: string[][] = [];
    await expect(manageService("stop", root, { platform: "darwin", uid: 123, homeDirectory,
      executeCommand: (command: string, args: string[]) => { calls.push([command, ...args]); return { status: 0, stdout: "/another/checkout\n" }; },
    })).rejects.toThrow("another checkout");
    expect(await readFile(file, "utf8")).toBe(before);
    expect(calls.some((args) => args.includes("bootout"))).toBe(false);
  });
});
