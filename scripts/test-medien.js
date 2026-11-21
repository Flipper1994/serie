#!/usr/bin/env node
// Echte Auflösung und Range-Abruf eines öffentlichen Testvideos. Keine Token-Ausgabe.
// API_TOKEN=… TEST_BASIS=https://…/serie/ node scripts/test-medien.js
const assert = require('node:assert/strict');

async function main() {
  const basis = process.env.TEST_BASIS;
  const token = process.env.API_TOKEN;
  if (!basis || !token) throw new Error('TEST_BASIS und API_TOKEN müssen gesetzt sein');
  assert.equal((await fetch(new URL('health', basis))).status, 200);
  assert.equal((await fetch(new URL('video', basis))).status, 200);
  const quelle = process.env.TEST_VIDEO || 'https://archive.org/details/BigBuckBunny_124';
  const url = new URL('stream', basis);
  url.searchParams.set('url', quelle);
  const antwort = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(100000) });
  const daten = await antwort.json();
  if (antwort.status !== 200 || !daten.ok) throw new Error(`Videoauflösung fehlgeschlagen (${antwort.status}): ${daten.fehler || 'keine Details'}`);
  assert.ok(daten.medien && daten.mp4);
  const medien = await fetch(new URL(daten.medien, basis), { headers: { Range: 'bytes=0-299' }, signal: AbortSignal.timeout(30000) });
  assert.equal(medien.status, 206, 'Video muss mit Teilabruf erreichbar sein');
  assert.match(medien.headers.get('content-type') || '', /^video\//);
  assert.match(medien.headers.get('content-range') || '', /^bytes 0-299\//);
  assert.equal((await medien.arrayBuffer()).byteLength, 300);
  console.log(`OK: Health, Videoseite, echte ${daten.art}-Auflösung und Medien-Proxy (206, 300 Bytes)`);
  if (process.env.TEST_BROWSER_VIDEO === '1') {
    const { chromium } = require('playwright');
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      await context.addInitScript(({ token, ursprung }) => {
        if (location.origin === ursprung) localStorage.setItem('serienKatalog.token', token);
      }, { token, ursprung: new URL(basis).origin });
      const page = await context.newPage();
      const videoSeite = new URL('video', basis);
      videoSeite.searchParams.set('url', quelle);
      await page.goto(videoSeite.href, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.querySelector('video').readyState >= 2, null, { timeout: 90000 });
      const laeuft = await page.locator('video').evaluate((v) => ({ bereit: v.readyState, dauer: v.duration, fehler: v.error?.code || 0 }));
      assert.ok(laeuft.bereit >= 2 && laeuft.dauer > 0 && !laeuft.fehler);
      console.log('OK: Echte Videoseite lädt das aufgelöste Video im Chromium-Player');
    } finally { await browser.close(); }
  }
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
