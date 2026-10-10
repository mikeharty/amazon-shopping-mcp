import { randomUUID } from "node:crypto";
import { run } from "graphile-worker";
import { loadConfig } from "../../packages/core/config.js";
import { Executor } from "../../packages/core/execution.js";
import { Store } from "../../packages/store/index.js";
import { NotificationOutbox } from "../../packages/store/notifications.js";
import { createMacOSNotificationChannel } from "../../packages/notifications/index.js";
import { Monitoring } from "../../packages/store/monitoring.js";
import type { ShoppingProvider } from "../../packages/contracts/index.js";
import { createAmazonWebProvider } from "../../packages/providers/amazon-web/index.js";
const config = loadConfig();
const store = new Store(config.databaseUrl, config.dataKey);
await store.migrate();
const account = await store.account(config.ownerId);
const id = randomUUID();
let provider: ShoppingProvider;
if (config.liveEnabled && account.enabled) {
  // Every runtime start invalidates prepared intents from the prior browser lifecycle.
  const row = await store.pool.query(
    "UPDATE accounts SET session_generation=session_generation+1 WHERE id=$1 RETURNING session_generation",
    [account.id],
  );
  const instance = createAmazonWebProvider({
    profileDir: config.profileDir,
    headless: config.browserHeadless,
    initialSessionGeneration: row.rows[0].session_generation,
    onSessionGeneration: async (generation) => {
      await store.pool.query(
        "UPDATE accounts SET session_generation=$2 WHERE id=$1 AND session_generation<$2",
        [account.id, generation],
      );
    },
  });
  await instance.runtime.start();
  provider = instance.provider;
} else {
  provider = {
    read: async () => ({
      status: "requires_user_action",
      data: {
        instructions:
          "Complete dedicated browser login and enable AMAZON_LIVE_ENABLED before browsing.",
      },
    }),
    mutate: async () => ({
      status: "requires_user_action",
      error: { code: "LIVE_ACCESS_DISABLED", retryable: false },
    }),
    close: async () => {},
  };
}
const executor = new Executor(
  store,
  provider,
  id,
  config.retainObservations,
  config.desktopNotifications,
  config.amazonReadOnly,
  config.purchasingEnabled,
  `http://127.0.0.1:${config.port}`,
);
const monitoring = new Monitoring(store);
const notifications = new NotificationOutbox(
  store,
  createMacOSNotificationChannel({ enabled: config.desktopNotifications }),
);
await store.recoverStale(new Date(Date.now() - 120000));
await store.heartbeat(id);
const runner = await run({
  pgPool: store.pool,
  noHandleSignals: true,
  concurrency: 2,
  pollInterval: 1000,
  crontab: "",
  taskList: {
    execute_operation: async (payload) => {
      const job = payload as { operationId?: unknown };
      if (typeof job.operationId !== "string")
        throw new Error("Invalid operation payload");
      await executor.run(job.operationId);
    },
    deliver_notification: async (payload) => {
      const job = payload as { eventId?: unknown };
      if (typeof job.eventId !== "string")
        throw new Error("Invalid notification payload");
      await notifications.deliver(job.eventId);
    },
    observe_watch: async (payload) => {
      const job = payload as { watchId?: unknown; revision?: unknown };
      if (typeof job.watchId !== "string" || typeof job.revision !== "number")
        throw new Error("Invalid watch payload");
      await executor.watch(job.watchId, job.revision);
    },
  },
});
let ticking = false;
const tick = async () => {
  if (ticking) return;
  ticking = true;
  try {
    await store.heartbeat(id);
    const current = await store.getAccount(config.ownerId, account.id);
    if (!current.enabled) await provider.close();
    await store.recoverStale(new Date(Date.now() - 120000));
    if (config.liveEnabled && current.enabled) await monitoring.due();
    if (config.desktopNotifications) {
      await notifications.recoverStale(new Date(Date.now() - 120000));
      await notifications.enqueuePending();
    }
  } catch {
    console.error(
      "Worker maintenance failed; database connectivity needs attention.",
    );
  } finally {
    ticking = false;
  }
};
const timer = setInterval(() => void tick(), 10000);
timer.unref();
console.log(
  `Persistent worker running; Amazon live access ${config.liveEnabled ? "enabled" : "disabled"}; notifications use the durable event inbox.`,
);
process.send?.({ type: "ready" });
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await runner.stop();
  await runner.promise;
  await provider.close();
  await store.pool.query("DELETE FROM worker_health WHERE id=$1", [id]);
  await store.close();
};
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void stop().then(() => process.exit(0)));
await runner.promise;
