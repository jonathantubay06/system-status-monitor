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
    group:        r.fields['Client'] || '',
    alertThreshold: parseInt(r.fields['Alert Threshold (min)']) || 0,
    alertChannel: (r.fields['Alert Channel'] || 'email').toLowerCase(),
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

    const hasHeader    = /<header|class="[^"]*header|id="[^"]*header|id="MainContent/i.test(html);
    const hasNav       = /<nav|class="[^"]*nav|role="navigation|menu-drawer|header-drawer|class="[^"]*menu|cart-drawer|id="MainContent/i.test(html);
    const hasProducts  = /product|collection|\.product-/i.test(html);
    const hasCart      = /cart|basket/i.test(html);
    const hasFooter    = /<footer|class="[^"]*footer|id="[^"]*footer/i.test(html);

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

    // Wait for auth redirect: URL should leave the magic-authentication page
    await page.waitForURL(url => !url.toString().includes('magic-authentication'), { timeout: 20000 })
      .catch(() => {});
    // Brief extra wait for app shell to fully render
    await page.waitForTimeout(3000);

    const httpOk = response?.status() < 400;
    components.push({ name: 'Page loads', status: httpOk ? 'operational' : 'degraded' });

    // Check if magic link failed
    const loginBodyText = await page.locator('body').innerText().catch(() => '');
    const currentTitle = await page.title();
    const magicLinkFailed = /magic link is no longer valid|link has expired|invalid link/i.test(loginBodyText)
      || /sign.?in|log.?in/i.test(currentTitle);
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
      // ─── STEP 1: Wait for login form to render (SPA hydration) ───
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForSelector('input[type="password"]', { timeout: 15000 }).catch(() => {});

      // ─── STEP 2: Fill email field ───
      // Try multiple selector strategies (placeholder, type, name, id)
      const emailSelectors = [
        'input[type="email"]',
        'input[name*="email" i]',
        'input[placeholder*="email" i]',
        'input[id*="email" i]',
        'input[type="text"]:not([type="password"])',
      ];
      let emailInput = null;
      for (const sel of emailSelectors) {
        const loc = page.locator(sel).first();
        if (await loc.count().catch(() => 0) > 0) { emailInput = loc; break; }
      }
      if (!emailInput) {
        components.push({ name: 'Login', status: 'down', detail: 'Email field not found' });
        await context.close();
        return { status: 'down', responseMs: Date.now() - start, error: 'Email field not found', components };
      }
      await emailInput.click({ force: true });
      await emailInput.fill(''); // Clear any pre-filled value
      await emailInput.fill(email);
      await page.waitForTimeout(300);

      // ─── STEP 3: Fill password field ───
      const passInput = page.locator('input[type="password"]').first();
      await passInput.click({ force: true });
      await passInput.fill('');
      await passInput.fill(password);
      await page.waitForTimeout(300);

      // ─── STEP 4: Submit form (try Enter; fallback to Log In button) ───
      const beforeUrl = page.url();
      await passInput.press('Enter');

      // Wait for URL change (login redirect)
      const navigated = await page.waitForURL(url => url.toString() !== beforeUrl, { timeout: 12000 })
        .then(() => true).catch(() => false);

      // If Enter didn't trigger submit, try clicking the Log In button explicitly
      if (!navigated && page.url() === beforeUrl) {
        const logInBtn = page.locator('button').filter({ hasText: /^Log In$/i }).last();
        if (await logInBtn.count().catch(() => 0) > 0) {
          await logInBtn.click({ force: true }).catch(() => {});
          await page.waitForURL(url => url.toString() !== beforeUrl, { timeout: 12000 }).catch(() => {});
        }
      }

      // Wait for full page render after navigation
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(1500);

      // ─── STEP 5: Verify login success ───
      const currentUrl = page.url();
      const bodyText = await page.locator('body').innerText().catch(() => '');
      const stillOnLogin = /\/login|\/signin|\/sign-in/i.test(currentUrl);
      const loginError = /invalid (email|password|credentials)|incorrect (email|password)|wrong password|user not found|account.*not.*exist/i.test(bodyText);

      if (stillOnLogin || loginError) {
        components.push({
          name: 'Login',
          status: 'down',
          detail: loginError ? 'Invalid credentials' : 'Still on login page after submit'
        });
        await context.close();
        return { status: 'down', responseMs: Date.now() - start, error: loginError ? 'Invalid credentials' : 'Login redirect failed', components };
      }
      components.push({ name: 'Login', status: 'operational' });

      // ─── STEP 6: Handle child profile selection (Kingdomland Playwatch) ───
      // Wait briefly for profile selection text/cards if present
      await page.waitForSelector('text=/who.?s.?watching|pick a kid|select.*profile/i', { timeout: 3000 }).catch(() => {});
      const refreshedUrl = page.url();
      const refreshedBody = await page.locator('body').innerText().catch(() => '');
      const isProfileSelection = /child-profile-selection|profile-select|who.?s.?watching|pick a kid/i.test(refreshedUrl + ' ' + refreshedBody);

      if (isProfileSelection) {
        // Find a profile card — try multiple selectors targeting clickable profile elements
        const profileSelectors = [
          'div[class*="profile-card"]',
          'div[class*="profileCard"]',
          'button[class*="profile"]',
          'div[class*="ProfileCard"]',
          '[role="button"][class*="kid"]',
          // Image avatar in a clickable parent
          'img[alt*="avatar" i]',
          // Look for clickable cards in the main content area
          'main button, main [role="button"], main a[href*="profile"]',
          // Last resort: any image that's a profile (in a grid with another "add" button)
          'main img:not([alt*="logo" i]):not([alt*="banner" i])',
        ];
        let profileCard = null;
        for (const sel of profileSelectors) {
          const loc = page.locator(sel).first();
          const count = await loc.count().catch(() => 0);
          if (count > 0 && await loc.isVisible().catch(() => false)) {
            profileCard = loc;
            break;
          }
        }
        if (profileCard) {
          await profileCard.click({ force: true }).catch(() => {});
          // Wait for the profile selection page to disappear (animation + redirect)
          await page.waitForFunction(
            () => !/who.?s.?watching|pick a kid/i.test(document.body.innerText),
            { timeout: 10000 }
          ).catch(() => {});
          await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
          await page.waitForTimeout(1500);
        }
      }
    }

    // Navigation check — try semantic, role-based, and content-based detection
    // Wait a moment for any nav to render
    await page.waitForSelector('nav, header, [role="navigation"], [role="banner"]', { timeout: 5000 }).catch(() => {});
    const hasNav = await page.locator([
      'nav',
      'header',
      '[role="navigation"]',
      '[role="banner"]',
      '[class*="nav"]',
      '[class*="header"]',
      '[class*="menu"]',
      '[class*="sidebar"]',
      'a[href="/"]', // Home link is a common nav indicator
    ].join(', ')).count().catch(() => 0);
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
async function sendSlackAlert(project, result) {
  if (!process.env.SLACK_WEBHOOK_URL) return;
  const failedComponents = (result.components || []).filter(c => c.status !== 'operational');
  const compText = failedComponents.length
    ? '\n' + failedComponents.map(c => `  • ${c.name}: ${c.detail || c.status}`).join('\n')
    : '';
  await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `*${project.name} is ${result.status.toUpperCase()}*\nURL: ${new URL(project.url).origin}\nResponse: ${result.responseMs}ms${compText}\n${result.error ? 'Error: '+result.error : ''}` }),
  }).catch(e => console.error('Slack alert failed:', e.message));
}

// Rate limit: don't send same project alert more than once per 6 hours
const ALERT_COOLDOWN_HOURS = 6;
function isAlertRateLimited(projectId) {
  const logPath = path.join(__dirname, '..', 'dashboard', 'alert-log.json');
  let log = {};
  if (fs.existsSync(logPath)) { try { log = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch {} }
  const last = log[projectId];
  if (!last) return false;
  const hoursAgo = (Date.now() - new Date(last).getTime()) / 3600000;
  return hoursAgo < ALERT_COOLDOWN_HOURS;
}
function recordAlertSent(projectId) {
  const logPath = path.join(__dirname, '..', 'dashboard', 'alert-log.json');
  let log = {};
  if (fs.existsSync(logPath)) { try { log = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch {} }
  log[projectId] = new Date().toISOString();
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
}

async function sendAlert(project, result) {
  const channel = project.alertChannel || 'email';
  if (channel === 'none') return;
  // Rate limit: skip if we just sent an alert for this project
  if (isAlertRateLimited(project.id)) {
    console.log(`  >> Alert suppressed (cooldown active, last alert < ${ALERT_COOLDOWN_HOURS}h ago)`);
    return;
  }
  if ((channel === 'email' || channel === 'both') && process.env.SENDGRID_API_KEY && project.alertEmail) {
    await sendEmailAlert(project, result);
  }
  if ((channel === 'slack' || channel === 'both') && process.env.SLACK_WEBHOOK_URL) {
    await sendSlackAlert(project, result);
  }
  recordAlertSent(project.id);
}

async function sendEmailAlert(project, result) {
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

// ── Fetch client-reported issues from Google Sheet ───────────────────────────
async function fetchClientReports() {
  const sheetId = '1mokCRIxI5Cw4_PChoWd3jkv3268n85k4tjD3AdB8zXY';
  const sheetName = '2026';
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) { console.log('  ! Google Sheet fetch failed:', res.status); return []; }
    const csv = await res.text();
    const rows = parseCSV(csv);
    if (rows.length < 2) return [];
    const headers = rows[0];
    const dateCol = headers.findIndex(h => /date reported/i.test(h));
    const issueCol = headers.findIndex(h => /issues raised/i.test(h));
    const defCol = headers.findIndex(h => /^issue definition$/i.test(h));
    const subDefCol = headers.findIndex(h => /issue sub definition/i.test(h));
    const raisedCol = headers.findIndex(h => /raised by/i.test(h));
    const requestCol = headers.findIndex(h => /^request$/i.test(h));
    if (dateCol < 0 || issueCol < 0) { console.log('  ! Could not find required columns'); return []; }
    const reports = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const dateStr = (r[dateCol] || '').trim();
      if (!dateStr) continue;
      const parsed = new Date(dateStr);
      if (isNaN(parsed.getTime())) continue;
      reports.push({
        projectId: 'jordan-ranch-portal',
        date: parsed.toISOString().split('T')[0],
        request: (r[requestCol] || '').trim(),
        issue: (r[issueCol] || '').trim(),
        definition: defCol >= 0 ? (r[defCol] || '').trim() : '',
        subDefinition: subDefCol >= 0 ? (r[subDefCol] || '').trim() : '',
        raisedBy: raisedCol >= 0 ? (r[raisedCol] || '').trim() : '',
      });
    }
    return reports;
  } catch (e) {
    console.log('  ! Client reports fetch error:', e.message);
    return [];
  }
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || (c === '\r' && text[i + 1] === '\n')) {
        row.push(field); field = '';
        if (row.some(f => f.trim())) rows.push(row);
        row = [];
        if (c === '\r') i++;
      } else field += c;
    }
  }
  row.push(field);
  if (row.some(f => f.trim())) rows.push(row);
  return rows;
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
    // and downtime exceeds threshold (if set)
    const prev = prevResults.find(r => r.id === project.id || r.name === project.name);
    const wasDownBefore = prev && prev.status !== 'operational';
    const isDownNow = result.status !== 'operational';

    if (isDownNow && wasDownBefore) {
      const threshold = project.alertThreshold || 0;
      if (threshold > 0) {
        // Calculate consecutive downtime from history
        let downMinutes = 0;
        const histFile2 = path.join(outDir, 'history.json');
        let hist2 = [];
        if (fs.existsSync(histFile2)) { try { hist2 = JSON.parse(fs.readFileSync(histFile2, 'utf8')); } catch {} }
        for (let i = hist2.length - 1; i >= 0; i--) {
          const hr = (hist2[i].results || []).find(x => x.id === project.id);
          if (!hr || hr.status === 'operational') break;
          downMinutes = (Date.now() - new Date(hist2[i].timestamp).getTime()) / 60000;
        }
        if (downMinutes < threshold) {
          console.log(`  >> Down ${Math.round(downMinutes)}min (threshold: ${threshold}min) - waiting`);
        } else {
          console.log(`  >> Down ${Math.round(downMinutes)}min (threshold: ${threshold}min) - sending alert`);
          await sendAlert(project, result);
        }
      } else {
        console.log(`  >> Confirmed down (2 consecutive failures) - sending alert`);
        await sendAlert(project, result);
      }
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
  // Strip results to minimal fields for history (saves ~50-60% file size)
  const minimalResults = results.map(r => ({
    id: r.id, name: r.name, status: r.status, responseMs: r.responseMs,
    ...(r.error ? { error: r.error } : {}),
    components: r.components
  }));
  history.push({ timestamp: new Date().toISOString(), results: minimalResults });
  if (history.length > 672) history = history.slice(-672);
  fs.writeFileSync(histFile, JSON.stringify(history, null, 2));

  // Fetch and save client-reported issues from Google Sheet
  console.log('\nFetching client-reported issues from Google Sheet...');
  const clientReports = await fetchClientReports();
  const crPath = path.join(outDir, 'client-reports.json');
  // Don't overwrite existing data with empty results (Google Sheet fetch may fail in CI)
  if (clientReports.length > 0) {
    fs.writeFileSync(crPath, JSON.stringify(clientReports, null, 2));
    console.log(`   Saved ${clientReports.length} client report(s)`);
  } else {
    const existing = fs.existsSync(crPath) ? JSON.parse(fs.readFileSync(crPath, 'utf8')) : [];
    if (existing.length > 0) {
      console.log(`   Google Sheet returned 0 reports — keeping existing ${existing.length} report(s)`);
    } else {
      fs.writeFileSync(crPath, '[]');
      console.log('   No client reports found');
    }
  }

  const down = results.filter(r => r.status !== 'operational');
  // Per-project alerts already handled above via sendAlert() with channel preference

  console.log(`\nDone. ${results.length} site(s) checked.`);
  if (down.length) process.exit(1);
})();
