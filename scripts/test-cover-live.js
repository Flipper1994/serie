#!/usr/bin/env node
// Echte ausgelieferte UI, echtes Register und echte Coverquelle; nur lesend.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');

async function main() {
  const token = process.env.API_TOKEN;
  if (!token || !process.env.TEST_BASIS) throw new Error('Konfiguration fehlt');
  const basis = new URL(process.env.TEST_BASIS.replace(/\/?$/, '/'));
  if (!['http:', 'https:'].includes(basis.protocol) || basis.username || basis.password) throw new Error('Ungültige Basis');
  const browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER_EXECUTABLE || undefined });
  try {
    for (const breite of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width: breite, height: 900 }, hasTouch: breite < 768 });
      try {
        await context.addInitScript((wert) => localStorage.setItem('serienKatalog.token', wert), token);
        const page = await context.newPage();
        let skriptfehler = 0;
        page.on('pageerror', () => skriptfehler++);
        const antwort = await page.goto(basis.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
        assert.ok(antwort?.ok());
        await page.locator('.start-ansicht').waitFor({ timeout: 45000 });
        const ersteKarte = page.locator('.serien-zeile').first();
        await ersteKarte.waitFor({ state: 'visible', timeout: 30000 });
        await ersteKarte.scrollIntoViewIfNeeded();
        await page.waitForFunction(() => {
          const bild = document.querySelector('.serien-zeile .poster-bild');
          return bild?.complete && bild.naturalWidth > 0 && bild.parentElement.classList.contains('mit-cover');
        }, null, { timeout: 30000 });
        assert.ok(await ersteKarte.locator('.poster-bild').isVisible());
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.equal(skriptfehler, 0);
        if (process.env.TEST_SCREENSHOTS || process.env.TEST_SCREENSHOT_DIR) {
          const ordner = process.env.TEST_SCREENSHOT_DIR || os.tmpdir();
          fs.mkdirSync(ordner, { recursive: true });
          await page.screenshot({ path: path.join(ordner, `flipperflix-cover-${breite}.png`), fullPage: true });
        }
        console.log(`OK: Live-Cover ${breite}px sichtbar geladen, kein horizontaler Überlauf, keine Skriptfehler.`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
}
main().catch(() => { console.error('Live-Cover-Test fehlgeschlagen. Anmeldung, Deployment und echte Coverquelle prüfen.'); process.exitCode = 1; });
