// Lokaler HTTP-Solver und Worker-Stubs; keine externen Hoster oder Captcha-Aufträge.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { suchen } = require('./solver-browser');

async function main() {
  let body, pfad, status = 200;
  const gut = { ok: true, url: 'https://media.hoster.test/video.mp4', art: 'datei', titel: 'Test',
    referer: 'https://hoster.test/e/video', userAgent: 'Solver-Testbrowser',
    cookies: [{ name: 'freigabe', value: 'intern', domain: '.hoster.test', secure: true }] };
  let antwort = gut;
  const service = http.createServer(async (req, res) => {
    pfad = req.url; let text = ''; for await (const teil of req) text += teil;
    body = JSON.parse(text); res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(typeof antwort === 'string' ? antwort : JSON.stringify(antwort));
  });
  await new Promise((r) => service.listen(0, '127.0.0.1', r));
  const vorher = process.env.VIDEO_SOLVER_URL;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'serie-solver-test-'));
  process.env.VIDEO_SOLVER_URL = `http://127.0.0.1:${service.address().port}`;
  try {
    for (const art of ['datei', 'hls']) {
      antwort = { ...gut, art };
      const r = await suchen('https://hoster.test/d/video');
      assert.equal(r.ok, true, r.fehler); assert.equal(r.art, art); assert.equal(r.resolver, 'byparr');
      assert.equal(r.cookies[0].path, '/'); assert.equal(r.cookies[0].expires, -1);
      assert.equal(pfad, '/video'); assert.deepEqual(body, { url: 'https://hoster.test/d/video', maxTimeout: 90000 });
    }
    for (const schlecht of [
      { ok: false, fehler: 'Kein Video gefunden' }, 'kein JSON', null,
      { ...gut, url: 'javascript:alert(1)' }, { ...gut, referer: 'file:///x' },
      { ...gut, art: 'html' }, { ...gut, userAgent: 'UA\r\nCookie: geheim' },
      { ...gut, cookies: [{ name: 'x', value: 'y', domain: null }] },
      { ...gut, cookies: [{ name: 'x', value: 'y;z', domain: 'hoster.test' }] },
      'x'.repeat(1024 * 1024 + 1),
    ]) { antwort = schlecht; assert.equal((await suchen('https://hoster.test/e/video')).ok, false); }
    antwort = gut; status = 503; assert.equal((await suchen('https://hoster.test/e/video')).ok, false); status = 200;
    assert.equal((await suchen('file:///video')).ok, false);

    // Der echte Worker nutzt den generischen Fallback nach Browserfehlern.
    for (const datei of ['video-link.js', 'solver-browser.js']) fs.copyFileSync(path.join(__dirname, datei), path.join(temp, datei));
    fs.mkdirSync(path.join(temp, 'node_modules', 'playwright'), { recursive: true });
    fs.writeFileSync(path.join(temp, 'node_modules', 'playwright', 'index.js'), `exports.chromium={launch:async()=>{throw new Error('Testbrowser fehlgeschlagen')}};`);
    fs.writeFileSync(path.join(temp, 'playmogo.js'), `exports.istPlaymogo=u=>new URL(u).hostname==='playmogo.com';exports.suchen=async()=>({ok:true,url:'https://legacy.test/video.mp4',art:'datei'});`);
    async function worker(link, env = {}) {
      try { const r = await execFile(process.execPath, [path.join(temp, 'video-link.js'), link], { env: { ...process.env, ...env } }); return JSON.parse(r.stdout); }
      catch (e) { if (e.stdout) return JSON.parse(e.stdout); throw e; }
    }
    antwort = gut;
    assert.equal((await worker('https://hoster.test/d/video')).resolver, 'byparr');
    assert.equal((await worker('https://playmogo.com/d/video')).resolver, 'byparr');
    assert.equal(body.url, 'https://playmogo.com/e/video');
    antwort = { ok: false, fehler: 'Solver ausgefallen' };
    assert.equal((await worker('https://playmogo.com/d/video')).url, 'https://legacy.test/video.mp4');
    assert.equal((await worker('https://hoster.test/e/video')).ok, false);
    assert.equal((await worker('https://hoster.test/e/video', { VIDEO_SOLVER_URL: '' })).ok, false);
    assert.equal((await worker('https://playmogo.com/d/video', { VIDEO_SOLVER_URL: '' })).url, 'https://legacy.test/video.mp4');
    delete process.env.VIDEO_SOLVER_URL;
    assert.equal((await suchen('https://hoster.test/e/video')).ok, false);
    console.log('OK: Gemeinsamer HTTP-Solver, MP4/HLS, Antwortlimit, Validierung, generischer Fallback, Playmogo-/e/ und unveränderter Pfad ohne Solver');
  } finally {
    if (vorher === undefined) delete process.env.VIDEO_SOLVER_URL; else process.env.VIDEO_SOLVER_URL = vorher;
    await new Promise((r) => service.close(r));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
