import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import shippedPolicy from '../extension/policy/default.json' with { type: 'json' };
/** The judge's time limits the extension ships with (a release always uses them: policy.ts normalizePolicy). */
const SHIPPED_JUDGE = shippedPolicy.judge;

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXT = path.join(ROOT, 'extension');

export type LogEntry = { ts: number; method: string; path: string; body?: string };
export type AuditEntry = {
  kind: string; ts: number; method: string; url: string; verdict: string; source: string; reason: string;
  enforced: boolean; fingerprint?: string; bodyShape?: string; pWrite?: number; lastUiActions?: Array<{ type: string; name?: string; tag: string }>;
};

/** The stored decision log, oldest first. The background keeps it in chunks (`audit.<id>`, ordered by
 *  `auditIndex`, see background/audit.ts) so an append rewrites one small key; this reads them back as one list. */
export async function storedAudit(sw: Worker): Promise<AuditEntry[]> {
  return sw.evaluate(async () => {
    const { auditIndex } = await chrome.storage.local.get('auditIndex');
    const ids = (auditIndex ?? []) as number[];
    const chunks = await chrome.storage.local.get(ids.map((id) => `audit.${id}`));
    return ids.flatMap((id) => (chunks[`audit.${id}`] ?? []) as unknown[]);
  }) as Promise<AuditEntry[]>;
}

export class Harness {
  server!: ChildProcess;
  ctx!: BrowserContext;
  sw!: Worker;
  page!: Page;
  readonly base: string;
  readonly port: number;

  constructor(port: number) { this.port = port; this.base = `http://localhost:${port}`; }

  /** `noJudge`: the pages as with no AI judge set (the way to set one, alone); otherwise they show as with one, while the
   *  judge stays rules-only (messages.ts assumeJudge).
   *  `windowViewport`: pages take the window's own size and the screen's scaling (as a person's browser does) instead of
   *  Playwright's fixed viewport, whose emulated scaling never reaches the extension's own frames (another process). */
  async start(policyPatch: Record<string, unknown>, opts: { extraArgs?: string[]; profileDir?: string; noJudge?: boolean; windowViewport?: boolean } = {}): Promise<void> {
    this.server = spawn(process.execPath, [path.join(ROOT, 'fixtures/testapp/server.ts')], {
      env: { ...process.env, PORT: String(this.port) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.server.stderr?.on('data', (d) => process.stderr.write(`[fixture] ${d}`));
    await this.waitForHealth();
    await this.reset();

    const profile = opts.profileDir ?? path.join(ROOT, 'test-results', `profile-${this.port}-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    // Google Chrome >= 137 ignores --load-extension; Playwright's Chromium honours it.
    this.ctx = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true, ...(opts.windowViewport ? { viewport: null } : {}),
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--silent-debugger-extension-api', ...(opts.extraArgs ?? [])],
    });
    this.sw = this.ctx.serviceWorkers()[0] ?? (await this.ctx.waitForEvent('serviceworker'));
    if (process.env.ONLYREAD_DEBUG) {
      const t0 = Date.now();
      this.sw.on('console', (m) => process.stderr.write(`+${Date.now() - t0}ms [sw:${m.type()}] ${m.text()}\n`));
      this.sw.on('close', () => process.stderr.write(`+${Date.now() - t0}ms [sw] CLOSED\n`));
      this.ctx.on('serviceworker', (w) => process.stderr.write(`[harness] NEW service worker ${w.url()}\n`));
    }
    // The fixture suites test interception itself, so they attach always unless a test asks for
    // agent-session attachment (the product default, which stays dormant until an agent appears), and judge with an own
    // key that is not set (rules only) unless a test chooses Pro (the product default).
    await this.assumeJudge(!opts.noJudge);
    // Protection on: a fresh install ships it off until setup has an AI judge (policy/default.json).
    await this.setPolicy({ enabled: true, attachWhen: 'always', judge: { provider: 'byok', byok: { id: 'openrouter' }, timeoutMs: SHIPPED_JUDGE.timeoutMs, llmTimeoutMs: SHIPPED_JUDGE.llmTimeoutMs }, customSites: [{ id: 'fixture', name: 'fixture', domains: ['localhost', '127.0.0.1'], enabled: true }], ...policyPatch });
    await this.waitFor(async () => (await this.sw.evaluate(async () => (await chrome.declarativeNetRequest.getDynamicRules()).length)) >= 3, 'dynamic rules');
    this.page = await this.ctx.newPage();
    await this.page.goto(`${this.base}/`);
  }

  async stop(): Promise<void> {
    await this.ctx?.close();
    this.server?.kill();
  }

  /** Whether the pages show as with an AI judge set (messages.ts assumeJudge); the judge itself stays as it is. */
  async assumeJudge(on: boolean): Promise<void> {
    await this.sw.evaluate(async (on) => (globalThis as unknown as { __onlyread: { assumeJudge: (on: boolean) => void } }).__onlyread.assumeJudge(on), on);
  }

  async setPolicy(patch: Record<string, unknown>): Promise<void> {
    await this.sw.evaluate(async (patch) => {
      const hook = (globalThis as unknown as { __onlyread: { ready: () => Promise<void>; setPolicy: (p: unknown) => Promise<unknown> } }).__onlyread;
      await hook.ready();
      await hook.setPolicy(patch);
    }, patch);
  }

  async status(): Promise<{ mode: string; attachedTabs: number; inFlight: number; observations: number; judge: string; failClosed: boolean; targetDomains: string[]; agentSession: boolean; managed?: { version: number }; managedPending?: string }> {
    return this.sw.evaluate(() => (globalThis as unknown as { __onlyread: { status: () => Promise<unknown> } }).__onlyread.status()) as never;
  }

  async born(): Promise<number> {
    return this.sw.evaluate(() => (globalThis as unknown as { __onlyread: { born: () => number } }).__onlyread.born());
  }

  /** The decision log as stored (not the background's in-memory copy): what survives a worker restart. */
  async audit(): Promise<AuditEntry[]> { return storedAudit(this.sw); }

  async exportAll(): Promise<{ audit: AuditEntry[]; observations: unknown[] }> {
    const { observations } = await this.sw.evaluate(() => chrome.storage.local.get('observations'));
    return { audit: await storedAudit(this.sw), observations: (observations ?? []) as unknown[] };
  }

  async observations(): Promise<Array<{ method: string; url: string; outcome?: string; error?: string }>> {
    const { observations } = await this.sw.evaluate(() => chrome.storage.local.get('observations'));
    return (observations ?? []) as never;
  }

  /** Signs the extension in to the fixture's mock Pro service (fixtures/cloud/mock.ts): the PKCE exchange done
   *  here (the mock's sign-in page redirects at once, so no auth window is needed), the tokens stored where the
   *  background keeps them. */
  async signInToMock(): Promise<void> {
    const svc = `${this.base}/cloud`;
    await this.setPolicy({ cloud: { serviceUrl: svc, timeoutMs: 8000 } });
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const redirect = 'http://localhost/cb';
    const q = new URLSearchParams({ redirect_uri: redirect, state: 's', code_challenge: challenge, code_challenge_method: 'S256' });
    const res = await fetch(`${svc}/signin?${q}`, { redirect: 'manual' });
    const code = new URL(res.headers.get('location') ?? '').searchParams.get('code');
    const t = (await (await fetch(`${svc}/v1/token`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect }),
    })).json()) as { access_token: string; refresh_token: string; expires_in: number };
    const tokens = { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000 };
    await this.sw.evaluate((tokens) => chrome.storage.local.set({ cloudTokens: tokens }), tokens);
  }

  /** Patches the mock Pro service's state (`managed` sets the account's site list, a new version). */
  async mock(patch: Record<string, unknown>): Promise<void> {
    await fetch(`${this.base}/cloud/__mock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
  }

  /** Sync now, as the settings page's button does (background/cloud-sync.ts). */
  async syncManaged(): Promise<void> {
    await this.sw.evaluate(() => (globalThis as unknown as { __onlyread: { syncManaged: () => Promise<void> } }).__onlyread.syncManaged());
  }

  async serverLog(): Promise<LogEntry[]> { return (await fetch(`${this.base}/__log`)).json() as Promise<LogEntry[]>; }
  async reset(): Promise<void> { await fetch(`${this.base}/__reset`, { method: 'POST' }); }

  /** fetch() inside the page → "status:<n>" | "error:<name>" */
  async pageFetch(method: string, url: string, body?: string, contentType = 'application/json'): Promise<string> {
    return this.page.evaluate(async ({ method, url, body, contentType }) => {
      try {
        const res = await fetch(url, { method, headers: body ? { 'content-type': contentType } : {}, body });
        return `status:${res.status}`;
      } catch (e) { return `error:${(e as Error).name}`; }
    }, { method, url, body, contentType });
  }

  async workerFetch(method: string, url: string, body?: string): Promise<string> {
    return this.page.evaluate(({ method, url, body }) => new Promise<string>((resolve) => {
      const w = new Worker('/worker.js');
      w.onmessage = (e) => { resolve(e.data.status !== undefined ? `status:${e.data.status}` : `error:${e.data.error}`); w.terminate(); };
      w.postMessage({ method, url, body });
      setTimeout(() => resolve('timeout'), 5000);
    }), { method, url, body });
  }

  async waitFor(cond: () => Promise<boolean>, what: string, ms = 10_000): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  /** 30 s: the two fixture suites start their servers side by side, and a loaded machine took more than 10 s. */
  private async waitForHealth(ms = 30_000): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      try { if ((await fetch(`${this.base}/__health`)).ok) return; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('fixture did not come up');
  }
}
