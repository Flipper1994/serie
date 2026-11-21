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

### Stream-Resolver (direkte Video-URLs)

`GET /stream?url=<hoster-url>` löst die direkte MP4-URL aus einer Hoster-Seite
via `yt-dlp` auf. Token wie bei `/katalog`. Antwort:

    { "ok": true, "mp4": "https://...mp4", "cached": false }

Eigener Cache (30 min), eigene Queue (max. 3 parallel). Blockiert lokale
Adressen (SSRF-Schutz). Ergebnisse landen 30 Minuten im Cache.

Neue Umgebungsvariablen: `YT_DLP_PATH` (Pfad zum Binary, sonst `yt-dlp`),
`STREAM_CACHE_MINUTEN` (30), `STREAM_MAX_PARALLEL` (3), `STREAM_MAX_WARTEND`
(5), `STREAM_TIMEOUT_MS` (30000).

`deploy/install.sh` installiert `yt-dlp` automatisch via `pip3`, falls
vorhanden. Update später mit `yt-dlp -U`.

In der Oberfläche hat jede Folge Anbieter-Knöpfe (VOE, Vidmoly, Filemoon).
Der Weg zur Videoseite ist unten beschrieben.

### Vom Anbieter zur Videoseite

Ein Anbieter-Klick öffnet `/video?url=…` in einem neuen Tab. Der Server gibt
den Anbieter-Link mit Camoufox und lokalen Bildmodellen frei und reicht ihn
an den bestehenden Video-Resolver weiter. Keine Erweiterung, kein Kopieren
und kein kostenpflichtiger Captcha-Dienst. Die erste Freigabe kann mehrere
Minuten dauern; erfolgreiche Hoster-Links bleiben sechs Stunden in
`daten/anbieter.json`. Eine Freigabe läuft gleichzeitig, gleiche Anfragen
teilen sich die Aufgabe. `/stream` antwortet währenddessen mit 202; die
Videoseite fragt den Stand erneut ab, ohne lange Proxy-Verbindungen.

Einrichtung als Dienstbenutzer (Python 3, Git, curl und Xvfb vorausgesetzt):

    sudo -u serie bash deploy/install-anbieter.sh

Alles liegt isoliert unter `.anbieter/` und im Browser-Cache des Dienstbenutzers.
Das Skript ändert keine Systemkonfiguration. Verwendete Bausteine:
[Camoufox](https://github.com/daijro/camoufox),
[recaptcha_ia_solver](https://github.com/cateyelow/recaptcha_ia_solver) und
[cf-solver](https://github.com/VeyraAgent/cf-solver), mit festgelegten Git-Ständen.
`deploy/patch-anbieter.py` korrigiert die RGB/BGR-Übergabe an Ultralytics und
verhindert das erneute Abwählen statischer Bilder. Ein Google-QR-Zwang oder
eine Netzsperre wird als Fehler angezeigt; eine automatische Freigabe ist
daher nicht bei jeder Sicherheitsabfrage garantiert.

Die Quelle bestimmt das Format: MP4 bleibt MP4, HLS wird mit dem lokal
ausgelieferten [hls.js 1.6.15](https://github.com/video-dev/hls.js/tree/v1.6.15)
im normalen Videoelement abgespielt. Safari verwendet seine native HLS-Unterstützung.
Ein physischer Chromecast benötigt eine gesonderte Abnahme im eigenen WLAN;
Apple-Browser bieten nicht dieselbe Cast-Unterstützung wie Desktop-Chrome.

Beide Seiten bieten ein responsives Layout, Hell-/Dunkelmodus, Safe-Area-Abstände,
Tastaturbedienung und Touch-Flächen von mindestens 44 px für die Anbieter-Knöpfe.

Gezielte Prüfung ohne echte Captcha-Freigabe:

    node scripts/test-anbieter.js
    TEST_BROWSER=webkit node scripts/test-anbieter.js

Benötigt Playwright und den jeweiligen Browser. Prüft den neuen Tab, 202-Polling,
automatische Player-Übergabe und mobile Bedienung bei 320–1440 px in Hell/Dunkel.
Die Antworten sind in diesem Oberflächentest nachgebildet.

Echter vollständiger Browser-Test mit Katalog, Anbieter-Freigabe und Videoframes:

    API_TOKEN=… TEST_BASIS=https://flippercapital.duckdns.org/serie/ node scripts/test-video-e2e.js

Optional: `TEST_ANBIETER=Vidmoly`, `TEST_FOLGEN_INDEX=1`, `TEST_SERIE=Furious`.
Der Test gibt weder Token noch signierte Medienadressen aus.

Echte Auflösung eines öffentlichen Testvideos und Range-Abruf über den Proxy:

    API_TOKEN=… TEST_BASIS=https://flippercapital.duckdns.org/serie/ node scripts/test-medien.js

Der Test gibt weder Token noch signierte Medienadressen aus.
Mit `TEST_BROWSER_VIDEO=1` prüft er zusätzlich, dass das Video im echten
Chromium-Player der Videoseite geladen wird.

### Video-Link abspielen und auf den Fernseher streamen

`GET /video` liefert eine zweite Seite (`public/video.html`): einen Video-Link
einfügen, „Video öffnen“, und das Video läuft im Browser. „Auf Fernseher
streamen“ schickt es an einen Chromecast im selben WLAN (Chrome am Handy oder
Rechner); danach dient die Seite als Fernbedienung (Pause, ±30 s, Position).
Ein Aufruf mit `video?url=<Link>` öffnet das Video sofort. Die Seite nutzt
dasselbe Token wie der Katalog und merkt sich die zuletzt geöffneten Links im
Browser.

`/stream` liefert dafür zusätzlich `titel`, `art` (`datei` oder `hls`) und
`medien`: eine signierte, sechs Stunden gültige Adresse (`MEDIEN_GUELTIG_STUNDEN`),
unter der der Dienst das Video durchleitet (`GET /medien?…`, ohne Token, mit
Vorspulen; HLS-Wiedergabelisten werden auf die Durchleitung umgeschrieben).
Nötig ist das, weil viele Anbieter das Video nur an die Adresse herausgeben,
die den Link aufgelöst hat, und ein Chromecast kein Token mitschicken kann.
Der Datenverkehr des Videos läuft damit über den Server.

Kennt `yt-dlp` den Anbieter nicht (z. B. VOE), öffnet `scripts/video-link.js`
die Seite im Headless-Browser, startet den Player und liest mit, welche
Videoadresse er lädt. Das dauert einige Sekunden länger.

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
