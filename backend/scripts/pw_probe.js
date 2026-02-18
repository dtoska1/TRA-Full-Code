// backend/scripts/pw_probe.js
'use strict';

const { chromium } = require('playwright');

const url = process.argv[2];
if (!url) {
  console.error('Usage: node scripts/pw_probe.js <url>');
  process.exit(1);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    locale: 'sq-AL',
  });

  const page = await context.newPage();

  // Helps with many WAFs without doing anything shady:
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'sq-AL,sq;q=0.9,en-US;q=0.8,en;q=0.7',
  });

  let status = null;
  let finalUrl = url;

  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    status = resp ? resp.status() : null;
    finalUrl = page.url();

    // Give SPAs a moment to render links
    await page.waitForTimeout(2500);

    const links = await page.$$eval('a', (as) =>
      as
        .map((a) => ({
          text: (a.textContent || '').replace(/\s+/g, ' ').trim(),
          href: a.href || a.getAttribute('href') || '',
        }))
        .filter((x) => x.href)
        .slice(0, 50)
    );

    const docLinks = links.filter((l) =>
      /\.(pdf|docx?|xlsx?|pptx?)($|\?)/i.test(l.href)
    );

    console.log(JSON.stringify({ status, finalUrl, linksCount: links.length, docLinks }, null, 2));
  } catch (e) {
    console.error('Playwright error:', e.message || e);
    console.log(JSON.stringify({ status, finalUrl }, null, 2));
    process.exitCode = 2;
  } finally {
    await browser.close();
  }
})();
