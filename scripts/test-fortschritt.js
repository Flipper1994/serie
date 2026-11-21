#!/usr/bin/env node
// Linux-Integration: echter HTTP-Dienst, kontrollierter Freigabe-Prozess.
// Prüft Fortschrittsmeldungen und dass Cache-Treffer die Warteschlange umgehen.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'serie-status-test-'));
  const scripts = path.join(temp, 'scripts'); fs.mkdirSync(scripts);
  const bin = path.join(temp, 'bin'); fs.mkdirSync(bin);
  fs.copyFileSync(path.join(__dirname, 'server.js'), path.join(scripts, 'server.js'));
  fs.writeFileSync(path.join(scripts, 'video-link.js'), `setTimeout(() => console.log(JSON.stringify({ok:true,url:'https://example.com/video.mp4',art:'datei',titel:'Cachevideo'})), 300);`);
  const worker = path.join(bin, 'xvfb-run');
  fs.writeFileSync(worker, `#!/usr/bin/env node
const fs=require('fs');fs.appendFileSync(process.env.DATEN_ORDNER+'/starts','x');
const line=JSON.stringify({fortschritt:{phase:'pruefung',detail:'Bilder werden geprüft',versuch:2,maxVersuche:3,runde:4,versuchSeit:Date.now(),versuchLimit:180}})+'\\n';
process.stdout.write(line.slice(0,11));setTimeout(()=>process.stdout.write(line.slice(11)),30);
setTimeout(()=>console.log(JSON.stringify({ok:false,fehler:'Kontrollierter Testfehler'})),2500);
`);
  fs.chmodSync(worker, 0o755);
  const cold = 'https://burningseries.ac/serie/Test/1/1-Test/de/VOE';
  const next = cold.replace('/VOE', '/Vidmoly');
  const warm = cold.replace('/VOE', '/Filemoon');
  fs.writeFileSync(path.join(temp, 'anbieter.json'), JSON.stringify({ [warm]: { bis: Date.now() / 1000 + 600, url: 'https://example.com/hoster' } }));
  const frei = net.createServer(); await new Promise((r) => frei.listen(0, '127.0.0.1', r));
  const port = frei.address().port; await new Promise((r) => frei.close(r));
  const dienst = spawn(process.execPath, [path.join(scripts, 'server.js')], {
    env: { ...process.env, API_TOKEN: 'test', HOST: '127.0.0.1', PORT: String(port), DATEN_ORDNER: temp, YT_DLP_PATH: '/nicht-installiert', PATH: `${bin}:${process.env.PATH}` }, stdio: 'ignore',
  });
  const basis = `http://127.0.0.1:${port}`;
  async function holen(url) {
    const r = await fetch(`${basis}/stream?${new URLSearchParams({ url })}`, { headers: { Authorization: 'Bearer test' } });
    return { status: r.status, ...(await r.json()) };
  }
  try {
    for (let i = 0; i < 100; i++) { if (await fetch(`${basis}/health`).then((r) => r.ok).catch(() => false)) break; await pause(50); }
    assert.equal((await holen(cold)).status, 202);
    let stand;
    for (let i = 0; i < 30; i++) { stand = await holen(cold); if (stand.fortschritt.phase === 'pruefung') break; await pause(40); }
    assert.equal(stand.fortschritt.phase, 'pruefung');
    assert.equal(stand.fortschritt.versuch, 2);
    assert.equal(stand.fortschritt.runde, 4);
    assert.ok(stand.fortschritt.serverZeit >= stand.fortschritt.begonnen);
    assert.ok(stand.fortschritt.verlauf.some((e) => e.phase === 'pruefung'));
    const queued = await holen(next);
    assert.equal(queued.status, 202); assert.equal(queued.fortschritt.vorDir, 1);
    const start = Date.now();
    await holen(warm);
    let result;
    for (let i = 0; i < 30; i++) { result = await holen(warm); if (result.status !== 202) break; await pause(40); }
    assert.equal(result.status, 200, 'Gespeicherte Freigabe darf nicht hinter der laufenden Bildprüfung warten');
    assert.ok(Date.now() - start < 1800);
    assert.equal(fs.readFileSync(path.join(temp, 'starts'), 'utf8'), 'x', 'Gleiche Anfragen starten keinen zweiten Worker');
    assert.ok(result.fortschritt.verlauf[0].detail.includes('entfällt'));
    for (let i = 0; i < 80; i++) { stand = await holen(cold); if (stand.status !== 202) break; await pause(40); }
    assert.equal(stand.status, 502); assert.equal(stand.fortschritt.phase, 'fehler');
    console.log('OK: JSONL-Status, Versuch/Bildrunde, Warteschlangenposition, geteilte Anfrage, Fehler und Cache-Vorrang');
    // Den zweiten kontrollierten Worker fertig laufen lassen, bevor der Testdienst endet.
    await pause(2700);
  } finally {
    dienst.kill();
    await new Promise((r) => dienst.once('exit', r));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
