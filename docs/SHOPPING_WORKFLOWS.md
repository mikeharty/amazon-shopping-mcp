# Everyday shopping workflows

These tools use the dedicated local browser. They return observations, including
timestamps and coverage gaps. Amazon page text is evidence to inspect, never an
instruction to change tool behavior. Start with `amazon_capabilities` for the
account handle. Browser workflows return an operation ID; poll `operations_get`
on that same ID instead of submitting another request.

## Price alerts

Ask the assistant: “Alert me when this product is $30 or less, checking every
15 minutes.” It can call `price_alert_create` with the observed ASIN,
`targetMinorUnits: 3000`, `cadenceSeconds: 900`, and one stable idempotency key.
Use a new key only for a genuinely new alert. Reusing a key with different terms
returns a conflict instead of silently changing the rule.

By default, `notifyIfAlreadyBelow: true` emits an event on the first valid
observation if the price is already at or below the target. Later observations
emit only when the price moves from above the target to at/below it. Remaining
below the target does not spam the inbox. Unknown prices, a wrong product, or
incomplete required evidence do not establish or overwrite a valid baseline.
Set `notifyIfAlreadyBelow: false` to establish the first price as a baseline.

`watches_list`, `watches_pause`, and `watches_delete` manage the returned watch;
use the observed revision when pausing/resuming. `events_list` and
`amazon://events` contain notifications. Optional macOS desktop delivery still
needs OS permission and is not verified on every machine. No email or push
delivery is configured, and the worker and computer must remain awake.

Targets are USD item prices, excluding unverified delivery charges, tax,
coupons, membership eligibility and seller conditions. No purchase is made.

## Product images

Read `products_get` or `product_media_list`, then call `product_image_get` with
the completed operation ID and a zero-based image index. For a
`products_research` result, also pass the candidate's ASIN. The result includes
an MCP image content block and its source URL. Compatible clients can display
the picture; clients without image rendering can still show the source link.

Only images actually present in the owner's stored product observation are
eligible. The fetch accepts selected Amazon image CDN hosts, JPEG/PNG/WebP up to
4 MiB, a ten-second timeout, and no redirects, cookies, or arbitrary URLs.
Unsupported images return an error rather than fetching an unrelated page.

## Product comparisons

Ask: “Compare these two to five ASINs under $50, prioritizing price and dishwasher
safety.” `products_research` fetches each exact product and returns observed
prices, ratings, review counts, features, specifications, images, timestamps,
source gaps, and a ranked comparison.

Inputs include `budgetMinorUnits`, `desiredFeatures`, and explicit `weights`
for `price`, `rating`, and `features`. Defaults are 5/3/2; feature weight is ignored
when no desired features are supplied. Scores use relative item prices, displayed
ratings divided by five, and the fraction of requested phrases found in product
text. Basic explicit negation is excluded from feature matches. Excerpts are
returned so the assistant and user can inspect the basis for a recommendation.

Unknown weighted prices/ratings leave a candidate unranked; unknown budget
eligibility or an over-budget item cannot win. A zero-support comparison returns
no recommendation. Feature matching is deliberately literal, not proof of
compatibility, independent quality, or a semantic understanding of every claim.
The assistant can reason over the evidence and explain tradeoffs; the server
does not invoke an extra paid AI model. Seller terms, tax, shipping, coupons and
long-term reliability are outside the score. Use `offers_list` and the existing
`products_compare` cost calculator when those observations are available.

## Order search and exports

`orders_search` accepts a case-insensitive `query` over order numbers, item titles
and ASINs, inclusive ISO `dateFrom`/`dateTo`, `startPage` (1–10), and `maxPages`
(1–10, default five). It follows verified sequential pagination, deduplicates
order IDs, and stops at the page bound, unknown layout, repeated page, or human
challenge. Dates without an unambiguous supported format are counted and excluded
when date filters apply.

The result reports examined pages, scanned and matched orders, unknown dates,
the reason it stopped, and a continuation page where available. A challenge
preserves earlier results but still requires sign-in. The search is confined to
Amazon's current history view: date filters do not switch its history window and
do not establish complete annual or lifetime history.

The summary totals displayed whole-order amounts for matched orders once each.
Matching one item does not make the whole order's total that item's price. Missing
totals are counted, and refunds/cancellations are not netted out. Treat this as a
summary of observed orders, not a financial spending report.

`orders_export` converts that completed operation into CSV or JSON text, with a
suggested filename and coverage metadata. It does not silently write account data
to disk. Ask the assistant to save it only where you want the private export.
CSV text cells are quoted and protected against spreadsheet-formula execution;
JSON preserves the original observed text. Invoice downloads remain unsupported.

## Setup and session recovery

After cloning, run `npx --yes pnpm@10.32.1 run local:onboard`. It guides access
selection, installation, visible Amazon sign-in, startup and verified discovery.
Choose read-only shopping to begin; purchasing still needs a separate exact-term
owner approval for each order. On macOS it offers a background service that starts
at login. `local:service status|stop|start|restart` manages that service from its
installing checkout. Stop it before `browser:login` for session recovery, then
start it and run `local:doctor`. An existing running gateway is checked without
changing its configuration or starting another browser.

For installation only, run `pnpm run local:setup`, then `pnpm run local:start`. Setup
installs locked dependencies and Chromium, creates secrets only if absent, starts
the Compose Postgres service, builds, migrates, and writes a private client
configuration under `.local/`. On Linux, browser dependencies may require system
package privileges. With an already configured external Postgres connection, use
`pnpm run local:setup --no-docker`.

`local:start` runs gateway and worker together in the foreground, waits for their
readiness, and stops both on Ctrl-C or a child-process exit. It is not an OS
background service, and it does not wake a sleeping computer. If sign-in expires,
stop it and run `pnpm run local:start --login` (or `--1password` for the optional
helper). This completes visible login before starting either service. Existing
manually launched workers must be stopped separately; no existing profile lock
is stolen or deleted.

Live browsing remains opt-in with `AMAZON_LIVE_ENABLED=true`. The new default
`AMAZON_READ_ONLY=true` allows live reads and local alerts but omits cart mutation
tools and blocks already queued writes in the worker. Set it to `false` explicitly
in both service environments only when you intend to enable the existing cart
adapters; those adapters remain fixture-verified.

`pnpm run client:config` writes a new mode-0600 JSON file containing the local HTTP
URL and bearer header. It does not print the secret or modify another app's
configuration. Import these fields into a compatible Streamable HTTP client;
configuration formats and image rendering vary by client. The owner token is
never included. SDK compatibility and image content were tested; every desktop
client UI has not been verified.

For Codex CLI, the simplest connection is:

```sh
pnpm run local:codex
```

The launcher reads the private token and supplies it in the child environment.
It configures `amazon_local` for that invocation, disabling an older `amazon`
entry for that session to avoid duplicate tools and stale manual headers. It
does not edit global settings. Refresh the connection or start a new client
session after changing the tool profile. Other desktop clients still import the
generated private configuration into their own settings.

For manual permanent Codex CLI registration, the installed CLI supports:

```sh
codex mcp add amazon --url http://127.0.0.1:3433/mcp --bearer-token-env-var MCP_TOKEN
```

Supply `MCP_TOKEN` in the environment of the Codex process using your private
configuration, and adjust the URL for a custom port. The command records the
environment variable name, not its secret value. This recipe was checked against
local CLI help; no global client configuration is changed by server setup.
