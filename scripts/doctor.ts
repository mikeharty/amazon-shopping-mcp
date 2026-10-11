import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";

// Contact the local gateway only. Never print tokens, connection strings,
// raw exception text, encrypted payloads, or browser/profile contents.
const port = Number(process.env.PORT ?? 3433);
const resultSchema = z.object({ status: z.literal("ok"), data: z.object({
  sampledAt: z.string(), readiness: z.enum(["available", "needs_attention"]), authentication: z.literal("not_checked"),
  liveEnabled: z.boolean(), worker: z.object({ online: z.boolean(), lastHeartbeatAt: z.string().nullable() }),
  queue: z.object({ queued: z.number(), active: z.number(), uncertain: z.number(), staleActive: z.number() }),
  issues: z.array(z.object({ code: z.string(), action: z.string() })),
}) });
const client = new Client({ name: "amazon-local-doctor", version: "0.3.0-alpha" }, { versionNegotiation: { mode: "auto" } });
try {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !process.env.MCP_TOKEN) throw new Error();
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` } },
  }), { timeout: 10_000 });
  const response = await client.callTool({ name: "amazon_diagnostics", arguments: {} }, { timeout: 10_000 });
  const { data } = resultSchema.parse(response.structuredContent);
  const readiness = process.argv.includes("--allow-offline") && !data.liveEnabled && data.worker.online && data.issues.every((issue) => issue.code === "live_disabled")
    ? "available" : data.readiness;
  if (process.argv.includes("--json")) console.log(JSON.stringify({ ...data, readiness }, null, 2));
  else {
    const sampledAt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "long" }).format(new Date(data.sampledAt));
    console.log(`${sampledAt} Local service: ${readiness}; worker: ${data.worker.online ? "online" : "offline"}; live browsing: ${data.liveEnabled ? "enabled" : "disabled"}.`);
    console.log(`Jobs: ${data.queue.queued} queued, ${data.queue.active} active, ${data.queue.uncertain} uncertain.`);
    for (const issue of data.issues) {
      if (readiness === "available" && issue.code === "live_disabled") console.log("Offline access selected; Amazon browsing is disabled.");
      else console.log(`${issue.code}: ${issue.action}`);
    }
    console.log("Amazon sign-in was not checked. No jobs were retried or Amazon pages accessed.");
  }
  if (readiness !== "available") process.exitCode = 2;
} catch {
  console.error("Local diagnostics unavailable. Check the gateway, private MCP_TOKEN, database and account initialization. No private error details were logged.");
  process.exitCode = 1;
} finally { await client.close().catch(() => undefined); }
