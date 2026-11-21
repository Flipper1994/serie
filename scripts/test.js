#!/usr/bin/env node
// Durchlauf gegen die echte Seite: node test.js
// Jeder Fall startet katalog.js als eigenen Prozess und prüft Rückgabe und JSON.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const skript = path.join(__dirname, 'katalog.js');
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'katalog-test-'));

function aufruf(...args) {
  const r = spawnSync('node', [skript, ...args, '--ausgabe', ordner], { encoding: 'utf8', timeout: 120000 });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {}
  return { code: r.status, json, roh: r.stdout + r.stderr };
}

const faelle = [
  ['Furious 1 5: Folge gefunden', ['Furious', '1', '5'], (r) =>
    r.code === 0 && r.json.serie.titel === 'Furious' && r.json.staffel.anzahlFolgen === 8 &&
    r.json.folge.vorhanden && r.json.folge.titel === 'Wähle einen Sticker'],
  ['Kleinschreibung, ohne Folge', ['breaking bad', '2'], (r) =>
    r.code === 0 && r.json.serie.titel === 'Breaking Bad' && r.json.staffel.anzahlFolgen === 13 &&
    r.json.folge === null && r.json.staffel.folgen[0].titel === 'Vorsichtsmaßnahmen'],
  ['Staffelwechsel landet auf der richtigen Staffel', ['Breaking Bad', '5', '16'], (r) =>
    r.code === 0 && r.json.staffel.nummer === 5 && r.json.browser.endUrl.includes('/Breaking-Bad/5') &&
    r.json.folge.vorhanden],
  ['Staffel 0 = Specials', ['Breaking Bad', '0'], (r) =>
    r.code === 0 && r.json.staffel.name === 'Specials' && r.json.staffel.anzahlFolgen > 0],
  ['Sonderzeichen & im Namen', ['Fast & Furious Spy Racers', '3', '2'], (r) =>
    r.code === 0 && r.json.serie.titel === 'Fast & Furious Spy Racers' && r.json.folge.titel === 'Die Sackgasse'],
  ['Umlaute im Namen', ['Türkisch für Anfänger', '1', '1'], (r) =>
    r.code === 0 && r.json.serie.titel === 'Türkisch für Anfänger' && r.json.folge.vorhanden],
  ['Doppelpunkt und | im Namen', ['MobLand: Familie bis aufs Blut | Mob Land', '2'], (r) =>
    r.code === 0 && r.json.staffel.nummer === 2 && r.json.staffel.anzahlFolgen > 0],
  ['Deutscher Titelteil, viele Staffeln', ['Die Simpsons', '30', '1'], (r) =>
    r.code === 0 && r.json.serie.titel === 'Die Simpsons | The Simpsons' && r.json.staffel.nummer === 30 &&
    r.json.folge.vorhanden],
  ['Originaltitel als Namensteil', ['the simpsons', '1'], (r) =>
    r.code === 0 && r.json.serie.titel === 'Die Simpsons | The Simpsons' && r.json.staffel.nummer === 1],
  ['Leerzeichen um den Namen', ['  Furious  ', '1'], (r) => r.code === 0 && r.json.serie.titel === 'Furious'],
  ['Tippfehler nennt ähnliche Treffer', ['Furios', '1'], (r) =>
    r.code === 1 && r.json.ok === false && r.json.aehnlicheTreffer.includes('Furious')],
  ['Teilname ohne Apostroph und deutschen Zusatz', ['Greys anatomy', '1'], (r) =>
    r.code === 0 && /Grey.?s Anatomy/i.test(r.json.serie.titel) && r.json.staffel.anzahlFolgen > 0],
  ['Fehlende Staffel', ['Furious', '3'], (r) =>
    r.code === 1 && r.json.fehler === 'Staffel 3 gibt es nicht' && r.json.staffeln.join() === '1'],
  ['Fehlende Folge ist kein Fehler', ['Furious', '1', '12'], (r) =>
    r.code === 0 && r.json.folge.vorhanden === false && r.json.staffel.anzahlFolgen === 8],
  ['Aufruf ohne Argumente', [], (r) => r.code === 1 && /Aufruf/.test(r.json.fehler)],
  ['Staffel ist keine Zahl', ['Furious', 'abc'], (r) => r.code === 1 && /Aufruf/.test(r.json.fehler)],
  ['Folge ist keine Zahl', ['Furious', '1', 'x'], (r) => r.code === 1 && /Folge/.test(r.json.fehler)],
];

let fehlgeschlagen = 0;
for (const [name, args, pruefung] of faelle) {
  const r = aufruf(...args);
  let ok = false;
  try {
    ok = pruefung(r);
  } catch {}
  console.log(`${ok ? 'OK    ' : 'FEHLER'} ${name}`);
  if (!ok) {
    fehlgeschlagen++;
    console.log(`       Rückgabe ${r.code}: ${r.roh.replace(/\s+/g, ' ').slice(0, 400)}`);
  }
}
fs.rmSync(ordner, { recursive: true, force: true });
console.log(`\n${faelle.length - fehlgeschlagen} von ${faelle.length} bestanden`);
process.exitCode = fehlgeschlagen ? 1 : 0;
