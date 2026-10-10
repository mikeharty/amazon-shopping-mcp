import { orderSearchInput, researchInput, exportOrders } from "../../packages/core/shopping-workflows.js";
import { fetchProductImage } from "../../packages/core/product-images.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/server";
import {
  DomainError,
  type Result,
  type Owner,
} from "../../packages/contracts/index.js";
import { Store } from "../../packages/store/index.js";
import { Monitoring } from "../../packages/store/monitoring.js";
import { OperationQueries, operationListInput } from "../../packages/store/operations.js";
import { SERVER_INSTRUCTIONS, WORKFLOW_GUIDE } from "./guide.js";
import { productHistorySubject } from "../../packages/core/observations.js";
import { prepareUserDraft } from "../../packages/core/action-proposals.js";
import { compareOffers } from "../../packages/core/comparison.js";
import { purchaseCommitKinds } from "../../packages/core/purchasing.js";
import type { KeepaProvider } from "../../packages/providers/keepa/index.js";
import type { ToolDefinition, ResourceDefinition } from "./transport.js";
const account = { accountRef: z.uuid() };
const asin = z.string().regex(/^[A-Z0-9]{10}$/);
const idempotencyKey = z.string().min(8).max(120);
const pagination = { page: z.number().int().min(1).max(10).optional() };
const resultSchema = z
  .object({
    status: z.string(),
    data: z.unknown().optional(),
    operationId: z.string().optional(),
    error: z
      .object({
        code: z.string(),
        retryable: z.boolean(),
        message: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();
export const readSchemas: Record<string, z.ZodType> = {
  orders_search: z.object({ ...account, ...orderSearchInput.shape }).strict().refine((i) => !i.dateFrom || !i.dateTo || i.dateFrom <= i.dateTo, "dateFrom must precede dateTo"),
  products_research: z.object({ ...account, ...researchInput.shape }).strict().refine((i) => new Set(i.asins).size === i.asins.length && i.weights.price + i.weights.rating + (i.desiredFeatures.length ? i.weights.features : 0) > 0, "Use distinct ASINs and applicable positive weights"),
  products_search: z
    .object({ ...account, query: z.string().min(1).max(200), ...pagination })
    .strict(),
  products_get: z.object({ ...account, asin }).strict(),
  offers_list: z.object({ ...account, asin }).strict(),
  product_reviews_list: z.object({ ...account, asin, ...pagination }).strict(),
  product_media_list: z.object({ ...account, asin }).strict(),
  cart_get: z.object(account).strict(),
  orders_list: z.object({ ...account, ...pagination }).strict(),
  orders_get: z
    .object({ ...account, orderId: z.string().regex(/^\d{3}-\d{7}-\d{7}$/) })
    .strict(),
  shipments_get: z
    .object({ ...account, orderId: z.string().regex(/^\d{3}-\d{7}-\d{7}$/) })
    .strict(),
  subscriptions_list: z.object(account).strict(),
  categories_browse: z
    .object({
      ...account,
      node: z
        .string()
        .regex(/^\d{1,20}$/)
        .optional(),
    })
    .strict(),
  products_variants: z.object({ ...account, asin }).strict(),
  products_related: z.object({ ...account, asin }).strict(),
  sellers_get: z
    .object({ ...account, sellerId: z.string().regex(/^[A-Z0-9]{6,32}$/) })
    .strict(),
  seller_feedback_list: z
    .object({
      ...account,
      sellerId: z.string().regex(/^[A-Z0-9]{6,32}$/),
      ...pagination,
    })
    .strict(),
  deals_search: z.object(account).strict(),
  checkout_get: z.object({ ...account, url: z.url().max(2048) }).strict(),
  checkout_prepare: z
    .object({
      ...account,
      url: z.url().max(2048),
      expectedRevision: z.string().min(1).max(64),
    })
    .strict(),
};
const revision = z.string().min(1).max(64);
const lineRef = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const exactProduct = {
  ...account, idempotencyKey, asin,
  quantity: z.number().int().min(1).max(10),
  expectedSellerId: z.string().regex(/^[A-Z0-9]{6,32}$/),
  expectedCondition: z.string().trim().min(1).max(80),
};
export const purchasePreparationSchemas: Record<string, z.ZodType> = {
  checkout_prepare: z.object({ ...account, idempotencyKey, url: z.url().max(2048).optional(), expectedRevision: revision }).strict(),
  buy_now_prepare: z.object(exactProduct).strict(),
  subscriptions_prepare: z.object({ ...exactProduct, frequency: z.string().min(1).max(120) }).strict(),
};
export const cartWriteSchemas: Record<string, z.ZodType> = {
  cart_add: z
    .object({
      ...account,
      idempotencyKey,
      asin,
      quantity: z.number().int().min(1).max(10),
      expectedRevision: revision,
      expectedSellerId: z.string().regex(/^[A-Z0-9]{6,32}$/),
      expectedCondition: z.string().min(1).max(80),
      purchaseMode: z.literal("one_time"),
    })
    .strict(),
  cart_set_quantity: z
    .object({
      ...account,
      idempotencyKey,
      lineRef,
      quantity: z.number().int().min(1).max(10),
      expectedRevision: revision,
    })
    .strict(),
  cart_remove: z
    .object({ ...account, idempotencyKey, lineRef, expectedRevision: revision })
    .strict(),
  cart_move: z
    .object({
      ...account,
      idempotencyKey,
      lineRef,
      expectedRevision: revision,
      destination: z.enum(["save_for_later", "restore"]),
    })
    .strict(),
};
export function content(result: Result): CallToolResult {
  const safe = JSON.parse(JSON.stringify(result));
  return {
    structuredContent: safe,
    content: [{ type: "text", text: JSON.stringify(safe) }],
    ...(["failed", "conflict", "outcome_unknown"].includes(result.status)
      ? { isError: true }
      : {}),
  };
}
export function createRegistry(
  store: Store,
  options: {
    liveEnabled: boolean;
    retainObservations: boolean;
    origin: string;
    readKinds?: string[];
    writeSchemas?: Record<string, z.ZodType>;
    keepa?: KeepaProvider;
    desktopNotifications?: boolean;
    fetchImage?: typeof fetchProductImage;
    purchasingEnabled?: boolean;
  },
) {
  const monitoring = new Monitoring(store);
  const operationQueries = new OperationQueries(store);
  const tools: ToolDefinition[] = [];
  const add = (
    name: string,
    description: string,
    inputSchema: z.ZodType,
    scope: string,
    readOnly: boolean,
    handler: (input: Record<string, unknown>, owner: Owner) => Promise<Result>,
  ) => {
    tools.push({
      name,
      description,
      inputSchema,
      outputSchema: resultSchema,
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: !readOnly,
        idempotentHint: readOnly,
        openWorldHint: ![
          "products_compare",
          "orders_export",
          "operations_get",
          "operations_list",
          "amazon_diagnostics",
          "amazon_capabilities",
          "events_list",
          "prices_history",
        ].includes(name),
      },
      handler: async (input, ctx) => {
        if (!ctx.owner.scopes.includes(scope))
          return content({
            status: "failed",
            error: { code: "FORBIDDEN", retryable: false },
          });
        try {
          return content(
            await handler(input as Record<string, unknown>, ctx.owner),
          );
        } catch (e) {
          return content({
            status:
              e instanceof DomainError && e.status === 409
                ? "conflict"
                : "failed",
            error: {
              code: e instanceof DomainError ? e.code : "INTERNAL_ERROR",
              retryable: false,
              ...(e instanceof DomainError ? { message: e.message } : {}),
            },
          });
        }
      },
    });
  };
  add(
    "amazon_capabilities",
    "Get implemented tools, source/access state, account handle and worker health. Fixture verification does not imply live support.",
    z.object({}).strict(),
    "account:read",
    true,
    async (_, owner) => {
      const a = await store.account(owner.id);
      return {
        status: "ok",
        data: {
          accountRef: a.id,
          marketplace: a.marketplace,
          sessionGeneration: a.session_generation,
          quarantined: a.quarantined,
          accountEnabled: a.enabled,
          workerOnline: await store.workerHealth(),
          liveEnabled: options.liveEnabled,
          verification: "fixture-verified; run amazon:smoke for current account read evidence",
          notificationChannels: options.desktopNotifications
            ? ["event-inbox", "macos-desktop"]
            : ["event-inbox"],
          creatorsEnabled: false,
          keepaEnabled: options.keepa?.enabled ?? false,
          retainsObservations: options.retainObservations,
          readTools: [...new Set([...(options.readKinds ?? Object.keys(readSchemas)).filter((kind) => !options.purchasingEnabled || kind !== "checkout_prepare"), "orders_search", "products_research", ...(options.purchasingEnabled ? ["buying_options_get", "purchase_intent_get"] : [])])],
          writeTools: [...Object.keys(options.writeSchemas ?? {}), ...(options.purchasingEnabled ? [...purchaseCommitKinds, "buy_now_prepare", "subscriptions_prepare"] : [])],
          purchasingEnabled: options.purchasingEnabled ?? false,
          preparationTools: options.purchasingEnabled ? Object.keys(purchasePreparationSchemas) : [],
          consequentialActions:
            options.purchasingEnabled ? "exact-term owner approval required; fixture-verified purchase adapters; no live purchase verification" : "not exposed; internal proposal validation only",
          publicReadEvidence: {
            date: "2026-09-22",
            scope:
              "one logged-out search and product smoke; no account verification",
          },
          loginCommand: "pnpm run browser:login",
        },
      };
    },
  );
  for (const kind of [...new Set([...(options.readKinds ?? Object.keys(readSchemas)), "orders_search", "products_research"])]) {
    if (kind === "checkout_prepare" && options.purchasingEnabled) continue;
    const schema = readSchemas[kind];
    if (!schema) throw new Error(`No input schema for ${kind}`);
    add(
      kind,
      kind === "checkout_prepare"
        ? "Read-only checkout snapshot comparison. Does not create an executable intent, owner consent or purchase authorization. Poll operations_get."
        : `Read ${kind.replaceAll("_", " ")} through the dedicated Amazon browser. Returns a durable operation; poll operations_get. Coverage is partial and source dependent.`,
      schema,
      kind.startsWith("product") || kind === "offers_list"
        ? "catalog:read"
        : "account:read",
      true,
      async (input, owner) => {
        const { accountRef, ...args } = input;
        await store.getAccount(owner.id, String(accountRef));
        if (!options.liveEnabled)
          return {
            status: "requires_user_action",
            action: { kind: "enable_dedicated_browser" },
            data: {
              instructions:
                "Complete pnpm browser:login; establish source access; set AMAZON_LIVE_ENABLED=true and restart the worker and gateway.",
            },
          };
        const op = await store.start(
          owner.id,
          String(accountRef),
          kind,
          "read",
          args,
          randomUUID(),
        );
        return { status: "pending", operationId: op.id };
      },
    );
  }
  if (options.purchasingEnabled) {
    add("buying_options_get", "Read exact product identity, seller, condition and observed purchase modes/frequency values. This does not buy or subscribe. Poll operations_get.", z.object({ ...account, asin }).strict(), "account:read", true, async (input, owner) => {
      await store.getAccount(owner.id, String(input.accountRef));
      if (!options.liveEnabled) return { status: "requires_user_action", error: { code: "LIVE_ACCESS_DISABLED", retryable: false } };
      const op = await store.start(owner.id, String(input.accountRef), "buying_options_get", "read", { asin: input.asin }, randomUUID());
      return { status: "pending", operationId: op.id };
    });
    for (const [kind, schema] of Object.entries(purchasePreparationSchemas)) {
      add(kind, kind === "subscriptions_prepare"
        ? "Prepare Subscribe & Save enrollment for one exact item and observed frequency. Returns a durable operation and a private owner review link. Recurring terms and any immediate order must be approved; this never confirms enrollment."
        : "Prepare exact checkout terms and a private owner approval link. Buy It Now enters a review page without placing an order. For cart checkout omit url and use cart_get revision; for an existing review supply url and checkout_get revision. Preserve one idempotency key; poll operations_get.",
      schema, kind === "subscriptions_prepare" ? "subscriptions:write" : "checkout:prepare", false, async (input, owner) => {
        const { accountRef, idempotencyKey: key, ...args } = input;
        await store.getAccount(owner.id, String(accountRef));
        if (!options.liveEnabled) return { status: "requires_user_action", error: { code: "LIVE_ACCESS_DISABLED", retryable: false } };
        const op = await store.start(owner.id, String(accountRef), kind, kind === "checkout_prepare" ? "read" : "write", args, String(key));
        return { status: "pending", operationId: op.id };
      });
    }
    add("purchase_intent_get", "Read an owner-bound purchase or subscription intent, approval status and exact terms. This cannot approve an intent.", z.object({ ...account, intentId: z.uuid() }).strict(), "account:read", true, async (input, owner) => {
      const intent = await store.getIntent(owner.id, String(input.intentId));
      await store.getAccount(owner.id, String(input.accountRef));
      if (intent.account_id !== input.accountRef || !(purchaseCommitKinds as readonly string[]).includes(intent.kind)) throw new DomainError("NOT_FOUND", "Purchase intent not found", 404);
      return { status: "ok", data: { intentId: intent.id, kind: intent.kind, terms: intent.terms, termsDigest: intent.digest, approved: Boolean(intent.approved_at), consumed: Boolean(intent.consumed_at), expiresAt: intent.expires_at.toISOString(), reviewUrl: `${options.origin}/owner/intents/${intent.id}` } };
    });
    for (const kind of purchaseCommitKinds) {
      add(kind, "Submit exactly one current owner-approved intent. The owner approves through the private review page; a caller boolean is never approval. Changed terms stop submission. Unknown outcomes quarantine later writes and must never be retried with another intent. Poll operations_get.", z.object({ ...account, intentId: z.uuid(), idempotencyKey }).strict(), kind === "subscriptions_submit" ? "subscriptions:write" : "checkout:commit", false, async (input, owner) => {
        const intent = await store.getIntent(owner.id, String(input.intentId));
        await store.getAccount(owner.id, String(input.accountRef));
        if (intent.account_id !== input.accountRef || intent.kind !== kind) throw new DomainError("INTENT_MISMATCH", "Intent does not match this account or action");
        if (!options.liveEnabled) return { status: "requires_user_action", error: { code: "LIVE_ACCESS_DISABLED", retryable: false } };
        const op = await store.submit(owner.id, intent.id, String(input.idempotencyKey));
        return { status: "pending", operationId: op.id };
      });
    }
    for (let index = 0; index < tools.length; index++) {
      const tool = tools[index]!;
      if ([...Object.keys(purchasePreparationSchemas), ...purchaseCommitKinds, "purchase_intent_get"].includes(tool.name))
        tools[index] = { ...tool, annotations: { ...tool.annotations, idempotentHint: true, ...(tool.name === "purchase_intent_get" ? { openWorldHint: false } : {}) } };
    }
  }
  for (const [kind, schema] of Object.entries(options.writeSchemas ?? {}))
    add(
      kind,
      `Apply and verify ${kind.replaceAll("_", " ")}. Requires exact current cart revision; uncertain effects quarantine writes.`,
      schema,
      "cart:write",
      false,
      async (input, owner) => {
        const { accountRef, idempotencyKey: key, ...args } = input;
        await store.getAccount(owner.id, String(accountRef));
        if (!options.liveEnabled)
          return {
            status: "requires_user_action",
            data: {
              instructions:
                "Dedicated account login and source access must be established first.",
            },
          };
        const op = await store.start(
          owner.id,
          String(accountRef),
          kind,
          "write",
          args,
          String(key),
        );
        return { status: "pending", operationId: op.id };
      },
    );
  add(
    "amazon_diagnostics",
    "Inspect local account access, service-wide worker heartbeat, owner-scoped queue and recovery steps. Does not contact Amazon, verify sign-in, retry operations or alter account state.",
    z.object({}).strict(), "account:read", true,
    async (_, owner) => ({ status: "ok", data: await operationQueries.diagnostics(owner.id, options.liveEnabled) }),
  );
  add(
    "operations_list",
    "Recover durable job handles after a disconnect. Returns owner-scoped metadata only, newest first, with filters and an opaque nextCursor. Use the same filters on subsequent pages; fetch results with operations_get. Does not retry jobs or list Amazon orders.",
    operationListInput, "account:read", true,
    async (input, owner) => ({ status: "ok", data: await operationQueries.list(owner.id, input) }),
  );
  add(
    "operations_get",
    "Read owner-scoped durable progress/result. Unknown outcomes must not be retried as a new purchase.",
    z.object({ operationId: z.uuid() }).strict(),
    "account:read",
    true,
    async (input, owner) => {
      const op = await store.getOperation(owner.id, String(input.operationId));
      return {
        status: "ok",
        data: {
          id: op.id,
          kind: op.kind,
          status: op.status,
          revision: op.revision,
          result: op.result,
        },
      };
    },
  );
  add(
    "operations_cancel",
    "Cancel queued work only. This never cancels an Amazon order or proves a dispatched effect stopped.",
    z
      .object({ operationId: z.uuid(), revision: z.number().int().positive() })
      .strict(),
    "cart:write",
    false,
    async (input, owner) => {
      const op = await store.cancel(
        owner.id,
        String(input.operationId),
        Number(input.revision),
      );
      return {
        status: "ok",
        data: { id: op.id, status: op.status, revision: op.revision },
      };
    },
  );
  add(
    "account_disconnect",
    "Disconnect account access and pause watches. Active actions must settle first. Browser profile deletion is a separate local owner action.",
    z.object(account).strict(),
    "account:write",
    false,
    async (i, o) => {
      await store.disconnect(o.id, String(i.accountRef));
      return {
        status: "ok",
        data: { disconnected: true, profileRetained: true },
      };
    },
  );
  if (options.keepa?.enabled) {
    add(
      "keepa_prices_history",
      "Optional paid Keepa observations; no guarantee of complete history. Uses configured per-process call/token budget.",
      z
        .object({
          asins: z.array(asin).min(1).max(10),
          days: z.number().int().min(1).max(3650).default(365),
        })
        .strict(),
      "catalog:read",
      true,
      async (i) => {
        const r = await options.keepa!.productHistory({
          asins: i.asins as string[],
          days: Number(i.days),
        });
        return {
          ...r,
          coverage: { ...r.coverage, missing: [...r.coverage.missing] },
          error: r.error ? { ...r.error, retryable: false } : undefined,
        };
      },
    );
    add(
      "keepa_sellers_get",
      "Optional paid Keepa seller observations; can be stale and exclude storefront inventory.",
      z
        .object({
          sellerIds: z
            .array(z.string().regex(/^[A-Z0-9]{4,32}$/))
            .min(1)
            .max(10),
        })
        .strict(),
      "catalog:read",
      true,
      async (i) => {
        const r = await options.keepa!.sellers({
          sellerIds: i.sellerIds as string[],
        });
        return {
          ...r,
          coverage: { ...r.coverage, missing: [...r.coverage.missing] },
          error: r.error ? { ...r.error, retryable: false } : undefined,
        };
      },
    );
  }
  add(
    "content_draft",
    "Preserve supplied review/feedback/support text for manual owner review. Never publishes or contacts anyone, and does not certify an actual purchase or source eligibility.",
    z
      .object({
        ...account,
        kind: z.enum(["product_review", "seller_feedback", "support_contact"]),
        destinationRef: z
          .string()
          .regex(/^(?:[A-Z0-9]{10}|\d{3}-\d{7}-\d{7})$/),
        userText: z.string().min(1).max(10000),
      })
      .strict(),
    "account:read",
    true,
    async (i, o) => {
      await store.getAccount(o.id, String(i.accountRef));
      const draft = prepareUserDraft({
        context: {
          proposalId: randomUUID(),
          ownerId: o.id,
          accountRef: String(i.accountRef),
          expiresAt: new Date(Date.now() + 300000).toISOString(),
          handoffUrl: "https://www.amazon.com/gp/your-account/order-history",
        },
        kind: i.kind as
          "product_review" | "seller_feedback" | "support_contact",
        destinationRef: String(i.destinationRef),
        userText: String(i.userText),
      });
      return {
        status: "ok",
        data: {
          source: "user-provided-text",
          draft,
          eligibilityVerified: false,
        },
      };
    },
  );
  const money = z
    .object({
      currency: z.string().length(3),
      minorUnits: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER / 100),
    })
    .strict();
  const offer = z
    .object({
      asin,
      sellerId: z.string().optional(),
      condition: z.string(),
      purchaseMode: z.string(),
      price: money,
      shipping: money.optional(),
      tax: money.optional(),
      quantity: z.number().int().positive(),
      unitsPerItem: z.number().positive().optional(),
      unit: z.string().optional(),
    })
    .strict();
  add(
    "products_compare",
    "Calculate unit/delivered costs from supplied offer observations. Does not fetch or certify current prices; unknown fees remain unknown.",
    z.object({ offers: z.array(offer).min(1).max(20) }).strict(),
    "catalog:read",
    true,
    async (input) => ({
      status: "ok",
      data: {
        source: "caller-supplied-observations",
        items: compareOffers(input.offers as z.infer<typeof offer>[]),
      },
    }),
  );
  add("orders_export", "Export a completed owner-scoped orders_search result as CSV or JSON. Includes coverage; totals are whole-order observations, not net spending. CSV cells are escaped against spreadsheet formulas.",
    z.object({ operationId: z.uuid(), format: z.enum(["csv", "json"]).default("csv") }).strict(), "account:read", true,
    async (input, owner) => {
      const op = await store.getOperation(owner.id, String(input.operationId));
      if (op.kind !== "orders_search" || !["ok", "partial", "requires_user_action"].includes(op.status)) throw new DomainError("INVALID_ORDER_RESULT", "Use a finished orders_search operation", 400);
      return { status: "partial", data: exportOrders(op.result?.data, input.format as "csv" | "json") };
    });
  tools.push({
    name: "product_image_get", description: "Display one product image from an owner-scoped products_get or product_media_list or products_research operation (pass asin for research). Returns an MCP image block plus source link. Client image display varies; no arbitrary URLs, browser cookies or authenticated pages are fetched.",
    inputSchema: z.object({ operationId: z.uuid(), asin: asin.optional(), index: z.number().int().min(0).max(19).default(0) }).strict(),
    outputSchema: resultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    handler: async (input, ctx) => {
      try {
        if (!ctx.owner.scopes.includes("catalog:read")) throw new DomainError("FORBIDDEN", "Catalog access required", 403);
        const args = input as { operationId: string; asin?: string; index: number };
        const op = await store.getOperation(ctx.owner.id, args.operationId);
        if (!["products_get","product_media_list","products_research"].includes(op.kind) || !["ok","partial"].includes(op.status)) throw new DomainError("INVALID_IMAGE_SOURCE", "Read product media first", 400);
        const source = op.kind === "products_research" ? z.object({ items: z.array(z.object({ asin }).passthrough()) }).parse(op.result?.data).items.find((p) => p.asin === args.asin) : op.result?.data;
        const data = z.object({ asin, media: z.array(z.object({ kind: z.string(), url: z.string(), alt: z.string().optional() })) }).parse(source);
        if ((op.kind === "products_research" ? !Array.isArray(op.input.asins) || !op.input.asins.includes(data.asin) : data.asin !== op.input.asin || (args.asin !== undefined && args.asin !== data.asin)) || op.result?.coverage?.missing.some((m) => m.startsWith("required:"))) throw new DomainError("INVALID_IMAGE_SOURCE", "Product identity must be verified", 400);
        const selected = data.media.filter((m) => m.kind === "image")[args.index];
        if (!selected) throw new DomainError("NOT_FOUND", "Image index not available", 404);
        const image = await (options.fetchImage ?? fetchProductImage)(selected.url);
        const result = content({ status: "ok", data: { asin: data.asin, sourceUrl: selected.url, alt: selected.alt, observedAt: op.result?.observation?.observedAt } });
        return { ...result, content: [...result.content, image] };
      } catch (e) { return content({ status: "failed", error: { code: e instanceof DomainError ? e.code : "IMAGE_UNAVAILABLE", retryable: false } }); }
    },
  });
  add("price_alert_create", "Create an idempotent USD product-price alert. By default the first valid observation notifies if already at/below target; later notifications require a new downward crossing. Uses the durable inbox and optional desktop notices, not purchases. The worker must remain awake.",
    z.object({ ...account, asin, targetMinorUnits: z.number().int().nonnegative().max(100_000_000), cadenceSeconds: z.number().int().min(300).max(604800).default(900),
      notifyIfAlreadyBelow: z.boolean().default(true), expiresAt: z.iso.datetime().optional(), idempotencyKey }).strict(), "watches:write", false,
    async (i,o) => {
      await store.getAccount(o.id, String(i.accountRef));
      if (!options.liveEnabled) return { status: "requires_user_action", data: { instructions: "Enable dedicated browser access and start the worker before creating an alert." } };
      const watch = await monitoring.create(o.id, String(i.accountRef), "products_get", { asin: i.asin }, Number(i.cadenceSeconds), i.expiresAt as string | undefined,
        String(i.idempotencyKey), { currency: "USD", minorUnits: Number(i.targetMinorUnits), notifyOnFirstMatch: Boolean(i.notifyIfAlreadyBelow) });
      return { status: "ok", data: { watch, channels: options.desktopNotifications ? ["event-inbox","macos-desktop"] : ["event-inbox"], priceBasis: "Observed item price; excludes unverified shipping, tax, coupons and seller conditions." } };
    });
  add(
    "prices_history",
    "Read retained own product observations across account runtime restarts, with per-point source/session/delivery provenance. These are historical observations, never one merged quote. No pre-install backfill; only populated when permitted retention is enabled.",
    z
      .object({
        ...account,
        asin,
        limit: z.number().int().min(1).max(500).default(100),
      })
      .strict(),
    "catalog:read",
    true,
    async (input, owner) => {
      const a = await store.getAccount(owner.id, String(input.accountRef));
      const subject = productHistorySubject(a.marketplace, String(input.asin));
      return {
        status: "partial",
        data: {
          items: await monitoring.history(
            owner.id,
            a.id,
            subject,
            Number(input.limit),
          ),
          source: "own-observations",
          quoteEligible: false,
          contextPolicy:
            "Each point retains its own context; unverified delivery contexts are not comparable quotes",
          retentionEnabled: options.retainObservations,
        },
        coverage: {
          complete: false,
          missing: ["pre-install-history", "verified-delivery-context"],
          reason: "Only permitted observations recorded by this installation",
        },
      };
    },
  );
  const watchKinds = [
    "shipments_get",
    "orders_get",
    "products_get",
    "offers_list",
    "subscriptions_list",
  ] as const;
  add(
    "watches_upsert",
    "Create an idempotent change watch with durable inbox and optionally configured desktop delivery. Minimum cadence five minutes. First observation establishes a baseline; optional product price threshold emits only downward crossings. No automatic shopping actions.",
    z
      .object({
        ...account,
        kind: z.enum(watchKinds),
        input: z.record(z.string(), z.unknown()),
        cadenceSeconds: z.number().int().min(300).max(604800).default(900),
        expiresAt: z.iso.datetime().optional(),
        idempotencyKey,
        priceAtOrBelow: z
          .object({
            currency: z.literal("USD"),
            minorUnits: z
              .number()
              .int()
              .nonnegative()
              .max(Number.MAX_SAFE_INTEGER),
          })
          .strict()
          .optional(),
      })
      .strict(),
    "watches:write",
    false,
    async (input, owner) => {
      if (!options.liveEnabled)
        return {
          status: "requires_user_action",
          data: {
            instructions:
              "Enable and verify a dedicated source before starting scheduled observation.",
          },
        };
      const kind = String(input.kind);
      const parsed = readSchemas[kind]!.parse({
        ...(input.input as object),
        accountRef: input.accountRef,
      }) as Record<string, unknown>;
      delete parsed.accountRef;
      return {
        status: "ok",
        data: await monitoring.create(
          owner.id,
          String(input.accountRef),
          kind,
          parsed,
          Number(input.cadenceSeconds),
          input.expiresAt as string | undefined,
          String(input.idempotencyKey),
          input.priceAtOrBelow as
            { currency: "USD"; minorUnits: number } | undefined,
        ),
      };
    },
  );
  add(
    "watches_list",
    "List owner watches, next due time and last successful observation.",
    z.object({}).strict(),
    "account:read",
    true,
    async (_, owner) => ({
      status: "ok",
      data: { items: await monitoring.list(owner.id) },
    }),
  );
  add(
    "watches_pause",
    "Pause/resume a watch using optimistic revision checking.",
    z
      .object({
        watchRef: z.uuid(),
        paused: z.boolean(),
        revision: z.number().int().positive(),
      })
      .strict(),
    "watches:write",
    false,
    async (i, o) => {
      await monitoring.pause(
        o.id,
        String(i.watchRef),
        Boolean(i.paused),
        Number(i.revision),
      );
      return { status: "ok" };
    },
  );
  add(
    "watches_delete",
    "Delete an owner watch without altering its Amazon subject.",
    z.object({ watchRef: z.uuid() }).strict(),
    "watches:write",
    false,
    async (i, o) => {
      await monitoring.remove(o.id, String(i.watchRef));
      return { status: "ok" };
    },
  );
  add(
    "events_list",
    "Read durable owner notifications after an opaque sequence cursor. MCP cannot wake a closed client.",
    z
      .object({
        cursor: z
          .string()
          .regex(/^\d{1,18}$/)
          .default("0"),
        limit: z.number().int().min(1).max(100).default(50),
      })
      .strict(),
    "account:read",
    true,
    async (i, o) => ({
      status: "ok",
      data: await monitoring.events(o.id, String(i.cursor), Number(i.limit)),
    }),
  );
  add(
    "events_acknowledge",
    "Mark inbox events read; never performs downstream shopping actions.",
    z.object({ eventIds: z.array(z.uuid()).max(100) }).strict(),
    "watches:write",
    false,
    async (i, o) => {
      await monitoring.acknowledge(o.id, i.eventIds as string[]);
      return { status: "ok" };
    },
  );
  const resources: ResourceDefinition[] = [
    {
      name: "workflow-guide", uri: "amazon://guide", title: "Amazon MCP workflow guide",
      description: "Polling, recovery, research, tracking, coverage and notification workflows", mimeType: "text/markdown",
      handler: async (uri, ctx) => {
        if (!ctx.owner.scopes.includes("account:read")) throw new DomainError("FORBIDDEN", "Read scope required", 403);
        return { contents: [{ uri: uri.toString(), mimeType: "text/markdown", text: WORKFLOW_GUIDE }] };
      },
    },
    {
      name: "local-status", uri: "amazon://status", title: "Local service health",
      description: "Owner-scoped local diagnostics; no Amazon request or sign-in verification", mimeType: "application/json",
      handler: async (uri, ctx) => {
        if (!ctx.owner.scopes.includes("account:read")) throw new DomainError("FORBIDDEN", "Read scope required", 403);
        return { contents: [{ uri: uri.toString(), mimeType: "application/json", text: JSON.stringify(await operationQueries.diagnostics(ctx.owner.id, options.liveEnabled)) }] };
      },
    },
    {
      name: "event-inbox",
      uri: "amazon://events",
      description: "Owner-scoped persisted notification inbox",
      mimeType: "application/json",
      handler: async (uri, ctx) => {
        if (!ctx.owner.scopes.includes("account:read"))
          throw new DomainError("FORBIDDEN", "Read scope required", 403);
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: "application/json",
              text: JSON.stringify(await monitoring.events(ctx.owner.id)),
            },
          ],
        };
      },
    },
  ];
  return { tools, resources, instructions: SERVER_INSTRUCTIONS };
}
