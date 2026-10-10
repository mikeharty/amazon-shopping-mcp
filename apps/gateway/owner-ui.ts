import { randomBytes } from "node:crypto";
import { Store } from "../../packages/store/index.js";
import { secureEqual } from "../../packages/store/crypto.js";
import { DomainError } from "../../packages/contracts/index.js";
import { purchaseTermsSchema, type PurchaseTerms } from "../../packages/core/purchasing.js";
type Session = { csrf: string; expires: number };
const escape = (v: unknown) =>
  String(v)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const localTime = (value: Date) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(value);
const dollars = (value: { minorUnits: number; currency: string }) => new Intl.NumberFormat("en-US", { style: "currency", currency: value.currency }).format(value.minorUnits / 100);
function purchaseReview(terms: PurchaseTerms) {
  return `<h2>${terms.recurring ? "Subscribe &amp; Save enrollment" : "One-time purchase"}</h2><ul>${terms.lines.map((line) => `<li><strong>${escape(line.title)}</strong> (${escape(line.asin)}) — ${line.quantity} × ${dollars(line.unitPrice)}<br>Seller: ${line.sellerName ? `${escape(line.sellerName)} (${escape(line.sellerId)})` : escape(line.sellerId)}; condition: ${escape(line.condition)}</li>`).join("")}</ul><p>Items: ${dollars(terms.subtotal)} · shipping: ${dollars(terms.shipping)} · tax: ${dollars(terms.tax)} · discounts: ${dollars(terms.discount)}</p><p><strong>${terms.recurring && !terms.recurring.createsImmediateOrder ? "First delivery estimate" : "Total charged for this order"}: ${dollars(terms.total)}</strong></p><p>Deliver to: ${escape(terms.address.summary)}<br>Payment: ${escape(terms.payment.summary)}</p><ul>${terms.shippingGroups.map((group) => `<li>${escape(group.delivery)} — ${escape(group.speed)}</li>`).join("")}</ul>${terms.recurring ? `<h2>Recurring commitment</h2><p><strong>This enrolls you in automatic recurring deliveries.</strong></p><p>Schedule: ${escape(terms.recurring.frequency)}<br>Next delivery: ${escape(terms.recurring.nextDelivery)}<br>Displayed discount: ${escape(terms.recurring.discount)}<br>${escape(terms.recurring.futurePricePolicy)}</p><p>${terms.recurring.createsImmediateOrder ? "This approval also places the initial order at the total above." : "This approval enrolls the subscription without placing an immediate order."}</p>` : ""}${terms.promotions.length ? `<p>Promotions: ${terms.promotions.map(escape).join("; ")}</p>` : ""}${terms.warnings.length ? `<p>Amazon notices: ${terms.warnings.map(escape).join("; ")}</p>` : ""}`;
}
const page = (body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Amazon MCP owner control</title><style>:root{color-scheme:light dark;--background:#fafafa;--foreground:#17202a;--panel:#eee;--link:#0645ad}@media(prefers-color-scheme:dark){:root{--background:#15191f;--foreground:#e9edf2;--panel:#252b33;--link:#a5c8ff}}body{font:1rem/1.6 system-ui;max-width:52rem;margin:3rem auto;padding:1rem;color:var(--foreground);background:var(--background);overflow-wrap:anywhere}input,button{box-sizing:border-box;font:inherit;padding:.75rem;min-height:48px;max-width:100%}label{display:block;margin-top:1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--panel);padding:1rem}a{color:var(--link)}:focus-visible{outline:3px solid #5a9eff}button{cursor:pointer}li{margin-bottom:.75rem}@media(max-width:600px){body{margin:1rem auto}}</style><main>${body}</main></html>`;
function html(
  body: string,
  status = 200,
  extra: Record<string, string> = {},
): Response {
  return new Response(page(body), {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      // Browser form POSTs need a same-origin Origin header for verification.
      "referrer-policy": "same-origin",
      "x-content-type-options": "nosniff",
      ...extra,
    },
  });
}
export function createOwnerUi(
  store: Store,
  config: { ownerId: string; ownerToken: string; origin: string },
) {
  const sessions = new Map<string, Session>();
  const attempts = new Map<string, { count: number; since: number }>();
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.origin !== config.origin) return html("Invalid host", 403);
    if (
      request.method === "POST" &&
      request.headers.get("origin") !== config.origin
    )
      return html("Origin check failed", 403);
    if (!["GET", "POST"].includes(request.method))
      return html("Method not allowed", 405);
    const raw = request.headers
      .get("cookie")
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("owner_session="))
      ?.slice(14);
    let session = raw ? sessions.get(raw) : undefined;
    if (session && session.expires < Date.now()) {
      sessions.delete(raw!);
      session = undefined;
    }
    for (const [id, s] of sessions)
      if (s.expires < Date.now()) sessions.delete(id);
    if (url.pathname === "/owner/login" && request.method === "POST") {
      const key = "local";
      const a = attempts.get(key);
      if (a && a.since > Date.now() - 60000 && a.count >= 5)
        return html("Too many attempts. Try again in one minute.", 429);
      if (Number(request.headers.get("content-length") ?? 0) > 4096)
        return html("Request too large", 413);
      const body = await request.text();
      if (body.length > 4096) return html("Request too large", 413);
      const form = new URLSearchParams(body);
      if (!secureEqual(form.get("token") ?? "", config.ownerToken)) {
        attempts.set(key, {
          count: a && a.since > Date.now() - 60000 ? a.count + 1 : 1,
          since: a && a.since > Date.now() - 60000 ? a.since : Date.now(),
        });
        return html("Owner sign-in failed", 401);
      }
      attempts.delete(key);
      const id = randomBytes(32).toString("hex");
      sessions.set(id, {
        csrf: randomBytes(32).toString("hex"),
        expires: Date.now() + 900000,
      });
      return new Response(null, {
        status: 303,
        headers: {
          location: "/owner",
          "set-cookie": `owner_session=${id}; HttpOnly; SameSite=Strict; Path=/owner; Max-Age=900`,
          "cache-control": "no-store",
        },
      });
    }
    if (!session)
      return html(
        '<h1>Owner sign-in</h1><p>Use OWNER_TOKEN from your private .env. This is separate from the MCP client token.</p><form method="post" action="/owner/login"><label for="token">Owner token</label><input id="token" name="token" type="password" autocomplete="current-password" required><button type="submit">Sign in</button></form>',
      );
    const match = /^\/owner\/intents\/([0-9a-f-]{36})$/.exec(url.pathname);
    try {
      if (url.pathname === "/owner/reconnect" && request.method === "POST") {
        const body = await request.text();
        if (body.length > 4096) return html("Request too large", 413);
        const form = new URLSearchParams(body);
        if (!secureEqual(form.get("csrf") ?? "", session.csrf))
          return html("Request verification failed", 403);
        const a = await store.account(config.ownerId);
        await store.reconnect(config.ownerId, a.id);
        return html(
          '<h1>Account access enabled</h1><p>Restart the dedicated worker to reconnect the browser. Watches remain paused until explicitly resumed.</p><a href="/owner">Account status</a>',
        );
      }
      if (url.pathname === "/owner/delete-data" && request.method === "POST") {
        const body = await request.text();
        if (body.length > 4096) return html("Request too large", 413);
        const form = new URLSearchParams(body);
        if (
          !secureEqual(form.get("csrf") ?? "", session.csrf) ||
          form.get("confirm") !== "delete"
        )
          return html("Request verification failed", 403);
        await store.deletePrivateData(config.ownerId);
        return html(
          "<h1>Private records deleted</h1><p>Account access is disconnected. The dedicated local browser profile remains on disk; close the worker before deleting that profile separately.</p>",
        );
      }
      if (match) {
        const intent = await store.getIntent(config.ownerId, match[1]!);
        if (request.method === "POST") {
          const body = await request.text();
          if (body.length > 4096) return html("Request too large", 413);
          const form = new URLSearchParams(body);
          if (!secureEqual(form.get("csrf") ?? "", session.csrf))
            return html("Request verification failed", 403);
          if (form.get("action") !== "approve")
            return html("Unknown action", 400);
          await store.approve(
            config.ownerId,
            intent.id,
            form.get("digest") ?? "",
          );
          return html(
            '<h1>Intent approved</h1><p>The approval is single-use and expires with the displayed terms. Return to your assistant to submit it.</p><a href="/owner">Account status</a>',
          );
        }
        const parsed = purchaseTermsSchema.safeParse(intent.terms);
        const account = await store.getAccount(config.ownerId, intent.account_id);
        const active = intent.expires_at > new Date() && !intent.consumed_at && account.enabled && !account.quarantined && account.session_generation === intent.session_generation;
        return html(`<h1>Review ${parsed.success ? (parsed.data.recurring ? "this subscription" : "this purchase") : escape(intent.kind)}</h1><p>Expires ${escape(localTime(intent.expires_at))}. Review the exact terms before authorizing.</p>${parsed.success ? purchaseReview(parsed.data) : `<pre>${escape(JSON.stringify(intent.terms, null, 2))}</pre>`}${active ? `<form method="post" action="${escape(url.pathname)}"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="digest" value="${intent.digest}"><input type="hidden" name="action" value="approve"><button type="submit">Approve these exact terms once</button></form>` : "<p>This approval is unavailable or already consumed. Prepare fresh terms after resolving any account issue.</p>"}<p><a href="/owner">Leave without approving</a></p>`);
      }
      const a = await store.account(config.ownerId);
      const health = await store.workerHealth();
      return html(
        `<h1>Amazon MCP owner control</h1><p>Worker: ${health ? "running" : "offline"}. Account access: ${a.enabled ? "enabled" : "disabled"}. Account writes: ${a.quarantined ? "quarantined after an uncertain operation" : "subject to provider support"}.</p><p>Account handle: ${escape(a.id)}</p><p>Sign-in and payment credentials are entered directly in the dedicated Amazon browser. This page never collects them.</p><p>Open the intent review link returned by a preparation tool to inspect exact terms. No purchases run automatically.</p>${!a.enabled ? `<form method="post" action="/owner/reconnect"><input type="hidden" name="csrf" value="${session.csrf}"><button type="submit">Enable account access</button></form>` : ""}<h2>Delete private records</h2><p>This disconnects access and deletes observations, events, watches and settled operation records. Browser cookies remain in the local profile.</p><form method="post" action="/owner/delete-data"><input type="hidden" name="csrf" value="${session.csrf}"><label><input type="checkbox" name="confirm" value="delete" required> Delete my stored records and disconnect</label><button type="submit">Delete private records</button></form>`,
      );
    } catch (e) {
      return html(
        `<h1>Action unavailable</h1><p>${escape(e instanceof DomainError ? e.message : "Request failed")}</p>`,
        e instanceof DomainError ? e.status : 500,
      );
    }
  };
}
