import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import pg from "pg";

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a disposable Postgres server with CREATEDB permission.");
const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
const name = `onboarding_${randomUUID().replaceAll("-", "")}`;
const database = new URL(process.env.TEST_DATABASE_URL);
database.pathname = `/${name}`;
const root = await mkdtemp(join(tmpdir(), "amazon-onboarding-"));
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const token = randomBytes(32).toString("base64");
let child;
let exit;
try {
  await admin.query(`CREATE DATABASE ${name}`);
  await cp(resolve("scripts"), join(root, "scripts"), { recursive: true });
  await symlink(resolve("dist"), join(root, "dist"), process.platform === "win32" ? "junction" : "dir");
  await symlink(resolve("node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin/launchctl"), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o700 });
  await writeFile(join(root, ".env"), `DATABASE_URL=${database}\nDATA_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}\nMCP_TOKEN=${token}\nOWNER_TOKEN=${randomBytes(32).toString("base64")}\nOWNER_ID=onboarding-fixture\nPORT=${port}\nAMAZON_PROFILE_DIR=${join(root, ".local/profile")}\nAMAZON_LIVE_ENABLED=false\nAMAZON_READ_ONLY=true\nAMAZON_PURCHASING_ENABLED=false\n`, { mode: 0o600 });
  // The actual installer and compiled application run. Only downloads/build are
  // replaced because verification already installed and built this exact source.
  // Every browser login attempt fails the check; there must be no Amazon access.
  await writeFile(join(root, "pnpm.cjs"), `
const {spawnSync}=require('node:child_process');
const {appendFileSync}=require('node:fs');
const args=process.argv.slice(2);
appendFileSync('setup-calls.jsonl',JSON.stringify(args)+'\\n');
if(args[0]==='install'||args[0]==='exec'||args[1]==='build')process.exit(0);
const files={'local:setup':'scripts/local-setup.mjs','local:init':'dist/scripts/setup.js','migrate':'dist/scripts/migrate.js','client:config':'dist/scripts/client-config.js','local:doctor':'dist/scripts/doctor.js','mcp:smoke':'dist/scripts/mcp-smoke.js'};
if(args[0]!=='run'||!files[args[1]])process.exit(9);
const result=spawnSync(process.execPath,['--env-file=.env',files[args[1]],...args.slice(2)],{stdio:'inherit',env:process.env});
process.exit(result.status??1);
`, { mode: 0o600 });
  const env = { ...process.env, npm_execpath: join(root, "pnpm.cjs"), PATH: `${join(root, "bin")}:${process.env.PATH}` };
  // A calling shell must not be able to override the wizard's selected mode.
  env.AMAZON_LIVE_ENABLED = "true";
  env.AMAZON_READ_ONLY = "false";
  env.AMAZON_PURCHASING_ENABLED = "true";
  child = spawn(process.execPath, ["scripts/local-onboard.mjs", "--mode", "offline", "--foreground", "--no-docker"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  exit = once(child, "exit");
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const deadline = Date.now() + 45_000;
  while (!output.includes("Onboarding complete.") && Date.now() < deadline && child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 250));
  let safeOutput = output;
  for (const [key, value] of Object.entries(parseEnv(await readFile(join(root, ".env"), "utf8")))) {
    if (/TOKEN|KEY|URL/.test(key)) safeOutput = safeOutput.replaceAll(value, "[redacted fixture value]");
  }
  assert.ok(output.includes("Onboarding complete."), `Onboarding did not complete. Synthetic fixture output:\n${safeOutput}`);
  assert.ok(output.includes("worker: online"));
  assert.ok(output.includes("MCP discovery verified: 38 tools"));
  assert.ok(output.includes("Amazon sign-in: not checked"));
  assert.ok(!output.includes(token));
  const settings = parseEnv(await readFile(join(root, ".env"), "utf8"));
  assert.equal(settings.MCP_TOKEN, token);
  assert.equal(settings.AMAZON_LIVE_ENABLED, "false");
  assert.equal(settings.AMAZON_READ_ONLY, "true");
  assert.equal(settings.AMAZON_PURCHASING_ENABLED, "false");
  const calls = await readFile(join(root, "setup-calls.jsonl"), "utf8");
  assert.ok(!calls.includes("browser:login"));
  child.kill("SIGTERM");
  const [code] = await exit;
  assert.equal(code, 0);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  console.log("Isolated onboarding verified: numbered installation, preserved secrets, offline access despite inherited flags, gateway and worker ready, 38 tools, no sign-in or Amazon calls, clean shutdown.");
} finally {
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await exit; }
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
  await rm(root, { recursive: true, force: true });
}
