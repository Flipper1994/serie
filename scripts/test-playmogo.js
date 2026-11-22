// Kontrollierte Hoster-Antworten; kein Nachweis für die echte Cloudflare-Freigabe.
const assert = require('node:assert/strict');
const { istPlaymogo, suchen } = require('./playmogo');
const { anlegen, lesen, kopfFuer } = require('./medien-sitzung');

async function main() {
  assert.ok(istPlaymogo('https://playmogo.com/d/onlyy2irbz99'));
  for (const url of ['https://evilplaymogo.com/e/a', 'https://playmogo.com.evil.com/e/a', 'https://voe.sx/e/a', 'kaputt']) assert.equal(istPlaymogo(url), false);
  for (const hls of [false, true]) {
    let playerAdresse;
    const result = await suchen('https://playmogo.com/d/onlyy2irbz99', { suchzeit: 5000, vorbereiten: async (context) => {
      await context.addCookies([{ name: 'session', value: 'intern', domain: 'playmogo.com', path: '/', secure: true }]);
      await context.route('**/*', (route) => {
        const u = new URL(route.request().url());
        if (u.pathname.startsWith('/e/')) {
          playerAdresse = u.pathname;
          return route.fulfill({ contentType: 'text/html', body: '<title>Testplayer</title><iframe src="/player"></iframe>' });
        }
        if (u.pathname === '/player') return route.fulfill({ contentType: 'text/html', body: `<button aria-label="Play" onclick="fetch('/fehler.mp4').then(()=>fetch('/media.${hls ? 'm3u8' : 'mp4'}'))">Play</button>` });
        if (u.pathname === '/fehler.mp4') return route.fulfill({ contentType: 'text/html', body: '<h1>Kein Video</h1>' });
        return route.fulfill({ contentType: hls ? 'application/vnd.apple.mpegurl' : 'video/mp4', body: hls ? '#EXTM3U\n' : 'kontrollierte Videoreaktion' });
      });
    } });
    assert.equal(playerAdresse, '/e/onlyy2irbz99');
    assert.equal(result.ok, true, result.fehler);
    assert.equal(result.art, hls ? 'hls' : 'datei');
    assert.equal(new URL(result.url).pathname, hls ? '/media.m3u8' : '/media.mp4');
    assert.ok(result.cookies.some((c) => c.name === 'session'));
    assert.match(result.userAgent, /Chrome/);
    assert.equal(new URL(result.referer).pathname, '/player');
  }
  for (const body of ['<title>Just a moment...</title>Security verification', '<title>Nur einen Moment…</title>Sicherheitsüberprüfung wird durchgeführt']) {
    const blockiert = await suchen('https://playmogo.com/d/onlyy2irbz99', { suchzeit: 800, vorbereiten: async (c) => {
      await c.route('**/*', (r) => r.fulfill({ status: 403, contentType: 'text/html', body }));
    } });
    assert.equal(blockiert.ok, false);
    assert.match(blockiert.fehler, /Cloudflare/);
  }
  const cookie = (name, domain, path = '/', extra = {}) => ({ name, value: 'test', domain, path, secure: true, expires: -1, ...extra });
  const id = anlegen({ userAgent: 'Browser-Test', cookies: [cookie('host', 'playmogo.com'), cookie('domain', '.playmogo.com'), cookie('pfad', '.playmogo.com', '/video'), cookie('alt', 'playmogo.com', '/', { expires: 1 })] }, 60000);
  const kopf = (url) => kopfFuer(new URL(url), { Referer: 'https://playmogo.com/' }, lesen(id));
  assert.equal(kopf('https://playmogo.com/video/a').Cookie, 'pfad=test; host=test; domain=test');
  assert.equal(kopf('https://playmogo.com/videofalsch').Cookie, 'host=test; domain=test');
  assert.equal(kopf('https://cdn.playmogo.com/a').Cookie, 'domain=test');
  for (const url of ['https://playmogo.com.evil.com/a', 'https://other.test/a', 'http://playmogo.com/a']) assert.equal(kopf(url).Cookie, undefined);
  assert.equal(kopf('https://other.test/a')['User-Agent'], 'Browser-Test');
  assert.equal(lesen(anlegen({ cookies: [], userAgent: 'a' }, -1)), null);
  console.log('OK: Playmogo-Erkennung, Download→Embed, Iframe-Play, MP4/HLS, HTML-Ausschluss, Cloudflare-Diagnose, Sitzung und Cookie-Grenzen');
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
