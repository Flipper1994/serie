# serie

Dieses Repo enthält den Skill „serien-katalog“. Die Arbeitsanweisung steht in
`SKILL.md` und gilt auch für Sitzungen direkt auf diesem Repo.

Nennt der Nutzer eine Serie und eine Staffel (optional eine Folge):

    node scripts/katalog.js "<Serienname>" <Staffel> [Folge]

Die Folgen als Tabelle mit Nummer und Titel zeigen, kein rohes JSON. In
Cloud-Sitzungen sind Playwright und Chromium vorinstalliert; nichts installieren.

Nach einer Änderung an `SKILL.md` oder `scripts/` das Paket
`serien-katalog.skill` neu schnüren, damit es zum Quelltext passt.

Die Grenze aus `SKILL.md` gilt: Ende auf der Staffelübersicht, keine
Episodenseiten, keine Episoden- oder Anbieter-Links.

Sprache: Deutsch mit echten Umlauten. Commits deutsch, ohne AI-Attribution.
