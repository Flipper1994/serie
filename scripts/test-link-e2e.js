#!/usr/bin/env node
// Live-E2E: echte /video-Seite, echter Resolver, Medien-Proxy, Frames und Vorspulen.
// API_TOKEN=… TEST_BASIS=http://127.0.0.1:8080/ node scripts/test-link-e2e.js [URL]
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

async function main() {
  const token = process.env.API_TOKEN;
  const basis = new URL(process.env.TEST_BASIS || 'http://127.0.0.1:8080/');
  if (!basis.pathname.endsWith('/')) basis.pathname += '/';
  if (!token) throw new Error('API_TOKEN fehlt');
  const quelle = process.argv[2] || process.env.TEST_VIDEO || 'https://playmogo.com/d/onlyy2irbz99';
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  let page;
  const start = Date.now();
  try {
    const context = await browser.newContext();
    await context.addInitScript(({ token, origin }) => {
      if (location.origin === origin) localStorage.setItem('serienKatalog.token', token);
      document.addEventListener('DOMContentLoaded', () => { const v = document.querySelector('video'); if (v) v.muted = true; });
    }, { token, origin: basis.origin });
    page = await context.newPage();
    let daten;
    const seitenFehler = [];
    page.on('pageerror', (e) => seitenFehler.push(e.message));
    page.on('response', async (r) => {
      if (new URL(r.url()).pathname === new URL('stream', basis).pathname) {
        try { const d = await r.json(); if (d.ok) daten = d; } catch {}
      }
    });
    const seite = new URL('video', basis);
    seite.searchParams.set('url', quelle);
    console.log('1/4: Öffne /video mit dem echten Anbieterlink');
    await page.goto(seite.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return (v && v.videoWidth > 0 && v.readyState >= 2) || !!document.querySelector('#meldung.fehler:not([hidden])');
    }, null, { timeout: 250000 });
    const meldung = page.locator('#meldung.fehler:not([hidden])');
    if (await meldung.count()) throw new Error(await meldung.innerText());
    assert.ok(daten?.ok && daten.mp4 && daten.medien, 'UI muss eine echte Stream-Antwort erhalten');
    if (process.env.TEST_ERWARTE_MP4 === '1') assert.equal(daten.art, 'datei', 'Es wird ausdrücklich MP4 erwartet');
    console.log(`2/4: Quelle aufgelöst (${daten.art}); prüfe Medien-Proxy`);
    // Signierte Medienadresse muss ohne Authorization funktionieren (Chromecast).
    const antwort = await fetch(new URL(daten.medien, basis), {
      headers: { Range: 'bytes=0-299' }, signal: AbortSignal.timeout(30000),
    });
    if (daten.art === 'datei') {
      assert.equal(antwort.status, 206, 'MP4-Teilabruf muss HTTP 206 liefern');
      assert.match(antwort.headers.get('content-range') || '', /^bytes 0-299\//);
      const bytes = Buffer.from(await antwort.arrayBuffer());
      assert.equal(bytes.length, 300);
      if (process.env.TEST_ERWARTE_MP4 === '1') assert.equal(bytes.subarray(4, 8).toString(), 'ftyp', 'ISO-MP4-Dateikopf');
    } else {
      assert.equal(antwort.status, 200);
      assert.match(await antwort.text(), /^#EXTM3U/);
    }
    console.log('3/4: Prüfe echte Videoframes und laufende Wiedergabe');
    await page.locator('video').evaluate((v) => { v.muted = true; return v.play(); });
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return v.videoWidth > 0 && v.currentTime > 1 && !v.paused && !v.error;
    }, null, { timeout: 45000 });
    const ziel = await page.locator('video').evaluate((v) => {
      if (!Number.isFinite(v.duration) || v.duration <= 3) throw new Error('Videodauer fehlt oder ist zu kurz');
      const ziel = Math.min(v.duration / 2, 10);
      v.currentTime = ziel;
      return ziel;
    });
    await page.waitForFunction((ziel) => {
      const v = document.querySelector('video');
      return !v.seeking && !v.error && v.currentTime > ziel + 0.3 && v.readyState >= 2;
    }, ziel, { timeout: 45000 });
    const stand = await page.locator('video').evaluate((v) => ({ breite: v.videoWidth, dauer: Math.round(v.duration), position: Math.round(v.currentTime) }));
    assert.deepEqual(seitenFehler, [], 'Keine JavaScript-Fehler in /video');
    assert.equal(context.pages().length, 1, 'Keine Werbetabs im Client');
    assert.equal(await page.locator('#anbieterSchritt').isVisible(), false);
    console.log(`4/4: OK – Frames, Wiedergabe und Vorspulen; ${JSON.stringify({ art: daten.art, sekunden: Math.round((Date.now() - start) / 1000), ...stand })}`);
  } catch (e) {
    if (page && process.env.TEST_SCREENSHOT) await page.screenshot({ path: process.env.TEST_SCREENSHOT, fullPage: true }).catch(() => {});
    throw e;
  } finally { await browser.close(); }
}
main().catch((e) => { console.error(`E2E FEHLGESCHLAGEN: ${e.message}`); process.exitCode = 1; });
