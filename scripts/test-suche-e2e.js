// Echte UI-Suche: Kurzname ohne Apostroph findet Grey's Anatomy.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
  const basis = process.env.TEST_BASIS;
  const token = process.env.API_TOKEN;
  if (!basis || !token) throw new Error('TEST_BASIS und API_TOKEN fehlen');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.addInitScript(({ token, origin }) => { try { if (location.origin === origin) localStorage.setItem('serienKatalog.token', token); } catch {} }, { token, origin: new URL(basis).origin });
    await page.goto(basis);
    await page.locator('#serie').fill('Greys anatomy');
    await page.locator('#los').click();
    await page.locator('#ausgabe h2.titel').waitFor({ timeout: 90000 });
    const titel = await page.locator('#ausgabe h2.titel').textContent();
    assert.match(titel, /Grey.?s Anatomy/i);
    assert.ok(await page.locator('.stream-button[href]').count() > 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    console.log(JSON.stringify({ ok: true, suche: 'Greys anatomy', titel }));
  } finally { await browser.close(); }
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
