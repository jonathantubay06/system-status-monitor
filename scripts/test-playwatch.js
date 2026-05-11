// scripts/test-playwatch.js — Local test runner for Kingdomland Playwatch only
// Run: node scripts/test-playwatch.js
// This loads the same customCheck logic from monitor.js but only runs it for Playwatch.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Read the current Playwatch config from status.json so we use real credentials
const statusPath = path.join(__dirname, '..', 'dashboard', 'status.json');
const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
const project = status.results.find(r => r.id === 'kingdomland-playwatch');

if (!project) {
  console.error('❌ Kingdomland Playwatch not found in status.json');
  process.exit(1);
}

console.log('═══════════════════════════════════════════════');
console.log('Testing:', project.name);
console.log('URL:    ', project.url);
console.log('Email:  ', project.loginEmail);
console.log('═══════════════════════════════════════════════\n');

// ─── Inline customCheck (copied from monitor.js) ─────────────────────────────
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
    console.log('→ Loading login page...');
    const response = await page.goto(project.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    const httpOk = response?.status() < 400;
    console.log(`  HTTP ${response?.status()} — ${httpOk ? 'OK' : 'FAIL'}`);
    components.push({ name: 'Page loads', status: httpOk ? 'operational' : 'degraded' });
    if (!httpOk) { await context.close(); return { status: 'down', responseMs: Date.now() - start, components }; }

    const email    = project.loginEmail    || process.env.PLAYWATCH_EMAIL;
    const password = project.loginPassword || process.env.PLAYWATCH_PASSWORD;
    if (!email || !password) {
      components.push({ name: 'Login', status: 'degraded', detail: 'No credentials configured' });
    } else {
      console.log('→ Waiting for form to hydrate...');
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForSelector('input[type="password"]', { timeout: 15000 }).catch(() => {});

      console.log('→ Finding email field...');
      const emailSelectors = [
        'input[type="email"]',
        'input[name*="email" i]',
        'input[placeholder*="email" i]',
        'input[id*="email" i]',
        'input[type="text"]:not([type="password"])',
      ];
      let emailInput = null;
      let matchedSelector = null;
      for (const sel of emailSelectors) {
        const loc = page.locator(sel).first();
        if (await loc.count().catch(() => 0) > 0) { emailInput = loc; matchedSelector = sel; break; }
      }
      if (!emailInput) {
        components.push({ name: 'Login', status: 'down', detail: 'Email field not found' });
        await context.close();
        return { status: 'down', responseMs: Date.now() - start, error: 'Email field not found', components };
      }
      console.log(`  Found with: ${matchedSelector}`);

      console.log('→ Filling email...');
      await emailInput.click({ force: true });
      await emailInput.fill('');
      await emailInput.fill(email);
      await page.waitForTimeout(300);

      console.log('→ Filling password...');
      const passInput = page.locator('input[type="password"]').first();
      await passInput.click({ force: true });
      await passInput.fill('');
      await passInput.fill(password);
      await page.waitForTimeout(300);

      console.log('→ Submitting form...');
      const beforeUrl = page.url();
      await passInput.press('Enter');

      const navigated = await page.waitForURL(url => url.toString() !== beforeUrl, { timeout: 12000 })
        .then(() => true).catch(() => false);
      console.log(`  Navigated via Enter: ${navigated}, URL: ${page.url()}`);

      if (!navigated && page.url() === beforeUrl) {
        console.log('  → Enter didn\'t submit, trying Log In button...');
        const logInBtn = page.locator('button').filter({ hasText: /^Log In$/i }).last();
        if (await logInBtn.count().catch(() => 0) > 0) {
          await logInBtn.click({ force: true }).catch(() => {});
          await page.waitForURL(url => url.toString() !== beforeUrl, { timeout: 12000 }).catch(() => {});
          console.log(`  After button click, URL: ${page.url()}`);
        }
      }

      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(1500);

      const currentUrl = page.url();
      console.log(`  Current URL: ${currentUrl}`);
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
      console.log('  ✓ Login successful');

      await page.waitForSelector('text=/who.?s.?watching|pick a kid|select.*profile/i', { timeout: 3000 }).catch(() => {});
      const refreshedUrl = page.url();
      const refreshedBody = await page.locator('body').innerText().catch(() => '');
      const isProfileSelection = /child-profile-selection|profile-select|who.?s.?watching|pick a kid/i.test(refreshedUrl + ' ' + refreshedBody);
      console.log(`  isProfileSelection: ${isProfileSelection} (URL: ${refreshedUrl}, body has "who's watching": ${/who.?s.?watching/i.test(refreshedBody)})`);

      if (isProfileSelection) {
        console.log('→ Profile selection page detected...');
        const profileSelectors = [
          'div[class*="profile-card"]',
          'div[class*="profileCard"]',
          'button[class*="profile"]',
          'div[class*="ProfileCard"]',
          '[role="button"][class*="kid"]',
          'img[alt*="avatar" i]',
          'main button, main [role="button"], main a[href*="profile"]',
          'main img:not([alt*="logo" i]):not([alt*="banner" i])',
        ];
        let profileCard = null;
        let profileSelector = null;
        for (const sel of profileSelectors) {
          const loc = page.locator(sel).first();
          const count = await loc.count().catch(() => 0);
          if (count > 0 && await loc.isVisible().catch(() => false)) {
            profileCard = loc;
            profileSelector = sel;
            break;
          }
        }
        if (profileCard) {
          console.log(`  Clicking profile (found with: ${profileSelector})`);
          await profileCard.click({ force: true }).catch(() => {});
          await page.waitForFunction(
            () => !/who.?s.?watching|pick a kid/i.test(document.body.innerText),
            { timeout: 10000 }
          ).catch(() => {});
          await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
          await page.waitForTimeout(1500);
          console.log(`  → After profile click, URL: ${page.url()}`);
        } else {
          console.log('  ! No profile card found');
        }
      }
    }

    console.log('→ Checking navigation...');
    await page.waitForSelector('nav, header, [role="navigation"], [role="banner"]', { timeout: 5000 }).catch(() => {});
    const hasNav = await page.locator([
      'nav','header','[role="navigation"]','[role="banner"]',
      '[class*="nav"]','[class*="header"]','[class*="menu"]','[class*="sidebar"]',
      'a[href="/"]',
    ].join(', ')).count().catch(() => 0);
    console.log(`  Nav element count: ${hasNav}`);
    components.push({ name: 'Navigation', status: hasNav > 0 ? 'operational' : 'degraded' });

    console.log('→ Checking for errors...');
    const pageText = await page.locator('body').innerText().catch(() => '');
    const errorPatterns = [/something went wrong/i, /internal server error/i, /access denied/i, /page not found/i];
    const errorFound = errorPatterns.find(re => re.test(pageText));
    components.push({ name: 'No errors', status: errorFound ? 'down' : 'operational', detail: errorFound ? String(errorFound) : null });

    // Take a final screenshot for visual confirmation
    const screenshotPath = path.join(__dirname, '..', 'test-playwatch-final.png');
    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`\n📸 Screenshot saved: ${screenshotPath}`);

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

// ─── Run the test ────────────────────────────────────────────────────────────
(async () => {
  const browser = await chromium.launch({ headless: true });
  const result = await customCheck(project, browser);
  await browser.close();

  console.log('\n═══════════════════════════════════════════════');
  console.log('RESULT:', result.status.toUpperCase(), `(${result.responseMs}ms)`);
  console.log('═══════════════════════════════════════════════');
  if (result.error) console.log(`Error: ${result.error}`);
  console.log('\nComponents:');
  result.components.forEach(c => {
    const icon = c.status === 'operational' ? '✓' : c.status === 'degraded' ? '○' : '✗';
    console.log(`  ${icon} ${c.name}: ${c.status}${c.detail ? ' — ' + c.detail : ''}`);
  });
  process.exit(result.status === 'operational' ? 0 : 1);
})();
