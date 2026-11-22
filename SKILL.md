---
name: serien-katalog
description: Liest per Headless-Browser die Staffelübersicht einer Serie auf burningseries.ac aus und liefert Staffeln, Folgennummern, Folgentitel, Beschreibung und Besetzung. Immer verwenden, wenn der Nutzer einen Seriennamen nennt und wissen will, welche Staffeln oder Folgen es gibt, wie eine Folge heißt oder ob es eine bestimmte Folge gibt – auch bei knappen Eingaben wie „Breaking Bad Staffel 2“ oder „Furious 1 5“.
---

# Serien-Katalog

Ein fertiges, getestetes Skript steuert ein Headless-Chromium über die Suche der
Seite bis zur Staffelübersicht und liest sie aus. Nicht selbst zur Seite
navigieren oder das Skript nachbauen – es fängt die Eigenheiten der Seite schon
ab (Titel mit „|“, Sonderzeichen im Filter, Staffelleiste als Schieberegler).

## Aufruf

Das Skript liegt in `scripts/katalog.js` in diesem Skill-Ordner:

    node <skill-ordner>/scripts/katalog.js "<Serienname>" <Staffel> [Folge] --ausgabe <Ordner>

- `--ausgabe` auf einen beschreibbaren Ordner setzen (Scratchpad, sonst Temp).
  Dort landen `ergebnis.json` und `ergebnis.png` (Screenshot der Übersicht).
- Staffel `0` steht für „Specials“. Die Folge ist optional.
- Groß-/Kleinschreibung ist egal. Bei Titeln der Form
  „Deutscher Titel | Originaltitel“ reicht einer der beiden Teile.
- Teilnamen und Schreibweisen ohne Apostrophe oder Akzente werden erkannt,
  z. B. „Greys anatomy“. Bei mehreren passenden Serien eine Auswahl anbieten.
- Nennt der Nutzer keine Staffel, Staffel 1 abfragen: Die Antwort enthält auch
  die Liste aller Staffeln.

Ein Lauf dauert etwa 10 Sekunden. In Cloud-Sitzungen sind Playwright und
Chromium vorinstalliert, dort nichts installieren. Fehlt Playwright auf einem
lokalen Rechner: `npm install playwright` und `npx playwright install chromium`.

## Ergebnis lesen

Das Skript gibt JSON auf stdout aus.

| Rückgabe | Bedeutung | Was tun |
|---|---|---|
| 0 | Erfolg | Daten zeigen |
| 1 | Serie oder Staffel fehlt, falscher Aufruf | `fehler` nennen; `aehnlicheTreffer`, `kandidaten` oder `staffeln` als Auswahl anbieten |
| 2 | Technischer Fehler (Seite nicht erreichbar, Aufbau geändert) | einmal wiederholen, dann melden |

Bei Erfolg stehen die Folgen in `staffel.folgen` (Nummer, Titel, Anbieter), die
Seriendaten in `serie`, und `folge` sagt bei angegebener Folge, ob es sie gibt.
`serie.bild` enthält die absolute HTTPS-Adresse des vorhandenen Seriencovers
oder `null`. Das Cover wird im selben Seitenabruf mitgelesen; dafür sind weder
eine zusätzliche Suche noch ein API-Schlüssel nötig. Die Weboberfläche speichert
die Adresse beim Serienbesuch und lädt Bilder erst bei Bedarf. Ohne erreichbares
Bild bleibt die Titelkarte sichtbar.

## Antwort an den Nutzer

Kurz und lesbar, kein rohes JSON: Serientitel, gewählte Staffel und Anzahl der
Folgen in einem Satz, dann die Folgen als Tabelle mit Nummer und Titel. Die
übrigen Staffeln und Sprachen in einer Zeile nennen. Beschreibung und Besetzung
nur, wenn danach gefragt wurde. Der Nutzer liest oft am Handy.

## Wenn etwas nicht mehr geht

`node <skill-ordner>/scripts/test.js` läuft mit 17 Fällen gegen die echte Seite
(rund 3 Minuten). Schlägt etwas fehl, hat die Seite meist ihren Aufbau geändert;
dann die Auswahlregeln in `katalog.js` anpassen.
