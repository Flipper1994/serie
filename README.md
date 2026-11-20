# serie

Skill „serien-katalog“ für Claude: liest per Headless-Browser (Playwright) die
Staffelübersicht einer Serie auf burningseries.ac aus – Titel, Beschreibung,
Besetzung, Sprachen, Staffeln und je Folge Nummer und Titel.

## Als Skill installieren

`serien-katalog.skill` herunterladen und in Claude als Skill speichern. Danach
reicht in jeder Sitzung eine Eingabe wie „Breaking Bad Staffel 2“.

## Direkt aufrufen

    node scripts/katalog.js "<Serienname>" <Staffel> [Folge] [--ausgabe <Ordner>]

Staffel `0` steht für „Specials“. Ausgabe ist JSON, dazu `ergebnis.json` und
`ergebnis.png` im Ausgabeordner. Braucht Node und Playwright mit Chromium.

## Testen

    node scripts/test.js

16 Fälle gegen die echte Seite, etwa drei Minuten.

## Grenze

Der Skill endet auf der Staffelübersicht. Er öffnet keine Episodenseiten und
gibt keine Episoden- oder Anbieter-Links aus.
