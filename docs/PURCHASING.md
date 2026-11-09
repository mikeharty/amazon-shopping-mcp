# Buy It Now, checkout and Subscribe & Save

Purchasing is available in the optional transaction profile. The guided
`pnpm run local:onboard` command offers purchasing as an explicit choice and
configures the gateway and worker together. Read-only is the recommended default.
Stop a running service before rerunning onboarding to change access mode.
For manual configuration, enable both settings and restart:

```dotenv
AMAZON_READ_ONLY=false
AMAZON_PURCHASING_ENABLED=true
```

The default profile has 38 tools; enabling cart writes exposes 42, and enabling
purchasing exposes 50. `amazon_capabilities` reports the active profile.
Purchase adapters are implemented and verified with synthetic browser pages,
real isolated Postgres databases, the official MCP client, and compiled Chromium.
No real purchase or enrollment has been used as a test. Amazon layouts that do
not expose complete evidence stop with `unsupported` or a human handoff.

## Buy It Now

1. Read `buying_options_get` with the account handle and exact child ASIN. Poll
   `operations_get` for the returned operation. Read the observed seller,
   condition, purchase modes, and available frequency values.
2. Call `buy_now_prepare` with `accountRef`, `asin`, `quantity`,
   `expectedSellerId`, `expectedCondition`, and a stable `idempotencyKey`.
   It enters a supported Amazon review page without submitting an order. A
   button with an instant-order destination is rejected.

   Some ordinary one-time product pages omit explicit condition or purchase-mode
   controls. For a requested `New` Buy It Now item, preparation may enter the
   observed `/checkout/entry/buynow` review route when the seller matches exactly.
   An observed condition mismatch or present but conflicting, unselected, or
   ambiguous mode controls still block entry. The requested terms do not fill in
   missing observations: the resulting review must independently establish the
   exact ASIN, seller, New condition, one-time mode, quantity, and all remaining
   checkout terms before an approval intent can be created. Subscription
   preparation does not use this exception.

   `buying_options_get` also exposes filtered layout diagnostics for unsupported
   pages. These contain control IDs, labels, paths without URL queries, condition
   phrases, form-field names without values, and canonical availability messages.
   They are diagnostic evidence, not executable purchase terms.

   If Amazon opens its address-selection step instead of review, preparation
   returns `requires_user_action` with `checkout_address_selection_required` and
   the observed Amazon handoff URL. Preserve the complete validated URL,
   including its routing parameters. Read and select an existing saved address
   through the separate checkout-address workflow below before preparing fresh
   purchase terms. Preparation itself does not select an address or place an
   order.
3. Poll the same operation. Its completed result contains `intentId`, exact
   terms, expiry, and the private owner `reviewUrl`.
4. The owner opens that link, signs in with the separate local owner token, and
   approves those exact terms once. The assistant cannot create approval through
   MCP. `purchase_intent_get` can read approval status.
5. Call `checkout_submit` with `accountRef`, `intentId`, and a stable
   `idempotencyKey`. Poll its durable operation for the verified result.

Preparation is never a purchase authorization. The approval expires after five
minutes and is invalidated by a worker/browser lifecycle change. A changed price,
address, payment method, delivery promise, quantity, seller, or purchase mode
requires new preparation and approval.

## Existing saved checkout addresses

`checkout_addresses_get` reads saved choices from the exact observed checkout
address URL. Its result is private to the authenticated owner and includes
rendered address summaries, opaque address references and fingerprints, selected
state, session and checkout context, and a revision. Match the intended existing
destination explicitly; an address being first or marked as default is not enough
to choose it. Missing or ambiguous evidence stops selection.

Modern checkout can omit Amazon's ordinary account greeting. The address reader
can verify the signed-in account on a fixed account page during the same
serialized operation, then return to the complete checkout URL and require the
recognized saved-address controls without sign-in or payment challenges. This
proof is not cached and does not weaken authentication for other pages.

`checkout_address_select` is a separate journaled write with a stable idempotency
key. It requires a fresh matching address snapshot and selects only the requested
existing entry for that checkout. It does not create or edit addresses, change the
account default, approve a purchase, or place an order. Selection must be verified
against the resulting checkout destination; a checked radio alone is insufficient.
Changed context or address evidence stops the action before an effect. An
uncertain effect is nonretryable and uses the normal write quarantine.

Pass the fields from that exact snapshot, rather than reconstructing identity
from the displayed address text:

```json
{
  "accountRef": "ACCOUNT_UUID",
  "url": "COMPLETE_OBSERVED_CHECKOUT_ADDRESS_URL",
  "idempotencyKey": "one-existing-address-selection",
  "expectedRevision": "SNAPSHOT_REVISION",
  "expectedContextFingerprint": "SNAPSHOT_CONTEXT_FINGERPRINT",
  "expectedSessionGeneration": 1,
  "addressRef": "OBSERVED_ADDRESS_REF",
  "expectedFingerprint": "OBSERVED_ADDRESS_FINGERPRINT"
}
```

Refresh the snapshot after a worker/browser restart. Selection currently requires
a complete explicitly rendered US destination, including recipient, street and
unit, city, region, ZIP and country. The result distinguishes verification of the
physical destination alone from verification that also observes the saved-address
ID. Physical equality does not independently prove retained phone details.

Use `checkout_addresses_get` with `inspectCurrent: true` for diagnostic-only
inspection without navigation. This returns stage and control metadata without
address summaries, references, purchase terms, or intents. Diagnostic query
output contains names only. The full validated checkout URL remains necessary
for navigation and snapshot identity; dropping `pipelineType` or `isBuyNow` can
change the checkout flow.

The mutually exclusive `reconcileCurrent: true` mode reads the applied destination
on the current same-checkout address, payment or review stage with fresh account
authentication. It never repeats an address selection or clears quarantine.
Supply the exact previously observed `reconcileUrl` with that mode to restore the
same checkout stage after a restart. Partial results can include private rendered
address evidence for unsupported layouts; they do not establish complete proof.

An uncertain address selection can be reconciled by an explicit local operator
command after a complete authenticated read confirms the intended destination:

```sh
node --env-file=.env --import tsx scripts/reconcile-address-selection.ts \
  --operation UNKNOWN_ADDRESS_SELECTION_UUID \
  --snapshot-operation PRE_DISPATCH_ADDRESS_READ_UUID \
  --reconciliation-operation COMPLETE_APPLIED_ADDRESS_READ_UUID
```

This defaults to verification only. Add `--apply` to append an encrypted linked
receipt and release only that operation's account quarantine in one transaction.
The command validates the original snapshot, checkout, session, identity and
later proof, and rejects other unresolved effects or financial activity. It
preserves the original uncertain result and idempotency key. This procedure
supports address selection only; it never retries a selection, resolves a purchase
outcome, approves terms or submits an order. Receipt replay cannot release a newer
quarantine. Physical-only proof confirms the current destination without proving
retained phone details or the original click's full history.

After address selection, prepare and approve fresh complete purchase terms.
Shipping eligibility, tax, delivery and total may change with the destination.

## Cart checkout

Read `cart_get` and use its current revision in `checkout_prepare`:

```json
{
  "accountRef": "ACCOUNT_UUID",
  "expectedRevision": "OBSERVED_CART_REVISION",
  "idempotencyKey": "one-cart-checkout-request"
}
```

Omitting `url` enters checkout through the observed cart review control. To
prepare an existing checkout review, supply its allowed Amazon `url` and the
revision from `checkout_get` instead. Review and submit through the same owner
approval flow. This purchases the observed checkout items; it does not change
addresses, payment methods, shipping speeds, coupons, or selected cart lines.

With purchasing disabled, `checkout_prepare` retains its original read-only
snapshot contract (`accountRef`, `url`, `expectedRevision`) and creates no intent.

## Subscribe & Save enrollment

Use `buying_options_get` to read the available frequency values. Call
`subscriptions_prepare` with the same exact product inputs as Buy It Now,
plus the observed `frequency` value and a stable `idempotencyKey`.

```json
{
  "accountRef": "ACCOUNT_UUID",
  "asin": "B0EXAMPL01",
  "quantity": 1,
  "expectedSellerId": "OBSERVED_SELLER_ID",
  "expectedCondition": "New",
  "frequency": "OBSERVED_FREQUENCY_VALUE",
  "idempotencyKey": "one-subscription-enrollment"
}
```

Preparation selects only an observed supported frequency and opens review. The
owner page displays the item, quantity, first-delivery total, recurring schedule,
next delivery, displayed discount, future-price notice, and whether enrollment
also places an immediate order. Missing recurring terms prevent preparation.
One-time checkout cannot silently include a subscription.

After owner approval, call `subscriptions_submit` with `accountRef`, `intentId`,
and `idempotencyKey`. Success requires observed new subscription identity and
matching item, seller, quantity, frequency, and next delivery. If an initial order
was included, its new identity, exact purchased lines, and aggregate total must
also be verified independently through order details. Enrollment without an
immediate order is supported only when that behavior is explicitly observed.

`subscriptions_list` reads existing enrollment. Editing, skipping, pausing, or
cancelling an existing subscription is not implemented by these enrollment tools.

## Recovery and evidence

Every submitted intent maps to one operation even if a client repeats the call
with a different idempotency key. Keep the original handle on a timeout or lost
connection. A repeated call retrieves that operation; it never places another
order. Scope, ownership, intent action/account, session generation, approval, and
expiry are checked independently of model input.

Before dispatch, the worker re-reads the review terms. The adapter checks them
again inside the serialized browser action just before the final click. After
dispatch, a timeout, challenge, wrong item/quantity, missing order/subscription
identity, or incomplete postcondition returns non-retryable `outcome_unknown`.
The account is quarantined for operator reconciliation. Never create a replacement
intent to retry an uncertain effect. An old order confirmation does not prove a
new order; existing order and subscription identities are captured before dispatch.

Price changes, pending payment authentication, and unsupported layouts are
explicit outcomes. An accepted click or a checkout snapshot is never reported as
a completed purchase.
