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
//           (anfrage, serie, staffel, folge, browser), inkl. Anbieter-Links.
//           ausgabe=kurz: flache Fassung für die Oberfläche (serie als Titel,
//           folgen, staffeln, sprachen, beschreibung, infos).
//           GET /health antwortet ohne Token und ohne Browserlauf.
// Register: GET /gesehen liefert alle Serien mit abgehakten Folgen.
//           POST /gesehen mit JSON { serie, staffel, folgen: [Nr, …],
//           gesehen: true|false, anzahlFolgen?, staffeln? } hakt Folgen ab
//           oder nimmt den Haken weg; { serie, entfernen: true } löscht eine
//           Serie aus dem Register. Beides mit demselben Token.
// Video:    GET /video liefert public/video.html: Link einfügen, abspielen,
//           auf den Fernseher streamen. GET /stream?url=<Link> (mit Token)
//           löst den Link auf und liefert neben der direkten Adresse (mp4)
//           auch titel, art (datei|hls) und medien – eine signierte, zeitlich
//           begrenzte Adresse, unter der dieser Dienst das Video durchleitet.
//           GET /medien?… braucht kein Token (die Signatur genügt), damit
//           auch ein Chromecast das Video laden kann.
// Umgebung: API_TOKEN (Pflicht), PORT (8080), HOST (127.0.0.1),
//           CACHE_MINUTEN (60), DATEN_ORDNER (<Projekt>/daten),
//           STREAM_CACHE_MINUTEN (30), STREAM_MAX_PARALLEL (3),
//           STREAM_MAX_WARTEND (5), STREAM_TIMEOUT_MS (30000),
//           YT_DLP_PATH (Pfad zum yt-dlp-Binary, default: „yt-dlp"),
//           MEDIEN_GUELTIG_STUNDEN (6).
// Status:   200 Erfolg, 400 falscher Aufruf, 401 Token fehlt/falsch,
//           404 Serie oder Staffel fehlt, 429 zu viele wartende Anfragen,
//           500 Register nicht speicherbar, 502 technischer Fehler beim Auslesen.

const http = require('http');
const https = require('https');
const { pipeline } = require('stream');
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
const VIDEO_SKRIPT = path.join(__dirname, 'video-link.js');
const VIDEO_SEITE = path.join(__dirname, '..', 'public', 'video.html');
const DATEN_ORDNER = process.env.DATEN_ORDNER || path.join(__dirname, '..', 'daten');
const REGISTER_DATEI = path.join(DATEN_ORDNER, 'gesehen.json');
const MAX_KOERPER = 64 * 1024;
const MAX_SERIEN = 5000;

// ---------- Stream-Resolver-Konfiguration ----------
const YT_DLP_PATH = process.env.YT_DLP_PATH || 'yt-dlp';
const STREAM_CACHE_MS = Number(process.env.STREAM_CACHE_MINUTEN || 30) * 60 * 1000;
const STREAM_MAX_PARALLEL = Number(process.env.STREAM_MAX_PARALLEL || 3);
const STREAM_MAX_WARTEND = Number(process.env.STREAM_MAX_WARTEND || 5);
const STREAM_TIMEOUT_MS = Number(process.env.STREAM_TIMEOUT_MS || 30000);
// Durchleitung (/medien): Gültigkeit der signierten Adressen und der Browser,
// als der sich yt-dlp und die Durchleitung gleichermaßen ausgeben.
const MEDIEN_GUELTIG_MS = Number(process.env.MEDIEN_GUELTIG_STUNDEN || 6) * 60 * 60 * 1000;
const MEDIEN_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MEDIEN_MAX_LISTE = 2 * 1024 * 1024;
const MEDIEN_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
};
// Die Videoseite lädt zusätzlich das Cast-SDK von Google und darf Medien einbinden.
const VIDEO_KOPF = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'unsafe-inline' https://www.gstatic.com; style-src 'unsafe-inline'; " +
    "connect-src 'self'; media-src 'self' https: http: blob:; img-src 'self' data: https:; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
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

const AUSGABEN = ['original', 'kurz'];

// Baut die Antwort in der gewünschten Form. daten ist die Originalausgabe
// (inkl. Anbieter-Links); folge ist die angefragte Folgennummer oder null.
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
      const inhalt = ergebnis.daten;
      cache.set(schluessel, { bis: Date.now() + CACHE_MS, inhalt });
      return { status: 200, inhalt };
    }
    return { status: ergebnis.code === 1 ? 404 : 502, inhalt: ergebnis.daten };
  }).finally(() => laufend.delete(schluessel));
  laufend.set(schluessel, lauf);
  return lauf;
}

// ---------- Stream-Resolver ----------
// Löst die direkte Video-URL aus einer Hoster-Seite via yt-dlp auf.
// Eigener Cache (signierte URLs gelten meist 2-24 h) und eigene Queue
// (mehrere Hoster parallel auflösen, aber begrenzt).

const streamCache = new Map();      // key = url-hash → { bis, inhalt }
let streamLaufend = 0;               // aktuell laufende yt-dlp-Prozesse
let streamWartend = 0;               // wartende Anfragen

// SSRF-Schutz: lokale/interne Adressen ablehnen.
function istLokal(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h === 'localhost.' || h.endsWith('.localhost')) return true;
  if (h === '0.0.0.0' || h === '::' || h === '::1' || h === '[::1]') return true;
  // IPv4 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }
  // IPv6 unique local fc00::/7
  if (/^f[cd][0-9a-f]{2}:/.test(h) || h.startsWith('fe80:')) return true;
  return false;
}

// Führt yt-dlp aus und liefert die direkte Video-URL samt Titel, Art
// (datei = eine durchgehende Datei, hls = Wiedergabeliste) und Referer.
function ytDlpLauf(videoUrl) {
  return new Promise((fertig) => {
    execFile(
      YT_DLP_PATH,
      ['--dump-single-json', '--no-warnings', '--no-playlist', '--no-check-certificates',
        '--format', 'b[ext=mp4][height<=1080]/b[ext=mp4]/b[height<=1080]/b', '--user-agent', MEDIEN_AGENT, '--', videoUrl],
      { timeout: STREAM_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (fehler, stdout, stderr) => {
        if (fehler) {
          if (fehler.code === 'ENOENT') return fertig({ ok: false, fehler: 'yt-dlp ist auf dem Server nicht installiert' });
          const msg = String(stderr || fehler.message || '').split('\n')[0].slice(0, 200);
          return fertig({ ok: false, fehler: msg || 'yt-dlp fehlgeschlagen' });
        }
        let info = null;
        try { info = JSON.parse(stdout); } catch { /* unten behandelt */ }
        const url = info && typeof info.url === 'string' ? info.url : '';
        if (!/^https?:\/\//.test(url)) return fertig({ ok: false, fehler: 'Keine Video-URL gefunden' });
        const kopf = info.http_headers || {};
        const hls = /m3u8/.test(String(info.protocol || '')) || /\.m3u8(\?|$)/.test(url);
        fertig({
          ok: true,
          mp4: url,
          titel: typeof info.title === 'string' ? info.title.slice(0, 200) : '',
          art: hls ? 'hls' : 'datei',
          referer: typeof kopf.Referer === 'string' ? kopf.Referer.slice(0, 2048) : '',
        });
      },
    );
  });
}

// Rückfall für Anbieter, die yt-dlp nicht kennt (z. B. VOE): video-link.js
// öffnet die Seite im Headless-Browser und liest mit, was der Player lädt.
function browserLauf(videoUrl) {
  return new Promise((fertig) => {
    execFile(
      process.execPath, [VIDEO_SKRIPT, videoUrl],
      { timeout: 70000, maxBuffer: 1024 * 1024, env: { ...process.env, MEDIEN_AGENT } },
      (fehler, stdout) => {
        let d = null;
        try { d = JSON.parse(stdout); } catch { /* unten behandelt */ }
        if (!d) return fertig({ ok: false, fehler: 'keine lesbare Ausgabe' });
        if (!d.ok || !/^https?:\/\//.test(String(d.url))) return fertig({ ok: false, fehler: d.fehler || 'kein Video gefunden' });
        fertig({
          ok: true, mp4: d.url, titel: String(d.titel || '').slice(0, 200),
          art: d.art === 'hls' ? 'hls' : 'datei', referer: String(d.referer || '').slice(0, 2048),
        });
      },
    );
  });
}

// Eigene Queue für Stream-Aufrufe: begrenzt parallele yt-dlp-Prozesse.
function streamEingereiht(aufgabe) {
  if (streamWartend >= STREAM_MAX_WARTEND) {
    return Promise.resolve({ status: 429, inhalt: { ok: false, fehler: 'Zu viele wartende Stream-Anfragen' } });
  }
  streamWartend++;
  // Warten, bis ein Slot frei ist.
  const warte = () => {
    if (streamLaufend < STREAM_MAX_PARALLEL) {
      streamLaufend++;
      streamWartend--;
      return Promise.resolve();
    }
    return new Promise((r) => setTimeout(r, 50)).then(warte);
  };
  return warte().then(() => aufgabe()).finally(() => streamLaufend--);
}

// Liefert { status, inhalt } für eine Hoster-URL.
function streamHolen(videoUrl) {
  const schluessel = crypto.createHash('sha256').update(videoUrl).digest('hex');
  const treffer = streamCache.get(schluessel);
  const antwort = (e, cached) => ({
    status: 200,
    inhalt: { ok: true, mp4: e.mp4, cached, titel: e.titel, art: e.art, medien: medienPfad(e.mp4, e.referer) },
  });
  if (treffer && treffer.bis > Date.now()) return Promise.resolve(antwort(treffer.inhalt, true));
  return streamEingereiht(async () => {
    let ergebnis = await ytDlpLauf(videoUrl);
    if (!ergebnis.ok) {
      // Es läuft nur ein Browser gleichzeitig (gemeinsame Schlange mit dem Katalog).
      const ausBrowser = await eingereiht(() => browserLauf(videoUrl));
      if (ausBrowser.ok) ergebnis = ausBrowser;
      else ergebnis.fehler = `${ergebnis.fehler} · Browser: ${ausBrowser.fehler}`;
    }
    if (ergebnis.ok) {
      streamCache.set(schluessel, { bis: Date.now() + STREAM_CACHE_MS, inhalt: ergebnis });
      return antwort(ergebnis, false);
    }
    return { status: 502, inhalt: { ok: false, fehler: ergebnis.fehler } };
  });
}

// ---------- Durchleitung (/medien) ----------
// Viele Anbieter geben das Video nur an die Adresse heraus, die den Link
// aufgelöst hat (also diesen Server), oder verlangen einen Referer. Ein
// Chromecast lädt das Video außerdem selbst und kann kein Token mitschicken.
// Deshalb leitet der Dienst das Video unter einer signierten Adresse durch.
const MEDIEN_SCHLUESSEL = crypto.createHmac('sha256', TOKEN).update('medien-signatur').digest();
const medienSignatur = (ab, referer, ziel) =>
  crypto.createHmac('sha256', MEDIEN_SCHLUESSEL).update(`${ab}\n${referer}\n${ziel}`).digest('base64url');

// Relative Adresse; so stimmt sie auch hinter einem Reverse-Proxy mit Pfad.
function medienPfad(ziel, referer, ab = Date.now() + MEDIEN_GUELTIG_MS) {
  const p = new URLSearchParams({ ab: String(ab), s: medienSignatur(ab, referer || '', ziel) });
  if (referer) p.set('r', referer);
  p.set('u', ziel);
  return `medien?${p}`;
}

// Holt die Quelle und folgt Weiterleitungen selbst, damit keine davon auf
// eine interne Adresse führt. Liefert { antwort, adresse }.
function quelleHolen(adresse, methode, kopf, signal, rest = 5) {
  return new Promise((fertig, abgelehnt) => {
    if (adresse.protocol !== 'http:' && adresse.protocol !== 'https:') return abgelehnt(new Error('Nur http(s) ist erlaubt'));
    if (istLokal(adresse.hostname)) return abgelehnt(new Error('Lokale Adressen sind nicht erlaubt'));
    const anfrage = (adresse.protocol === 'https:' ? https : http).request(
      adresse, { method: methode, headers: kopf, signal, timeout: 20000 },
      (antwort) => {
        const weiter = [301, 302, 303, 307, 308].includes(antwort.statusCode) && antwort.headers.location;
        if (!weiter) return fertig({ antwort, adresse });
        antwort.resume();
        if (rest <= 0) return abgelehnt(new Error('Zu viele Weiterleitungen'));
        let naechste;
        try { naechste = new URL(weiter, adresse); } catch { return abgelehnt(new Error('Ungültige Weiterleitung')); }
        quelleHolen(naechste, methode, kopf, signal, rest - 1).then(fertig, abgelehnt);
      },
    );
    anfrage.on('timeout', () => anfrage.destroy(new Error('Die Quelle antwortet nicht')));
    anfrage.on('error', abgelehnt);
    anfrage.end();
  });
}

// Schreibt in einer HLS-Wiedergabeliste jede Adresse auf die Durchleitung um.
function listeUmschreiben(text, basis, referer, ab) {
  const um = (roh) => {
    try { return medienPfad(new URL(roh.trim(), basis).href, referer, ab); } catch { return roh; }
  };
  return text.split(/\r?\n/).map((zeile) => {
    if (!zeile.trim()) return zeile;
    if (zeile.startsWith('#')) return zeile.replace(/URI="([^"]+)"/g, (_, adresse) => `URI="${um(adresse)}"`);
    return um(zeile);
  }).join('\n');
}

async function medienAusliefern(req, res, url) {
  const text = (status, meldung) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...MEDIEN_CORS });
    res.end(req.method === 'HEAD' ? undefined : meldung);
  };
  const ziel = url.searchParams.get('u') || '';
  const referer = url.searchParams.get('r') || '';
  const ab = url.searchParams.get('ab') || '';
  const erhalten = Buffer.from(url.searchParams.get('s') || '');
  const erwartet = Buffer.from(medienSignatur(ab, referer, ziel));
  if (erhalten.length !== erwartet.length || !crypto.timingSafeEqual(erhalten, erwartet)) return text(403, 'Signatur ungültig');
  if (!(Number(ab) > Date.now())) return text(410, 'Der Link ist abgelaufen – das Video bitte neu öffnen');

  const kopf = { 'User-Agent': MEDIEN_AGENT, Accept: '*/*', 'Accept-Encoding': 'identity' };
  if (referer) {
    kopf.Referer = referer;
    try { kopf.Origin = new URL(referer).origin; } catch { /* ohne Origin */ }
  }
  if (req.headers.range) kopf.Range = req.headers.range;
  const abbruch = new AbortController();
  res.on('close', () => abbruch.abort());

  let antwort, adresse;
  try {
    ({ antwort, adresse } = await quelleHolen(new URL(ziel), req.method, kopf, abbruch.signal));
  } catch (fehler) {
    if (abbruch.signal.aborted) return;
    return text(502, `Quelle nicht erreichbar: ${String(fehler.message).split('\n')[0]}`);
  }

  const typ = String(antwort.headers['content-type'] || '');
  const laenge = Number(antwort.headers['content-length'] || 0);
  let anfang = null;
  let liste = /mpegurl/i.test(typ) || /\.m3u8$/i.test(adresse.pathname);
  // Manche Anbieter liefern Wiedergabelisten unter falschem Typ: Anfang prüfen.
  if (!liste && req.method === 'GET' && antwort.statusCode === 200 && laenge <= MEDIEN_MAX_LISTE) {
    anfang = await new Promise((fertig) => {
      antwort.once('readable', () => fertig(antwort.read()));
      antwort.once('error', () => fertig(null));
    });
    liste = !!anfang && anfang.subarray(0, 7).toString('latin1') === '#EXTM3U';
  }

  // Wiedergabelisten immer ganz holen, auch wenn der Abspieler nur einen Teil wollte.
  if (liste && req.method === 'GET' && antwort.statusCode === 206) {
    antwort.destroy();
    delete kopf.Range;
    try {
      ({ antwort, adresse } = await quelleHolen(adresse, 'GET', kopf, abbruch.signal));
    } catch (fehler) {
      if (abbruch.signal.aborted) return;
      return text(502, `Quelle nicht erreichbar: ${String(fehler.message).split('\n')[0]}`);
    }
  }

  if (liste && req.method === 'GET' && antwort.statusCode === 200) {
    const teile = anfang ? [anfang] : [];
    let groesse = anfang ? anfang.length : 0;
    try {
      for await (const teil of antwort) {
        groesse += teil.length;
        if (groesse > MEDIEN_MAX_LISTE) throw new Error('Wiedergabeliste zu groß');
        teile.push(teil);
      }
    } catch (fehler) {
      antwort.destroy();
      if (abbruch.signal.aborted) return;
      return text(502, `Quelle nicht lesbar: ${String(fehler.message).split('\n')[0]}`);
    }
    const inhalt = Buffer.from(listeUmschreiben(Buffer.concat(teile).toString('utf8'), adresse, referer, ab));
    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Content-Length': inhalt.length,
      'Cache-Control': 'no-store',
      ...MEDIEN_CORS,
    });
    return res.end(inhalt);
  }

  const ausgang = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...MEDIEN_CORS };
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    if (antwort.headers[name]) ausgang[name] = antwort.headers[name];
  }
  // Nie als Webseite ausliefern: sonst liefe fremdes HTML unter dieser Adresse.
  if (/html|javascript|xml/i.test(typ)) ausgang['content-type'] = 'application/octet-stream';
  res.writeHead(antwort.statusCode, ausgang);
  if (req.method === 'HEAD') { antwort.destroy(); return res.end(); }
  if (anfang) res.write(anfang);
  pipeline(antwort, res, () => {});
}

// ---------- Gesehen-Register ----------
// Eine JSON-Datei: { serien: { <titel klein>: { titel, staffeln, geaendert,
// gesehen: { <Staffelnr>: { anzahlFolgen, folgen: [Nr, …] } } } } }
function registerLaden() {
  let text;
  try {
    text = fs.readFileSync(REGISTER_DATEI, 'utf8');
  } catch (fehler) {
    if (fehler.code === 'ENOENT') return { serien: {} };
    throw fehler;
  }
  try {
    const daten = JSON.parse(text);
    if (daten && typeof daten.serien === 'object' && daten.serien !== null) return daten;
    throw new Error('unerwarteter Aufbau');
  } catch {
    // Unlesbare Datei nicht überschreiben, sondern zur Seite legen.
    const ablage = `${REGISTER_DATEI}.unlesbar-${Date.now()}`;
    fs.renameSync(REGISTER_DATEI, ablage);
    console.error(`Register war nicht lesbar und liegt jetzt unter ${ablage}; es wird ein leeres angelegt.`);
    return { serien: {} };
  }
}

function registerSpeichern() {
  fs.mkdirSync(DATEN_ORDNER, { recursive: true });
  const vorlaeufig = `${REGISTER_DATEI}.neu`;
  fs.writeFileSync(vorlaeufig, JSON.stringify(register, null, 2));
  fs.renameSync(vorlaeufig, REGISTER_DATEI);
}

const register = registerLaden();
const nummer = (wert) => Number.isInteger(wert) && wert >= 0 && wert <= 9999;

// Wendet eine Änderung an. Liefert { status, inhalt }.
function registerAendern(eingabe) {
  const falsch = (fehler) => ({ status: 400, inhalt: { ok: false, fehler } });
  if (!eingabe || typeof eingabe !== 'object' || Array.isArray(eingabe)) return falsch('JSON-Objekt erwartet');
  const titel = typeof eingabe.serie === 'string' ? eingabe.serie.trim() : '';
  if (!titel || titel.length > 200) return falsch('serie fehlt oder ist zu lang');
  const schluessel = titel.toLowerCase();
  const vorher = register.serien[schluessel] ? JSON.stringify(register.serien[schluessel]) : null;

  if (eingabe.entfernen === true) {
    delete register.serien[schluessel];
  } else {
    const { staffel, folgen, gesehen, anzahlFolgen, staffeln } = eingabe;
    if (!nummer(staffel)) return falsch('staffel muss eine ganze Zahl sein');
    if (!Array.isArray(folgen) || folgen.length === 0 || folgen.length > 2000 || !folgen.every(nummer)) {
      return falsch('folgen muss eine Liste ganzer Zahlen sein');
    }
    if (typeof gesehen !== 'boolean') return falsch('gesehen muss true oder false sein');
    if (anzahlFolgen !== undefined && !nummer(anzahlFolgen)) return falsch('anzahlFolgen muss eine ganze Zahl sein');
    if (staffeln !== undefined && !(Array.isArray(staffeln) && staffeln.length <= 300 &&
        staffeln.every((s) => typeof s === 'string' && s.length <= 60))) {
      return falsch('staffeln muss eine Liste kurzer Texte sein');
    }
    if (!register.serien[schluessel] && Object.keys(register.serien).length >= MAX_SERIEN) {
      return falsch('Das Register ist voll');
    }

    const eintrag = register.serien[schluessel] || { titel, staffeln: [], geaendert: null, gesehen: {} };
    eintrag.titel = titel;
    if (staffeln) eintrag.staffeln = staffeln;
    const s = eintrag.gesehen[staffel] || { anzahlFolgen: null, folgen: [] };
    if (anzahlFolgen !== undefined) s.anzahlFolgen = anzahlFolgen;
    const menge = new Set(s.folgen);
    for (const f of folgen) gesehen ? menge.add(f) : menge.delete(f);
    s.folgen = [...menge].sort((a, b) => a - b);
    if (s.folgen.length) eintrag.gesehen[staffel] = s;
    else delete eintrag.gesehen[staffel];
    eintrag.geaendert = new Date().toISOString();
    // Ohne einen einzigen Haken verschwindet die Serie wieder aus dem Register.
    if (Object.keys(eintrag.gesehen).length) register.serien[schluessel] = eintrag;
    else delete register.serien[schluessel];
  }

  try {
    registerSpeichern();
  } catch (fehler) {
    // Stand im Speicher zurücksetzen, damit er zur Datei passt.
    if (vorher) register.serien[schluessel] = JSON.parse(vorher);
    else delete register.serien[schluessel];
    console.error(`Register ließ sich nicht speichern: ${fehler.code || fehler.message}`);
    return { status: 500, inhalt: { ok: false, fehler: 'Das Register ließ sich nicht speichern' } };
  }
  return { status: 200, inhalt: { ok: true, serie: register.serien[schluessel] || null } };
}

// Liest den Anfragekörper als JSON; null bei zu großem oder unlesbarem Inhalt.
function koerperLesen(req) {
  return new Promise((fertig) => {
    const teile = [];
    let groesse = 0;
    req.on('data', (teil) => {
      groesse += teil.length;
      if (groesse > MAX_KOERPER) {
        fertig(null);
        req.destroy();
      } else teile.push(teil);
    });
    req.on('end', () => {
      try {
        fertig(JSON.parse(Buffer.concat(teile).toString('utf8')));
      } catch {
        fertig(null);
      }
    });
    req.on('error', () => fertig(null));
  });
}

function tokenStimmt(kopfzeile) {
  const erwartet = Buffer.from(`Bearer ${TOKEN}`);
  const erhalten = Buffer.from(String(kopfzeile || ''));
  return erhalten.length === erwartet.length && crypto.timingSafeEqual(erhalten, erwartet);
}

function antworten(res, status, inhalt) {
  const text = JSON.stringify(inhalt, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

const ganzzahl = (wert) => /^\d{1,4}$/.test(wert);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/medien') {
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...MEDIEN_CORS, 'Access-Control-Max-Age': '86400' }); return res.end(); }
    if (req.method !== 'GET' && req.method !== 'HEAD') return antworten(res, 405, { ok: false, fehler: 'Nur GET ist erlaubt' });
    return medienAusliefern(req, res, url).catch(() => res.destroy());
  }
  const schreibend = req.method === 'POST' && url.pathname === '/gesehen';
  if (req.method !== 'GET' && !schreibend) return antworten(res, 405, { ok: false, fehler: 'Nur GET ist erlaubt (POST nur auf /gesehen)' });
  if (url.pathname === '/health') return antworten(res, 200, { ok: true });
  const seite = { '/': OBERFLAECHE, '/index.html': OBERFLAECHE, '/video': VIDEO_SEITE, '/video.html': VIDEO_SEITE }[url.pathname];
  if (seite) {
    return fs.readFile(seite, (fehler, inhalt) => {
      if (fehler) return antworten(res, 500, { ok: false, fehler: 'Oberfläche fehlt' });
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': inhalt.length,
        'Cache-Control': 'no-cache',
        ...(seite === VIDEO_SEITE ? VIDEO_KOPF : SICHERHEITS_KOPF),
      });
      res.end(inhalt);
    });
  }
  if (url.pathname !== '/katalog' && url.pathname !== '/gesehen' && url.pathname !== '/stream') {
    return antworten(res, 404, { ok: false, fehler: 'Unbekannter Pfad' });
  }
  if (!tokenStimmt(req.headers.authorization)) return antworten(res, 401, { ok: false, fehler: 'Token fehlt oder ist falsch' });

  if (url.pathname === '/stream') {
    const videoUrl = (url.searchParams.get('url') || '').trim();
    if (!videoUrl || videoUrl.length > 2048) {
      return antworten(res, 400, { ok: false, fehler: 'Parameter url fehlt oder ist zu lang' });
    }
    let geparsest;
    try { geparsest = new URL(videoUrl); } catch { return antworten(res, 400, { ok: false, fehler: 'URL ist nicht gültig' }); }
    if (geparsest.protocol !== 'http:' && geparsest.protocol !== 'https:') {
      return antworten(res, 400, { ok: false, fehler: 'Nur http(s) ist erlaubt' });
    }
    if (istLokal(geparsest.hostname)) {
      return antworten(res, 400, { ok: false, fehler: 'Lokale Adressen sind nicht erlaubt' });
    }
    try {
      const { status, inhalt } = await streamHolen(videoUrl);
      return antworten(res, status, inhalt);
    } catch (fehler) {
      return antworten(res, 502, { ok: false, fehler: String(fehler.message).split('\n')[0] });
    }
  }

  if (url.pathname === '/gesehen') {
    if (!schreibend) return antworten(res, 200, { ok: true, serien: Object.values(register.serien) });
    const eingabe = await koerperLesen(req);
    if (eingabe === null) return antworten(res, 400, { ok: false, fehler: 'Der Inhalt ist kein lesbares JSON oder zu groß' });
    const { status, inhalt } = registerAendern(eingabe);
    return antworten(res, status, inhalt);
  }

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
