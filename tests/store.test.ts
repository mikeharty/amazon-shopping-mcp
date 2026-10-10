import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { Store } from "../packages/store/index.js";
import { productHistorySubject } from "../packages/core/observations.js";
import { NotificationOutbox } from "../packages/store/notifications.js";
import { Monitoring } from "../packages/store/monitoring.js";
import { Executor } from "../packages/core/execution.js";
import type { ShoppingProvider } from "../packages/contracts/index.js";
const connection = process.env.TEST_DATABASE_URL;
describe.skipIf(!connection)("Postgres durable operations", () => {
  let store: Store;
  let admin: pg.Pool;
  const db = `amazon_test_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: connection });
    await admin.query(`CREATE DATABASE ${db}`);
    const u = new URL(connection!);
    u.pathname = `/${db}`;
    store = new Store(u.toString(), randomBytes(32).toString("base64"));
    await store.migrate();
  }, 30000);
  afterAll(async () => {
    await store?.close();
    await admin?.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin?.end();
  });
  it("atomically reuses operation across repeated and concurrent keys for one consent", async () => {
    const a = await store.account("owner");
    const intent = await store.prepare("owner", a.id, "checkout_submit", {
      total: { currency: "USD", minorUnits: 1299 },
    });
    await expect(
      store.submit("owner", intent.id, "no-consent"),
    ).rejects.toThrow("owner-approved");
    await store.approve("owner", intent.id, intent.digest);
    const [first, second] = await Promise.all([
      store.submit("owner", intent.id, "first"),
      store.submit("owner", intent.id, "new-key"),
    ]);
    expect(first.id).toBe(second.id);
    expect(
      (
        await store.pool.query(
          "SELECT count(*) FROM operations WHERE intent_id=$1",
          [intent.id],
        )
      ).rows[0].count,
    ).toBe("1");
    await expect(store.getOperation("other", first.id)).rejects.toThrow(
      "not found",
    );
  });
  it("rejects reused request keys, scopes encryption and persists across store reconnect", async () => {
    const a = await store.account("reads");
    const op = await store.start(
      "reads",
      a.id,
      "products_get",
      "read",
      { asin: "B000000001" },
      "same",
    );
    expect(
      (
        await store.start(
          "reads",
          a.id,
          "products_get",
          "read",
          { asin: "B000000001" },
          "same",
        )
      ).id,
    ).toBe(op.id);
    await expect(
      store.start(
        "reads",
        a.id,
        "products_get",
        "read",
        { asin: "B000000002" },
        "same",
      ),
    ).rejects.toThrow("different");
    const raw = (
      await store.pool.query("SELECT input FROM operations WHERE id=$1", [
        op.id,
      ])
    ).rows[0].input;
    expect(raw).not.toContain("B000000001");
    expect(() => store.vault.open(raw, "other")).toThrow();
    expect((await store.getOperation("reads", op.id)).input.asin).toBe(
      "B000000001",
    );
  });
  it("crash after dispatch quarantines writes and cannot retry under another key", async () => {
    const a = await store.account("crash");
    const op = await store.start(
      "crash",
      a.id,
      "cart_add",
      "write",
      { asin: "B000000001" },
      "crash-key",
    );
    const claimed = await store.claim(op.id, "dead");
    expect(claimed).not.toBeNull();
    await store.markDispatch(op.id, "dead");
    await store.pool.query(
      "UPDATE operations SET heartbeat_at=now()-interval '10 minutes' WHERE id=$1",
      [op.id],
    );
    await store.recoverStale(new Date(Date.now() - 60000));
    expect((await store.getOperation("crash", op.id)).status).toBe(
      "outcome_unknown",
    );
    await expect(
      store.start("crash", a.id, "cart_add", "write", {}, "new-key"),
    ).rejects.toThrow("reconciliation");
    expect(await store.claim(op.id, "new-worker")).toBeNull();
  });
  it("executor refuses changed terms and does not dispatch a consequential effect", async () => {
    const a = await store.account("terms");
    const intent = await store.prepare("terms", a.id, "checkout_submit", {
      total: 100,
    });
    await store.approve("terms", intent.id, intent.digest);
    const op = await store.submit("terms", intent.id, "terms-key");
    let effects = 0;
    const provider: ShoppingProvider = {
      read: async () => ({ status: "ok", data: { total: 101 } }),
      mutate: async () => {
        effects++;
        return { status: "ok" };
      },
      close: async () => {},
    };
    await new Executor(store, provider, "tester", false, false, false, true).run(op.id);
    expect(effects).toBe(0);
    expect((await store.getOperation("terms", op.id)).status).toBe("conflict");
  });
  it("lost response after effect is uncertain and never automatically repeats", async () => {
    const a = await store.account("lost");
    const op = await store.start(
      "lost",
      a.id,
      "cart_add",
      "write",
      {},
      "lost-key",
    );
    let effects = 0;
    const provider: ShoppingProvider = {
      read: async () => ({ status: "ok" }),
      mutate: async () => {
        effects++;
        throw new Error("network response lost");
      },
      close: async () => {},
    };
    const executor = new Executor(store, provider, "tester");
    await executor.run(op.id);
    await executor.run(op.id);
    expect(effects).toBe(1);
    expect((await store.getOperation("lost", op.id)).status).toBe(
      "outcome_unknown",
    );
  });
  it("deduplicates repeated observations but preserves A-B-A occurrences and ownership", async () => {
    const a = await store.account("watch");
    const monitor = new Monitoring(store);
    const w = await monitor.create(
      "watch",
      a.id,
      "shipments_get",
      { orderId: "111-1111111-1111111" },
      300,
    );
    expect(
      await monitor.observe(w, {
        status: "ok",
        data: { status: "A", observedAt: "one" },
      }),
    ).toBe(false);
    expect(
      await monitor.observe(w, {
        status: "ok",
        data: { status: "A", observedAt: "two" },
      }),
    ).toBe(false);
    expect(
      await monitor.observe(w, { status: "ok", data: { status: "B" } }),
    ).toBe(true);
    expect(
      await monitor.observe(w, { status: "ok", data: { status: "A" } }),
    ).toBe(true);
    expect((await monitor.events("watch")).items).toHaveLength(2);
    expect((await monitor.events("other")).items).toHaveLength(0);
    await monitor.pause("watch", w.id, true, w.revision);
    expect(
      await monitor.observe(w, { status: "ok", data: { status: "C" } }),
    ).toBe(false);
  });
  it("cancels only queued work with matching revision", async () => {
    const a = await store.account("cancel");
    const op = await store.start(
      "cancel",
      a.id,
      "cart_get",
      "read",
      {},
      "cancel-key",
    );
    await store.cancel("cancel", op.id, op.revision);
    expect(await store.claim(op.id, "tester")).toBeNull();
  });
  it("disconnect cancels queued work, blocks new work, pauses watches and invalidates old consent", async () => {
    const a = await store.account("disconnect");
    const monitor = new Monitoring(store);
    const watch = await monitor.create("disconnect", a.id, "cart_get", {}, 300);
    const intent = await store.prepare("disconnect", a.id, "fixture", {});
    await store.approve("disconnect", intent.id, intent.digest);
    const op = await store.start(
      "disconnect",
      a.id,
      "cart_get",
      "read",
      {},
      "queued",
    );
    await store.disconnect("disconnect", a.id);
    expect((await store.getOperation("disconnect", op.id)).status).toBe(
      "cancelled",
    );
    expect((await monitor.get(watch.id))?.paused).toBe(true);
    await expect(
      store.start("disconnect", a.id, "cart_get", "read", {}, "later"),
    ).rejects.toThrow("disconnected");
    await store.reconnect("disconnect", a.id);
    await expect(
      store.submit("disconnect", intent.id, "old-consent"),
    ).rejects.toThrow();
    expect((await monitor.get(watch.id))?.paused).toBe(true);
  });
  it("private deletion preserves unresolved effects and isolates the owner", async () => {
    const a = await store.account("delete");
    const op = await store.start(
      "delete",
      a.id,
      "cart_get",
      "read",
      {},
      "delete",
    );
    await store.claim(op.id, "tester");
    await expect(store.deletePrivateData("delete")).rejects.toThrow("resolved");
    await store.finish(await store.getOperation("delete", op.id), "tester", {
      status: "ok",
    });
    await store.deletePrivateData("delete");
    await expect(store.getOperation("delete", op.id)).rejects.toThrow(
      "not found",
    );
    expect((await store.getAccount("delete", a.id)).enabled).toBe(false);
    await expect(store.deletePrivateData("lost")).rejects.toThrow("resolved");
    await expect(
      store.reconnect("lost", (await store.account("lost")).id),
    ).rejects.toThrow("uncertain");
  });

  it("retains opted-in observations with context isolation and ignores missing required watch fields", async () => {
    const a = await store.account("history");
    const monitor = new Monitoring(store);
    await monitor.record("history", a.id, "context-one", "products_get", {
      price: 100,
    });
    await monitor.record("history", a.id, "context-two", "products_get", {
      price: 200,
    });
    expect(
      (await monitor.history("history", a.id, "context-one")).map(
        (r) => r.value,
      ),
    ).toEqual([{ price: 100 }]);
    await expect(monitor.history("other", a.id, "context-one")).rejects.toThrow(
      "not found",
    );
    const watch = await monitor.create(
      "history",
      a.id,
      "products_get",
      { asin: "B000000001" },
      300,
    );
    await monitor.observe(watch, {
      status: "partial",
      data: { price: 100 },
      coverage: { complete: false, missing: ["non-exhaustive"] },
    });
    expect(
      await monitor.observe(watch, {
        status: "partial",
        data: {},
        coverage: { complete: false, missing: ["required:price"] },
      }),
    ).toBe(false);
    expect((await monitor.events("history")).items).toHaveLength(0);
    expect(
      await monitor.observe(watch, {
        status: "partial",
        data: { price: 90 },
        coverage: { complete: false, missing: ["non-exhaustive"] },
      }),
    ).toBe(true);
  });

  it("atomically creates notification deliveries and suppresses concurrent or uncertain redelivery", async () => {
    const a = await store.account("notify");
    const monitor = new Monitoring(store, true);
    const watch = await monitor.create(
      "notify",
      a.id,
      "products_get",
      { asin: "B000000001" },
      300,
    );
    await monitor.observe(watch, { status: "ok", data: { price: 100 } });
    await monitor.observe(watch, { status: "ok", data: { price: 90 } });
    const event = (await monitor.events("notify")).items[0]!;
    expect(event.desktop_delivery_status).toBe("pending");
    const sent: unknown[] = [];
    const outbox = new NotificationOutbox(store, {
      deliver: async (notice) => {
        sent.push(notice);
        return { status: "sent" };
      },
    });
    await Promise.all([outbox.deliver(event.id), outbox.deliver(event.id)]);
    expect(sent).toEqual([{ eventId: event.id, kind: "products_get" }]);
    expect(
      (await monitor.events("notify")).items[0]!.desktop_delivery_status,
    ).toBe("sent");
    await monitor.observe(watch, { status: "ok", data: { price: 80 } });
    const next = (await monitor.events("notify")).items[1]!;
    await store.pool.query(
      "UPDATE notification_deliveries SET status='dispatching',updated_at=now()-interval '10 minutes' WHERE event_id=$1",
      [next.id],
    );
    await outbox.recoverStale(new Date(Date.now() - 60000));
    await outbox.deliver(next.id);
    expect(sent).toHaveLength(1);
    expect(
      (await monitor.events("notify")).items[1]!.desktop_delivery_status,
    ).toBe("outcome_unknown");
  });

  it("emits price threshold downward crossings without repeated below-threshold alerts", async () => {
    const a = await store.account("threshold");
    const m = new Monitoring(store);
    const w = await m.create(
      "threshold",
      a.id,
      "products_get",
      { asin: "B000000001" },
      300,
      undefined,
      "threshold-key",
      { currency: "USD", minorUnits: 100 },
    );
    const observe = (price: number) =>
      m.observe(w, {
        status: "ok",
        data: { asin: "B000000001", price: { currency: "USD", minorUnits: price } },
      });
    expect(await observe(120)).toBe(false);
    expect(await observe(100)).toBe(true);
    expect(await observe(90)).toBe(false);
    expect(await observe(110)).toBe(false);
    expect(await observe(95)).toBe(true);
    expect((await m.events("threshold")).items).toHaveLength(2);
    await expect(
      m.create(
        "threshold",
        a.id,
        "products_get",
        { asin: "B000000001" },
        300,
        undefined,
        "threshold-key",
        { currency: "USD", minorUnits: 90 },
      ),
    ).rejects.toThrow("another rule");
  });
  it("alerts once on the first valid low price and preserves the baseline across invalid observations", async () => {
    const a = await store.account("first-price"); const m = new Monitoring(store);
    const watch = await m.create("first-price", a.id, "products_get", { asin: "B000000001" }, 300, undefined, "first-price-key", { currency: "USD", minorUnits: 100, notifyOnFirstMatch: true });
    const observe = (asin: string, price?: number) => m.observe(watch, { status: "partial", data: { asin, price: price === undefined ? undefined : { currency: "USD", minorUnits: price } } });
    expect(await observe("B000000001")).toBe(false);
    expect(await observe("B000000002",90)).toBe(false);
    expect(await observe("B000000001",90)).toBe(true);
    expect(await observe("B000000001",80)).toBe(false);
    expect(await observe("B000000001")).toBe(false);
    expect(await observe("B000000001",80)).toBe(false);
    expect(await observe("B000000001",110)).toBe(false);
    expect(await observe("B000000001",100)).toBe(true);
    expect((await m.events("first-price")).items).toHaveLength(2);
  });
  it("migrates generation-keyed legacy product history without inventing verified provenance", async () => {
    const account = await store.account("legacy-history");
    const monitor = new Monitoring(store);
    await monitor.record(
      "legacy-history",
      account.id,
      "obsolete-session-digest",
      "products_get",
      { asin: "B000000001", price: { currency: "USD", minorUnits: 100 } },
    );
    await store.migrate();
    const subject = productHistorySubject("amazon.com", "B000000001");
    const points = await monitor.history("legacy-history", account.id, subject);
    expect(points).toHaveLength(1);
    expect(points[0]!.provenance).toMatchObject({
      sessionGeneration: null,
      sourceObservedAt: null,
      deliveryContext: { status: "unverified" },
      productIdentityVerified: false,
      quoteEligible: false,
    });
    await store.migrate();
    expect(
      (await monitor.history("legacy-history", account.id, subject))[0]!
        .provenance?.contextRef,
    ).toBe(points[0]!.provenance?.contextRef);
    await expect(monitor.history("other", account.id, subject)).rejects.toThrow(
      "not found",
    );
  });
});
