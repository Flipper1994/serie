# serie

Skill „serien-katalog“ für Claude: liest per Headless-Browser (Playwright) die
Staffelübersicht einer Serie auf burningseries.ac aus – Titel, Beschreibung,
Besetzung, Sprachen, Staffeln und je Folge Nummer, Titel und Anbieter-Links.
Die Weboberfläche dient zugleich als Serien-Register: Gesehene Folgen lassen
sich abhaken.

## Als Skill installieren

`SKILL.md` und den Ordner `scripts/` zusammen in Claude als Skill speichern.
Danach reicht in jeder Sitzung eine Eingabe wie „Breaking Bad Staffel 2“.

## Direkt aufrufen

    node scripts/katalog.js "<Serienname>" <Staffel> [Folge] [--ausgabe <Ordner>]

Staffel `0` steht für „Specials“. Ausgabe ist JSON, dazu `ergebnis.json` und
`ergebnis.png` im Ausgabeordner. Braucht Node und Playwright mit Chromium.

## Als HTTP-Dienst auf einem Server

`scripts/server.js` ruft `katalog.js` auf und gibt dessen Ausgabe als JSON
zurück. `ausgabe=original` (Standard) liefert sie unverändert – Anfrage,
Seriendaten, Staffel mit Folgen, Folge und Browser-Diagnose; `ausgabe=kurz`
eine flache Fassung (Serientitel, Folgen mit Nummer und Titel, Staffeln,
Sprachen, Beschreibung, Infos) ohne Anbieter-Links.

    curl -H "Authorization: Bearer <Token>" \
      "http://127.0.0.1:8080/katalog?serie=furious&staffel=1&folge=6"

`staffel` ist optional (Standard 1), `folge` ebenfalls. `GET /health` antwortet
ohne Token. Es läuft immer nur ein Browser gleichzeitig; Ergebnisse bleiben
60 Minuten im Speicher.

### Oberfläche und Gesehen-Register

`GET /` liefert die Oberfläche (`public/index.html`): Suche nach einer Serie,
Staffel-Leiste, Folgenliste mit Anbietern, Sprachen und „Über die Serie“. Jede
Folge hat einen Haken für „gesehen“, dazu gibt es „Ganze Staffel gesehen“ und
einen Zähler. Die Startseite „Meine Serien“ zeigt alle Serien mit Haken samt
letztem Stand; ein Klick öffnet die Staffel, bei der es weitergeht.

Die Oberfläche fragt beim ersten Aufruf das Token ab und merkt es sich im
Browser; ein Link mit `#token=<Token>` setzt es direkt, „Zugangslink kopieren“
in der Fußzeile erzeugt ihn für ein weiteres Gerät. Die Adresse enthält die
Abfrage (`?serie=furious&staffel=1`).

Das Register liegt auf dem Server in `daten/gesehen.json` (Ordner änderbar mit
`DATEN_ORDNER`) und gilt damit auf allen Geräten. Die Datei gehört nicht zum
Repo; für eine Sicherung reicht es, sie zu kopieren.

    GET  /gesehen     alle Serien mit abgehakten Folgen
    POST /gesehen     { "serie": "Furious", "staffel": 1, "folgen": [1, 2],
                        "gesehen": true, "anzahlFolgen": 8, "staffeln": ["1"] }
    POST /gesehen     { "serie": "Furious", "entfernen": true }

Einrichten (Debian/Ubuntu, als root, Node ab Version 18 vorausgesetzt):

    useradd --system --create-home serie
    git clone https://github.com/flipper1994/serie.git /opt/serie
    chown -R serie: /opt/serie
    cd /opt/serie
    sudo -u serie npm install playwright
    npx playwright install-deps chromium
    sudo -u serie npx playwright install chromium
    echo "API_TOKEN=$(openssl rand -hex 32)" > /etc/serien-katalog.env
    chmod 600 /etc/serien-katalog.env
    cp deploy/serien-katalog.service /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable --now serien-katalog

Der Dienst lauscht nur auf `127.0.0.1:8080`. Für Zugriff von außen einen
Reverse-Proxy mit TLS davorsetzen oder in `/etc/serien-katalog.env`
`HOST=0.0.0.0` setzen (dann geht das Token unverschlüsselt über die Leitung).
Weitere Einstellungen: `PORT`, `CACHE_MINUTEN`, `DATEN_ORDNER`.

Läuft der Reverse-Proxy selbst in Docker, kommt er nicht an `127.0.0.1` des
Servers. Dann den Dienst auf das Gateway des Docker-Netzes legen, z. B.
`bash deploy/install.sh --host 172.18.0.1 --port 8090`, und im Proxy
`proxy_pass http://172.18.0.1:8090/;` unter einem eigenen Pfad wie `/serie/`.

## Testen

    node scripts/test.js

16 Fälle gegen die echte Seite, etwa drei Minuten.
