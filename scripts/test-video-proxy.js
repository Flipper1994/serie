// Echter HTTP-Dienst und Proxy mit kontrollierten Resolver-/Upstream-Antworten.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'serie-proxy-test-'));
  const scripts = path.join(temp, 'scripts'); fs.mkdirSync(scripts);
  for (const datei of ['server.js', 'playmogo.js', 'medien-sitzung.js']) fs.copyFileSync(path.join(__dirname, datei), path.join(scripts, datei));
  const abrufe = [];
  const upstream = http.createServer((req, res) => {
    abrufe.push({ host: req.headers['x-test-host'], cookie: req.headers.cookie, ua: req.headers['user-agent'], referer: req.headers.referer, range: req.headers.range });
    if (req.url === '/start') { res.writeHead(302, { Location: 'https://other.example/video.mp4' }); return res.end(); }
    if (req.url === '/master.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:5,\nsegment.ts\n');
    }
    res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-299/1000', 'Content-Length': '300' });
    res.end(Buffer.alloc(300));
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamPort = upstream.address().port;
  // Nur im Test: externe HTTPS-Adressen zum lokalen Test-Upstream transportieren.
  const preload = path.join(temp, 'transport.cjs');
  fs.writeFileSync(preload, `const https=require('node:https'),http=require('node:http');
https.request=(url,opts,cb)=>http.request(new URL(url.pathname+url.search,'http://127.0.0.1:${upstreamPort}'),{...opts,headers:{...opts.headers,'x-test-host':url.hostname}},cb);`);
  fs.writeFileSync(path.join(scripts, 'video-link.js'), `const hls=process.argv[2].includes('/hls');console.log(JSON.stringify({ok:true,url:'https://media.playmogo.com/'+(hls?'master.m3u8':'start'),art:hls?'hls':'datei',referer:'https://playmogo.com/e/test',userAgent:'Sitzungsbrowser',resolver:process.argv[2].includes('/solver')?'byparr':undefined,cookies:[{name:'clearance',value:'geheim',domain:'.playmogo.com',path:'/',secure:true,expires:-1}]}));`);
  const frei = http.createServer(); await new Promise((r) => frei.listen(0, '127.0.0.1', r));
  const port = frei.address().port; await new Promise((r) => frei.close(r));
  const basis = `http://127.0.0.1:${port}/`;
  const server = spawn(process.execPath, ['--require', preload, path.join(scripts, 'server.js')], {
    env: { ...process.env, API_TOKEN: 'test', HOST: '127.0.0.1', PORT: String(port), DATEN_ORDNER: temp, YT_DLP_PATH: path.join(temp, 'nicht-installiert') }, stdio: ['ignore', 'ignore', 'inherit'],
  });
  async function stream(url) {
    const r = await fetch(new URL(`stream?${new URLSearchParams({ url })}`, basis), { headers: { Authorization: 'Bearer test' } });
    assert.equal(r.status, 200); return r.json();
  }
  try {
    for (let i = 0; i < 100; i++) { if (await fetch(basis + 'health').then((r) => r.ok).catch(() => false)) break; if (i === 99) throw new Error('Testserver startet nicht'); await pause(50); }
    const d = await stream('https://playmogo.com/d/test');
    assert.ok(!JSON.stringify(d).includes('geheim') && !d.cookies && !d.userAgent);
    const medien = new URL(d.medien, basis);
    assert.ok(medien.searchParams.get('sid'));
    const antwort = await fetch(medien, { headers: { Range: 'bytes=0-299' } });
    assert.equal(antwort.status, 206); assert.equal((await antwort.arrayBuffer()).byteLength, 300);
    assert.equal(abrufe[0].cookie, 'clearance=geheim');
    assert.equal(abrufe[1].cookie, undefined, 'Weiterleitung auf Fremddomain darf keine Cookies erhalten');
    for (const a of abrufe) { assert.equal(a.ua, 'Sitzungsbrowser'); assert.equal(a.referer, 'https://playmogo.com/e/test'); assert.equal(a.range, 'bytes=0-299'); }
    const warm = await stream('https://playmogo.com/d/test'); assert.equal(warm.cached, true);
    assert.equal(new URL(warm.medien, basis).searchParams.get('sid'), medien.searchParams.get('sid'));
    for (const modus of ['löschen', 'ändern']) {
      const kaputt = new URL(medien);
      if (modus === 'löschen') kaputt.searchParams.delete('sid'); else kaputt.searchParams.set('sid', 'falsch');
      assert.equal((await fetch(kaputt)).status, 403, 'Sitzungs-ID gehört zur Signatur');
    }
    const hls = await stream('https://playmogo.com/d/hls');
    const liste = await (await fetch(new URL(hls.medien, basis))).text();
    const urls = [...liste.matchAll(/URI="([^"]+)"|^(medien\?[^\r\n]+)/gm)].map((m) => new URL(m[1] || m[2], basis));
    assert.equal(urls.length, 2, 'HLS-Schlüssel und Segment werden umgeschrieben');
    for (const u of urls) {
      assert.equal(u.searchParams.get('sid'), new URL(hls.medien, basis).searchParams.get('sid'));
      const r = await fetch(u); assert.equal(r.status, 206); await r.arrayBuffer();
      assert.equal(abrufe.at(-1).cookie, 'clearance=geheim');
    }
    const alt = await stream('https://voe.sx/e/test');
    assert.equal(new URL(alt.medien, basis).searchParams.has('sid'), false, 'Andere Hoster behalten das alte Signaturformat');
    const r = await fetch(new URL(alt.medien, basis)); assert.equal(r.status, 206); await r.arrayBuffer();
    assert.equal(abrufe.at(-2).cookie, undefined);
    assert.notEqual(abrufe.at(-2).ua, 'Sitzungsbrowser');
    const gemeinsam = await stream('https://anderer-hoster.test/e/solver');
    assert.ok(new URL(gemeinsam.medien, basis).searchParams.get('sid'), 'Gemeinsamer Solver erhält für alle Hoster eine Sitzung');
    assert.ok(!JSON.stringify(gemeinsam).includes('geheim') && !gemeinsam.cookies && !gemeinsam.userAgent);
    const solverVideo = await fetch(new URL(gemeinsam.medien, basis), { headers: { Range: 'bytes=0-299' } });
    assert.equal(solverVideo.status, 206); await solverVideo.arrayBuffer();
    assert.equal(abrufe.at(-2).cookie, 'clearance=geheim');
    assert.equal(abrufe.at(-2).ua, 'Sitzungsbrowser');
    assert.equal(abrufe.at(-1).cookie, undefined, 'Auch Solver-Cookies bleiben auf ihre Domain begrenzt');
    console.log('OK: Proxy-Range, Cookies intern, Redirect-Domaingrenze, Browserkennung, Cache, signierte Sitzungs-ID, HLS-Schlüssel/Segmente und alter Hosterpfad');
  } finally {
    if (server.exitCode === null) { server.kill(); await new Promise((r) => server.once('exit', r)); }
    await new Promise((r) => upstream.close(r));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
