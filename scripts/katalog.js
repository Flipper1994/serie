#!/usr/bin/env node
// Steuert ein Headless-Chromium über die Serienliste bis zur Staffelübersicht
// und liest dort die Katalogdaten aus.
//
// Aufruf:   node katalog.js "<Serienname>" <Staffel> [Folge] [--ausgabe <Ordner>]
//           Staffel 0 steht für „Specials“.
// Ausgabe:  JSON auf stdout; im Ausgabeordner (Standard: serien-katalog im
//           Temp-Verzeichnis) zusätzlich ergebnis.json und ergebnis.png.
// Rückgabe: 0 bei Erfolg, 1 bei fachlichem Fehler (Serie/Staffel fehlt,
//           falscher Aufruf), 2 bei technischem Fehler (Seite nicht erreichbar).
//
// Gelesen wird die Staffelübersicht; die Anbieter-Links je Folge stehen dort
// in Zelle 2 der Folgentabelle.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');

const BASIS = 'https://burningseries.ac';
const ZEITLIMIT_MS = 30000;

class Fachfehler extends Error {
  constructor(meldung, extra = {}) {
    super(meldung);
    this.extra = extra;
  }
}

function argumenteLesen(argv) {
  const frei = [];
  let ausgabe = path.join(os.tmpdir(), 'serien-katalog');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ausgabe') ausgabe = argv[++i];
    else frei.push(argv[i]);
  }
  const [name, staffelArg, folgeArg] = frei;
  const ganzzahl = (wert) => /^\d+$/.test(String(wert));
  if (!name || !name.trim() || !ganzzahl(staffelArg) || !ausgabe || frei.length > 3) {
    throw new Fachfehler('Aufruf: node katalog.js "<Serienname>" <Staffel> [Folge] [--ausgabe <Ordner>]');
  }
  if (folgeArg !== undefined && !ganzzahl(folgeArg)) {
    throw new Fachfehler('Die Folge muss eine ganze Zahl sein', { folge: folgeArg });
  }
  return {
    name: name.trim(),
    staffel: Number(staffelArg),
    folge: folgeArg === undefined ? null : Number(folgeArg),
    ausgabe,
  };
}

// Viele Titel haben die Form „Deutscher Titel | Originaltitel“. Ein Name passt,
// wenn er dem ganzen Titel entspricht, sonst wenn er einem der beiden Teile
// entspricht. Groß-/Kleinschreibung ist egal.
function passende(titelListe, wunsch) {
  const einmalig = [...new Set(titelListe)];
  const ganz = einmalig.filter((t) => t.toLowerCase() === wunsch);
  if (ganz.length) return ganz;
  return einmalig.filter((t) => t.toLowerCase().split('|').some((teil) => teil.trim() === wunsch));
}

// Tippt den Namen ins Suchfeld der Serienliste und klickt den passenden Treffer an.
async function serieOeffnen(page, name) {
  await page.goto(BASIS, { waitUntil: 'domcontentloaded', timeout: ZEITLIMIT_MS });
  await page.getByText('Got it!').click({ timeout: 3000 }).catch(() => {});
  await page.getByRole('link', { name: 'Suche', exact: true }).first().click();

  const feld = page.locator('#serInput');
  await feld.waitFor({ state: 'visible', timeout: ZEITLIMIT_MS });
  await page.locator('#seriesContainer a').first().waitFor({ state: 'attached', timeout: ZEITLIMIT_MS });
  await feld.click();
  await feld.pressSequentially(name, { delay: 50 });
  await page.waitForTimeout(1000);

  const titelLesen = (auswahl) =>
    page.locator(auswahl).evaluateAll((links) => links.map((a) => a.textContent.trim()));
  const wunsch = name.toLowerCase();
  const sichtbar = await titelLesen('#seriesContainer a:visible');
  let kandidaten = passende(sichtbar, wunsch);

  // Bei Sonderzeichen (z. B. „&“) findet der Filter der Seite nichts, obwohl es
  // die Serie gibt. Dann Feld leeren und in der ganzen Liste nachsehen.
  if (kandidaten.length === 0) {
    kandidaten = passende(await titelLesen('#seriesContainer a'), wunsch);
    if (kandidaten.length === 0) {
      throw new Fachfehler(`Keine Serie mit genau diesem Namen gefunden: „${name}“`, {
        aehnlicheTreffer: sichtbar.slice(0, 25),
      });
    }
    await feld.fill('');
    await feld.press('Backspace');
    await page.waitForTimeout(800);
  }
  if (kandidaten.length > 1) {
    throw new Fachfehler(`Der Name „${name}“ passt auf mehrere Serien`, { kandidaten });
  }
  const titel = kandidaten[0];

  // Der Filter hebt den Suchbegriff in jedem Treffer hervor. Deshalb wird der
  // Link über seinen ganzen Text gewählt, nicht über ein Teilstück darin.
  const ganzerText = new RegExp(`^\\s*${titel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
  await page.locator('#seriesContainer a:visible').filter({ hasText: ganzerText }).first().click();
  await page.locator('section.serie table.episodes').waitFor({ state: 'attached', timeout: ZEITLIMIT_MS });
  return titel;
}

async function staffelWaehlen(page, staffel) {
  const aktiv = await page.locator(`#seasons li.s${staffel}.active`).count();
  if (aktiv) return;
  const link = page.locator(`#seasons li.s${staffel} a`);
  // Die Staffelleiste ist ein Schieberegler; weit hinten liegende Staffeln
  // liegen außerhalb des sichtbaren Bereichs und lassen sich nicht anklicken.
  // Dann wird die Staffelübersicht über die Adresse des Reiters geöffnet.
  try {
    await link.click({ timeout: 4000 });
  } catch {
    const ziel = await link.evaluate((a) => a.href);
    await page.goto(ziel, { waitUntil: 'domcontentloaded', timeout: ZEITLIMIT_MS });
  }
  await page.locator(`#seasons li.s${staffel}.active`).waitFor({ state: 'attached', timeout: ZEITLIMIT_MS });
}

async function uebersichtLesen(page) {
  return page.evaluate(() => {
    const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
    const wurzel = document.querySelector('section.serie');
    const kopf = wurzel.querySelector('#sp_left h2');
    const zusatz = text(kopf.querySelector('small')) || '';
    const titel = text(kopf).slice(0, text(kopf).length - zusatz.length).trim();

    const infos = {};
    for (const block of wurzel.querySelectorAll('.infos > div')) {
      const schluessel = text(block.querySelector(':scope > span'));
      const werte = [...block.querySelectorAll('p > span, p > em')].map((e) => text(e).replace(/,$/, ''));
      if (schluessel) infos[schluessel] = werte;
    }

    const staffeln = [...wurzel.querySelectorAll('#seasons li')].map((li) => ({
      nummer: Number((li.className.match(/\bs(\d+)\b/) || [])[1]),
      name: text(li),
      aktiv: li.classList.contains('active'),
    }));

    const folgen = [...wurzel.querySelectorAll('table.episodes tr')]
      .map((zeile) => {
        const zellen = zeile.querySelectorAll('td');
        // Zelle 2 enthält die Anbieter-Links der Folge (Icons mit title + href).
        const hoster = zellen[2]
          ? [...zellen[2].querySelectorAll('a')].map((a) => ({
              title: a.getAttribute('title'),
              href: a.href, // absolut aufgelöste URL
            }))
          : [];
        return { nummer: Number(text(zellen[0])), titel: text(zellen[1]), hoster };
      })
      .filter((f) => Number.isInteger(f.nummer));

    return {
      titel,
      beschreibung: text(wurzel.querySelector('#sp_left > p')),
      infos,
      sprachen: [...wurzel.querySelectorAll('select.series-language option')].map((o) => text(o)),
      staffeln,
      folgen,
    };
  });
}

async function lauf({ name, staffel, folge, ausgabe }) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
      locale: 'de-DE',
    });
    const page = await context.newPage();
    let zusaetzlicheTabs = 0;
    context.on('page', () => zusaetzlicheTabs++);

    const erwarteterTitel = await serieOeffnen(page, name);
    let daten = await uebersichtLesen(page);
    if (daten.titel.toLowerCase() !== erwarteterTitel.toLowerCase()) {
      throw new Fachfehler('Falsche Serie geöffnet', { erwartet: erwarteterTitel, geoeffnet: daten.titel });
    }
    if (!daten.staffeln.some((s) => s.nummer === staffel)) {
      throw new Fachfehler(`Staffel ${staffel} gibt es nicht`, {
        serie: daten.titel,
        staffeln: daten.staffeln.map((s) => s.name),
      });
    }

    await staffelWaehlen(page, staffel);
    daten = await uebersichtLesen(page);
    const gewaehlt = daten.staffeln.find((s) => s.aktiv);
    if (!gewaehlt || gewaehlt.nummer !== staffel) {
      throw new Error(`Staffel ${staffel} ließ sich nicht auswählen`);
    }

    const gesucht = daten.folgen.find((f) => f.nummer === folge);
    const ergebnis = {
      ok: true,
      anfrage: { serie: name, staffel, folge },
      serie: {
        titel: daten.titel,
        beschreibung: daten.beschreibung,
        infos: daten.infos,
        sprachen: daten.sprachen,
        staffeln: daten.staffeln.map((s) => s.name),
      },
      staffel: { nummer: staffel, name: gewaehlt.name, anzahlFolgen: daten.folgen.length, folgen: daten.folgen },
      folge: folge === null ? null : gesucht ? { vorhanden: true, ...gesucht } : { vorhanden: false, nummer: folge },
      browser: {
        endUrl: page.url(),
        captchaImSeitentext: /captcha/i.test(await page.content()),
        iframes: await page.locator('iframe').count(),
        zusaetzlicheTabs,
      },
    };

    fs.mkdirSync(ausgabe, { recursive: true });
    await page.screenshot({ path: path.join(ausgabe, 'ergebnis.png'), fullPage: true });
    fs.writeFileSync(path.join(ausgabe, 'ergebnis.json'), JSON.stringify(ergebnis, null, 2));
    return ergebnis;
  } finally {
    await browser.close();
  }
}

(async () => {
  try {
    const ergebnis = await lauf(argumenteLesen(process.argv.slice(2)));
    console.log(JSON.stringify(ergebnis, null, 2));
  } catch (fehler) {
    const fachlich = fehler instanceof Fachfehler;
    const meldung = fehler.message.split('\n')[0];
    console.log(JSON.stringify({ ok: false, fehler: meldung, ...(fachlich ? fehler.extra : {}) }, null, 2));
    process.exitCode = fachlich ? 1 : 2;
  }
})();
