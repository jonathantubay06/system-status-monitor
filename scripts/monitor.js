const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TOKEN   = process.env.AIRTABLE_TOKEN;
const TABLE            = 'Projects';

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
    intervalMins: r.fields['Check Interval (mins)'] || 15,
    alertEmail:   r.fields['Alert Email'] || '',
    id:           slugify(r.fields['Project Name']),
    checkPage:    r.fields['Check Page'] || '',
  })).filter(p => p.name && p.url);
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

    // Check key Shopify components via HTML content
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
    // Step 1: Visit magic link — logs in and redirects to app root
    const response = await page.goto(project.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(8000); // Give Softr more time to process auth + redirect

    // Page loads check
    const httpOk = response?.status() < 400;
    components.push({ name: 'Page loads', status: httpOk ? 'operational' : 'degraded' });

    // Check if magic link itself failed (expired/invalid)
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

    // Step 2: Navigate to Check Page in same session (session still active after magic link)
    const baseUrl = new URL(project.url).origin; // e.g. https://gainsurance.softr.app
    const checkPath = project.checkPage || '/';
    const checkUrl = `${baseUrl}${checkPath}`;

    if (project.checkPage) {
      await page.goto(checkUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2000);
    }

    const pageTitle = await page.title();
    const bodyText  = await page.locator('body').innerText().catch(() => '');

    // Navigation present
    const hasNav = await page.locator('nav, header, [class*="nav"], [class*="header"], [class*="menu"]').count().catch(() => 0);
    components.push({ name: 'Navigation', status: hasNav > 0 ? 'operational' : 'degraded' });

    // Check for Softr error popups (invalid permissions, database missing, etc.)
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
      // Softr renders data in various ways — check all common patterns
      const rowCount = await page.locator([
        'table tbody tr',           // standard HTML table
        'table tr + tr',            // table rows after header
        '[class*="list-item"]',     // list blocks
        '[class*="record-row"]',    // record rows
        '[class*="sf-list"] > *',   // Softr list
        '[class*="records"] > *',   // records container
        '[class*="table-row"]',     // table row class
        '[class*="grid-row"]',      // grid row
        '[class*="data-row"]',      // data row
        'tbody tr',                 // any tbody rows
      ].join(', ')).count().catch(() => 0);

      // Also check if page has meaningful text content beyond just headers
      const pageText = await page.locator('body').innerText().catch(() => '');
      const hasMeaningfulContent = pageText.length > 200;

      components.push({
        name: 'Data loads',
        status: (rowCount > 0 || hasMeaningfulContent) ? 'operational' : 'down',
        detail: rowCount > 0 ? `${rowCount} record(s) found` : 'No rows detected',
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

// ── Email alert ───────────────────────────────────────────────────────────────
async function sendAlert(project, result) {
  if (!process.env.SENDGRID_API_KEY || !project.alertEmail) return;
  const failedComponents = (result.components || []).filter(c => c.status !== 'operational');
  const compText = failedComponents.length
    ? `\nFailed components:\n${failedComponents.map(c => `  ✗ ${c.name}`).join('\n')}`
    : '';
  await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: project.alertEmail }] }],
      from: { email: process.env.ALERT_FROM_EMAIL || 'monitor@noreply.com' },
      subject: `🚨 ${project.name} is ${result.status.toUpperCase()}`,
      content: [{ type: 'text/plain', value: `${project.name} is ${result.status.toUpperCase()}\nURL: ${project.url}\nResponse: ${result.responseMs}ms${compText}\n${result.error ? 'Error: '+result.error : ''}\nChecked: ${new Date().toUTCString()}` }],
    }),
  }).catch(e => console.error('Email alert failed:', e.message));
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log('🚀 System Status Health Monitor\n');
  console.log('📋 Loading projects from Airtable...');
  const projects = await fetchProjects();
  console.log(`   Found ${projects.length} project(s):`);
  projects.forEach(p => console.log(`   • [${p.type.toUpperCase()}] ${p.name}`));
  console.log('');

  const hasSoftr = projects.some(p => p.type === 'softr');
  const browser  = hasSoftr ? await chromium.launch() : null;
  const results  = [];

  for (const project of projects) {
    process.stdout.write(`Checking ${project.name} [${project.type}]... `);
    const result = project.type === 'softr'
      ? await softrCheck(project, browser)
      : await shopifyCheck(project);

    console.log(`${result.status.toUpperCase()} (${result.responseMs}ms)`);
    if (result.error) console.log(`  ⚠ ${result.error}`);
    if (result.components) {
      result.components.forEach(c => {
        const icon = c.status === 'operational' ? '✓' : '✗';
        console.log(`  ${icon} ${c.name}: ${c.status}`);
      });
    }
    if (result.status !== 'operational') await sendAlert(project, result);
    results.push({ ...project, checkedAt: new Date().toISOString(), ...result });
  }

  if (browser) await browser.close();

  const outDir = path.join(__dirname, '..', 'dashboard');
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
    await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `🚨 *Health Alert*\n${down.map(s => `❌ *${s.name}* is DOWN`).join('\n')}` }),
    }).catch(() => {});
  }

  console.log(`\n✅ Done. ${results.length} site(s) checked.`);
  if (down.length) process.exit(1);
})();
