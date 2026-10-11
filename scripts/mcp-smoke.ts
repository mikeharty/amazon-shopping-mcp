import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
const client = new Client(
  { name: "amazon-mcp-smoke", version: "0.3.0-alpha" },
  { versionNegotiation: { mode: "auto" } },
);
const transport = new StreamableHTTPClientTransport(
  new URL(`http://127.0.0.1:${process.env.PORT ?? 3433}/mcp`),
  {
    requestInit: {
      headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` },
    },
  },
);
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const summary = process.argv.includes("--summary");
  if (!summary) console.log(`Protocol: ${client.getNegotiatedProtocolVersion()}; tools: ${tools.tools.length}`);
  const result = await client.callTool({
    name: "amazon_capabilities",
    arguments: {},
  });
  if (result.isError || !z.object({ status: z.literal("ok") }).safeParse(result.structuredContent).success) throw new Error("MCP capability discovery failed.");
  if (summary) console.log(`MCP discovery verified: ${tools.tools.length} tools. No Amazon pages were accessed.`);
  else console.log(JSON.stringify(result.structuredContent, null, 2));
} finally {
  await client.close();
}
