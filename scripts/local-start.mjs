import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
const children = new Set();
let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  await Promise.all(
    [...children].map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      await exited;
      clearTimeout(timer);
    }),
  );
  process.exit(code);
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => void stop(0));
function launch(relative, args = []) {
  const child = spawn(
    process.execPath,
    [
      "--env-file=.env",
      fileURLToPath(new URL(relative, import.meta.url)),
      ...args,
    ],
    { stdio: ["inherit", "inherit", "inherit", "ipc"], env: process.env },
  );
  children.add(child);
  child.once("error", () => {
    console.error("Unable to start a local service.");
    void stop(1);
  });
  child.once("exit", () => children.delete(child));
  return child;
}
if (process.argv.includes("--login") || process.argv.includes("--1password")) {
  const login = launch(
    "../dist/scripts/browser-login.js",
    process.argv.includes("--1password") ? ["--1password"] : [],
  );
  const [code] = await once(login, "exit");
  if (code !== 0) {
    console.error(
      "Sign-in incomplete. No services started; rerun local:start --login after resolving the handoff.",
    );
    process.exit(2);
  }
}
function ready(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Service startup timed out"));
    }, 30_000);
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", message);
      child.off("exit", failed);
      child.off("error", failed);
    };
    const message = (value) => {
      if (value?.type === "ready") {
        cleanup();
        resolve();
      }
    };
    const failed = () => {
      cleanup();
      reject(new Error("Service could not start"));
    };
    child.on("message", message);
    child.once("exit", failed);
    child.once("error", failed);
  });
}
try {
  const gateway = launch("../dist/apps/gateway/main.js");
  gateway.once("exit", (code) => {
    if (!stopping) void stop(code || 1);
  });
  await ready(gateway);
  const worker = launch("../dist/apps/worker/main.js");
  worker.once("exit", (code) => {
    if (!stopping) void stop(code || 1);
  });
  await ready(worker);
  console.log(
    "Gateway and worker ready. Ctrl-C stops both. For session recovery, stop this command and run pnpm run local:start --login.",
  );
  process.send?.({ type: "ready" });
} catch {
  console.error(
    "Local services could not start. Check the database, port, and dedicated profile ownership; no locks were removed.",
  );
  await stop(1);
}
