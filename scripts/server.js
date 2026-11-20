#!/usr/bin/env node
// Kleiner HTTP-Dienst um katalog.js: liefert dessen Ausgabe als JSON.
//
// Aufruf:   API_TOKEN=<geheim> node server.js
// Oberfläche: GET / liefert public/index.html (ohne Token; die Seite fragt
//           das Token selbst ab und schickt es bei jeder Abfrage mit).
// Abfrage:  GET /katalog?serie=<Name>&staffel=<Nr>[&folge=<Nr>][&ausgabe=original|kurz]
//           Kopfzeile „Authorization: Bearer <API_TOKEN>“.
//           Fehlt die Staffel, wird Staffel 1 abgefragt.
//           ausgabe=original (Standard): Ausgabe von katalog.js unverändert
//           (anfrage, serie, staffel, folge, browser).
//           ausgabe=kurz: flache Fassung für die Oberfläche (serie als Titel,
//           folgen, staffeln, sprachen, beschreibung, infos).
//           GET /health antwortet ohne Token und ohne Browserlauf.
// Umgebung: API_TOKEN (Pflicht), PORT (8080), HOST (127.0.0.1),
//           CACHE_MINUTEN (60).
// Status:   200 Erfolg, 400 falscher Aufruf, 401 Token fehlt/falsch,
//           404 Serie oder Staffel fehlt, 429 zu viele wartende Anfragen,
//           502 technischer Fehler beim Auslesen.
//
// In beiden Formen fehlen nur die Anbieter-Links je Folge (staffel.folgen[].hoster).

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const TOKEN = process.env.API_TOKEN || '';
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const CACHE_MS = Number(process.env.CACHE_MINUTEN || 60) * 60 * 1000;
const LAUF_ZEITLIMIT_MS = 90000;
const MAX_WARTEND = 5;
const SKRIPT = path.join(__dirname, 'katalog.js');
const OBERFLAECHE = path.join(__dirname, '..', 'public', 'index.html');
const SICHERHEITS_KOPF = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; " +
    "img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

if (!TOKEN) {
  console.error('API_TOKEN ist nicht gesetzt – der Dienst startet nicht ohne Token.');
  process.exit(1);
}

// Startet katalog.js als eigenen Prozess; so bleibt ein hängender Browser
// vom Dienst getrennt und wird nach dem Zeitlimit beendet.
function skriptLauf(serie, staffel) {
  return new Promise((fertig) => {
    const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'serien-katalog-'));
    execFile(
      process.execPath,
      [SKRIPT, serie, String(staffel), '--ausgabe', ordner],
      { timeout: LAUF_ZEITLIMIT_MS, maxBuffer: 10 * 1024 * 1024 },
      (fehler, stdout) => {
        fs.rmSync(ordner, { recursive: true, force: true });
        let daten = null;
        try {
          daten = JSON.parse(stdout);
        } catch {
          // kein lesbares JSON: unten als technischer Fehler behandelt
        }
        const code = fehler ? (typeof fehler.code === 'number' ? fehler.code : 2) : 0;
        if (!daten) fertig({ code: 2, daten: { ok: false, fehler: 'Das Skript lieferte keine lesbare Ausgabe' } });
        else fertig({ code, daten });
      },
    );
  });
}

// Es läuft immer nur ein Browser gleichzeitig; weitere Anfragen warten.
let schlange = Promise.resolve();
let wartend = 0;
function eingereiht(aufgabe) {
  wartend++;
  const lauf = schlange.then(aufgabe).finally(() => wartend--);
  schlange = lauf.catch(() => {});
  return lauf;
}

const cache = new Map();
const laufend = new Map();

// Entfernt die Anbieter-Links (Links zu Streams) aus den Folgen; alles andere
// bleibt wie von katalog.js geliefert.
function ohneAnbieterLinks(daten) {
  return {
    ...daten,
    staffel: { ...daten.staffel, folgen: daten.staffel.folgen.map(({ hoster, ...folge }) => folge) },
  };
}

const AUSGABEN = ['original', 'kurz'];

// Baut die Antwort in der gewünschten Form. daten ist die Originalausgabe
// (ohne Anbieter-Links); folge ist die angefragte Folgennummer oder null.
function ausgabeBauen(daten, ausgabe, folge) {
  const antwort = ausgabe === 'kurz' ? { ok: true, ...kuerzen(daten) } : { ...daten };
  if (folge !== null) {
    const gesucht = daten.staffel.folgen.find((f) => f.nummer === folge);
    antwort.folge = gesucht ? { vorhanden: true, ...gesucht } : { vorhanden: false, nummer: folge };
    if (ausgabe === 'original') antwort.anfrage = { ...daten.anfrage, folge };
  }
  return antwort;
}

function kuerzen(daten) {
  return {
    serie: daten.serie.titel,
    beschreibung: daten.serie.beschreibung,
    infos: daten.serie.infos,
    staffel: daten.staffel.nummer,
    anzahlFolgen: daten.staffel.anzahlFolgen,
    folgen: daten.staffel.folgen.map((f) => ({ nummer: f.nummer, titel: f.titel })),
    staffeln: daten.serie.staffeln,
    sprachen: daten.serie.sprachen,
  };
}

// Liefert { status, inhalt } für eine Serie und Staffel. Erfolge werden
// zwischengespeichert; gleiche Anfragen zur selben Zeit teilen sich einen Lauf.
function staffelHolen(serie, staffel) {
  const schluessel = `${serie.toLowerCase()}|${staffel}`;
  const treffer = cache.get(schluessel);
  if (treffer && treffer.bis > Date.now()) return Promise.resolve({ status: 200, inhalt: treffer.inhalt });
  if (laufend.has(schluessel)) return laufend.get(schluessel);
  if (wartend >= MAX_WARTEND) {
    return Promise.resolve({ status: 429, inhalt: { ok: false, fehler: 'Zu viele wartende Anfragen, bitte später erneut versuchen' } });
  }

  const lauf = eingereiht(async () => {
    let ergebnis = await skriptLauf(serie, staffel);
    if (ergebnis.code === 2) ergebnis = await skriptLauf(serie, staffel);
    if (ergebnis.code === 0 && ergebnis.daten.ok) {
      const inhalt = ohneAnbieterLinks(ergebnis.daten);
      cache.set(schluessel, { bis: Date.now() + CACHE_MS, inhalt });
      return { status: 200, inhalt };
    }
    return { status: ergebnis.code === 1 ? 404 : 502, inhalt: ergebnis.daten };
  }).finally(() => laufend.delete(schluessel));
  laufend.set(schluessel, lauf);
  return lauf;
}

function tokenStimmt(kopfzeile) {
  const erwartet = Buffer.from(`Bearer ${TOKEN}`);
  const erhalten = Buffer.from(String(kopfzeile || ''));
  return erhalten.length === erwartet.length && crypto.timingSafeEqual(erhalten, erwartet);
}

function antworten(res, status, inhalt) {
  const text = JSON.stringify(inhalt, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

const ganzzahl = (wert) => /^\d{1,4}$/.test(wert);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET') return antworten(res, 405, { ok: false, fehler: 'Nur GET ist erlaubt' });
  if (url.pathname === '/health') return antworten(res, 200, { ok: true });
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return fs.readFile(OBERFLAECHE, (fehler, inhalt) => {
      if (fehler) return antworten(res, 500, { ok: false, fehler: 'Oberfläche fehlt' });
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': inhalt.length,
        'Cache-Control': 'no-cache',
        ...SICHERHEITS_KOPF,
      });
      res.end(inhalt);
    });
  }
  if (url.pathname !== '/katalog') return antworten(res, 404, { ok: false, fehler: 'Unbekannter Pfad' });
  if (!tokenStimmt(req.headers.authorization)) return antworten(res, 401, { ok: false, fehler: 'Token fehlt oder ist falsch' });

  const serie = (url.searchParams.get('serie') || '').trim();
  const staffelArg = url.searchParams.get('staffel') ?? '1';
  const folgeArg = url.searchParams.get('folge');
  const ausgabe = url.searchParams.get('ausgabe') ?? 'original';
  if (!serie || serie.length > 200 || !ganzzahl(staffelArg) || (folgeArg !== null && !ganzzahl(folgeArg)) ||
      !AUSGABEN.includes(ausgabe)) {
    return antworten(res, 400, {
      ok: false,
      fehler: 'Aufruf: /katalog?serie=<Name>&staffel=<Nr>[&folge=<Nr>][&ausgabe=original|kurz]',
    });
  }

  try {
    const { status, inhalt } = await staffelHolen(serie, Number(staffelArg));
    if (status !== 200) return antworten(res, status, inhalt);
    antworten(res, 200, ausgabeBauen(inhalt, ausgabe, folgeArg === null ? null : Number(folgeArg)));
  } catch (fehler) {
    antworten(res, 502, { ok: false, fehler: String(fehler.message).split('\n')[0] });
  }
});

server.listen(PORT, HOST, () => console.log(`serien-katalog lauscht auf http://${HOST}:${PORT}`));
