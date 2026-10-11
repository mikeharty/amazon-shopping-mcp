<div align="center">

# Amazon shopping MCP

**Your Amazon shopping assistant, running on your own computer.**

Research products, keep an eye on prices, and look up orders through an MCP client.
Your account session stays in a dedicated local browser.

[![Verify](https://github.com/mikeharty/amazon-mcp/actions/workflows/verify.yml/badge.svg?branch=main)](https://github.com/mikeharty/amazon-mcp/actions/workflows/verify.yml) [![Alpha](https://img.shields.io/badge/status-v0.3.0%20alpha-f59e0b?style=flat-square)](CHANGELOG.md) [![Node](https://img.shields.io/badge/Node-22.18%2B%20%7C%2024%20%7C%2026%2B-43853d?style=flat-square&logo=nodedotjs&logoColor=white)](#before-you-start) [![MIT license](https://img.shields.io/badge/license-MIT-2563eb?style=flat-square)](LICENSE) [![Local](https://img.shields.io/badge/runs-locally-0f766e?style=flat-square)](#quick-start) [![Read only](https://img.shields.io/badge/Amazon-read%20only%20by%20default-6366f1?style=flat-square)](#defaults-and-optional-features)

[Quick start](#quick-start) · [Platform notes](#platform-notes) · [Connect a client](#connect-your-mcp-client) · [Troubleshooting](#troubleshooting) · [Development](#development)

</div>

> [!NOTE]
> This is an early personal project for one Amazon.com account. It is unofficial
> and unaffiliated with Amazon. The source is public and MIT licensed; the service
> runs locally. Amazon page changes and sign-in challenges can interrupt browsing.

## What you can do

| Workflow | What it gives you |
| --- | --- |
| Research products | Compare two to five products, including observed prices, images, source excerpts, and a ranking based on your preferences. |
| Watch a price | Create a USD price alert and check its updates in the local notification inbox. |
| Check your account | Read the cart, order history, order details, shipment tracking, and subscription inventory. |
| Search and export orders | Search a bounded set of history pages and request CSV or JSON with coverage information. |
| Recover a request | Find a durable operation handle after a client disconnect and retrieve its result. |

The default read-only mode exposes **38 tools**. Explicitly enabling the existing
cart adapters exposes 42; enabling purchasing exposes 48. Local price alerts work
in read-only mode. [Purchase workflows](docs/PURCHASING.md) cover Buy It Now, cart
checkout and Subscribe & Save enrollment with exact-term owner approval.

Live reads have been observed for the cart, paginated order history, order details,
split-shipment tracking, and subscriptions. Other page paths and all cart writes
have been tested with synthetic fixtures. Search coverage is bounded, prices may
omit delivery context, and research does not verify product compatibility. The
[capability ledger](docs/capabilities.md) keeps those distinctions in one place.

## Before you start

You need:

- **Node.js 22.18+, 24.x, or 26+.** Use a current 24.x or 26.x release. Node 23 and
  25 are outside the project's supported range.
- **pnpm.** Use the version pinned by `packageManager` in [package.json](package.json).
  Setup supports both JavaScript pnpm entry points and standalone executables.
- **Docker with Compose**, running and reachable from your terminal, or an
  existing **Postgres 17** database.
- An internet connection for the initial dependency and Chromium downloads.
  Amazon sign-in also needs a visible desktop browser.

Start Docker Desktop before running setup. The installer checks the selected
Node version, Docker Compose, and the Docker daemon before downloading anything.
If you use nvm, `nvm use` selects the version in `.nvmrc`.

## Quick start

Clone the repository and open a terminal in it:

```sh
git clone https://github.com/mikeharty/amazon-mcp.git
cd amazon-mcp
npx --yes pnpm@10.32.1 run local:onboard
```

The guided command takes you through the whole first run:

1. Choose **read-only shopping** (recommended), **purchasing**, or **offline**.
   Purchasing adds Buy It Now, checkout and Subscribe & Save. Each purchase still
   requires approval of the exact terms in the separate owner page.
2. On macOS, choose whether to run in the background and start at Mac login.
   Other systems use a foreground service.
3. Watch numbered installation steps for dependencies, Chromium, private
   configuration, Postgres, build, migrations and client configuration.
4. For live shopping, finish sign-in and MFA in the dedicated Amazon window.
   Setup enables the chosen access mode without making you edit `.env`.
5. Setup starts the gateway and worker, checks their readiness, and verifies MCP
   tool discovery before reporting **“Onboarding complete.”**

An existing `.env` and its secrets are preserved. If the gateway is already
running, onboarding checks it and prints connection instructions without changing
its access mode or opening a competing browser. It also refuses to take over a
background service belonging to another checkout.

With foreground startup, leave the terminal open; **Ctrl-C stops both services**.
With macOS background startup, you can close the terminal. Postgres stays in its
Docker volume. Docker and the computer must still be running for watches to work.

To open **Codex CLI** with the correct local endpoint and private token:

```sh
pnpm run local:codex
```

If pnpm is not installed, use `npx --yes pnpm@10.32.1 run local:codex`. Other
clients use the private configuration generated by setup, as described below.

For **installation only**, use `pnpm run local:setup`, followed by
`pnpm run local:start` when ready. Installation alone does not verify Amazon
sign-in or start the gateway and worker.

> [!TIP]
> You can rerun `local:onboard` after resolving a failed step. It preserves
> an existing `.env` and its secrets. Use `local:setup` or `local:init` exactly:
> `pnpm setup` is pnpm's own shell setup command.

### Platform notes

The project has local macOS verification and a Linux CI matrix for Node 22, 24,
and 26. Windows and WSL instructions below describe the setup requirements;
this project has not yet completed an end-to-end Windows or WSL verification.

| System | What to check |
| --- | --- |
| **macOS** | Start Docker Desktop before setup. Check `node --version` in the same terminal: Homebrew and a Node version manager can select different versions. Chromium is downloaded for your machine's architecture. Optional desktop notifications are macOS only. |
| **Linux** | Use a [Playwright-supported distribution](https://playwright.dev/docs/intro#system-requirements) and Docker Engine with the Compose plugin, or Docker Desktop. Setup adds `--with-deps` when installing Chromium; system packages may require sudo. A graphical session is needed for the visible login window even though normal worker browsing is headless. |
| **Windows / PowerShell** | Use a [Playwright-supported Windows version](https://playwright.dev/docs/intro#system-requirements) and [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/) in Linux-container mode. Run the same `pnpm run` commands from PowerShell. Use the PowerShell environment-variable example under Development for database tests. |
| **Windows / WSL 2** | Enable [Docker Desktop's integration](https://docs.docker.com/desktop/features/wsl/) for your distribution. Install Node and pnpm inside WSL, and run setup, startup, and tests in that same environment. Visible login requires Linux GUI support. Keep the checkout and browser profile in that environment; do not share an active profile between Windows and WSL. |

On macOS and Linux, generated secret files use mode `0600`. On Windows, protect
`.env`, `.local/`, and the browser profile with your user account's filesystem
permissions; POSIX mode bits do not provide the same access control there.

### Use your own database

Create the private environment file first, then edit its `DATABASE_URL` to point
to your existing Postgres database:

```sh
pnpm install --frozen-lockfile
pnpm run local:init
# Edit DATABASE_URL in .env, then:
pnpm run local:onboard --no-docker
```

`--no-docker` skips container startup. It still builds the app and applies its
schema migrations to the database you configure. The normal local database binds
to `127.0.0.1:55432`; its development password is intended for local use.

## Connect your MCP client

**Codex CLI:** run `pnpm run local:codex` from this checkout. It reads the private
token, supplies it through the child process environment, and opens a fresh Codex
session with the Amazon MCP configured for that invocation. It does not print
the token or edit your global Codex settings. This command configures the CLI;
Codex desktop and other apps still use their own connection settings.
The CLI connection is named `amazon_local`; an older `amazon` entry is disabled
for that invocation to avoid duplicate tools and stale manual headers.

**Other clients:** setup prints the path to a new `.local/mcp-client-*.json` file. Use the URL and
bearer header from that private file in a client that supports **Streamable HTTP**.
Client configuration formats vary; setup does not edit another app's settings.
After enabling new tools, refresh the MCP connection or start a new client
session so it discovers the current catalogue.

| Endpoint | Default address | Authentication |
| --- | --- | --- |
| MCP | `http://127.0.0.1:3433/mcp` | `Authorization: Bearer <MCP_TOKEN>` |
| Owner controls | `http://127.0.0.1:3433/owner` | Separate `OWNER_TOKEN` |
| Health | `http://127.0.0.1:3433/health` | No token required |

The gateway listens on loopback only. This release uses local bearer tokens and
has no hosted endpoint or OAuth authorization server. Keep tokens and generated
configuration out of chat, screenshots, and commits.

With the services running, check discovery from a second terminal:

```sh
pnpm run mcp:smoke
```

This lists tools and capability state without contacting Amazon. SDK tests cover
native 2026 and legacy 2025 protocol paths; compatibility and image rendering in
every desktop client UI are not established. See the
[client setup guide](docs/SHOPPING_WORKFLOWS.md#setup-and-session-recovery) for more.

## Sign in to Amazon

The guided `local:onboard` command opens the login window automatically for live
shopping. The following commands are for later recovery or manual setup.

Stop `local:start` with Ctrl-C, then run:

```sh
pnpm run local:start --login
```

A dedicated Chromium window opens at Amazon's account page. Complete sign-in and
MFA there. The command checks your session, closes the window when verification
succeeds, and starts the gateway and worker. Press Enter to check immediately;
Ctrl-C closes the login window and releases its profile lock.

Your normal Chrome session is separate. This browser uses
`.local/amazon-profile`, or `AMAZON_PROFILE_DIR` from `.env`, and keeps its own
session between restarts. One process owns that profile at a time.

After completing sign-in and reviewing the documented
[source-access basis](docs/research/browser-and-data.md), set
`AMAZON_LIVE_ENABLED=true` in `.env` and restart the services. Read-only mode stays
on unless you explicitly change it. Amazon challenges require human interaction;
there is no CAPTCHA bypass or private API fallback.

For session recovery, stop the worker and repeat `local:start --login`. You can
also run `pnpm run browser:login` on its own while the worker is stopped.
`pnpm run browser:login -- --check-config` checks the resolved profile path without
opening a browser.

For a macOS background installation, stop it before opening the login browser:

```sh
pnpm run local:service stop
pnpm run browser:login
pnpm run local:service start
pnpm run local:doctor
```

Use `local:service status` to inspect installation, `local:service restart` after
changing `.env` or rebuilding, and `local:doctor` to check actual gateway and
worker readiness. Run service commands from the checkout that installed it.
The service uses the Node executable selected at installation; reinstall it while
stopped if that executable is removed during a Node upgrade.

To change access mode through the guided choices, stop the running service and
rerun `local:onboard`. Existing credentials and the dedicated profile are reused.

For unattended installation checks, explicit choices are required, for example
`pnpm run local:onboard --mode offline --foreground --no-docker`. Live modes
normally open the interactive Amazon login window. `--skip-login` reuses an
existing session and reports that sign-in was not checked.

<details>
<summary><strong>Optional: use 1Password for the password step</strong></summary>

Install the official `op` CLI and enable
[desktop app integration](https://www.1password.dev/cli/app-integration), then run:

```sh
pnpm run local:start --1password
```

Unlock 1Password and approve its CLI prompt. The helper selects a unique Login
item with an `amazon.com` or `www.amazon.com` website. If several match, set
`AMAZON_1PASSWORD_ITEM` in `.env`; `AMAZON_1PASSWORD_VAULT` can narrow the search.

The helper reads the username and password into process memory, checks the
sign-in form, and submits the password once. It does not print credentials,
write them to `.env`, or change vault items. MFA, CAPTCHA, passkeys, unfamiliar
forms, and ambiguous account selection still need manual completion. Browser
debug logging is disabled during login. The password step has reached Amazon's
authenticator screen in a live check; it does not automate MFA.

</details>

<details>
<summary><strong>Check authenticated reads after login</strong></summary>

With live access enabled and both services running:

```sh
pnpm run amazon:smoke
# Also inspect one observed recent order and its shipments:
pnpm run amazon:smoke --order-details
```

The basic check reads the cart, first order-history page, and subscription
inventory. The extended check follows one observed order into details and
shipment tracking. A sign-in challenge stops the batch; these checks do not
change the cart or submit purchases.

A private report goes to `.local/evidence/`. It records operation handles, counts,
and coverage labels, while excluding product titles, order numbers, tracking
URLs, addresses, credentials, and raw provider errors. Exit `0` means the required
read evidence passed; `2` means blocked or incomplete; `1` means the connection
or report could not be completed. Each read has a 60-second wait limit. If it
times out, inspect its saved operation handle before running it again: the job
may still finish.

</details>

## Defaults and optional features

| Setting | Default | What changes when enabled |
| --- | --- | --- |
| `AMAZON_LIVE_ENABLED` | `false` | Lets the worker browse Amazon after dedicated login and source-access review. |
| `AMAZON_READ_ONLY` | `true` | Setting this to `false` in both services enables cart adapters and permits explicitly enabled purchase tools. Live mutation behavior remains unverified. |
| `AMAZON_PURCHASING_ENABLED` | `false` | With write access enabled, exposes Buy It Now, checkout submission and Subscribe & Save enrollment. Every submission requires an exact-term approval in the owner page. |
| `AMAZON_HEADLESS` | `true` | Setting this to `false` shows the worker browser. The login window is always visible. |
| `RETAIN_OBSERVATIONS` | `false` | Keeps observations collected by this installation for product history. It cannot recover earlier prices. |
| `KEEPA_ENABLED` | `false` | Enables the optional paid provider when an existing `KEEPA_API_KEY` is also configured. |
| `DESKTOP_NOTIFICATIONS` | `false` | Enables generic macOS notices pointing to the private inbox. Actual OS permission and display remain unverified. |

Watch intervals are at least five minutes. The durable inbox is available through
`events_list` and `amazon://events`; there is no email, Web Push, or automatic
computer wakeup. Keepa call/token limits apply per gateway process and reset on
restart. Unknown provider charges cannot be guaranteed in advance. The Creators
API integration is not implemented.

Checkout snapshots are available in read-only mode. The optional purchasing
profile adds reviewed one-time orders and Subscribe & Save enrollment. Purchase
and enrollment adapters are fixture-verified; no live purchase was made during
verification. Returns, cancellations, existing-subscription changes, and review
publishing are not exposed. `content_draft` saves supplied text for your review and never publishes
it. Cart adapters require exact line identity and check their result; an
ambiguous write quarantines later writes until an operator reconciles it.

## Troubleshooting

Start with the local doctor while the gateway is running:

```sh
pnpm run local:doctor
pnpm run local:doctor --json
```

It reads worker health, queue counts, and recovery guidance without contacting
Amazon or retrying jobs. Exit `0` means local services are available, `2` means
attention is needed, and `1` means diagnostics could not be read. Local health
alone does not confirm Amazon sign-in.

| Symptom | What to do |
| --- | --- |
| Setup fails with a `SyntaxError` at the pnpm executable | Update to this setup script. It launches native pnpm directly and JavaScript entry points through Node. Check `node --version` too. |
| Docker cannot connect | Start Docker Desktop or your Docker daemon. Confirm `docker info` works from the same terminal; in WSL, check distribution integration. |
| Chromium is missing or Linux libraries are unavailable | Rerun `local:setup`. On Linux, its `--with-deps` step needs permission to install system packages. Check Playwright's supported OS list. |
| Startup reports a database or port problem | Check `DATABASE_URL`, Postgres health, and whether another service owns port `3433` or database port `55432`. `PORT` in `.env` controls the gateway. |
| Amazon asks for sign-in or a challenge | Stop the worker, run `local:start --login`, complete the visible handoff, then restart with live access enabled. |
| A profile ownership lock remains after a crash | Stop every process using that dedicated profile and verify its browser children have exited before manually removing the stale `.local/amazon-profile.amazon-mcp-owner` directory. Never remove a live owner's lock. |
| A client disconnects during a request | Use `operations_list` to recover the handle, then `operations_get` to retrieve its status or result before deciding whether to try again. |

Long-running browser tools return durable operation handles. Poll
`operations_get`; it is normal for work to outlive the initial client request.
`operations_list` supports filters and encrypted owner-bound pagination. It
returns operation metadata, not your Amazon history, and never retries work or
clears a quarantine. Clients can also read `amazon://guide`, `amazon://status`,
and `amazon://events` for instructions, health, and inbox updates.

`account_disconnect` cancels queued work and pauses watches after active work
settles. Owner controls can enable access again; restart the worker afterward.
They can also delete stored private records when no unresolved operation needs
the audit trail. The dedicated browser profile is retained and can be removed
separately while its browser is stopped.

## Development

Run the full checks with a Postgres role that can create databases. The tests
create and drop isolated temporary databases; browser checks use synthetic pages
and temporary profiles. They do not perform Amazon purchases or account changes.

**macOS, Linux, or WSL:**

```sh
export TEST_DATABASE_URL=postgres://amazon_mcp:local-development-only@127.0.0.1:55432/amazon_mcp
pnpm run verify
pnpm run test:startup
pnpm run test:onboarding
pnpm audit --prod
```

**PowerShell:**

```powershell
$env:TEST_DATABASE_URL = 'postgres://amazon_mcp:local-development-only@127.0.0.1:55432/amazon_mcp'
pnpm run verify
pnpm run test:startup
pnpm run test:onboarding
pnpm audit --prod
```

Without `TEST_DATABASE_URL`, database suites skip; that is incomplete verification.
`verify` runs typecheck, tests, build, and the compiled Chromium fixtures. Use the
package scripts for the worker and login: running their TypeScript directly with
`tsx` can break callbacks evaluated inside Chromium.

Manual commands remain available: `local:init`, `migrate`, `dev`, `worker`,
`browser:login`, and `client:config`. See [Contributing](CONTRIBUTING.md) for the
review workflow and [Security](SECURITY.md) for credential and data handling.

| Directory | Purpose |
| --- | --- |
| `apps/gateway` | Local HTTP/MCP server and separate owner controls. |
| `apps/worker` | Durable queue and browser worker. |
| `packages/store` | Encrypted state, operation journal, watches, and migrations. |
| `packages/browser-runtime` | Dedicated browser profile ownership and human handoff. |
| `packages/providers` | Amazon page extraction, cart adapters, and optional Keepa. |
| `packages/core` | Execution rules, offer comparison, and shopping workflows. |
| `tests` | MCP client, Postgres/queue, browser fixture, and domain checks. |

## More detail

- [Shopping workflows](docs/SHOPPING_WORKFLOWS.md): tool examples, price alerts,
  research, order exports, and client setup.
- [Capability ledger](docs/capabilities.md): what works and the evidence behind it.
- [Release review](docs/RELEASE_REVIEW.md) and [Changelog](CHANGELOG.md): dated
  verification and release history.
- [Implementation status](docs/IMPLEMENTATION.md) and [Roadmap](ROADMAP.md):
  current work and future plans.
- [Architecture](docs/architecture.md), [Requirements](docs/requirements.md),
  [Tool catalog](docs/tool-catalog.md), and [Workstreams](docs/workstreams.md):
  design context. Hosted and hybrid deployments are plans, not shipped services.

---

Made for local personal use. Licensed under the [MIT License](LICENSE).
