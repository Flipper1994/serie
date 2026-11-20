# serie

Dieses Repo enthält den Skill „serien-katalog“. Die Arbeitsanweisung steht in
`SKILL.md` und gilt auch für Sitzungen direkt auf diesem Repo.

Nennt der Nutzer eine Serie und eine Staffel (optional eine Folge):

    node scripts/katalog.js "<Serienname>" <Staffel> [Folge]

Die Folgen als Tabelle mit Nummer und Titel zeigen, kein rohes JSON. In
Cloud-Sitzungen sind Playwright und Chromium vorinstalliert; nichts installieren.

Sprache: Deutsch mit echten Umlauten. Commits deutsch, ohne AI-Attribution.

## Ausrollen

Änderungen immer direkt auf `main` pushen. Der vServer zieht `main` alle
2 Minuten (systemd-Timer `serie-update`) nach `/opt/serie` und startet den
Dienst `serien-katalog` bei neuen Commits neu. Erreichbar unter
https://flippercapital.duckdns.org/serie/.
