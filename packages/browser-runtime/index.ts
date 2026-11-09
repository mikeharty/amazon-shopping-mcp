import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { LoginCredentials } from "../core/onepassword.js";
import { assistAmazonPasswordLogin, type PasswordLoginResult } from "./password-login.js";

export type ChallengeKind =
  "signin" | "mfa" | "captcha" | "robot_check" | "payment" | "unknown";
export type PageState =
  | { kind: "ready"; url: string }
  | {
      kind: "challenge";
      challenge: ChallengeKind;
      url: string;
      message: string;
    };

export class BrowserRuntimeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface BrowserRuntimeOptions {
  profileDir: string;
  headless?: boolean;
  allowedHosts?: string[];
  userAgent?: string;
  initialSessionGeneration?: number;
  onSessionGeneration?: (generation: number) => void | Promise<void>;
}

type LockRecord = {
  version: 1;
  pid: number;
  host: string;
  runtimeId: string;
  acquiredAt: string;
  profileHash: string;
};

const DEFAULT_HOSTS = [
  "amazon.com",
  "www.amazon.com",
  "smile.amazon.com",
  "images-na.ssl-images-amazon.com",
  "m.media-amazon.com",
  "images.amazon.com",
  "completion.amazon.com",
];

export class PersistentBrowserRuntime {
  private context?: BrowserContext;
  private page?: Page;
  private lockDir?: string;
  private runtimeId = randomUUID();
  private tail: Promise<unknown> = Promise.resolve();
  private paused = false;
  private generation: number;

  constructor(private readonly options: BrowserRuntimeOptions) {
    const initial = options.initialSessionGeneration ?? 0;
    if (!Number.isInteger(initial) || initial < 0)
      throw new BrowserRuntimeError(
        "invalid_generation",
        "Initial session generation must be a non-negative integer",
      );
    this.generation = initial;
  }

  get sessionGeneration(): number {
    return this.generation;
  }
  get isPaused(): boolean {
    return this.paused;
  }
  status(): {
    runtimeId: string;
    sessionGeneration: number;
    paused: boolean;
    running: boolean;
  } {
    return {
      runtimeId: this.runtimeId,
      sessionGeneration: this.generation,
      paused: this.paused,
      running: Boolean(this.context),
    };
  }

  async start(): Promise<void> {
    if (this.context) return;
    await ensureDedicatedProfile(this.options.profileDir);
    this.lockDir = `${resolve(this.options.profileDir)}.amazon-mcp-owner`;
    await this.acquireLock(this.lockDir);
    try {
      this.context = await chromium.launchPersistentContext(
        resolve(this.options.profileDir),
        {
          // Use the same full Chromium build for visible login and background
          // operation, including Chromium's modern headless mode.
          channel: "chromium",
          headless: this.options.headless ?? true,
          // Callers own graceful shutdown and lock release. Playwright's
          // default SIGINT handler exits the process before their finally runs.
          handleSIGINT: false,
          handleSIGTERM: false,
          handleSIGHUP: false,
          viewport: { width: 1440, height: 1000 },
          userAgent: this.options.userAgent ?? "Agent/AmazonShoppingMCP",
          acceptDownloads: false,
          serviceWorkers: "block",
        },
      );
      await this.installNetworkPolicy(this.context);
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
    } catch (error) {
      const context = this.context;
      this.page = undefined;
      this.context = undefined;
      if (context) {
        try {
          await context.close();
        } catch {
          throw new BrowserRuntimeError(
            "recovery_required",
            "Browser startup failed and its process could not be confirmed stopped; the profile lock was retained for explicit recovery",
          );
        }
      }
      await this.releaseLock();
      throw error;
    }
  }

  async run<T>(operation: (page: Page) => Promise<T>): Promise<T> {
    const queued = this.tail.then(async () => {
      if (!this.context || !this.page)
        throw new BrowserRuntimeError(
          "runtime_not_started",
          "Browser runtime is not started",
        );
      if (this.paused)
        throw new BrowserRuntimeError(
          "handoff_in_progress",
          "Automation is paused for user handoff",
        );
      try {
        const result = await operation(this.page);
        const state = await classifyPage(this.page);
        if (state.kind === "challenge") this.paused = true;
        return result;
      } catch (error) {
        const state = await classifyPage(this.page).catch(() => undefined);
        if (state?.kind === "challenge") this.paused = true;
        throw error;
      }
    });
    this.tail = queued.catch(() => undefined);
    return queued;
  }

  async beginHandoff(
    url?: string,
  ): Promise<{ generation: number; url: string }> {
    return this.enqueueControl(async () => {
      if (!this.page)
        throw new BrowserRuntimeError(
          "runtime_not_started",
          "Browser runtime is not started",
        );
      this.paused = true;
      if (url) await this.safeNavigate(this.page, url);
      await this.page.bringToFront();
      return { generation: this.generation, url: this.page.url() };
    });
  }

  async completeHandoff(expectedGeneration: number): Promise<PageState> {
    return this.enqueueControl(async () => {
      if (!this.page || !this.paused)
        throw new BrowserRuntimeError(
          "no_handoff",
          "No user handoff is active",
        );
      if (expectedGeneration !== this.generation)
        throw new BrowserRuntimeError(
          "stale_generation",
          "Browser session generation changed",
        );
      const state = await classifyPage(this.page);
      if (state.kind === "challenge") return state;
      if (!(await isVerifiedAuthenticatedAmazonPage(this.page))) {
        return {
          kind: "challenge",
          challenge: "unknown",
          url: this.page.url(),
          message:
            "The Amazon account session could not be verified; keep the handoff open",
        };
      }
      this.generation += 1;
      await this.options.onSessionGeneration?.(this.generation);
      this.paused = false;
      return state;
    });
  }

  // Local login entrypoint only; not exposed by the worker or any MCP tool.
  // Keeps normal automation fenced while the explicit login helper runs.
  async assistPasswordLogin(
    expectedGeneration: number,
    readCredentials: () => Promise<LoginCredentials>,
  ): Promise<PasswordLoginResult> {
    return this.enqueueControl(async () => {
      if (!this.page || !this.paused)
        throw new BrowserRuntimeError("no_handoff", "No user handoff is active");
      if (expectedGeneration !== this.generation)
        throw new BrowserRuntimeError("stale_generation", "Browser session generation changed");
      if (await isVerifiedAuthenticatedAmazonPage(this.page)) return "manual";
      return assistAmazonPasswordLogin(this.page, readCredentials);
    });
  }

  async navigate(url: string): Promise<PageState> {
    return this.run(async (page) => {
      await this.safeNavigate(page, url);
      return classifyPage(page);
    });
  }

  async close(): Promise<void> {
    await this.enqueueControl(async () => {
      const context = this.context;
      this.page = undefined;
      this.context = undefined;
      this.paused = true;
      if (context) await context.close();
      await this.releaseLock();
    });
  }

  private async enqueueControl<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.tail.then(operation);
    this.tail = queued.catch(() => undefined);
    return queued;
  }

  private allowed(url: URL): boolean {
    if (url.href === "about:blank") return true;
    if (url.protocol !== "https:") return false;
    const hosts = this.options.allowedHosts ?? DEFAULT_HOSTS;
    return hosts.some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    );
  }

  private async safeNavigate(page: Page, rawUrl: string): Promise<void> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new BrowserRuntimeError("invalid_url", "Navigation URL is invalid");
    }
    if (!this.allowed(url))
      throw new BrowserRuntimeError(
        "host_not_allowed",
        `Navigation host is not allowed: ${url.hostname}`,
      );
    await page.goto(url.toString(), {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
  }

  private async installNetworkPolicy(context: BrowserContext): Promise<void> {
    await context.route("**/*", async (route) => {
      let url: URL;
      try {
        url = new URL(route.request().url());
      } catch {
        await route.abort("blockedbyclient");
        return;
      }
      if (this.allowed(url)) await route.continue();
      else await route.abort("blockedbyclient");
    });
  }

  private async acquireLock(lockDir: string): Promise<void> {
    await mkdir(dirname(lockDir), { recursive: true });
    try {
      await mkdir(lockDir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const record = await readLock(lockDir);
      const owner = record
        ? `pid ${record.pid} on ${record.host}`
        : "an unreadable owner record";
      throw new BrowserRuntimeError(
        "recovery_required",
        `Dedicated browser profile has an existing owner lock (${owner}); close or quiesce its browser process and recover the lock explicitly`,
      );
    }
    const record: LockRecord = {
      version: 1,
      pid: process.pid,
      host: hostname(),
      runtimeId: this.runtimeId,
      acquiredAt: new Date().toISOString(),
      profileHash: createHash("sha256")
        .update(resolve(this.options.profileDir))
        .digest("hex"),
    };
    const handle = await open(`${lockDir}/owner.json`, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`);
    } finally {
      await handle.close();
    }
  }

  private async releaseLock(): Promise<void> {
    if (!this.lockDir) return;
    const lockDir = this.lockDir;
    this.lockDir = undefined;
    const record = await readLock(lockDir);
    if (record?.runtimeId === this.runtimeId)
      await rm(lockDir, { recursive: true, force: true });
  }
}

async function readLock(lockDir: string): Promise<LockRecord | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(`${lockDir}/owner.json`, "utf8"),
    ) as Partial<LockRecord>;
    if (
      parsed.version === 1 &&
      typeof parsed.pid === "number" &&
      typeof parsed.host === "string" &&
      typeof parsed.runtimeId === "string"
    )
      return parsed as LockRecord;
  } catch {
    /* unreadable locks are never stolen */
  }
  return undefined;
}

export async function classifyPage(page: Page): Promise<PageState> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const startingURL = page.url();
    try {
      const state = await classifyCurrentPage(page);
      if (page.url() === startingURL) return state;
    } catch (error) {
      if (!(error instanceof Error) || !/execution context was destroyed|cannot find context|frame was detached/i.test(error.message)) throw error;
      await page.waitForLoadState('domcontentloaded', {timeout: 2_000}).catch(() => undefined);
    }
  }
  return {kind:'challenge',challenge:'unknown',url:page.url(),message:'The page changed during verification; automation is paused until its state can be verified'};
}

async function classifyCurrentPage(page: Page): Promise<PageState> {
  const url = page.url();
  const title = (await page.title().catch(() => "")).toLowerCase();
  const location = new URL(url);
  const checkpointRoute = location.origin === 'https://www.amazon.com' && /^\/checkpoint\/(?:continue|validate)(?:\/|$)/.test(location.pathname);
  const checkpointForm = await page.locator('form#checkpointForm').evaluateAll((forms) => forms.some((form) => {
    const element = form as HTMLFormElement;
    const action = new URL(element.action, window.location.href);
    return element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden' && action.origin === 'https://www.amazon.com' && action.pathname === '/checkpoint/validate' && Boolean(element.querySelector('input[type="checkbox"][name="continueCheck"]'));
  }));
  if (checkpointRoute || checkpointForm) return { kind: 'challenge', challenge: 'robot_check', url, message: 'Complete the I am human checkpoint in the visible dedicated Amazon browser; automation is paused' };
  if (/\/ap\/signin|\/ap\/mfa/.test(url)) {
    const challenge: ChallengeKind = url.includes("/mfa") ? "mfa" : "signin";
    return {
      kind: "challenge",
      challenge,
      url,
      message:
        "Complete Amazon authentication in the visible dedicated browser",
    };
  }
  if (
    /captcha|validatecaptcha|sorry/.test(url.toLowerCase()) ||
    /robot check/.test(title) ||
    (await page.locator("#captchacharacters").count()) > 0
  ) {
    return {
      kind: "challenge",
      challenge: "captcha",
      url,
      message: "Amazon requested a human challenge; automation is paused",
    };
  }
  if (
    (await page.locator('input[name="otpCode"], input[name="code"]').count()) >
    0
  ) {
    return {
      kind: "challenge",
      challenge: "mfa",
      url,
      message:
        "Complete multi-factor authentication in the visible dedicated browser",
    };
  }
  return { kind: "ready", url };
}

export async function isVerifiedAuthenticatedAmazonPage(
  page: Page,
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(page.url());
  } catch {
    return false;
  }
  if (
    url.protocol !== "https:" ||
    !(url.hostname === "amazon.com" || url.hostname.endsWith(".amazon.com"))
  )
    return false;
  const accountGreeting = page
    .locator(
      "#nav-link-accountList-nav-line-1, #nav-link-accountList .nav-line-1",
    )
    .first();
  if (!(await accountGreeting.isVisible())) return false;
  const greeting = (
    await accountGreeting.textContent().catch(() => "")
  )?.trim();
  return Boolean(
    greeting && /^hello,\s*\S/i.test(greeting) && !/sign\s*in/i.test(greeting),
  );
}

async function ensureDedicatedProfile(profileDir: string): Promise<void> {
  const path = resolve(profileDir);
  const normalized = path.toLowerCase();
  const forbidden = [
    "/library/application support/google/chrome",
    "/library/application support/microsoft edge",
    "/library/application support/chromium",
    "\\appdata\\local\\google\\chrome",
    "\\appdata\\local\\microsoft\\edge",
  ];
  if (forbidden.some((part) => normalized.includes(part)))
    throw new BrowserRuntimeError(
      "unsafe_profile",
      "Refusing to use a normal browser profile",
    );
  await mkdir(path, { recursive: true, mode: 0o700 });
  const marker = `${path}/.amazon-mcp-dedicated-profile`;
  try {
    const parsed = JSON.parse(await readFile(marker, "utf8")) as {
      version?: number;
    };
    if (parsed.version !== 1)
      throw new BrowserRuntimeError(
        "unsafe_profile",
        "Dedicated browser profile marker is invalid",
      );
    return;
  } catch (error) {
    if (error instanceof BrowserRuntimeError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new BrowserRuntimeError(
        "unsafe_profile",
        "Dedicated browser profile marker is unreadable",
      );
  }
  const entries = (await readdir(path)).filter((name) => name !== ".DS_Store");
  if (entries.length)
    throw new BrowserRuntimeError(
      "unsafe_profile",
      "Refusing to use a non-empty unmarked browser profile",
    );
  await writeFile(
    marker,
    `${JSON.stringify({ version: 1, createdAt: new Date().toISOString(), sessionGeneration: 0 })}\n`,
    { mode: 0o600, flag: "wx" },
  );
}
