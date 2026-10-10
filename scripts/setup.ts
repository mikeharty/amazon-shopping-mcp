import { randomBytes } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
await mkdir(".local", { recursive: true, mode: 0o700 });
const secret = () => randomBytes(32).toString("base64");
try {
  await writeFile(
    ".env",
    `DATABASE_URL=postgres://amazon_mcp:local-development-only@127.0.0.1:55432/amazon_mcp\nDATA_ENCRYPTION_KEY=${secret()}\nMCP_TOKEN=${secret()}\nOWNER_TOKEN=${secret()}\nOWNER_ID=local-owner\nPORT=3433\nAMAZON_PROFILE_DIR=.local/amazon-profile\nAMAZON_LIVE_ENABLED=false\nAMAZON_READ_ONLY=true\nAMAZON_PURCHASING_ENABLED=false\nRETAIN_OBSERVATIONS=false\n`,
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    "Created private .env. Secrets are not printed. Existing files are never overwritten.",
  );
} catch (e) {
  if ((e as NodeJS.ErrnoException).code === "EEXIST")
    console.log(".env already exists; preserved.");
  else throw e;
}
