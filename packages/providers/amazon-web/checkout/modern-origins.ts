import type { ProviderContext } from "../../../contracts/index.js";
import type { PurchaseTerms } from "../../../core/purchasing.js";
import { digest } from "../../../store/crypto.js";
import {
  consumeObservedNativeModernEntry,
  isObservedNativeModernEntry,
  modernCheckoutIdentity,
  type ModernProductOffer,
  type NativeModernEntry,
} from "./modern-product-offer.js";
import type { ModernReviewFacts } from "./modern-review-facts.js";

export type ModernCheckoutOrigin = {
  ownerId: string;
  accountRef: string;
  sessionGeneration: number;
  checkoutIdentity: string;
  offer: ModernProductOffer;
  createdAt: number;
  expiresAt: number;
  stage: "address" | "review";
  lineIdentityHash?: string;
};
/** Per-provider volatile proof. No serialization, request restore or sliding expiry. */
export class ModernCheckoutOrigins {
  private readonly entries = new Map<string, ModernCheckoutOrigin>();
  constructor(private readonly now: () => number = Date.now) {}
  private key(context: ProviderContext, url: string) {
    const identity = modernCheckoutIdentity(url);
    return identity
      ? JSON.stringify([
          context.ownerId,
          context.accountRef,
          context.sessionGeneration,
          identity,
        ])
      : undefined;
  }
  enterSession(context: ProviderContext) {
    for (const [key, value] of this.entries)
      if (
        value.expiresAt <= this.now() ||
        (value.ownerId === context.ownerId &&
          value.accountRef === context.accountRef &&
          value.sessionGeneration !== context.sessionGeneration)
      )
        this.entries.delete(key);
  }
  invalidate(context: ProviderContext) {
    for (const [key, value] of this.entries)
      if (
        value.ownerId === context.ownerId &&
        value.accountRef === context.accountRef
      )
        this.entries.delete(key);
  }
  clear() {
    this.entries.clear();
  }
  recordNativeEntry(
    context: ProviderContext,
    entry: NativeModernEntry,
  ): boolean {
    this.enterSession(context);
    if (!isObservedNativeModernEntry(entry)) return false;
    const key = this.key(context, entry.checkoutURL);
    if (!key || !consumeObservedNativeModernEntry(entry)) return false;
    const timestamp = this.now();
    this.entries.delete(key);
    this.entries.set(key, {
      ownerId: context.ownerId,
      accountRef: context.accountRef,
      sessionGeneration: context.sessionGeneration,
      checkoutIdentity: modernCheckoutIdentity(entry.checkoutURL)!,
      offer: entry.offer,
      createdAt: timestamp,
      expiresAt: timestamp + 15 * 60_000,
      stage: new URL(entry.checkoutURL).pathname.endsWith("/address")
        ? "address"
        : "review",
    });
    while (this.entries.size > 20)
      this.entries.delete(this.entries.keys().next().value!);
    return true;
  }
  get(context: ProviderContext, url: string): ModernCheckoutOrigin | undefined {
    this.enterSession(context);
    const key = this.key(context, url);
    const entry = key ? this.entries.get(key) : undefined;
    return entry ? structuredClone(entry) : undefined;
  }
  awaitingAddress(context: ProviderContext) {
    this.enterSession(context);
    return [...this.entries.values()].some(
      (entry) =>
        entry.ownerId === context.ownerId &&
        entry.accountRef === context.accountRef &&
        entry.sessionGeneration === context.sessionGeneration &&
        entry.stage === "address",
    );
  }
  completeAddressContinuation(
    context: ProviderContext,
    addressURL: string,
    reviewURL: string,
  ) {
    const key = this.key(context, addressURL);
    const entry = key ? this.entries.get(key) : undefined;
    if (
      !entry ||
      entry.expiresAt <= this.now() ||
      entry.stage !== "address" ||
      this.key(context, reviewURL) !== key ||
      !new URL(reviewURL).pathname.endsWith("/spc")
    ) {
      this.invalidate(context);
      return false;
    }
    entry.stage = "review";
    return true;
  }
  bindFacts(
    context: ProviderContext,
    url: string,
    facts: ModernReviewFacts,
  ): ModernCheckoutOrigin | undefined {
    const key = this.key(context, url);
    const entry = this.get(context, url);
    if (!key || !entry || entry.stage !== "review") return undefined;
    if (
      facts.line.asin !== entry.offer.asin ||
      facts.line.sellerId !== entry.offer.sellerId ||
      facts.line.quantity !== entry.offer.quantity ||
      digest(facts.line.unitPrice) !== digest(entry.offer.unitPrice) ||
      (entry.lineIdentityHash !== undefined &&
        entry.lineIdentityHash !== facts.line.lineIdentityHash)
    ) {
      this.invalidate(context);
      return undefined;
    }
    this.entries.get(key)!.lineIdentityHash = facts.line.lineIdentityHash;
    return this.get(context, url);
  }
  authorizesTerms(context: ProviderContext, terms: PurchaseTerms): boolean {
    const entry = this.get(context, terms.reviewUrl);
    return Boolean(
      entry &&
      entry.stage === "review" &&
      entry.lineIdentityHash &&
      terms.flow === "buy_now" &&
      !terms.recurring &&
      terms.lines.length === 1 &&
      terms.lines[0]!.asin === entry.offer.asin &&
      terms.lines[0]!.sellerId === entry.offer.sellerId &&
      terms.lines[0]!.quantity === 1 &&
      terms.lines[0]!.condition === entry.offer.condition &&
      terms.lines[0]!.purchaseMode === entry.offer.purchaseMode &&
      digest(terms.lines[0]!.unitPrice) === digest(entry.offer.unitPrice),
    );
  }
}
