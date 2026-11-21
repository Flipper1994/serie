// Echte UI → echter HTTP-Dienst → JSON-Datei → zweiter Browser → Neustart.
// Nur die fremden Katalog-/Hosterprozesse sind kontrollierte Testbausteine.
// Keine echten Captcha-Aufträge. Chromium spielt echte MP4-Daten über /medien ab.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium, webkit } = require('playwright');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const media = 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4';
const titel = "Grey's Anatomy | Die jungen Aerzte (2005)";
async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'serie-e2e-'));
  const scripts = path.join(temp, 'scripts'); fs.mkdirSync(scripts);
  const bin = path.join(temp, 'bin'); fs.mkdirSync(bin);
  const daten = path.join(temp, 'daten'); fs.mkdirSync(daten);
  fs.writeFileSync(path.join(daten, 'gesehen.json'), JSON.stringify({ serien: { altbestand: { titel: 'Altbestand', staffeln: ['1', '3'], geaendert: '2020-01-01', gesehen: { 1: { anzahlFolgen: 5, folgen: [2] } } } } }));
  fs.copyFileSync(path.join(__dirname, 'server.js'), path.join(scripts, 'server.js'));
  fs.cpSync(path.join(__dirname, '..', 'public'), path.join(temp, 'public'), { recursive: true });
  fs.writeFileSync(path.join(scripts, 'katalog.js'), `
const s=Number(process.argv[3]); const name=process.argv[2];
if(name==='Unbekannt'){console.log(JSON.stringify({ok:false,fehler:'Nicht gefunden'}));process.exit(1);}
const titel=name==='Zweite Serie'?name:${JSON.stringify(titel)};
const folgen=(s===0?[0,1]:s===3?[1,2]:[1,2,5]).map(n=>({nummer:n,titel:'Folge '+n,hoster:['VOE','Vidmoly','Filemoon'].map(title=>({title,href:'https://burningseries.ac/serie/Test/'+s+'/'+n+'-Test/de/'+title}))}));
console.log(JSON.stringify({ok:true,serie:{titel,staffeln:['Specials','1','3'],sprachen:[],infos:{}},staffel:{nummer:s,folgen}}));
`);
  fs.writeFileSync(path.join(scripts, 'video-link.js'), `console.log(JSON.stringify({ok:true,url:${JSON.stringify(media)},art:'datei',titel:'E2E-Testvideo'}));`);
  fs.writeFileSync(path.join(bin, 'xvfb-run'), `#!/usr/bin/env node
const fs=require('fs');fs.appendFileSync(process.env.DATEN_ORDNER+'/freigaben','x');
console.log(JSON.stringify({fortschritt:{phase:'captcha_api',detail:'Kontrollierte Freigabe ohne API-Kosten',versuch:1,maxVersuche:1}}));
setTimeout(()=>console.log(JSON.stringify({ok:true,url:'https://example.org/hoster',cached:false})),150);
`);
  fs.chmodSync(path.join(bin, 'xvfb-run'), 0o755);
  const frei = net.createServer(); await new Promise((r) => frei.listen(0, '127.0.0.1', r));
  const port = frei.address().port; await new Promise((r) => frei.close(r));
  const basis = `http://127.0.0.1:${port}/`;
  let server, browser;
  const starten = async () => {
    server = spawn(process.execPath, [path.join(scripts, 'server.js')], { env: { ...process.env, API_TOKEN: 'test', HOST: '127.0.0.1', PORT: String(port), DATEN_ORDNER: daten, YT_DLP_PATH: '/nicht-installiert', PATH: bin + ':' + process.env.PATH }, stdio: ['ignore', 'ignore', 'inherit'] });
    for (let i = 0; i < 100; i++) { if (await fetch(basis + 'health').then((r) => r.ok).catch(() => false)) return; await pause(50); }
    throw new Error('Testserver startet nicht');
  };
  const stoppen = async () => { if (server && server.exitCode === null) { server.kill(); await new Promise((r) => server.once('exit', r)); } };
  const get = async () => (await fetch(basis + 'gesehen', { headers: { Authorization: 'Bearer test' } })).json();
  const post = async (body) => { const r = await fetch(basis + 'gesehen', { method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
  const warten = async (pruefen, text) => { for (let i = 0; i < 100; i++) { if (await pruefen()) return; await pause(50); } throw new Error(text); };
  const eintrag = async () => (await get()).serien.find((e) => e.titel === titel);
  const ok = (text) => console.log('OK: ' + text);
  try {
    await starten();
    browser = await (process.env.TEST_BROWSER === 'webkit' ? webkit : chromium).launch({ executablePath: process.env.TEST_BROWSER_EXECUTABLE || undefined, args: process.env.TEST_BROWSER === 'webkit' ? [] : ['--autoplay-policy=no-user-gesture-required'] });
    const fehler = [];
    const kontext = async () => {
      const c = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
      await c.addInitScript(() => {
        try { localStorage.setItem('serienKatalog.token', 'test'); } catch {}
        document.addEventListener('DOMContentLoaded', () => { const v = document.querySelector('video'); if (v) v.muted = true; });
      });
      c.on('page', (p) => p.on('pageerror', (e) => fehler.push(e.message)));
      await c.route('https://www.gstatic.com/**', (r) => r.abort());
      return c;
    };
    const ca = await kontext(), cb = await kontext();
    const a = await ca.newPage(), b = await cb.newPage();
    await a.goto(basis); await a.locator('.kino').waitFor();
    assert.match(await a.locator('#weiterschauen .serien-weiter').textContent(), /Staffel 1 · Folge 3/);
    ok('Alter Gesehen-Stand ohne neue Metadaten bleibt erhalten und liefert einen Fortsetzpunkt');
    await a.locator('#serie').fill('Greys anatomy'); await a.locator('#los').click();
    await a.locator('#haken-1').waitFor();
    await warten(async () => !!(await eintrag())?.besucht, 'Suche nicht gespeichert');
    assert.deepEqual((await eintrag()).gesehen, {});
    await a.reload(); await a.locator('#haken-1').waitFor();
    await a.locator('#zurStartseite').click(); await a.locator('#letzte-suchen .serien-zeile').waitFor();
    await b.goto(basis); await b.locator('#letzte-suchen .serien-zeile').waitFor();
    assert.match(await b.locator('#letzte-suchen').textContent(), /Grey's Anatomy/);
    assert.equal(await b.locator('#letzte-suchen .serien-zeile').count(), 1);
    ok('Suche ohne Haken oder Vormerken überlebt Reload und erscheint auf zweitem Gerät');

    await a.locator('#letzte-suchen .serien-zeile').click(); await a.locator('#haken-2').waitFor();
    let videoMarkierungErlauben;
    const videoMarkierung = new Promise((r) => { videoMarkierungErlauben = r; });
    await ca.route('**/gesehen', async (route) => {
      if (route.request().method() === 'POST' && new URL(route.request().frame().url()).pathname === '/video') await videoMarkierung;
      await route.continue();
    });
    const popup = ca.waitForEvent('page');
    await a.locator('[data-folge="2"] .stream-button').first().click();
    const video = await popup;
    await warten(async () => (await eintrag()).gesehen['1']?.folgen.includes(2), 'Anbieter-Klick nicht abgehakt');
    videoMarkierungErlauben();
    await video.locator('#spieler').waitFor({ state: 'visible', timeout: 60000 });
    const videoURL = new URL(video.url());
    assert.equal(videoURL.searchParams.get('serie'), titel);
    assert.equal(videoURL.searchParams.get('folge'), '2');
    {
      await video.locator('#video').evaluate((v) => { v.muted = true; return v.play().catch(() => {}); });
      await video.waitForFunction(() => { const v = document.querySelector('video'); return v.videoWidth > 0 && v.currentTime > .1; }, null, { timeout: 60000 });
    }
    ok('Anbieter-Klick öffnet Videotab, speichert gesehen und erhält Serienkontext; echte Videoframes laufen');

    await b.bringToFront(); await b.evaluate(() => window.dispatchEvent(new Event('focus')));
    await b.locator('#weiterschauen .serien-zeile').filter({ hasText: "Grey's Anatomy" }).waitFor();
    assert.match(await b.locator('#weiterschauen .serien-zeile').filter({ hasText: "Grey's Anatomy" }).locator('.serien-weiter').textContent(), /Staffel 1 · Folge 5/);
    await b.locator('#weiterschauen .serien-zeile').filter({ hasText: "Grey's Anatomy" }).click();
    await b.locator('[data-folge="5"].markiert').waitFor();
    assert.equal(await b.locator('#haken-2').isChecked(), true);
    ok('Fortsetzen überspringt fehlende Folgennummern und öffnet auf anderem Gerät Staffel 1, Folge 5');

    await b.locator('#haken-2').uncheck();
    await warten(async () => !(await eintrag()).gesehen['1']?.folgen.includes(2), 'Manuelles Entfernen fehlt');
    await b.locator('#zurStartseite').click(); await b.locator('#letzte-suchen .serien-zeile').waitFor();
    await b.locator('#letzte-suchen .serien-zeile').click(); await b.locator('[data-folge="2"].markiert').waitFor();
    assert.equal(await b.locator('#haken-2').isChecked(), false);
    ok('Manuelles Entfernen bleibt gespeichert und setzt Fortsetzen auf die offene Folge zurück');

    await video.locator('#oeffnen').click();
    await warten(async () => (await eintrag()).gesehen['1']?.folgen.includes(2), 'Video erneut öffnen hakt nicht ab');
    await video.locator('#oeffnen').waitFor({ state: 'visible' });
    await video.waitForFunction(() => !document.querySelector('#oeffnen').disabled);
    assert.equal(fs.readFileSync(path.join(daten, 'freigaben'), 'utf8'), 'x');
    ok('Video öffnen hakt wieder ab; erneutes Laden verwendet dieselbe Freigabe');

    await video.locator('#linkFeld').fill(media);
    await video.locator('#oeffnen').click();
    await video.waitForFunction(() => !document.querySelector('#oeffnen').disabled);
    assert.equal(new URL(video.url()).searchParams.has('serie'), false);
    ok('Ein anderer eingefügter Videolink übernimmt keine falsche Serienzuordnung');

    await b.bringToFront(); await b.evaluate(() => window.dispatchEvent(new Event('focus')));
    await b.locator('#haken-2:checked').waitFor();
    const ende = cb.waitForEvent('page');
    await b.locator('[data-folge="5"] .stream-button').first().click();
    const endeVideo = await ende; await endeVideo.locator('#spieler').waitFor({ state: 'visible', timeout: 30000 });
    await endeVideo.close();
    await b.locator('#zurStartseite').click(); await b.locator('#weiterschauen .serien-zeile').filter({ hasText: "Grey's Anatomy" }).waitFor();
    assert.match(await b.locator('#weiterschauen .serien-zeile').filter({ hasText: "Grey's Anatomy" }).locator('.serien-weiter').textContent(), /Staffel 3/);
    await b.locator('#weiterschauen .serien-zeile').filter({ hasText: "Grey's Anatomy" }).click(); await b.locator('#ausgabe .meta').filter({ hasText: 'Staffel 3' }).waitFor();
    ok('Am Staffel-Ende geht es zur nächsten tatsächlich vorhandenen Staffel 3');

    await b.locator('#serie').fill('Zweite Serie'); await b.locator('#los').click();
    await b.locator('#ausgabe h2.titel').filter({ hasText: 'Zweite Serie' }).waitFor();
    await b.locator('#zurStartseite').click(); await b.locator('#letzte-suchen .serien-zeile').first().waitFor();
    assert.equal(await b.locator('#letzte-suchen .serien-name').first().textContent(), 'Zweite Serie');
    assert.equal(await b.locator('#letzte-suchen .serien-zeile').count(), 2);
    ok('Letzte Suchen werden gemeinsam sortiert und pro Serie dedupliziert');

    const vorher = (await get()).serien.length;
    await b.locator('#serie').fill('Unbekannt'); await b.locator('#los').click();
    await b.locator('.fehler-karte').waitFor();
    assert.equal((await get()).serien.length, vorher);
    assert.equal((await post({ serie: 'Falsch', besucht: { staffel: -1, folgen: [] } })).status, 400);
    assert.equal((await fetch(basis + 'gesehen')).status, 401);
    ok('Fehlgeschlagene Suche erzeugt keinen Eintrag; ungültige Daten und fehlendes Token werden abgelehnt');

    await post({ serie: titel, staffel: 3, folgen: [2], gesehen: true });
    await b.goto(basis); await b.locator('.kino').waitFor();
    assert.equal(await b.locator('#weiterschauen .serien-zeile').filter({ hasText: "Grey's Anatomy" }).count(), 0);
    await b.locator('#letzte-suchen .serien-zeile').filter({ hasText: "Grey's Anatomy" }).click();
    await b.locator('#ausgabe .meta').filter({ hasText: 'Staffel 3' }).waitFor();
    await b.locator('#haken-2').uncheck();
    await warten(async () => !(await eintrag()).gesehen['3']?.folgen.includes(2), 'Letzte Folge nicht entfernt');
    await b.locator('#zurStartseite').click(); await b.locator('#weiterschauen .serien-weiter').filter({ hasText: 'Staffel 3 · Folge 2' }).waitFor();
    ok('Serienende erzeugt keine erfundene nächste Folge; manuelles Entfernen macht Fortsetzen wieder verfügbar');

    const vorParallel = await eintrag();
    await Promise.all([post({ serie: titel, staffel: 1, folgen: [1], gesehen: true }), post({ serie: titel, staffel: 3, folgen: [1], gesehen: true })]);
    assert.ok((await eintrag()).gesehen['1'].folgen.includes(1));
    assert.ok((await eintrag()).gesehen['3'].folgen.includes(1));
    assert.equal((await eintrag()).besucht.zeit, vorParallel.besucht.zeit);
    ok('Gleichzeitige Änderungen zweier Geräte behalten beide Markierungen und den Verlauf');

    const vorFehler = await get();
    fs.chmodSync(daten, 0o500);
    try {
      const fehlerAntwort = await post({ serie: titel, staffel: 1, folgen: [1], gesehen: false });
      assert.equal(fehlerAntwort.status, 500);
      assert.deepEqual(await get(), vorFehler);
      await b.goto(basis + '?serie=Fehlertest&staffel=1');
      await b.locator('.treffer[role=alert]').filter({ hasText: 'letzte Suche konnte nicht gespeichert' }).waitFor();
    } finally { fs.chmodSync(daten, 0o700); }
    assert.deepEqual(await get(), vorFehler);
    ok('Echter Schreibfehler setzt den Serverzustand zurück und wird in der Oberfläche angezeigt');

    await ca.close(); await cb.close();
    const vorNeustart = await get(); await stoppen(); await starten();
    assert.deepEqual(await get(), vorNeustart);
    const cc = await kontext(), c = await cc.newPage();
    await c.goto(basis); await c.locator('#letzte-suchen .serien-zeile').first().waitFor();
    assert.equal(await c.locator('#letzte-suchen .serien-zeile').count(), 2);
    ok('Kompletter Dienst-Neustart erhält Verlauf, Haken und Fortsetzpunkt');
    for (const width of [320, 390, 768, 1440]) {
      await c.setViewportSize({ width, height: 900 });
      assert.ok(await c.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    assert.deepEqual(fehler, []);
    await cc.close();
    ok('Kein horizontaler Überlauf bei 320/390/768/1440 px und keine JavaScript-Fehler');
    console.log(JSON.stringify({ ok: true, browser: process.env.TEST_BROWSER || 'chromium', szenarien: 15, echteApiUndDatei: true, captchaAuftraege: 0 }));
  } finally {
    if (browser) await browser.close();
    await stoppen();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
