// Ausschließlich Playmogo; andere Hoster behalten ihren bisherigen Resolver.
const fs = require('node:fs');

function istPlaymogo(link) {
  try { return /^(www\.)?playmogo\.com$/i.test(new URL(link).hostname); } catch { return false; }
}

async function istSchutzseite(page) {
  const text = `${await page.title().catch(() => '')} ${(await page.locator('body').innerText({ timeout: 1000 }).catch(() => '')).slice(0, 3000)}`;
  return /just a moment|nur einen moment|security verification|sicherheitsüberprüfung|checking your browser|verify you are human/i.test(text);
}

async function suchen(link, optionen = {}) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  try {
    const datei = process.env.PLAYMOGO_SITZUNG_DATEI;
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 }, locale: 'de-DE',
      ...(datei ? { storageState: datei } : {}),
    });
    // Nur Tests verwenden diese Vorbereitung zum Nachbilden der Hoster-Antworten.
    if (optionen.vorbereiten) await optionen.vorbereiten(context);
    const page = await context.newPage();
    context.on('page', (p) => { if (p !== page) p.close().catch(() => {}); });
    const quellen = [];
    context.on('response', (r) => {
      if (!/^https?:/.test(r.url()) || r.status() >= 400) return;
      const typ = r.headers()['content-type'] || '';
      const pfad = new URL(r.url()).pathname;
      const hls = /mpegurl/i.test(typ) || /\.m3u8$/i.test(pfad);
      // Keine HTML-Fehlerseite unter einer MP4-Adresse und keine HLS-Segmente.
      if (/html|javascript|mp2t/i.test(typ) || /\.(ts|m4s)$/i.test(pfad)) return;
      if (!hls && !/^video\//i.test(typ) && !(/octet-stream/i.test(typ) && /\.(mp4|webm)$/i.test(pfad))) return;
      quellen.push({ url: r.url(), art: hls ? 'hls' : 'datei', referer: r.request().headers().referer || page.url() });
    });
    const adresse = new URL(link);
    // /d/ ist die Downloadseite, /e/ öffnet den eingebetteten Player.
    adresse.pathname = adresse.pathname.replace(/^\/d\//, '/e/');
    await page.goto(adresse.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const ende = Date.now() + (optionen.suchzeit || 35000);
    let schutz = false;
    while (Date.now() < ende) {
      schutz = await istSchutzseite(page);
      if (quellen.length) {
        const quelle = quellen.find((q) => q.art === 'hls') || quellen[0];
        return { ok: true, ...quelle, titel: (await page.title()).slice(0, 200),
          cookies: await context.cookies(), userAgent: await page.evaluate(() => navigator.userAgent) };
      }
      // Eine Schutzprüfung normal abwarten; keine Klicks in die Challenge.
      if (!schutz) {
        for (const frame of page.frames()) {
          if (/challenges\.cloudflare\.com/.test(frame.url())) continue;
          await frame.evaluate(() => {
            for (const v of document.querySelectorAll('video')) { v.muted = true; v.play().catch(() => {}); }
          }).catch(() => {});
          const play = frame.locator('.vjs-big-play-button, .jw-icon-display, .plyr__control--overlaid, #play-button, button[aria-label="Play"], button[title="Play"]');
          const knopf = play.first();
          if (await knopf.isVisible().catch(() => false)) await knopf.click({ timeout: 700 }).catch(() => {});
        }
        await page.mouse.click(640, 360).catch(() => {});
      }
      await page.waitForTimeout(700);
    }
    return { ok: false, fehler: schutz
      ? 'Playmogo: Cloudflare blockiert den Server-Browser. Eine gültige Sitzung auf demselben Server ist erforderlich (PLAYMOGO_SITZUNG_DATEI).'
      : 'Playmogo: Im Player wurde keine abspielbare MP4-/HLS-Quelle gefunden' };
  } catch (e) {
    return { ok: false, fehler: `Playmogo: ${String(e.message).split('\n')[0].slice(0, 300)}` };
  } finally { await browser.close(); }
}

// Einmalige manuelle Browserprüfung, z. B. über SSH mit X11-Weiterleitung.
async function sitzungSpeichern(link, datei) {
  if (!istPlaymogo(link) || !datei) throw new Error('Aufruf: node scripts/playmogo.js <Playmogo-Link> <Sitzungsdatei>');
  const { chromium } = require('playwright');
  const readline = require('node:readline/promises');
  const browser = await chromium.launch({ headless: false });
  const eingabe = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const context = await browser.newContext({ locale: 'de-DE', ...(fs.existsSync(datei) ? { storageState: datei } : {}) });
    const page = await context.newPage();
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    await eingabe.question('Prüfung im Browser abschließen und Video starten. Danach hier Enter drücken. ');
    if (await istSchutzseite(page)) throw new Error('Cloudflare-Prüfung ist noch nicht abgeschlossen');
    // Datei nie mit allgemein lesbaren Rechten erzeugen.
    const state = await context.storageState();
    fs.writeFileSync(datei, JSON.stringify(state), { mode: 0o600 });
    fs.chmodSync(datei, 0o600);
    console.log('Sitzung gespeichert. Sie muss vom Dienstbenutzer lesbar sein.');
  } finally { eingabe.close(); await browser.close(); }
}

module.exports = { istPlaymogo, suchen };
if (require.main === module) sitzungSpeichern(process.argv[2], process.argv[3]).catch((e) => { console.error(e.message); process.exitCode = 1; });
