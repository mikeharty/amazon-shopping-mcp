import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { verifyAccountReads } from "../packages/core/read-verification.js";

const port = Number(process.env.PORT ?? 3433);
if (
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535 ||
  !process.env.MCP_TOKEN
)
  throw new Error(
    "Set PORT and MCP_TOKEN in the private .env before verification",
  );
const client = new Client(
  { name: "amazon-read-smoke", version: "0.3.0-alpha" },
  { versionNegotiation: { mode: "auto" } },
);
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: {
        headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` },
      },
    }),
  );
  const report = await verifyAccountReads(
    async (name, args, signal) => {
      const response = await client.callTool(
        { name, arguments: args },
        { signal, timeout: 15_000 },
      );
      return response.structuredContent;
    },
    {
      includeOrderDetails: process.argv.includes("--order-details"),
      onCheck: (check) =>
        console.log(
          `${new Date().toISOString()} ${check.tool}: ${check.status}`,
        ),
    },
  );
  const directory = resolve(".local/evidence");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = resolve(
    directory,
    `amazon-reads-${report.startedAt.replaceAll(":", "-")}-${randomUUID()}.json`,
  );
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  console.log(
    `Read verification: ${report.status}${report.reason ? ` (${report.reason})` : ""}. Report: ${path}`,
  );
  if (report.status !== "completed") process.exitCode = 2;
} catch {
  console.error(
    "Read verification could not complete. Check the local gateway, MCP token and database. Private response details were not logged.",
  );
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
}
