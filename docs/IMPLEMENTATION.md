# Implementation status

Started 2026-09-22. Manager: Astra High. Two Medium worker lanes; no remote publishing, paid activation or live consequential account actions.

## Executable sequence

1. Establish current registry/runtime evidence, shared contracts, locked dependencies and clean baseline.
2. In parallel: transport/client/queue interoperability and dedicated browser/runtime/domain extraction.
3. Manager builds Postgres journal, atomic consent/idempotency, quarantine, observation/watch/event persistence and integrates both lanes.
4. Extend practical domain reads, cart and transaction preparation/execution contracts against offline browser fixtures; keep unsupported live flows explicit.
5. Run typecheck/build/unit, real Postgres/queue, MCP client and browser-fixture checks. Run permitted read-only public smoke; provide dedicated login instructions when ready.
6. Same-worker defect loop; integrate accepted commits; document implemented vs fixture/live evidence and operation commands.

## Current status

- Healthy existing non-bare repository; no application baseline before this run.
- Registry recheck: mcp-handler 2.2.0, MCP server/client 2.0.0, Playwright 1.63.0, Graphile Worker 0.18.0.
- Node 26.7.0 present; pnpm not on PATH. Use pinned pnpm through npm exec.
- Personal Amazon authentication and actual client UI remain unverified. No secrets requested or account mutations performed.

## Gates

Record source access basis before live activation; no stealth, CAPTCHA bypass, private APIs or copied browser profiles. Real purchases/returns/cancellations/subscriptions require a concrete user request, never tests. All external writes use exact state and postconditions; ambiguous dispatch quarantines future writes. Simulation is not live verification.

## 2026-09-22 integration milestones

- Baseline committed; two isolated Medium worktrees active. Transport commit and manager-requested streaming-bound fix integrated.
- Actual local Node HTTP gateway runs at loopback port 3433; SDK smoke negotiates MCP 2026-07-28 and discovers 21 typed tools at this milestone. Legacy 2025 path independently tested.
- Loopback Postgres 17 container started; encrypted app tables and Graphile migrations applied. Local secrets generated into ignored mode-0600 .env, never printed.
- 18 tests currently pass: SDK transport/auth/body bounds; real Postgres consent/idempotency/uncertainty/ownership; actual Graphile serialization/restart/replay/rollback; owner login/CSRF/escaped review; money/crypto.
- Browser worker expanding 18 reads plus four cart mutations and checkout snapshots. Review identified and is fixing click-timeout uncertainty, exact-offer/delta verification and stale profile lock takeover before enabling them.
- Optional Keepa adapter is in second worker lane. Paid API calls remain disabled; fixtures test decoding and budgets.
- No personal Amazon account connected or live mutation attempted. Live operation activation and observation retention default off.

## Integration in progress, 19:05 local

- Accepted optional Keepa adapter and review fixes: 10 bounded-provider tests, no paid API calls.
- Real registry now tested over production HTTP bridge + SDK + PostgreSQL: discovery, durable read result, owner isolation, scope rejection and strict write input rejection.
- Disconnect/delete/reconnect added; 9 store tests and 2 real queue tests pass. New account generation invalidates old consent; unresolved effects block audit deletion.
- Browser final review returned layout completeness, exact-order identity, cart destination/offer checks and checkout URL restrictions to the same worker. Integration waits for those fixes.
- Internal order/return/replacement/subscription proposal validation is being reviewed independently; it will not be represented as a live submission adapter.
- README now documents actual install/start/login/test commands and default-off live/paid settings. Capability ledger separates delivered code from broader planned work.

## Initial integrated verification, 2026-09-22

- `TEST_DATABASE_URL=postgres://amazon_mcp:local-development-only@127.0.0.1:55432/amazon_mcp npx pnpm@10.32.1 run verify`: **64 tests, 11 files passed**, typecheck and build passed, no skipped database suites. Tests create/drop distinct temporary databases; browser tests intercept all network and use synthetic pages.
- Full `npx pnpm@10.32.1 audit --json`: **zero advisories**, including development dependencies. Vitest upgraded from the initial 3.2.4 baseline to maintained 5.0.1 after the [maintainer advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9); tsx upgraded to 4.23.15. Registry versions and engine requirements were rechecked before install.
- Browser domain/runtime regression suite: 14 tests. Logged-out public search read observed 60 visible results and one exact product page; see browser evidence. No authenticated account read or live mutation was performed.
- macOS desktop adapter: 7 fake-delivery tests, default disabled; no actual notification sent. Durable outbox records accepted/failed/unknown states and never replays uncertain dispatch. Product price thresholds emit only downward crossings, with real database tests.
- Production HTTP + complete registry + official MCP SDK + Postgres: 3 integration tests, including owner isolation, input/scope checks, durable read results and exact user draft preservation.
- The separate login process remains waiting for human completion; no Enter/resume signal has been sent without a user answer. Account/live browsing and paid Keepa remain disabled in local configuration.
- Remaining feature gaps and their evidence boundaries are detailed in [capabilities](capabilities.md). Local deployment only; no remote push, deployment, paid call or shopping commitment.

### Initial integrated runtime smoke

The compiled gateway and worker run from `dist/` on loopback. `node --env-file=.env dist/scripts/mcp-smoke.js` negotiated MCP `2026-07-28`, discovered **35 tools**, and returned `workerOnline=true`, `liveEnabled=false`, `keepaEnabled=false`, and event-inbox-only configured delivery. Compiled worker registered `execute_operation`, `observe_watch` and `deliver_notification`. Markdown local links and `git diff --check` passed; repository remains non-bare.

64 tests by area: browser runtime/provider 14; transport 4; production registry 3; Postgres store 12; Graphile queue 2; owner UI 1; core money/crypto 4; action proposals 7; Keepa 10; notification adapter 7.

## Acceptance corrections, 2026-09-22

All four architect findings are corrected. Latest full verification passes **69 tests in 12 files**, typecheck and build, using the same `TEST_DATABASE_URL=... npx pnpm@10.32.1 run verify` command above.

- Cart writes check observed line identity, quantity, purchase mode and active/saved container before any select/click. Missing quantity/mode is unknown, never defaulted. Incomplete evidence returns unsupported with zero dispatched effects; postcondition uncertainty remains quarantined only after an actual attempted action.
- Product history lookup uses stable owner/account/marketplace/product identity across worker restarts. Each encrypted point preserves source timestamps, session generation and delivery provenance. Unverified delivery contexts have separate persisted IDs and are never combined into a quote. Existing product records with a valid ASIN migrate with unknown/unverified legacy provenance.
- `browser:login` now loads `.env` identically to gateway/worker and uses the same profile resolver. A hermetic subprocess regression verifies custom-profile paths with `--check-config`, without importing the browser runtime or touching the waiting login session.
- Seller feedback counts parse the explicit numeric/labelled ratings count (120), not the period (30) or positive percentage (98). Missing/invalid counts remain unknown.

Focused reproduction: `TEST_DATABASE_URL=postgres://amazon_mcp:local-development-only@127.0.0.1:55432/amazon_mcp npx pnpm@10.32.1 exec vitest run tests/browser-provider.test.ts tests/login-config.test.ts tests/store.test.ts tests/registry.test.ts`.

## Authenticated-read verification milestone, 2026-09-27

- Added `pnpm run amazon:smoke`: preflight plus sequential cart, first-page order-history and subscription reads through the SDK and durable operation registry. Each read has a 60-second deadline. Human challenges stop the batch; missing required page evidence fails verification.
- Account reads now check a visible signed-in Amazon navigation greeting and report that evidence in observation metadata. Synthetic tests reject missing, hidden, generic and signed-out greetings before extracting account data.
- Reports under ignored `.local/evidence/` have mode 0600 and include only timestamps, opaque operation handles, counts and known coverage labels. Raw account data, response text, URLs, credentials and error messages are excluded.
- Full verification on Node 26.0.0 with Postgres enabled: **84 tests in 13 files passed**, typecheck and production build passed. Command: `TEST_DATABASE_URL=postgres://amazon_mcp:local-development-only@127.0.0.1:55432/amazon_mcp PATH="/opt/homebrew/opt/node@26/bin:$PATH" npm exec --yes --package=pnpm@10.32.1 -- pnpm run verify`.
- Ran the compiled account-read checker against a temporary local gateway with live access disabled. It exited 2 with `live_disabled`, saved a mode-0600 report and dispatched zero account reads. The temporary gateway was stopped afterward.
- Dedicated login was opened for human completion. Authenticated live reads remain pending; no live cart edits, purchases, returns, cancellations or subscription changes were performed. Keepa and retained product history remain disabled.

### Login retry and headless operation

- Login starts at Amazon's account page and keeps the same browser open after an incomplete check. EOF or a handled interrupt closes the browser and releases the profile lock.
- The worker now uses configurable `AMAZON_HEADLESS` (default `true`); interactive login stays visible. Both modes use the full bundled Chromium channel and the same dedicated persistent profile.
- A synthetic persistent-cookie regression verifies session retention across headless restarts. A separate handoff regression verifies that a failed sign-in check can be retried in the same window. Full verification now passes **86 tests in 13 files**, typecheck and build.
- 1Password CLI is installed locally, but Amazon credential retrieval and autofill integration have not been implemented or verified. The documented recommendation is a visible 1Password-assisted login followed by headless reuse of the dedicated session.

### 1Password login implementation, 2026-09-28

- Added `browser:login:1password`: local `op` selection by Amazon website, optional exact item/vault configuration, username/password retrieval in memory, and one bounded password submission. Ambiguity, unknown destinations, MFA, passkeys, CAPTCHA, and unverified password-only screens stop for human completion. No credentials, raw authentication errors, screenshots or traces are logged.
- The login helper handles the currently observed JavaScript sign-in navigation, wrapped Continue input and Amazon email-claim form. It checks readiness automatically and persists the dedicated session for the headless worker after successful authentication.
- Disabled Playwright's process-exiting signal handlers so the caller can close Chromium and release its ownership lock. Verified Ctrl-C and immediate profile reuse live; added a real subprocess SIGINT regression.
- Full verification passed **109 tests in 15 files**, typecheck and build. Signed-out visible/headless login navigation was observed. The 1Password app is locked and the CLI request timed out; credential retrieval and authenticated Amazon/headless reads remain pending. No live cart edits or paid calls were performed.
- Follow-up: 1Password CLI access was authorized and Amazon item metadata was retrieved successfully. Two matching items triggered the ambiguity guard before any credentials were requested; explicit item selection is pending. Database preflight found no queued/running/uncertain operations or watches.

### Personal account and live headless verification, 2026-09-28 Pacific

- Selected the owner-requested Personal vault Amazon item in private local configuration. The dedicated browser had finished human sign-in; reopening it verified the session without submitting a password. A separate headless restart verified authentication at 2026-09-29 02:09:34 UTC.
- Actual MCP/Graphile reads observed 7 cart lines with incomplete identity evidence, 10 first-page order records, and an unrecognized subscription page. The report correctly remained incomplete. All three observations verified authentication; no mutations or paid calls occurred.
- Fixed the live `tsx`/Playwright callback failure by making worker/login commands build and run compiled JavaScript. Added three compiled-browser fixture checks to `verify`.
- Fixed verification polling for absent pending results and the actual `working` journal status. Added a missing-terminal-result regression and made the HTTP/SDK integration return a real queued response before completion.
- Remaining live compatibility work: full cart identity evidence, the optional subtotal selector delay, order field completeness, and subscription recognition. The temporary services were stopped after inspection; live access remains default-off in private `.env`.
- Final verification passed **110 tests in 15 files**, typecheck, build, and **3 compiled Chromium fixture checks**. The dedicated profile lock was released and the temporary gateway was no longer listening after cleanup.

### Completed live account reads and password submission, 2026-09-28 Pacific

- Cart extraction now reads saved-item quantity from its rendered row attribute, recognizes an explicitly empty active cart, and avoids waiting for an intentionally absent subtotal. Read identity and mutation evidence are reported separately; exact seller/condition/purchase-mode mutation guards are unchanged.
- Subscription extraction recognizes the live modern grid, validates identity from each rendered tile's edit destination, and reads visible quantity/frequency/next-delivery labels. It does not request the AJAX destination or read embedded client state. Unknown/empty layouts remain conservative.
- The real MCP/Graphile read batch completed at 04:38:22–04:38:28 UTC on September 29: seven saved cart items, ten first-page orders and four subscriptions, all authenticated and recognized. Source completeness and missing cart mutation evidence remain explicit. No live mutation, watch or paid call was dispatched.
- Live 1Password retrieval handles renamed built-in field labels by stable field ID. The password form at Amazon's `/ax/claim` now works while password submission remains restricted to HTTPS Amazon `/ap/signin`. A single automated password submission reached the authenticator-code step in a separate profile; human MFA completion is pending. The primary working session remains intact.
- Full verification: **122 tests in 15 files**, typecheck/build passed with real Postgres suites enabled; **six compiled Chromium fixtures** passed, including the modern cart/subscription layouts and email-claim password flow.

### Live order details and split-shipment tracking, 2026-09-28 Pacific

- Fixed current history date/total extraction and returned observed pagination metadata. Mismatched or unverified requested pages produce explicit missing coverage.
- Added the live order-detail layout, labeled exact order identity, displayed grand total, scoped document/action labels and split-shipment item mapping. An unrelated order number elsewhere in the page no longer establishes shipment identity.
- Shipment reads follow at most five displayed Amazon tracking links for the requested order. Each page revalidates authentication, order/package identity and a visible order-info link. Both observed tracking wrappers are supported; future milestones retain their incomplete state. Tracking URLs and private navigation parameters are not returned.
- Added `amazon:smoke --order-details`, which selects an observed order and verifies details and tracking without recording its order number. Empty history produces `no_order_available` instead of a fabricated identifier.
- Actual five-read MCP/Graphile batch completed at 04:59:47–05:00:00 UTC on September 29: cart, orders, subscriptions, one two-item order and both of its shipment tracking pages. A separate page-two read returned nine more records with dates/totals and observed page 2. No external account mutation, paid call or watch was dispatched.
- Full verification passed **141 tests in 16 files**, typecheck/build with real Postgres enabled, and **nine compiled Chromium fixtures**. The gateway and updated headless worker remain running; the private default live-access flag remains off outside those process overrides.

### Operational diagnostics and client recovery, 2026-09-30 Pacific

- Added `amazon_diagnostics` and `amazon://status`: read-only local account flags, worker heartbeat, owner-scoped queue counts, latest operation metadata and explicit recovery guidance. The result distinguishes local availability from Amazon authentication and does not decrypt payloads, contact Amazon, retry work or clear quarantine.
- Added `operations_list` with account/kind/mode/status filters, bounded page size and encrypted cursors bound to the owner and filters. Creation-time/ID keyset pagination preserves Postgres microsecond precision. Metadata history excludes private inputs, results and idempotency keys. Added supporting indexes using idempotent migrations.
- Added server workflow instructions and `amazon://guide`, covering durable polling, lost handles, coverage, authentication handoffs, cart identity and notification workflows. Both metadata tools carry read-only, closed-world annotations.
- Added `pnpm run local:doctor [--json]` with bounded local MCP requests, redacted failure output and meaningful exit codes. No Amazon or 1Password access is required.
- Verification: **147 tests in 17 files**, typecheck/build and **nine compiled Chromium fixtures** passed with real Postgres enabled. Tests cover owner isolation, cursor tampering and filter changes, precise pagination, read-only diagnostics and actual MCP discovery/resources/instructions.
- After restarting the gateway, a local SDK smoke at 2026-10-01 05:34 UTC discovered **37 tools and three resources**, read the workflow instructions/status resource, and recovered two distinct pages of operation metadata. `local:doctor` exited 0 with an online worker and zero queued, active or uncertain operations. No Amazon request or external mutation was made by these checks.

## Purchasing implementation, 2026-10-10 Pacific

- Added an optional transaction profile with Buy It Now preparation, cart checkout, single-use owner-approved order submission, and Subscribe & Save enrollment. The read-only profile remains 38 tools; the purchase profile exposes 48 with cart writes.
- Preparation captures exact browser-observed line identity, quantities, reconciled USD totals, address/payment fingerprints, delivery groups, promotions and recurring terms. Unsupported or incomplete layouts cannot create executable intents. Both rendered labels/links and recognized structured DOM layouts are covered.
- The worker persists owner/account/session-bound five-minute intents. The owner page displays charges, payment summaries, delivery details, recurring commitments and local expiry times. Approval remains outside MCP with separate authentication and CSRF checks.
- Submission rechecks terms before dispatch and within the serialized final action. Confirmations require new order identity and independently matching item/quantity/total evidence; enrollment also requires new matching subscription state. Uncertain results quarantine subsequent writes, and repeated submission keys map to the original consumed intent operation.
- Verification uses synthetic Amazon pages only, actual local HTTP/MCP and isolated Postgres, desktop/light and mobile/dark owner review, and the compiled Chromium runtime. No real order, subscription, paid call, or notification was performed. No remote publication is inferred from local installation.
