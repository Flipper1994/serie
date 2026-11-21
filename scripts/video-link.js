#!/usr/bin/env node
// Findet die Videoadresse hinter einer beliebigen Videoseite: öffnet die Seite
// im Headless-Browser, startet den Player und liest mit, was er lädt. Gedacht
// als Rückfall für Anbieter, die yt-dlp nicht kennt.
//
// Aufruf:   node video-link.js <Link>
// Ausgabe:  JSON auf stdout: { ok, url, art (datei|hls), titel, referer }
// Rückgabe: 0 Erfolg, 1 kein Video gefunden oder falscher Aufruf, 2 technischer Fehler

const { chromium } = require('playwright');

const AGENT = process.env.MEDIEN_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SUCHZEIT_MS = Number(process.env.VIDEO_SUCHZEIT_MS || 25000);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function suchen(link) {
  // Filemoon liefert im Katalog die Download-Seite; der Player liegt unter /e/.
  const adresse = new URL(link);
  if (/^(www\.)?filemoon\.to$/i.test(adresse.hostname) && /^\/d\/[a-z0-9]+\/?$/i.test(adresse.pathname)) {
    adresse.pathname = adresse.pathname.replace(/^\/d\//, '/e/');
    link = adresse.href;
  }
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  try {
    const context = await browser.newContext({
      userAgent: AGENT, viewport: { width: 1280, height: 720 }, locale: 'de-DE', ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    // Werbefenster, die ein Klick öffnet, gleich wieder schließen.
    context.on('page', (neu) => { if (neu !== page) neu.close().catch(() => {}); });

    const listen = [];   // HLS-Wiedergabelisten in der Reihenfolge des Ladens
    const dateien = [];  // durchgehende Videodateien mit Größe
    context.on('response', (antwort) => {
      const url = antwort.url();
      if (!/^https?:/.test(url) || antwort.status() >= 400) return;
      const kopf = antwort.headers();
      const typ = kopf['content-type'] || '';
      let pfad = '';
      try { pfad = new URL(url).pathname; } catch { return; }
      const referer = antwort.request().headers().referer || '';
      if (/mpegurl/i.test(typ) || /\.m3u8$/i.test(pfad)) {
        listen.push({ url, referer });
      } else if (/^video\//i.test(typ) || /\.(mp4|webm|mkv)$/i.test(pfad)) {
        if (/mp2t/i.test(typ) || /\.ts$/i.test(pfad)) return;   // HLS-Teilstück, keine ganze Datei
        const gesamt = Number((kopf['content-range'] || '').split('/')[1]) || Number(kopf['content-length']) || 0;
        dateien.push({ url, referer, groesse: gesamt });
      }
    });

    await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const ende = Date.now() + SUCHZEIT_MS;
    let versuch = 0;
    while (Date.now() < ende) {
      await pause(1500);
      // Eine Wiedergabeliste ist eindeutig; bei Dateien kurz warten, ob noch
      // eine größere kommt (vorgeschaltete Werbung ist klein).
      if (listen.length || dateien.some((d) => d.groesse > 5 * 1024 * 1024)) break;
      if (dateien.length && versuch >= 4) break;
      versuch++;
      // Player anstoßen: Videos in allen Rahmen starten, sonst in die Mitte tippen.
      for (const rahmen of page.frames()) {
        await rahmen.evaluate(() => {
          for (const v of document.querySelectorAll('video')) { v.muted = true; v.play().catch(() => {}); }
        }).catch(() => {});
      }
      await page.mouse.click(640, 360).catch(() => {});
    }
    await pause(500);

    const titel = (await page.title().catch(() => '')).trim().slice(0, 200);
    if (listen.length) return { ok: true, art: 'hls', titel, ...listen[0], referer: listen[0].referer || page.url() };
    if (dateien.length) {
      const beste = dateien.sort((a, b) => b.groesse - a.groesse)[0];
      return { ok: true, art: 'datei', titel, url: beste.url, referer: beste.referer || page.url() };
    }
    return { ok: false, fehler: 'Auf der Seite wurde kein Video gefunden' };
  } finally {
    await browser.close().catch(() => {});
  }
}

(async () => {
  const link = process.argv[2] || '';
  if (!/^https?:\/\//i.test(link)) {
    console.log(JSON.stringify({ ok: false, fehler: 'Aufruf: node video-link.js <Link>' }));
    process.exitCode = 1;
    return;
  }
  try {
    const ergebnis = await suchen(link);
    console.log(JSON.stringify(ergebnis));
    process.exitCode = ergebnis.ok ? 0 : 1;
  } catch (fehler) {
    console.log(JSON.stringify({ ok: false, fehler: String(fehler.message).split('\n')[0].slice(0, 200) }));
    process.exitCode = 2;
  }
})();
