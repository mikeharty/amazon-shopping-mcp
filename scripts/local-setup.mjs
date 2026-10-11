import { spawnSync } from "node:child_process";
import { packageCommand, run, supportedNode } from "./local-tools.mjs";

// Invoked through pnpm; never interpolate shell commands or print environment values.
if (process.argv.includes("--help")) {
  console.log("local:setup [--no-docker]: install files and database only. For guided sign-in, startup and connection use local:onboard.");
  process.exit(0);
}
let step = "Check prerequisites";
try {
  if (process.argv.slice(2).some((arg) => arg !== "--no-docker")) throw new Error("Unknown option. Use --no-docker for an existing Postgres database.");
  if (!supportedNode()) throw new Error(`Node ${process.versions.node} is unsupported. Select Node 22.18+, 24.x, or 26+ (nvm use on systems with nvm).`);
  const packages = packageCommand();
  const docker = !process.argv.includes("--no-docker");
  if (docker) {
    if (spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status !== 0)
      throw new Error("Docker Compose is missing. Install Docker Desktop, or configure Postgres and use --no-docker.");
    if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0)
      throw new Error("Docker is not running. Open Docker Desktop, wait until it is ready, then rerun this command.");
  }
  const steps = [
    ["Install locked dependencies", () => packages(["install", "--frozen-lockfile"])],
    ["Install dedicated Chromium", () => packages(["exec", "playwright", "install", ...(process.platform === "linux" ? ["--with-deps"] : []), "chromium"])],
    ["Create or preserve private configuration", () => packages(["run", "local:init"])],
    ...(docker ? [["Start local Postgres", () => run("docker", ["compose", "up", "-d", "--wait", "postgres"])]] : []),
    ["Build application", () => packages(["run", "build"])],
    ["Apply database migrations", () => packages(["run", "migrate"])],
    ["Create private client configuration", () => packages(["run", "client:config"])],
  ];
  for (const [index, [name, execute]] of steps.entries()) {
    step = name;
    console.log(`\n[${index + 1}/${steps.length}] ${name}`);
    execute();
  }
  console.log("\nInstallation complete. Gateway and worker have not been started; Amazon sign-in has not been checked.");
  console.log("Next: pnpm run local:onboard for guided sign-in and startup, or pnpm run local:start for a foreground service.");
} catch (error) {
  console.error(`Setup stopped at: ${step}. ${step === "Check prerequisites" ? error.message : "Resolve the preceding step and rerun local:setup; existing secrets are preserved."}`);
  process.exitCode = 1;
}
