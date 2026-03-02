require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TOKEN   = process.env.AIRTABLE_TOKEN;
const TABLE            = 'Projects';
const MAX_RETRIES      = 2;

function slugify(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function fetchProjects() {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${TABLE}?view=Grid%20view`;
  const res  = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
  if (!res.ok) throw new Error(`Airtable API ${res.status}: ${res.statusText}`);
  const data = await res.json();
  return (data.records || []).map(r => ({
    airtableId:   r.id,
    name:         r.fields['Project Name'] || '',
    type:         (r.fields['Type'] || 'shopify').toLowerCase(),
    url:          r.fields['URL'] || '',
    alertEmail:   r.fields['Alert Email'] || '',
    id:           slugify(r.fields['Project Name']),
    checkPage:    r.fields['Check Page'] || '',
    loginEmail:   r.fields['Login Email'] || '',
    loginPassword:r.fields['Login Password'] || '',
  })).filter(p => p.name && p.url);
}

// ── HTTP pre-check (quick ping to verify domain is reachable) ────────────────
async function httpPreCheck(url) {
  try {
    const origin = new URL(url).origin;
    const res = await fetch(origin, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HealthMonitor/1.0)' },
      redirect: 'follow',
    });
    return { reachable: true, status: res.status };
  } catch {
    return { reachable: false, status: 0 };
  }
}

// ── Retry wrapper ────────────────────────────────────────────────────────────
async function withRetry(fn, label, retries = MAX_RETRIES) {
  let lastResult;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    lastResult = await fn();
    if (lastResult.status !== 'down') return lastResult;
    if (attempt <= retries) {
      console.log(`  ↻ Retry ${attempt}/${retries} for ${label}...`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  return lastResult;
}

// ── Shopify deep check ────────────────────────────────────────────────────────
async function shopifyCheck(project) {
  const start = Date.now();
  const components = [];

  try {
    const res = await fetch(project.url, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HealthMonitor/1.0)' },
    });

    components.push({ name: 'Page loads', status: res.ok ? 'operational' : 'degraded' });

    if (!res.ok) {
      return { status: 'down', responseMs: Date.now() - start, httpStatus: res.status, components };
    }

    const html = await res.text();

    const hasHeader    = /<header|class="header|id="header/i.test(html);
    const hasNav       = /<nav|class="nav|role="navigation/i.test(html);
    const hasProducts  = /product|collection|\.product-/i.test(html);
    const hasCart      = /cart|basket/i.test(html);
    const hasFooter    = /<footer|class="footer/i.test(html);

    components.push({ name: 'Header', status: hasHeader ? 'operational' : 'degraded' });
    components.push({ name: 'Navigation', status: hasNav ? 'operational' : 'degraded' });
    components.push({ name: 'Products', status: hasProducts ? 'operational' : 'degraded' });
    components.push({ name: 'Cart', status: hasCart ? 'operational' : 'degraded' });
    components.push({ name: 'Footer', status: hasFooter ? 'operational' : 'degraded' });

    const anyDegraded = components.some(c => c.status === 'degraded');
    const status = anyDegraded ? 'degraded' : 'operational';

    return { status, responseMs: Date.now() - start, httpStatus: res.status, components };
  } catch (e) {
    components.push({ name: 'Page loads', status: 'down' });
    return { status: 'down', responseMs: Date.now() - start, error: e.message, components };
  }
}

// ── Softr deep check (browser) ────────────────────────────────────────────────
async function softrCheck(project, browser) {
  const start   = Date.now();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    },
  });
  const page = await context.newPage();
  const components = [];

  try {
    // Step 1: Visit magic link
    const response = await page.goto(project.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Smart wait: wait for Softr app shell to appear instead of fixed 8s
    await page.waitForSelector('nav, header, [class*="header"], [class*="sf-"], [class*="softr"]', { timeout: 15000 })
      .catch(() => {});
    // Brief extra wait for auth redirect to settle
    await page.waitForTimeout(2000);

    const httpOk = response?.status() < 400;
    components.push({ name: 'Page loads', status: httpOk ? 'operational' : 'degraded' });

    // Check if magic link failed
    const loginBodyText = await page.locator('body').innerText().catch(() => '');
    const magicLinkFailed = /magic link is no longer valid|link has expired|invalid link/i.test(loginBodyText);
    if (magicLinkFailed) {
      components.push({ name: 'Login', status: 'down', detail: 'Magic link expired or invalid' });
      components.push({ name: 'App content', status: 'down' });
      components.push({ name: 'Data loads', status: 'down' });
      await context.close();
      return { status: 'down', responseMs: Date.now() - start, error: 'Magic link expired', components };
    }
    components.push({ name: 'Login', status: 'operational' });

    // Step 2: Navigate to Check Page
    const baseUrl = new URL(project.url).origin;
    const checkPath = project.checkPage || '/';
    const checkUrl = `${baseUrl}${checkPath}`;

    if (project.checkPage) {
      await page.goto(checkUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      // Smart wait: wait for data content instead of fixed 5s
      await page.waitForSelector('table, [class*="list-item"], [class*="record"], [class*="sf-list"], [class*="data"]', { timeout: 12000 })
        .catch(() => {});
      await page.waitForTimeout(1000);
    }

    const pageTitle = await page.title();
    const bodyText  = await page.locator('body').innerText().catch(() => '');

    // Navigation present
    const hasNav = await page.locator('nav, header, [class*="nav"], [class*="header"], [class*="menu"]').count().catch(() => 0);
    components.push({ name: 'Navigation', status: hasNav > 0 ? 'operational' : 'degraded' });

    // Check for Softr error popups
    const softrErrors = [
      /invalid permissions/i,
      /database is missing/i,
      /something went wrong/i,
      /database connection/i,
      /access denied/i,
    ];
    const errorFound = softrErrors.find(re => re.test(bodyText));
    components.push({
      name: 'No errors',
      status: errorFound ? 'down' : 'operational',
      detail: errorFound ? bodyText.match(errorFound)?.[0] : null,
    });

    // Step 3: Check if data table/list has actual rows
    if (project.checkPage) {
      const rowCount = await page.locator([
        'table tbody tr',
        'table tr + tr',
        '[class*="list-item"]',
        '[class*="record-row"]',
        '[class*="sf-list"] > *',
        '[class*="records"] > *',
        '[class*="table-row"]',
        '[class*="grid-row"]',
        '[class*="data-row"]',
        'tbody tr',
      ].join(', ')).count().catch(() => 0);

      const pageText = await page.locator('body').innerText().catch(() => '');
      const hasMeaningfulContent = pageText.replace(/\s+/g, ' ').trim().length > 100;

      components.push({
        name: 'Data loads',
        status: (rowCount > 0 || hasMeaningfulContent) ? 'operational' : 'down',
        detail: rowCount > 0 ? `${rowCount} record(s) found` : hasMeaningfulContent ? 'Content detected' : 'No data detected',
      });
    }

    await context.close();

    const anyDown     = components.some(c => c.status === 'down');
    const anyDegraded = components.some(c => c.status === 'degraded');
    const status = anyDown ? 'down' : anyDegraded ? 'degraded' : 'operational';

    return { status, responseMs: Date.now() - start, httpStatus: response?.status(), pageTitle, components };
  } catch (e) {
    await context.close().catch(() => {});
    components.push({ name: 'Page loads', status: 'down' });
    return { status: 'down', responseMs: Date.now() - start, error: e.message, components };
  }
}


// ── Custom website deep check (email/password login) ───────────────────────────────
async function customCheck(project, browser) {
  const start   = Date.now();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });
  const page = await context.newPage();
  const components = [];

  try {
    const response = await page.goto(project.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    const httpOk = response?.status() < 400;
    components.push({ name: 'Page loads', status: httpOk ? 'operational' : 'degraded' });
    if (!httpOk) { await context.close(); return { status: 'down', responseMs: Date.now() - start, components }; }

    const email    = project.loginEmail    || process.env.PLAYWATCH_EMAIL;
    const password = project.loginPassword || process.env.PLAYWATCH_PASSWORD;
    if (!email || !password) {
      components.push({ name: 'Login', status: 'degraded', detail: 'No credentials configured' });
    } else {
      await page.waitForSelector('input', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1500);

      const emailInput = page.locator('input[type="text"]').first();
      await emailInput.click({ force: true });
      await page.waitForTimeout(300);
      await emailInput.pressSequentially(email, { delay: 80 });
      await page.waitForTimeout(500);

      const passInput = page.locator('input[type="password"]').first();
      await passInput.click({ force: true });
      await page.waitForTimeout(300);
      await passInput.pressSequentially(password, { delay: 80 });
      await page.waitForTimeout(500);

      await page.locator('button[type="submit"]').click({ force: true });

      await page.waitForTimeout(8000);
      const currentUrl = page.url();

      const pageContent = await page.locator('body').innerText().catch(() => '');

      const stillOnLogin = /login|signin|sign-in/i.test(currentUrl);
      const bodyText = pageContent;
      const loginError = /invalid|incorrect|wrong password|failed/i.test(bodyText);
      components.push({ name: 'Login', status: (!stillOnLogin && !loginError) ? 'operational' : 'down', detail: loginError ? 'Login failed - check credentials' : stillOnLogin ? 'Still on login page after submit' : null });
      if (stillOnLogin || loginError) { await context.close(); return { status: 'down', responseMs: Date.now() - start, error: 'Login failed', components }; }
    }

    const hasNav = await page.locator('nav, header, [class*="nav"], [class*="header"], [class*="menu"], [class*="sidebar"]').count().catch(() => 0);
    components.push({ name: 'Navigation', status: hasNav > 0 ? 'operational' : 'degraded' });

    const pageText = await page.locator('body').innerText().catch(() => '');
    const errorPatterns = [/something went wrong/i, /internal server error/i, /access denied/i, /page not found/i];
    const errorFound = errorPatterns.find(re => re.test(pageText));
    components.push({ name: 'No errors', status: errorFound ? 'down' : 'operational', detail: errorFound ? String(errorFound) : null });

    await context.close();
    const anyDown = components.some(c => c.status === 'down');
    const anyDegraded = components.some(c => c.status === 'degraded');
    return { status: anyDown ? 'down' : anyDegraded ? 'degraded' : 'operational', responseMs: Date.now() - start, components };
  } catch (e) {
    await context.close().catch(() => {});
    components.push({ name: 'Page loads', status: 'down' });
    return { status: 'down', responseMs: Date.now() - start, error: e.message, components };
  }
}

// ── Email alert ───────────────────────────────────────────────────────────────
async function sendAlert(project, result) {
  if (!process.env.SENDGRID_API_KEY || !project.alertEmail) return;
  const failedComponents = (result.components || []).filter(c => c.status !== 'operational');
  const compText = failedComponents.length
    ? `\nFailed components:\n${failedComponents.map(c => `  - ${c.name}: ${c.detail || c.status}`).join('\n')}`
    : '';
  await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: project.alertEmail }] }],
      from: { email: process.env.ALERT_FROM_EMAIL || 'monitor@noreply.com' },
      subject: `${project.name} is ${result.status.toUpperCase()}`,
      content: [{ type: 'text/plain', value: `${project.name} is ${result.status.toUpperCase()}\nURL: ${new URL(project.url).origin}\nResponse: ${result.responseMs}ms${compText}\n${result.error ? 'Error: '+result.error : ''}\nChecked: ${new Date().toUTCString()}\n\nNote: This alert was sent after ${MAX_RETRIES + 1} consecutive check attempts and confirmed the issue persists.` }],
    }),
  }).catch(e => console.error('Email alert failed:', e.message));
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log('System Status Health Monitor v4.1\n');
  console.log('Loading projects from Airtable...');
  const projects = await fetchProjects();
  console.log(`   Found ${projects.length} project(s):`);
  projects.forEach(p => console.log(`   - [${p.type.toUpperCase()}] ${p.name}`));
  console.log('');

  // Load previous status for confirmed-down logic
  const outDir = path.join(__dirname, '..', 'dashboard');
  const statusFile = path.join(outDir, 'status.json');
  let prevResults = [];
  if (fs.existsSync(statusFile)) {
    try { prevResults = JSON.parse(fs.readFileSync(statusFile, 'utf8')).results || []; } catch {}
  }

  const needsBrowser = projects.some(p => p.type === 'softr' || p.type === 'custom');
  const browser  = needsBrowser ? await chromium.launch() : null;
  const results  = [];

  for (const project of projects) {
    process.stdout.write(`Checking ${project.name} [${project.type}]... `);

    // HTTP pre-check for browser-based checks
    if (project.type === 'softr' || project.type === 'custom') {
      const ping = await httpPreCheck(project.url);
      if (!ping.reachable) {
        console.log(`DOWN (domain unreachable)`);
        const result = { status: 'down', responseMs: 0, error: 'Domain unreachable - server did not respond', components: [{ name: 'Page loads', status: 'down' }] };
        results.push({ ...project, checkedAt: new Date().toISOString(), ...result });
        continue;
      }
    }

    // Run check with retry logic
    const checkFn = project.type === 'softr'
      ? () => softrCheck(project, browser)
      : project.type === 'custom'
      ? () => customCheck(project, browser)
      : () => shopifyCheck(project);

    const needsRetry = project.type === 'softr' || project.type === 'custom';
    const result = needsRetry
      ? await withRetry(checkFn, project.name)
      : await checkFn();

    console.log(`${result.status.toUpperCase()} (${result.responseMs}ms)`);
    if (result.error) console.log(`  ! ${result.error}`);
    if (result.components) {
      result.components.forEach(c => {
        const icon = c.status === 'operational' ? '+' : '-';
        console.log(`  ${icon} ${c.name}: ${c.status}${c.detail ? ' ('+c.detail+')' : ''}`);
      });
    }

    // Confirmed-down alerting: only alert if previous check was also not operational
    const prev = prevResults.find(r => r.id === project.id || r.name === project.name);
    const wasDownBefore = prev && prev.status !== 'operational';
    const isDownNow = result.status !== 'operational';

    if (isDownNow && wasDownBefore) {
      console.log(`  >> Confirmed down (2 consecutive failures) - sending alert`);
      await sendAlert(project, result);
    } else if (isDownNow && !wasDownBefore) {
      console.log(`  >> First failure - will alert on next consecutive failure`);
    }

    results.push({ ...project, checkedAt: new Date().toISOString(), ...result });
  }

  if (browser) await browser.close();

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'status.json'), JSON.stringify({ updatedAt: new Date().toISOString(), results }, null, 2));

  const histFile = path.join(outDir, 'history.json');
  let history = [];
  if (fs.existsSync(histFile)) { try { history = JSON.parse(fs.readFileSync(histFile, 'utf8')); } catch {} }
  history.push({ timestamp: new Date().toISOString(), results });
  if (history.length > 672) history = history.slice(-672);
  fs.writeFileSync(histFile, JSON.stringify(history, null, 2));

  const down = results.filter(r => r.status === 'down');
  if (down.length && process.env.SLACK_WEBHOOK_URL) {
    // Only send Slack alert for confirmed-down (2 consecutive failures)
    const confirmedDown = down.filter(d => {
      const prev = prevResults.find(r => r.id === d.id || r.name === d.name);
      return prev && prev.status !== 'operational';
    });
    if (confirmedDown.length) {
      await fetch(process.env.SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `*Health Alert*\n${confirmedDown.map(s => `${s.name} is DOWN (confirmed - 2 consecutive failures)`).join('\n')}\n\nhttps://projecthealthmonitoring.netlify.app/` }),
      }).catch(() => {});
    }
  }

  console.log(`\nDone. ${results.length} site(s) checked.`);
  if (down.length) process.exit(1);
})();
