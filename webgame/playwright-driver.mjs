function joinUrl(base, readyPath) {
  return new URL(readyPath || '/', base).toString();
}

function isLoopbackUrl(value) {
  try {
    const url = new URL(value);
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

export class WebgameBrowserUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WebgameBrowserUnavailableError';
  }
}

export class WebgameBrowserHealthError extends Error {
  constructor(message, diagnostics = null) {
    super(message);
    this.name = 'WebgameBrowserHealthError';
    this.diagnostics = diagnostics;
  }
}

async function loadPlaywright(explicit) {
  if (explicit) return explicit;
  try {
    return await import('playwright');
  } catch (error) {
    throw new WebgameBrowserUnavailableError(`Playwright is not installed: ${error.message}`);
  }
}

export function createPlaywrightDriver({ playwright = null } = {}) {
  let browser = null;
  let context = null;
  let page = null;
  let currentPlan = null;
  const diagnostics = { page_errors: [], request_failures: [], console_errors: [], workers: [], crashes: [] };

  function healthCheckpoint() {
    return {
      page_errors: diagnostics.page_errors.length,
      request_failures: diagnostics.request_failures.length,
      console_errors: diagnostics.console_errors.length,
      crashes: diagnostics.crashes.length,
    };
  }

  function assertHealthy(since = { page_errors: 0, request_failures: 0, console_errors: 0, crashes: 0 }) {
    const failures = [];
    if (diagnostics.page_errors.length > since.page_errors) failures.push('page error');
    if (diagnostics.request_failures.length > since.request_failures) failures.push('request failure');
    if (diagnostics.console_errors.length > since.console_errors) failures.push('console error');
    if (diagnostics.crashes.length > since.crashes) failures.push('page crash');
    if (failures.length) throw new WebgameBrowserHealthError(`browser health check failed: ${failures.join(', ')}`, diagnostics);
  }

  async function sample() {
    assertHealthy();
    const value = await page.evaluate((globalName) => {
      const probe = globalThis[globalName];
      if (!probe) return null;
      return typeof probe.snapshot === 'function' ? probe.snapshot() : probe;
    }, currentPlan.probe.global);
    if (!value) throw new WebgameBrowserHealthError(`webgame probe ${currentPlan.probe.global} is not available in the page`, diagnostics);
    assertHealthy();
    return value;
  }

  async function collectFor(durationMs) {
    const checkpoint = healthCheckpoint();
    const samples = [await sample()];
    const interval = currentPlan.probe.sample_interval_ms;
    const steps = Math.max(1, Math.ceil(durationMs / interval));
    for (let index = 0; index < steps; index += 1) {
      await page.waitForTimeout(interval);
      samples.push(await sample());
    }
    assertHealthy(checkpoint);
    return samples;
  }

  async function waitForRequiredWorkers() {
    const required = currentPlan.browser.required_workers ?? 0;
    if (required <= 0) return;
    const timeoutMs = currentPlan.browser.worker_timeout_ms ?? 3000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (diagnostics.workers.length >= required) return;
      await page.waitForTimeout(Math.min(50, timeoutMs));
    }
    throw new WebgameBrowserHealthError(`required workers did not start: expected ${required}, observed ${diagnostics.workers.length}`, diagnostics);
  }

  return {
    diagnostics,
    async open(plan) {
      if (!plan?.execution?.available) throw new Error('Playwright driver refuses a non-executable webgame plan');
      if (!isLoopbackUrl(plan.serve.url)) throw new Error('Playwright driver only opens loopback webgame URLs');
      currentPlan = plan;
      const module = await loadPlaywright(playwright);
      const browserType = module[plan.browser.name];
      if (!browserType?.launch) throw new WebgameBrowserUnavailableError(`Playwright browser is unavailable: ${plan.browser.name}`);
      browser = await browserType.launch({ headless: plan.browser.headless });
      context = await browser.newContext({
        viewport: plan.browser.viewport ?? { width: 1280, height: 720 },
        serviceWorkers: 'block',
      });
      if (typeof context.route === 'function') {
        await context.route('**/*', async (route) => {
          const url = route.request().url();
          if (isLoopbackUrl(url)) await route.continue();
          else await route.abort('blockedbyclient');
        });
      }
      page = await context.newPage();
      page.on?.('pageerror', (error) => diagnostics.page_errors.push(String(error?.message ?? error)));
      page.on?.('requestfailed', (request) => diagnostics.request_failures.push({ url: request.url(), failure: request.failure()?.errorText ?? null }));
      page.on?.('console', (message) => { if (message.type() === 'error') diagnostics.console_errors.push(message.text()); });
      page.on?.('worker', (worker) => diagnostics.workers.push(worker.url()));
      page.on?.('crash', () => diagnostics.crashes.push({ at: Date.now() }));
      const response = await page.goto(joinUrl(plan.serve.url, plan.serve.ready_path), { waitUntil: 'domcontentloaded' });
      if (!response || typeof response.status !== 'function') throw new WebgameBrowserHealthError('browser navigation returned no HTTP response', diagnostics);
      const status = response.status();
      if (status < 200 || status >= 400) throw new WebgameBrowserHealthError(`browser navigation failed with HTTP ${status}`, diagnostics);
      await waitForRequiredWorkers();
      await sample();
    },
    async runScenario(scenario) {
      if (!page) throw new Error('Playwright driver is not open');
      const action = scenario.action;
      if (action.type === 'key') {
        await page.keyboard.down(action.key);
        try {
          return await collectFor(action.duration_ms);
        } finally {
          await page.keyboard.up(action.key);
        }
      }
      if (action.type === 'wait') return collectFor(action.duration_ms);
      if (action.type === 'interact') {
        const before = await sample();
        await page.keyboard.press(action.key ?? 'KeyE');
        await page.waitForTimeout(currentPlan.probe.sample_interval_ms);
        const after = await sample();
        assertHealthy();
        return [before, after];
      }
      throw new Error(`unsupported browser action: ${action.type}`);
    },
    async close() {
      const localContext = context;
      const localBrowser = browser;
      page = null;
      context = null;
      browser = null;
      currentPlan = null;
      if (localContext) await localContext.close();
      if (localBrowser) await localBrowser.close();
    },
  };
}
