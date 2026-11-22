#!/usr/bin/env node
// Zusammenhängende Regression ohne kostenpflichtige Captcha-Aufträge.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const tests = [
  [process.execPath, 'test-playmogo.js'],
  [process.execPath, 'test-solver-browser.js'],
  [process.execPath, 'test-video-proxy.js'],
  [process.execPath, 'test-suche.js'],
  [python, 'test-captcha-api.py'],
  ...(process.platform === 'linux' ? [[process.execPath, 'test-fortschritt.js']] : []),
  [process.execPath, 'test-flipperflix.js'],
  [process.execPath, 'test-cover.js'],
  [process.execPath, 'test-anbieter.js'],
  ...(process.platform === 'linux' ? [[process.execPath, 'test-serien-e2e.js']] : []),
];
for (const [programm, datei] of tests) {
  console.log(`Prüfe ${datei}`);
  const r = spawnSync(programm, [path.join(__dirname, datei)], { stdio: 'inherit', env: process.env, timeout: 300000 });
  if (r.status !== 0) { console.error(`Fehlgeschlagen: ${datei}`); process.exit(1); }
}
console.log('Testsuite erfolgreich. Keine kostenpflichtigen Captcha-Aufträge angelegt.');
