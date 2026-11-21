#!/usr/bin/env node
// Echte Oberfläche, echter Anbieter, echte Videoframes; keine nachgebildeten Antworten.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

(async () => {
  const basis = process.env.TEST_BASIS || 'http://127.0.0.1:18081/';
  const token = process.env.API_TOKEN;
  if (!token) throw new Error('API_TOKEN fehlt');
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await context.addInitScript(({ token, origin }) => {
      try { if (location.origin === origin) localStorage.setItem('serienKatalog.token', token); } catch {}
      document.addEventListener('DOMContentLoaded', () => { const v = document.querySelector('video'); if (v) v.muted = true; });
    }, { token, origin: new URL(basis).origin });
    const page = await context.newPage();
    await page.goto(`${basis}?serie=${encodeURIComponent(process.env.TEST_SERIE || 'Furious')}&staffel=1`);
    const name = process.env.TEST_ANBIETER || 'VOE';
    const link = page.getByRole('link', { name, exact: true }).nth(Number(process.env.TEST_FOLGEN_INDEX || 0));
    await link.waitFor({ timeout: 90000 });
    const neuerTab = context.waitForEvent('page');
    const start = Date.now();
    await link.click();
    const tab = await neuerTab;
    let wartend = 0;
    const phasen = new Set();
    tab.on('response', async (r) => {
      if (!r.url().includes('/stream?')) return;
      if (r.status() === 202) wartend++;
      try { const d = await r.json(); if (d.fortschritt) phasen.add(d.fortschritt.phase); } catch {}
    });
    await Promise.race([
      tab.locator('#spieler').waitFor({ state: 'visible', timeout: 12 * 60 * 1000 }),
      tab.locator('#meldung.fehler').waitFor({ state: 'visible', timeout: 12 * 60 * 1000 }).then(async () => { throw new Error(await tab.locator('#meldung').textContent()); }),
    ]);
    await tab.locator('#video').evaluate((v) => { v.muted = true; return v.play().catch(() => {}); });
    await tab.waitForFunction(() => {
      const v = document.querySelector('video');
      return v.readyState >= 2 && v.videoWidth > 0 && v.currentTime > 1;
    }, null, { timeout: 90000 });
    const stand = await tab.locator('#video').evaluate((v) => ({ zeit: v.currentTime, breite: v.videoWidth, dauer: v.duration }));
    assert.ok(stand.breite > 0 && stand.dauer > 10);
    assert.equal(await tab.locator('#anbieterSchritt').isVisible(), false);
    assert.equal(context.pages().length, 2);
    await tab.locator('#ladeTitel').filter({ hasText: 'Video läuft' }).waitFor({ timeout: 10000 });
    if (process.env.TEST_SCREENSHOT) await tab.screenshot({ path: process.env.TEST_SCREENSHOT, fullPage: true });
    console.log(JSON.stringify({ ok: true, anbieter: name, ladeSekunden: Math.round((Date.now() - start) / 1000), phasen: [...phasen], polling: wartend, ...stand }));
  } finally { await browser.close(); }
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
