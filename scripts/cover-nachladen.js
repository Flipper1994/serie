#!/usr/bin/env node
// Einmaliger Cover-Nachtrag für vorhandene Serien, ohne Änderung ihrer Historie.
async function main() {
  const token = process.env.API_TOKEN;
  if (!token || !process.env.TEST_BASIS) throw new Error('API_TOKEN und TEST_BASIS sind erforderlich.');
  const basis = new URL(process.env.TEST_BASIS.replace(/\/?$/, '/'));
  if (!['http:', 'https:'].includes(basis.protocol) || basis.username || basis.password) throw new Error('Ungültige TEST_BASIS.');
  async function dienst(pfad, body) {
    const antwort = await fetch(new URL(pfad, basis), {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(180000), redirect: 'error',
    });
    if (!antwort.ok) throw new Error(`HTTP ${antwort.status}`);
    const daten = await antwort.json();
    if (!daten?.ok) throw new Error('Dienst meldet Fehler');
    return daten;
  }
  const register = await dienst('gesehen');
  if (!Array.isArray(register.serien)) throw new Error('Ungültiges Register.');
  const offen = register.serien.filter((serie) => !serie.bild);
  console.log(`Cover-Nachtrag: ${offen.length} fehlen, ${register.serien.length - offen.length} bereits vorhanden.`);
  let gespeichert = 0, fehler = 0;
  for (let i = 0; i < offen.length; i++) {
    const serie = offen[i];
    try {
      const erste = (serie.staffeln || []).map((s) => /^\d+$/.test(String(s).trim()) ? Number(s) : /staffel\s+(\d+)/i.exec(String(s))?.[1]).find((s) => s !== undefined);
      const staffel = Number.isInteger(serie.besucht?.staffel) ? serie.besucht.staffel : Number(erste ?? 1);
      const parameter = new URLSearchParams({ serie: serie.titel, staffel: String(staffel), ausgabe: 'original' });
      const katalog = await dienst(`katalog?${parameter}`);
      if (!katalog.serie?.bild) throw new Error('Kein Quellcover');
      const antwort = await dienst('gesehen', { serie: serie.titel, bild: katalog.serie.bild });
      if (antwort.serie?.bild !== katalog.serie.bild) throw new Error('Cover nicht gespeichert');
      gespeichert++;
      console.log(`Serie ${i + 1}/${offen.length}: Cover gespeichert.`);
    } catch {
      fehler++;
      console.log(`Serie ${i + 1}/${offen.length}: Cover offen, Abruf oder Speicherung fehlgeschlagen.`);
    }
  }
  console.log(`Ergebnis: ${gespeichert} ergänzt, ${fehler} offen.`);
  if (fehler) process.exitCode = 1;
}
main().catch(() => { console.error('Cover-Nachtrag abgebrochen. Konfiguration, Anmeldung und Erreichbarkeit prüfen.'); process.exitCode = 1; });
