import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline/promises";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { accessMode, connectionSummary, gatewayRunning, packageCommand, readSettings, setAccessMode, supportedNode } from "./local-tools.mjs";
import { manageService, serviceLabel } from "./local-service.mjs";

const args = process.argv.slice(2);
const usage = "local:onboard [--no-docker] [--mode read-only|purchasing|offline] [--foreground|--background] [--skip-login]\nInteractive setup is recommended. Without a terminal, specify both --mode and a startup choice. --skip-login reuses an existing session without verifying Amazon sign-in. Background startup is macOS only.";
if (args.includes("--help")) { console.log(usage); process.exit(0); }
let input;
let foreground;
try {
  const options = new Set(["--no-docker", "--foreground", "--background", "--skip-login"]);
  let mode;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--mode") {
      mode = args[++index];
      if (!["offline", "read-only", "purchasing"].includes(mode)) throw new Error("--mode requires read-only, purchasing, or offline.");
    } else if (!options.has(args[index])) throw new Error(`Unknown option. ${usage}`);
  }
  if (args.includes("--foreground") && args.includes("--background")) throw new Error("Choose either foreground or background startup.");
  if (!supportedNode()) throw new Error(`Node ${process.versions.node} is unsupported. Select Node 22.18+, 24.x, or 26+.`);
  const packages = packageCommand();
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive && (!mode || (!args.includes("--foreground") && !args.includes("--background")))) throw new Error(usage);
  let settings;
  try { await access(".env"); settings = await readSettings(); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (settings && await gatewayRunning(settings.origin)) {
    console.log("An MCP gateway is already running. Checking it before changing any configuration or opening another browser.");
    packages(["run", "local:doctor", ...(accessMode(settings.env) === "offline" ? ["--allow-offline"] : [])], { env: { ...process.env, ...settings.env } });
    if (mode && mode !== accessMode(settings.env)) console.log(`Requested access change to ${mode} was not applied while the service is running. Stop it first, then rerun onboarding.`);
    console.log("Existing configuration preserved. Amazon sign-in was not checked.");
    connectionSummary(settings, accessMode(settings.env), process.platform === "darwin" && spawnSync("launchctl", ["print", `gui/${process.getuid()}/${serviceLabel}`], { stdio: "ignore" }).status === 0);
    process.exit(0);
  }
  if (process.platform === "darwin" && spawnSync("launchctl", ["print", `gui/${process.getuid()}/${serviceLabel}`], { stdio: "ignore" }).status === 0)
    throw new Error("A macOS MCP service is already loaded. Run local:doctor or local:service status from its checkout before starting another browser.");
  if (interactive) input = createInterface({ input: process.stdin, output: process.stdout });
  const choose = async (prompt, choices, fallback) => {
    while (true) {
      const answer = (await input.question(prompt)).trim() || fallback;
      if (choices.includes(answer)) return answer;
      console.log(`Choose ${choices.join(" or ")}.`);
    }
  };
  console.log("\nAmazon MCP first-run setup\nThis installs a private local browser and database. Your Amazon password is entered in the Amazon window.");
  if (!mode) {
    console.log("\n1. Read-only shopping (recommended): research, cart, orders and subscriptions.\n2. Purchasing: also Buy It Now, checkout and Subscribe & Save; each purchase still needs your exact-term approval.\n3. Offline: install and connect without accessing Amazon.");
    mode = { "1": "read-only", "2": "purchasing", "3": "offline" }[await choose("Choose access [1]: ", ["1", "2", "3"], "1")];
  }
  let background = args.includes("--background");
  if (!background && !args.includes("--foreground") && process.platform === "darwin")
    background = await choose("Keep running in the background and start at Mac login? [Y/n]: ", ["Y", "y", "n", "N"], "Y").then((value) => value.toLowerCase() === "y");
  if (background && process.platform !== "darwin") throw new Error("Background setup is currently macOS only. Choose --foreground on this platform.");
  if (background) await manageService("status");
  const login = mode !== "offline" && !args.includes("--skip-login");
  input?.close();
  input = undefined;
  packages(["run", "local:setup", ...(args.includes("--no-docker") ? ["--no-docker"] : [])]);
  settings = await readSettings();
  const doctorArgs = ["run", "local:doctor", ...(mode === "offline" ? ["--allow-offline"] : [])];
  Object.assign(process.env, settings.env);
  if (login) {
    console.log("\nSign in in the dedicated Amazon window. Complete MFA there; the window closes after the session is verified.");
    packages(["run", "browser:login"]);
  } else console.log("\nAmazon sign-in has not been checked.");
  await setAccessMode(mode);
  settings = await readSettings();
  // Avoid inherited flags overriding the selected private configuration in Node --env-file children.
  for (const key of ["AMAZON_LIVE_ENABLED", "AMAZON_READ_ONLY", "AMAZON_PURCHASING_ENABLED"]) delete process.env[key];
  if (background) await manageService("install");
  else {
    foreground = spawn(process.execPath, ["--env-file=.env", fileURLToPath(new URL("./local-start.mjs", import.meta.url))], { stdio: ["inherit", "inherit", "inherit", "ipc"], env: process.env });
    const exit = once(foreground, "exit").catch(() => [1]);
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Gateway and worker did not become ready within 35 seconds. Check the database and .local/logs.")), 35_000);
      foreground.on("message", (message) => { if (message?.type === "ready") { clearTimeout(timer); resolve(); } });
      foreground.once("exit", () => { clearTimeout(timer); reject(new Error("Foreground service stopped before setup could finish.")); });
      foreground.once("error", () => { clearTimeout(timer); reject(new Error("Foreground service could not start.")); });
    });
    const stop = () => foreground.kill("SIGTERM");
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    await ready;
    packages(doctorArgs);
    packages(["run", "mcp:smoke", "--summary"]);
    console.log(`\nOnboarding complete. Gateway and worker verified. Amazon sign-in: ${login ? "verified during this setup" : "not checked"}.`);
    connectionSummary(settings, mode, false);
    const [code] = await exit;
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.exitCode = code ?? 1;
  }
  if (background) {
    // The process appearing in launchctl is not proof that its worker is ready.
    let ready = false;
    const deadline = Date.now() + 35_000;
    while (Date.now() < deadline) {
      if (await gatewayRunning(settings.origin)) {
        try { packages([...doctorArgs, "--json"], { stdio: "ignore" }); ready = true; break; } catch { /* worker may still be starting */ }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!ready) throw new Error("Background service was installed but readiness is unconfirmed. Run local:doctor and inspect .local/logs; do not start a second service.");
    packages(doctorArgs);
    packages(["run", "mcp:smoke", "--summary"]);
    console.log(`\nOnboarding complete. Gateway and worker verified. Amazon sign-in: ${login ? "verified during this setup" : "not checked"}.`);
    connectionSummary(settings, mode, true);
    console.log("Service controls: pnpm run local:service status|restart|stop|start.");
  }
} catch (error) {
  if (foreground && foreground.exitCode === null) foreground.kill("SIGTERM");
  console.error(`Onboarding stopped. ${error.message === "Command did not complete" ? "Resolve the preceding step and rerun local:onboard. No private error details were printed." : error.message}`);
  process.exitCode = 1;
} finally { input?.close(); }
