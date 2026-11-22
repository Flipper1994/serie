// Die echte DOM-Auslese mit den möglichen Coverformaten prüfen.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { uebersichtLesen } = require('./katalog');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER_EXECUTABLE || undefined });
  try {
    const page = await browser.newPage();
    for (const [cover, meta, erwartet] of [
      ['<img src="/public/img/cover/123.jpg">', '', 'https://burningseries.ac/public/img/cover/123.jpg'],
      ['<img src="placeholder.png" data-src="https://cdn.example.org/cover.jpg">', '', 'https://cdn.example.org/cover.jpg'],
      ['', '<meta property="og:image" content="/poster.jpg">', 'https://burningseries.ac/poster.jpg'],
      ['', '', null],
      ['<img src="javascript:alert(1)">', '', null],
    ]) {
      await page.setContent(`<base href="https://burningseries.ac/serie/Test/1">${meta}<section class="serie"><div id="sp_left"><h2>Test<small>2026</small></h2><p>Beschreibung</p></div><div id="sp_right">${cover}</div><ul id="seasons"><li class="s1 active">1</li></ul><table class="episodes"><tr><td>1</td><td>Pilot</td><td></td></tr></table></section>`);
      const daten = await uebersichtLesen(page);
      assert.equal(daten.bild, erwartet);
      assert.equal(daten.folgen[0].titel, 'Pilot');
    }
    console.log('Cover: Quellbild, Lazy-Quelle, Metadaten, fehlendes/ungültiges Bild geprüft.');
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
