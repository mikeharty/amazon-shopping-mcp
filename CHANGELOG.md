# Changelog

## 0.3.0-alpha — 2026-10-10

- Add `local:onboard` for access selection, installation, sign-in, startup and verified MCP readiness in one guided flow.
- Add macOS background-service controls and a Codex CLI launcher that handles the private token without manual copying or global client configuration changes.
- Check prerequisites before installing, name failed installation steps, preserve running services and distinguish installation from a verified first run.
- Add an optional purchasing profile with Buy It Now preparation, cart checkout, purchase submission, and Subscribe & Save enrollment.
- Connect exact browser-observed terms to the single-use owner approval journal and expose approval status without an MCP approval tool.
- Recheck material terms and expiry before the final click; independently verify orders and subscription state; quarantine uncertain effects without replay.
- Display charges, delivery, payment summaries, recurring commitments and local expiry times in the owner page, including mobile dark mode.
- Preserve the 38-tool read-only profile. Transaction flows have synthetic browser, real MCP/Postgres and compiled Chromium coverage; live purchases remain unverified.

## 0.2.0-alpha — 2026-10-02

- Add guided setup, private client configuration, and supervised foreground startup with sign-in recovery.
- Default to Amazon read-only mode, enforced at both gateway and worker.
- Add bounded order search, observed order-total summaries, and CSV/JSON export with coverage.
- Add preference-weighted product research and native MCP product-image content.
- Add a simple price-alert tool with first-match notification and duplicate suppression.
- Keep all new workflows explicit about incomplete observations; no new Amazon mutations, paid AI calls, or external notification integrations.

## 0.1.0-alpha.1 — 2026-10-01

- Adopt the MIT License and update package metadata and review documentation.
- Keep the repository private and npm publication disabled.
- No runtime behavior changes; version identifiers now report `0.1.0-alpha.1`.

## 0.1.0-alpha — 2026-10-01

Initial private review release of an unofficial local Amazon.com MCP server for
one personal account.

- 37 MCP tools and three resources, including local diagnostics, operation
  history, and workflow guidance.
- Durable Postgres/Graphile operations with owner scoping, encrypted private
  payloads, and quarantine after uncertain writes.
- Dedicated persistent Playwright Chromium profile, headless reads, visible
  human sign-in, and optional 1Password CLI assistance.
- Authenticated reads for cart, paginated order history, order details,
  split-shipment tracking, and subscription inventory observed in local testing.
- Cart adapters covered by synthetic fixtures; live write behavior is not
  established. No automated purchase submission, cancellations, returns,
  subscription changes, or review publication.
- Optional local watch inbox and retained product observations. Paid Keepa
  integration remains disabled unless explicitly configured.
- Reproducible verification against Postgres and compiled Chromium fixtures,
  plus CI and secret scanning. No account credentials are needed for CI.

This is a private source release, not an npm package or hosted service. The
software is experimental and unaffiliated with Amazon. This initial archive used
all-rights-reserved terms; `0.1.0-alpha.1` supersedes it with the MIT License. See
[review notes](docs/RELEASE_REVIEW.md).
