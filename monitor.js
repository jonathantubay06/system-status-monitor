const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TOKEN   = process.env.AIRTABLE_TOKEN;
const TABLE            = 'Projects';

function slugify(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// ── Fetch projects from Airtable ──────────────────────────────────────────────
async function fetchProjects() {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${TABLE}?view=Grid%20view`;
  const res  = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
  });
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
  })).filter(p => p.name && p.url);
}

// ── HTTP check (Shopify) ──────────────────────────────────────────────────────
async function httpCheck(project) {
  const start = Date.now();
  try {
    const res = await fetch(project.url, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HealthMonitor/1.0)' },
    });
    return { status: res.ok ? 'operational' : 'degraded', responseMs: Date.now() - start, httpStatus: res.status };
  } catch (e) {
    return { status: 'down', responseMs: Date.now() - start, error: e.message };
  }
}

// ── Browser check (Softr magic link) ─────────────────────────────────────────
async function browserCheck(project, browser) {
  const start   = Date.now();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  });
  const page = await context.newPage();
  try {
    const response = await page.goto(project.url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    const pageTitle = await page.title();
    const bodyText  = await page.locator('body').innerText().catch(() => '');
    await context.close();
    const isError = /error|404|not found/i.test(pageTitle);
    if (bodyText.length < 100 || isError) {
      return { status: 'degraded', responseMs: Date.now() - start, pageTitle, note: 'Content may be missing' };
    }
    return { status: 'operational', responseMs: Date.now() - start, httpStatus: response?.status(), pageTitle };
  } catch (e) {
    await context.close().catch(() => {});
    return { status: 'down', responseMs: Date.now() - start, error: e.message };
  }
}

// ── Email alert (SendGrid) ────────────────────────────────────────────────────
async function sendAlert(project, result) {
  if (!process.env.SENDGRID_API_KEY || !project.alertEmail) return;
  await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: project.alertEmail }] }],
      from: { email: process.env.ALERT_FROM_EMAIL || 'monitor@noreply.com' },
      subject: `🚨 ${project.name} is DOWN`,
      content: [{ type: 'text/plain', value: `${project.name} is DOWN\nURL: ${project.url}\nResponse: ${result.responseMs}ms\n${result.error ? 'Error: '+result.error : ''}\nChecked: ${new Date().toUTCString()}` }],
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
      ? await browserCheck(project, browser)
      : await httpCheck(project);

    console.log(`${result.status.toUpperCase()} (${result.responseMs}ms)`);
    if (result.error)     console.log(`  ⚠ ${result.error}`);
    if (result.pageTitle) console.log(`  📄 ${result.pageTitle}`);
    if (result.status === 'down') await sendAlert(project, result);

    results.push({ ...project, checkedAt: new Date().toISOString(), ...result });
  }

  if (browser) await browser.close();

  // ── Save results ──────────────────────────────────────────────────────────
  const outDir = path.join(__dirname, '..', 'dashboard');
  fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(
    path.join(outDir, 'status.json'),
    JSON.stringify({ updatedAt: new Date().toISOString(), results }, null, 2)
  );

  const histFile = path.join(outDir, 'history.json');
  let history = [];
  if (fs.existsSync(histFile)) { try { history = JSON.parse(fs.readFileSync(histFile, 'utf8')); } catch {} }
  history.push({ timestamp: new Date().toISOString(), results });
  if (history.length > 672) history = history.slice(-672); // 7 days at 15min
  fs.writeFileSync(histFile, JSON.stringify(history, null, 2));

  // ── Slack alert ───────────────────────────────────────────────────────────
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
