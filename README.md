# serie

Skill „serien-katalog“ für Claude: liest per Headless-Browser (Playwright) die
Staffelübersicht einer Serie auf burningseries.ac aus – Titel, Beschreibung,
Besetzung, Sprachen, Staffeln und je Folge Nummer und Titel.

## Als Skill installieren

`SKILL.md` und den Ordner `scripts/` zusammen in Claude als Skill speichern.
Danach reicht in jeder Sitzung eine Eingabe wie „Breaking Bad Staffel 2“.

## Direkt aufrufen

    node scripts/katalog.js "<Serienname>" <Staffel> [Folge] [--ausgabe <Ordner>]

Staffel `0` steht für „Specials“. Ausgabe ist JSON, dazu `ergebnis.json` und
`ergebnis.png` im Ausgabeordner. Braucht Node und Playwright mit Chromium.

## Als HTTP-Dienst auf einem Server

`scripts/server.js` ruft `katalog.js` auf und gibt die gekürzte Fassung als
JSON zurück: Serientitel, Staffel, Folgen mit Nummer und Titel, Staffeln und
Sprachen.

    curl -H "Authorization: Bearer <Token>" \
      "http://127.0.0.1:8080/katalog?serie=furious&staffel=1&folge=6"

`staffel` ist optional (Standard 1), `folge` ebenfalls. `GET /health` antwortet
ohne Token. Es läuft immer nur ein Browser gleichzeitig; Ergebnisse bleiben
60 Minuten im Speicher.

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
Weitere Einstellungen: `PORT`, `CACHE_MINUTEN`.

## Testen

    node scripts/test.js

16 Fälle gegen die echte Seite, etwa drei Minuten.

## Grenze

Der Skill endet auf der Staffelübersicht. Er öffnet keine Episodenseiten und
gibt keine Episoden- oder Anbieter-Links aus.
