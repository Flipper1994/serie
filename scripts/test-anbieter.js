#!/usr/bin/env node
// Katalog-Klick → neuer Tab → asynchrone Freigabe → Videoplayer.
const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium, webkit } = require('playwright');
const anbieter = 'https://burningseries.ac/serie/Test/1/1-Test/de/VOE';
const katalog = {
  ok: true, serie: { titel: 'Eine Serie mit langem Titel für kleine Bildschirme', staffeln: ['1', '2'], sprachen: [], infos: {} },
  staffel: { nummer: 1, folgen: [{ nummer: 1, titel: 'Eine lange erste Folge für kleine Bildschirme', hoster: ['VOE', 'Vidmoly', 'Filemoon'].map((title) => ({ title, href: anbieter.replace('/VOE', `/${title}`) })) }] },
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const frei = net.createServer();
  await new Promise((r) => frei.listen(0, '127.0.0.1', r));
  const port = frei.address().port;
  await new Promise((r) => frei.close(r));
  const basis = `http://127.0.0.1:${port}/`;
  const dienst = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), API_TOKEN: 'test' }, stdio: ['ignore', 'ignore', 'inherit'],
  });
  let browser;
  try {
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${basis}health`).then((r) => r.ok).catch(() => false)) break;
      if (i === 99) throw new Error('Testdienst startet nicht');
      await pause(100);
    }
    browser = await (process.env.TEST_BROWSER === 'webkit' ? webkit : chromium).launch();
    for (const breite of [320, 390, 412, 768, 1440]) for (const farbe of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width: breite, height: 850 }, hasTouch: breite < 768, colorScheme: farbe });
      const fehler = [];
      context.on('page', (p) => p.on('pageerror', (e) => fehler.push(e.message)));
      await context.addInitScript(() => { try { localStorage.setItem('serienKatalog.token', 'test'); } catch {} });
      let anfragen = 0;
      let pruefungFreigegeben = false;
      let videoFreigegeben = false;
      await context.route('**/katalog?**', (r) => r.fulfill({ json: katalog }));
      await context.route('**/gesehen', (r) => r.fulfill({ json: { ok: true, serien: [] } }));
      await context.route('**/stream?**', (r) => {
        assert.equal(new URL(r.request().url()).searchParams.get('url'), anbieter);
        assert.equal(r.request().headers().authorization, 'Bearer test');
        anfragen++;
        const jetzt = Date.now();
        if (!videoFreigegeben) return r.fulfill({ status: 202, json: { ok: false, wartend: true, fortschritt: {
          phase: pruefungFreigegeben ? 'pruefung' : 'warteschlange', vorDir: 1,
          detail: 'Bilder werden geprüft', versuch: 2, maxVersuche: 3, runde: 4, versuchSeit: jetzt - 20000, versuchLimit: 180,
          begonnen: jetzt - 64000, phaseSeit: jetzt - 20000, aktualisiert: jetzt, serverZeit: jetzt,
          verlauf: [{ phase: 'cache', zeit: jetzt - 64000, detail: 'Noch keine Freigabe' }, { phase: 'pruefung', zeit: jetzt - 20000, detail: 'Bilder werden geprüft' }],
        } } });
        return r.fulfill({ json: { ok: true, titel: 'Testvideo', art: 'datei', mp4: 'https://example.com/video.mp4', medien: 'medien?test=1' } });
      });
      await context.route('**/medien?**', (r) => r.abort());
      await context.route('https://www.gstatic.com/**', (r) => r.abort());
      const page = await context.newPage();
      await page.goto(`${basis}?serie=Test&staffel=1`);
      await page.waitForSelector('.stream-button[href]');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Katalog ohne Überlauf bei ${breite}px`);
      const flaechen = await page.locator('.stream-button, .folge-kopf, .haken-feld').evaluateAll((nodes) => nodes.map((e) => e.getBoundingClientRect().height));
      assert.ok(flaechen.every((h) => h >= 44));
      for (const name of ['VOE', 'Vidmoly', 'Filemoon']) {
        const href = await page.getByRole('link', { name, exact: true }).getAttribute('href');
        assert.equal(new URL(href).searchParams.get('url'), anbieter.replace('/VOE', `/${name}`));
      }
      const neuerTab = context.waitForEvent('page');
      await page.getByRole('link', { name: 'VOE', exact: true }).click();
      const tab = await neuerTab;
      await tab.locator('#ladeDetail').filter({ hasText: '1 Freigabe vor dir' }).waitFor();
      pruefungFreigegeben = true;
      await tab.locator('#ladeTitel').filter({ hasText: 'Sicherheitsprüfung läuft' }).waitFor();
      assert.match(await tab.locator('#ladeVersuch').textContent(), /Versuch 2 von 3 · Bildrunde 4/);
      assert.match(await tab.locator('#ladeGesamt').textContent(), /^1:/);
      assert.equal(await tab.locator('[data-schritt="pruefung"]').getAttribute('data-status'), 'aktiv');
      assert.ok(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Statusanzeige ohne Überlauf');
      videoFreigegeben = true;
      await tab.locator('#spieler').waitFor({ state: 'visible', timeout: 15000 });
      assert.equal(await tab.locator('#titel').textContent(), 'Testvideo');
      assert.ok(anfragen >= 3, '202 wird bis zur Freigabe abgefragt');
      await tab.locator('#ladeTitel').filter({ hasText: 'Laden unterbrochen' }).waitFor();
      assert.match(await tab.locator('#ladeDetail').textContent(), /Player konnte das Video nicht laden/);
      assert.equal(await tab.locator('#anbieterSchritt').isVisible(), false);
      assert.ok(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(fehler, []);
      assert.equal(context.pages().length, 2, 'Nur ein neuer Videotab');
      await context.close();
      console.log(`OK: ${breite}px ${farbe}, Anbieter-Klick, Polling und Player ohne Erweiterung`);
    }
  } finally {
    if (browser) await browser.close();
    dienst.kill();
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
