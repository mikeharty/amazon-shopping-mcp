import { resolveAmazonProfileDir } from "./login-config.js";
export type Config = {
  databaseUrl: string;
  dataKey: string;
  mcpToken: string;
  ownerToken: string;
  ownerId: string;
  port: number;
  profileDir: string;
  browserHeadless: boolean;
  liveEnabled: boolean;
  amazonReadOnly: boolean;
  purchasingEnabled: boolean;
  retainObservations: boolean;
  keepaKey?: string;
  keepaCalls: number;
  keepaTokens: number;
  desktopNotifications: boolean;
};
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  for (const key of [
    "DATABASE_URL",
    "DATA_ENCRYPTION_KEY",
    "MCP_TOKEN",
    "OWNER_TOKEN",
  ])
    if (!env[key]) throw new Error(`Missing ${key}; run pnpm run local:init`);
  if (env.MCP_TOKEN === env.OWNER_TOKEN)
    throw new Error("Owner and MCP secrets must be different");
  if (env.MCP_TOKEN!.length < 32 || env.OWNER_TOKEN!.length < 32)
    throw new Error(
      "Authentication secrets must contain at least 32 random characters",
    );
  const port = Number(env.PORT ?? 3433);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid PORT");
  const headless = env.AMAZON_HEADLESS ?? "true";
  if (headless !== "true" && headless !== "false")
    throw new Error("AMAZON_HEADLESS must be true or false");
  const keepaCalls = Number(env.KEEPA_MAX_CALLS ?? 100),
    keepaTokens = Number(env.KEEPA_MAX_TOKENS ?? 100);
  if (
    !Number.isInteger(keepaCalls) ||
    keepaCalls < 1 ||
    keepaCalls > 10000 ||
    !Number.isInteger(keepaTokens) ||
    keepaTokens < 1 ||
    keepaTokens > 100000
  )
    throw new Error("Invalid Keepa session budget");
  return {
    desktopNotifications: env.DESKTOP_NOTIFICATIONS === "true",
    keepaKey: env.KEEPA_ENABLED === "true" ? env.KEEPA_API_KEY : undefined,
    keepaCalls,
    keepaTokens,
    databaseUrl: env.DATABASE_URL!,
    dataKey: env.DATA_ENCRYPTION_KEY!,
    mcpToken: env.MCP_TOKEN!,
    ownerToken: env.OWNER_TOKEN!,
    ownerId: env.OWNER_ID ?? "local-owner",
    port,
    profileDir: resolveAmazonProfileDir(env),
    browserHeadless: headless === "true",
    liveEnabled: env.AMAZON_LIVE_ENABLED === "true",
    amazonReadOnly: env.AMAZON_READ_ONLY !== "false",
    purchasingEnabled: env.AMAZON_PURCHASING_ENABLED === "true" && env.AMAZON_READ_ONLY === "false",
    retainObservations: env.RETAIN_OBSERVATIONS === "true",
  };
}
