#!/usr/bin/env node
// Übergabe im Browser mit nachgebildeter Anbieter-Freigabe, ohne Captcha zu umgehen.
// Aufruf: node scripts/test-anbieter.js; benötigt Playwright mit Chromium.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium, webkit } = require('playwright');

const produktiv = 'https://flippercapital.duckdns.org/serie/';
const anbieter = 'https://burningseries.ac/serie/Test/1/1-Test/de/VOE';
const hoster = 'https://example.com/embed/test?a=1&b=2';
const skript = fs.readFileSync(path.join(__dirname, '..', 'public', 'anbieter.user.js'), 'utf8');
const katalog = {
  ok: true, anfrage: { serie: 'Test', staffel: 1, folge: null },
  serie: { titel: 'Eine Serie mit einem sehr langen Titel für kleine Bildschirme', staffeln: ['Specials', '1', '2', '3'], sprachen: [], infos: {} },
  staffel: { nummer: 1, folgen: [{ nummer: 1, titel: 'Eine besonders lange erste Folge für kleine Bildschirme', hoster: ['VOE', 'Vidmoly', 'Filemoon'].map((title) => ({ title, href: anbieter.replace('/VOE', `/${title}`) })) }] },
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const frei = net.createServer();
  await new Promise((r) => frei.listen(0, '127.0.0.1', r));
  const port = frei.address().port;
  await new Promise((r) => frei.close(r));
  const basis = `http://127.0.0.1:${port}/`;
  const dienst = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), API_TOKEN: 'bruecken-test' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  let browser;
  try {
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${basis}health`).then((r) => r.ok).catch(() => false)) break;
      if (i === 99) throw new Error('Testdienst startet nicht');
      await pause(100);
    }
    const datei = await fetch(`${basis}anbieter.user.js`);
    assert.equal(datei.status, 200);
    assert.match(datei.headers.get('content-type'), /application\/javascript/);
    assert.equal(await datei.text(), skript);
    browser = process.env.TEST_BROWSER === 'webkit' ? await webkit.launch() : await chromium.launch({ args: ['--no-sandbox'] });

    // Die Browser-Brücke wird für Chrome geprüft; WebKit prüft den Weg ohne Erweiterung.
    for (const modus of (process.env.TEST_BROWSER === 'webkit' ? [] : ['link', 'iframe', 'spaetes-src'])) {
      const context = await browser.newContext();
      if (process.env.TEST_DEBUG === '1') {
        context.on('request', (r) => { if (r.isNavigationRequest()) console.log('Navigation:', r.url()); });
        context.on('console', (m) => console.log('Browser:', m.text()));
      }
      const fehler = [];
      context.on('page', (p) => p.on('pageerror', (e) => fehler.push(e.message)));
      await context.addInitScript({ content: skript });
      await context.addInitScript(() => {
        if (location.origin === 'https://flippercapital.duckdns.org') localStorage.setItem('serienKatalog.token', 'bruecken-test');
      });
      let streamAnfragen = 0;
      await context.route(`${produktiv}**`, async (route) => {
        const url = new URL(route.request().url());
        const pfad = url.pathname.replace('/serie/', '');
        if (pfad === 'katalog') return route.fulfill({ json: katalog });
        if (pfad === 'gesehen') return route.fulfill({ json: { ok: true, serien: [] } });
        if (pfad === 'stream') {
          streamAnfragen++;
          assert.equal(url.searchParams.get('url'), hoster);
          assert.equal(route.request().headers().authorization, 'Bearer bruecken-test');
          return route.fulfill({ json: { ok: true, mp4: 'https://example.com/test.mp4', titel: 'Testvideo', art: 'datei', medien: 'medien?test=1' } });
        }
        if (pfad === 'medien') return route.fulfill({ status: 404 });
        const antwort = await fetch(`${basis}${pfad}${url.search}`);
        return route.fulfill({ status: antwort.status, headers: Object.fromEntries(antwort.headers), body: Buffer.from(await antwort.arrayBuffer()) });
      });
      await context.route('https://www.gstatic.com/**', (route) => route.abort());
      await context.route('https://burningseries.ac/**', (route) => route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<section class="serie"><div class="hoster-player"><button id="freigeben">Reguläre Freigabe nachbilden</button></div></section>',
      }));
      const page = await context.newPage();
      await page.goto(`${produktiv}?serie=Test&staffel=1`);
      await page.waitForSelector('.stream-button[href]');
      assert.equal(await page.locator('#brueckenStatus').textContent(), 'bereit');
      const neuerTab = context.waitForEvent('page');
      await page.getByRole('link', { name: 'VOE', exact: true }).click();
      const tab = await neuerTab;
      await tab.waitForLoadState('domcontentloaded');
      assert.equal(new URL(tab.url()).hash, '#serienKatalog=1');
      assert.equal(new URL(tab.url()).searchParams.has('token'), false);
      // Vor der Freigabe kein Netzwerkaufruf zur Videoauflösung.
      assert.equal(streamAnfragen, 0);
      await tab.locator('#freigeben').evaluate((button, daten) => {
        button.onclick = () => {
          const player = button.parentElement;
          if (daten.modus === 'link') {
            const a = document.createElement('a'); a.href = daten.hoster;
            player.append(a);
            window.open(daten.hoster, '_blank');
          } else {
            const iframe = document.createElement('iframe');
            if (daten.modus === 'iframe') iframe.src = daten.hoster;
            player.replaceChildren(iframe);
            if (daten.modus === 'spaetes-src') setTimeout(() => { iframe.src = daten.hoster; }, 50);
          }
        };
      }, { modus, hoster });
      await tab.locator('#freigeben').click({ noWaitAfter: true });
      await tab.waitForURL(`${produktiv}video?**`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(async (ursache) => {
        const stand = await tab.evaluate(() => ({ player: document.querySelector('.hoster-player')?.innerHTML, bruecke: window.open.toString().includes('hosterAdresse') }));
        throw new Error(`Übergabe ${modus} stockt: ${ursache.message}; ${tab.url()}, Seitenfehler: ${fehler.join('; ')}, Stream-Anfragen: ${streamAnfragen}, Stand: ${JSON.stringify(stand)}`);
      });
      await tab.locator('#spieler').waitFor({ state: 'visible' });
      assert.equal(new URL(tab.url()).searchParams.get('url'), hoster);
      assert.equal(await tab.locator('#titel').textContent(), 'Testvideo');
      assert.equal(await tab.locator('#video').getAttribute('src'), `${produktiv}medien?test=1`);
      assert.equal(streamAnfragen, 1);
      assert.equal(context.pages().length, 2, 'Kein zusätzliches Hoster-Fenster');
      assert.deepEqual(fehler, []);
      await context.close();
      console.log(`OK: Katalog → Anbieter → ${modus} → Videoplayer`);
    }

    for (const [markiert, quelle] of [[false, hoster], [true, 'javascript:alert(1)'], [true, '/serie/intern']]) {
      const context = await browser.newContext();
      await context.addInitScript({ content: skript });
      await context.route('https://burningseries.ac/**', (route) => route.fulfill({ contentType: 'text/html', body: '<section class="serie"><div class="hoster-player"></div></section>' }));
      const page = await context.newPage();
      await page.goto(`${anbieter}${markiert ? '#serienKatalog=1' : ''}`);
      await page.evaluate((adresse) => {
        const a = document.createElement('a'); a.href = adresse;
        document.querySelector('.hoster-player').append(a);
      }, quelle);
      await pause(150);
      assert.ok(page.url().startsWith(anbieter));
      await context.close();
    }
    console.log('OK: Ohne Markierung, ungültige Links und interne Links werden nicht übernommen');

    const browserTypen = [{ instanz: browser, name: process.env.TEST_BROWSER === 'webkit' ? 'WebKit' : 'Chromium' }];
    if (process.env.TEST_WEBKIT === '1') {
      const { webkit } = require('playwright');
      browserTypen.push({ instanz: await webkit.launch(), name: 'WebKit' });
    }
    try {
      for (const typ of browserTypen) for (const breite of [320, 390, 412, 768, 1440]) for (const farbe of ['light', 'dark']) {
        const context = await typ.instanz.newContext({ viewport: { width: breite, height: 850 }, isMobile: breite < 768, hasTouch: breite < 768, colorScheme: farbe });
        const fehler = [];
        context.on('page', (p) => p.on('pageerror', (e) => fehler.push(e.message)));
        await context.addInitScript(() => {
          if (location.origin === 'https://flippercapital.duckdns.org') localStorage.setItem('serienKatalog.token', 'bruecken-test');
        });
        await context.route(`${produktiv}**`, async (route) => {
          const url = new URL(route.request().url());
          const pfad = url.pathname.replace('/serie/', '');
          if (pfad === 'katalog') return route.fulfill({ json: katalog });
          if (pfad === 'gesehen') return route.fulfill({ json: { ok: true, serien: [] } });
          const antwort = await fetch(`${basis}${pfad}${url.search}`);
          return route.fulfill({ status: antwort.status, headers: Object.fromEntries(antwort.headers), body: Buffer.from(await antwort.arrayBuffer()) });
        });
        await context.route('https://www.gstatic.com/**', (route) => route.abort());
        const page = await context.newPage();
        await page.goto(`${produktiv}?serie=Test&staffel=1`);
        await page.waitForSelector('.stream-button[href]');
        assert.equal(await page.locator('#brueckenStatus').textContent(), 'Einrichtung nötig');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Kein horizontaler Überlauf bei ${breite}px`);
        const flaechen = await page.locator('.stream-button, .folge-kopf, .haken-feld').evaluateAll((knoten) => knoten.map((e) => e.getBoundingClientRect().height));
        assert.ok(flaechen.every((h) => h >= 44), 'Touch-Flächen mindestens 44px hoch');
        const neuerTab = context.waitForEvent('page');
        await page.getByRole('link', { name: 'VOE', exact: true }).click();
        const tab = await neuerTab;
        await tab.waitForLoadState('domcontentloaded');
        await tab.locator('#anbieterSchritt').waitFor({ state: 'visible' });
        assert.equal(new URL(tab.url()).searchParams.get('anbieter'), `${anbieter}#serienKatalog=1`);
        assert.equal(await tab.locator('#anbieterOeffnen').getAttribute('href'), `${anbieter}#serienKatalog=1`);
        assert.ok(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Videoseite ohne horizontalen Überlauf');
        assert.deepEqual(fehler, []);
        if (process.env.BILDER_ORDNER && [390, 1440].includes(breite)) {
          fs.mkdirSync(process.env.BILDER_ORDNER, { recursive: true });
          await page.screenshot({ path: path.join(process.env.BILDER_ORDNER, `katalog-${typ.name}-${breite}-${farbe}.png`), fullPage: true });
          await tab.screenshot({ path: path.join(process.env.BILDER_ORDNER, `video-${typ.name}-${breite}-${farbe}.png`), fullPage: true });
        }
        await context.close();
        console.log(`OK: ${typ.name} ${breite}px ${farbe}, Touch-Flächen und Weg ohne Erweiterung`);
      }
    } finally {
      for (const typ of browserTypen) if (typ.instanz !== browser) await typ.instanz.close();
    }
  } finally {
    if (browser) await browser.close();
    dienst.kill();
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
