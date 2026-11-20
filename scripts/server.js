#!/usr/bin/env node
// Kleiner HTTP-Dienst um katalog.js: liefert die gekürzte Fassung als JSON.
//
// Aufruf:   API_TOKEN=<geheim> node server.js
// Abfrage:  GET /katalog?serie=<Name>&staffel=<Nr>[&folge=<Nr>]
//           Kopfzeile „Authorization: Bearer <API_TOKEN>“.
//           Fehlt die Staffel, wird Staffel 1 abgefragt.
//           GET /health antwortet ohne Token und ohne Browserlauf.
// Umgebung: API_TOKEN (Pflicht), PORT (8080), HOST (127.0.0.1),
//           CACHE_MINUTEN (60).
// Status:   200 Erfolg, 400 falscher Aufruf, 401 Token fehlt/falsch,
//           404 Serie oder Staffel fehlt, 429 zu viele wartende Anfragen,
//           502 technischer Fehler beim Auslesen.
//
// Die Antwort enthält nur Titel, Staffeln, Sprachen und je Folge Nummer und
// Titel – keine Beschreibung, keine Besetzung, keine Anbieter-Links.

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

function kuerzen(daten) {
  return {
    serie: daten.serie.titel,
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
      const inhalt = kuerzen(ergebnis.daten);
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
  if (url.pathname !== '/katalog') return antworten(res, 404, { ok: false, fehler: 'Unbekannter Pfad' });
  if (!tokenStimmt(req.headers.authorization)) return antworten(res, 401, { ok: false, fehler: 'Token fehlt oder ist falsch' });

  const serie = (url.searchParams.get('serie') || '').trim();
  const staffelArg = url.searchParams.get('staffel') ?? '1';
  const folgeArg = url.searchParams.get('folge');
  if (!serie || serie.length > 200 || !ganzzahl(staffelArg) || (folgeArg !== null && !ganzzahl(folgeArg))) {
    return antworten(res, 400, { ok: false, fehler: 'Aufruf: /katalog?serie=<Name>&staffel=<Nr>[&folge=<Nr>]' });
  }

  try {
    const { status, inhalt } = await staffelHolen(serie, Number(staffelArg));
    if (status !== 200) return antworten(res, status, inhalt);
    const antwort = { ok: true, ...inhalt };
    if (folgeArg !== null) {
      const nummer = Number(folgeArg);
      const gesucht = inhalt.folgen.find((f) => f.nummer === nummer);
      antwort.folge = gesucht ? { vorhanden: true, ...gesucht } : { vorhanden: false, nummer };
    }
    antworten(res, 200, antwort);
  } catch (fehler) {
    antworten(res, 502, { ok: false, fehler: String(fehler.message).split('\n')[0] });
  }
});

server.listen(PORT, HOST, () => console.log(`serien-katalog lauscht auf http://${HOST}:${PORT}`));
