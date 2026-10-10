import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
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
  console.log(
    `Protocol: ${client.getNegotiatedProtocolVersion()}; tools: ${tools.tools.length}`,
  );
  const result = await client.callTool({
    name: "amazon_capabilities",
    arguments: {},
  });
  console.log(JSON.stringify(result.structuredContent, null, 2));
} finally {
  await client.close();
}
