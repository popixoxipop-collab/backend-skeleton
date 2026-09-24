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
  const diagnostics = { page_errors: [], request_failures: [], console_errors: [], workers: [] };

  async function sample() {
    const value = await page.evaluate((globalName) => {
      const probe = globalThis[globalName];
      if (!probe) return null;
      return typeof probe.snapshot === 'function' ? probe.snapshot() : probe;
    }, currentPlan.probe.global);
    if (!value) throw new Error(`webgame probe ${currentPlan.probe.global} is not available in the page`);
    return value;
  }

  async function collectFor(durationMs) {
    const samples = [await sample()];
    const interval = currentPlan.probe.sample_interval_ms;
    const steps = Math.max(1, Math.ceil(durationMs / interval));
    for (let index = 0; index < steps; index += 1) {
      await page.waitForTimeout(interval);
      samples.push(await sample());
    }
    return samples;
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
      await page.goto(joinUrl(plan.serve.url, plan.serve.ready_path), { waitUntil: 'domcontentloaded' });
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
        return [before, await sample()];
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
