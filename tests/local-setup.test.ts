import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const setup = resolve("scripts/local-setup.mjs");
const browserInstall = [
  "exec",
  "playwright",
  "install",
  ...(process.platform === "linux" ? ["--with-deps"] : []),
  "chromium",
];
const steps = [
  ["install", "--frozen-lockfile"],
  browserInstall,
  ["run", "local:init"],
  ["run", "build"],
  ["run", "migrate"],
  ["run", "client:config"],
];

function runSetup(kind: "native" | "javascript", failAt?: string) {
  const cwd = mkdtempSync(join(tmpdir(), "amazon setup fixture "));
  try {
    const log = join(cwd, "calls.jsonl");
    const fixture = `
      const { appendFileSync } = require("node:fs");
      const { basename } = require("node:path");
      const args = process.argv.slice(2);
      if (basename(__filename) !== "pnpm.cjs") args.unshift(basename(__filename));
      appendFileSync(process.env.LOCAL_SETUP_FIXTURE_LOG, JSON.stringify(args) + "\\n");
      if (args.join(" ") === process.env.LOCAL_SETUP_FIXTURE_FAILURE) process.exit(7);
    `;
    for (const file of ["pnpm.cjs", "install", "exec", "run"])
      writeFileSync(join(cwd, file), fixture);
    // Node is a real native executable. The command fixtures let it act as pnpm
    // without installing dependencies or touching Docker, secrets, or a database.
    const result = spawnSync(process.execPath, [setup, "--no-docker"], {
      cwd,
      env: {
        ...process.env,
        npm_execpath:
          kind === "native" ? process.execPath : join(cwd, "pnpm.cjs"),
        LOCAL_SETUP_FIXTURE_LOG: log,
        LOCAL_SETUP_FIXTURE_FAILURE: failAt,
      },
      encoding: "utf8",
      timeout: 15_000,
    });
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    return { ...result, calls };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe.each(["native", "javascript"] as const)("%s pnpm setup", (kind) => {
  it("completes the setup steps with an external database", () => {
    const result = runSetup(kind);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual(steps);
    expect(result.stdout).toContain("Installation complete.");
    expect(result.stdout).toContain("Gateway and worker have not been started");
  });

  it("stops after a failed build without migrating or reporting success", () => {
    const result = runSetup(kind, "run build");
    expect(result.status).toBe(1);
    expect(result.calls).toEqual(steps.slice(0, 4));
    expect(result.stderr).toContain("Setup stopped at: Build application.");
    expect(result.stdout).not.toContain("Installation complete.");
  });
});

it("stops before installing dependencies when Docker is not running", () => {
  if (process.platform === "win32") return;
  const cwd = mkdtempSync(join(tmpdir(), "amazon Docker preflight "));
  try {
    writeFileSync(join(cwd, "docker"), `#!${process.execPath}\nprocess.exit(process.argv[2] === 'compose' ? 0 : 1);\n`, { mode: 0o700 });
    const result = spawnSync(process.execPath, [setup], { cwd, env: { ...process.env, PATH: `${cwd}:${process.env.PATH}`, npm_execpath: join(cwd, "should-not-run.cjs") }, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Docker is not running. Open Docker Desktop");
    expect(result.stdout).not.toContain("Install locked dependencies");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
