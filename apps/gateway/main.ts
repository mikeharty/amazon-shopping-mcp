import { loadConfig } from "../../packages/core/config.js";
import { Store } from "../../packages/store/index.js";
import { secureEqual } from "../../packages/store/crypto.js";
import { createKeepaProvider } from "../../packages/providers/keepa/index.js";
import { AMAZON_WEB_READ_KINDS } from "../../packages/providers/amazon-web/index.js";
import { createRegistry, cartWriteSchemas } from "./registry.js";
import { createGateway } from "./transport.js";
import { createOwnerUi } from "./owner-ui.js";
import { bearerToken } from "./auth.js";
import { serve } from "./server.js";
const config = loadConfig();
const store = new Store(config.databaseUrl, config.dataKey);
await store.migrate();
const origin = `http://127.0.0.1:${config.port}`;
const registry = createRegistry(store, {
  liveEnabled: config.liveEnabled,
  retainObservations: config.retainObservations,
  origin,
  desktopNotifications: config.desktopNotifications,
  readKinds: [...AMAZON_WEB_READ_KINDS],
  writeSchemas: config.amazonReadOnly ? {} : cartWriteSchemas,
  purchasingEnabled: config.purchasingEnabled,
  keepa: createKeepaProvider({
    apiKey: config.keepaKey,
    maxCallsPerSession: config.keepaCalls,
    maxTokensPerSession: config.keepaTokens,
  }),
});
const gateway = createGateway({
  ...registry,
  authenticate: (request) =>
    secureEqual(bearerToken(request) ?? "", config.mcpToken)
      ? {
          id: config.ownerId,
          scopes: [
            "catalog:read",
            "account:read",
            "account:write",
            ...(config.amazonReadOnly ? [] : ["cart:write"]),
            "checkout:prepare",
            "checkout:commit",
            "orders:write",
            "subscriptions:write",
            "watches:write",
          ],
        }
      : undefined,
});
const ownerUi = createOwnerUi(store, {
  ownerId: config.ownerId,
  ownerToken: config.ownerToken,
  origin,
});
const server = serve(async (request) => {
  const path = new URL(request.url).pathname;
  if (path === "/mcp") return gateway(request);
  if (path === "/owner" || path.startsWith("/owner/")) return ownerUi(request);
  if (path === "/health")
    return Response.json({
      status: "running",
      liveEnabled: config.liveEnabled,
    });
  return new Response("Not found", { status: 404 });
}, config.port);
server.once("listening", () => process.send?.({ type: "ready" }));
console.log(
  `Local MCP: ${origin}/mcp; owner control: ${origin}/owner. Amazon live access: ${config.liveEnabled ? "enabled" : "disabled"}.`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    server.close(() => {
      void store.close().then(() => process.exit(0));
    });
  });
