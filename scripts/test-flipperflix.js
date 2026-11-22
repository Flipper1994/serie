// Oberfläche und echte Persistenz in einem isolierten Testregister.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { chromium, webkit } = require('playwright');
const katalog = {
  ok: true, serie: { titel: "Grey's Anatomy | Die jungen Aerzte (2005)", bild: 'https://burningseries.ac/public/img/cover/test.png', staffeln: ['1', '2'], sprachen: ['Deutsch'], beschreibung: 'Eine Serie über das Leben im Krankenhaus.', infos: {} },
  staffel: { nummer: 1, folgen: [1, 2, 3].map((nummer) => ({ nummer, titel: `Folge ${nummer}`, hoster: [{ title: 'VOE', href: `https://burningseries.ac/serie/Test/1/${nummer}-Test/de/VOE` }] })) },
};
async function main() {
  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'flipperflix-test-'));
  const frei = net.createServer();
  await new Promise((r) => frei.listen(0, '127.0.0.1', r));
  const port = frei.address().port;
  await new Promise((r) => frei.close(r));
  const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, API_TOKEN: 'test', HOST: '127.0.0.1', PORT: String(port), DATEN_ORDNER: ordner }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  let browser;
  try {
    const basis = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Testserver startet nicht')), 10000);
      let ausgabe = '';
      server.stdout.on('data', (d) => { ausgabe += d; const m = ausgabe.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (m) { clearTimeout(timer); resolve(m[0] + '/'); } });
      server.on('exit', () => { clearTimeout(timer); reject(new Error('Testserver beendet')); });
    });
    browser = await (process.env.TEST_BROWSER === 'webkit' ? webkit : chromium).launch({ executablePath: process.env.TEST_BROWSER_EXECUTABLE || undefined });
    const daten = () => fetch(basis + 'gesehen', { headers: { Authorization: 'Bearer test' } }).then((r) => r.json());
    for (const breite of [320, 390, 768, 1440]) {
      const context = await browser.newContext({ viewport: { width: breite, height: 900 }, hasTouch: breite < 768 });
      const errors = [];
      context.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
      await context.addInitScript(() => { try { localStorage.setItem('serienKatalog.token', 'test'); } catch {} });
      await context.route('**/katalog?**', (r) => r.fulfill({ json: katalog }));
      const coverRoute = (r) => r.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') });
      await context.route(katalog.serie.bild, coverRoute);
      const page = await context.newPage();
      await page.goto(basis);
      await page.locator('.kino').waitFor();
      assert.match(await page.title(), /FlipperFlix/);
      assert.equal(await page.locator('#zugang').isVisible(), false);
      await page.locator('#serie').fill('Greys anatomy');
      await page.locator('#los').click();
      await page.locator('.listen-knopf').waitFor();
      await page.waitForFunction(() => document.querySelector('.detail-cover')?.naturalWidth > 0);
      const speichern = page.waitForResponse((r) => r.url().endsWith('/gesehen') && r.request().method() === 'POST' && r.request().postDataJSON()?.merken === true);
      await page.locator('.listen-knopf').click();
      assert.equal((await (await speichern).json()).serie.merken, true);
      assert.equal(JSON.parse(fs.readFileSync(path.join(ordner, 'gesehen.json'), 'utf8')).serien[katalog.serie.titel.toLowerCase()].merken, true);
      await page.locator('.listen-knopf[aria-pressed=true]').waitFor();
      assert.ok(await page.locator('.stream-button').first().getAttribute('href').then((h) => new URL(h).pathname.endsWith('/video')));
      await page.locator('#zurStartseite').click();
      await page.locator('#sammlung .serien-zeile').waitFor();
      assert.equal(await page.locator('#sammlung .serien-zeile').count(), 1);
      const poster = page.locator('#sammlung .poster-bild');
      await poster.scrollIntoViewIfNeeded();
      await page.waitForFunction(() => document.querySelector('#sammlung .poster-bild')?.naturalWidth > 0);
      assert.equal(await poster.getAttribute('loading'), 'lazy');
      assert.equal((await daten()).serien[0].bild, katalog.serie.bild);
      // Ein zweiter Browserkontext liest dieselbe Liste vom Server, ohne lokalen Listen-Speicher.
      const zweiter = await browser.newContext({ viewport: { width: breite, height: 900 } });
      // Fehlendes Quellbild muss auch auf einem anderen Gerät die Titelkarte zeigen.
      await zweiter.route(katalog.serie.bild, (r) => r.abort());
      await zweiter.addInitScript(() => { try { localStorage.setItem('serienKatalog.token', 'test'); } catch {} });
      const anderesGeraet = await zweiter.newPage();
      await anderesGeraet.goto(basis);
      await anderesGeraet.locator('#meine-liste .serien-zeile').waitFor();
      await anderesGeraet.locator('#meine-liste .serien-zeile').scrollIntoViewIfNeeded();
      await anderesGeraet.waitForFunction(() => !document.querySelector('#meine-liste .poster-bild'));
      assert.ok(await anderesGeraet.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (breite === 390 && process.env.TEST_SCREENSHOTS) await anderesGeraet.screenshot({ path: '/tmp/flipperflix-start.png', fullPage: true });
      await zweiter.close();
      await page.locator('#sammlung .serien-zeile').click();
      await page.locator('#haken-1').waitFor();
      const abhaken = page.waitForResponse((r) => r.url().endsWith('/gesehen') && r.request().method() === 'POST' && r.request().postDataJSON()?.gesehen === true);
      await page.locator('#haken-1').check();
      await abhaken;
      await page.locator('#zurStartseite').click();
      await page.locator('#sammlung .serien-zeile').waitFor();
      await page.locator('#sammlung .serien-zeile').click();
      await page.locator('#haken-1:checked').waitFor();
      const entfernen = page.waitForResponse((r) => r.url().endsWith('/gesehen') && r.request().method() === 'POST' && r.request().postDataJSON()?.merken === false);
      await page.locator('.listen-knopf').click();
      assert.equal((await (await entfernen).json()).serie.gesehen['1'].folgen[0], 1);
      await page.locator('.listen-knopf[aria-pressed=false]').waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (breite === 390 && process.env.TEST_SCREENSHOTS) await page.screenshot({ path: '/tmp/flipperflix-serie.png', fullPage: true });
      // Vor dem nächsten Durchlauf Liste und Register isoliert zurücksetzen.
      await fetch(basis + 'gesehen', { method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify({ serie: katalog.serie.titel, entfernen: true }) });
      assert.equal((await daten()).serien.length, 0);
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ ok: true, browser: process.env.TEST_BROWSER || 'chromium', breite, listeGeraeteuebergreifend: true, gesehenErhalten: true }));
      await context.close();
    }
    // Eine vorgemerkte Serie bleibt erhalten, wenn der letzte Haken entfernt wird.
    const post = (body) => fetch(basis + 'gesehen', { method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    await post({ serie: 'Bleibt auf der Liste', merken: true });
    await post({ serie: 'Bleibt auf der Liste', staffel: 1, folgen: [1], gesehen: true });
    const leer = await post({ serie: 'Bleibt auf der Liste', staffel: 1, folgen: [1], gesehen: false });
    assert.equal(leer.serie.merken, true);
    assert.deepEqual(leer.serie.gesehen, {});
    assert.equal((await post({ serie: 'Bleibt auf der Liste', merken: false })).serie, null);
    assert.equal((await post({ serie: 'Ungültig', merken: 'ja' })).ok, false);
    const besucht = { staffel: 1, folge: null, folgen: [1] };
    for (const bild of ['javascript:alert(1)', 'http://example.org/cover.jpg', 'https://user:pass@example.org/x', 123]) {
      assert.equal((await post({ serie: 'Ungültiges Cover', besucht, bild })).ok, false);
    }
    await post({ serie: 'Cover bleibt', besucht, bild: katalog.serie.bild });
    assert.equal((await post({ serie: 'Cover bleibt', besucht, bild: null })).serie.bild, katalog.serie.bild);
    await post({ serie: 'Altbestand', besucht, staffeln: ['1', '2'] });
    await post({ serie: 'Altbestand', merken: true });
    const vorher = (await post({ serie: 'Altbestand', staffel: 1, folgen: [1], gesehen: true })).serie;
    const coverNachtrag = await post({ serie: 'Altbestand', bild: katalog.serie.bild });
    assert.equal(coverNachtrag.ok, true);
    assert.deepEqual(coverNachtrag.serie, { ...vorher, bild: katalog.serie.bild });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ordner, 'gesehen.json'), 'utf8')).serien.altbestand, coverNachtrag.serie);
    assert.equal((await post({ serie: 'Altbestand', bild: null })).ok, false);
    assert.equal((await post({ serie: 'Noch nicht gespeichert', bild: katalog.serie.bild })).ok, false);
    const ohneToken = await fetch(basis + 'gesehen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serie: 'Altbestand', bild: katalog.serie.bild }) });
    assert.equal(ohneToken.status, 401);
    console.log('Liste und Gesehen-Stand bleiben unabhängig erhalten.');
  } finally {
    if (browser) await browser.close();
    server.kill();
    await new Promise((r) => server.exitCode !== null ? r() : server.once('exit', r));
    fs.rmSync(ordner, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
