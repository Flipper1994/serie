// Titelvergleich unabhängig von der strengen Suche der Quellseite.
function normalisieren(text) {
  return String(text).toLowerCase().replace(/ß/g, 'ss').normalize('NFKD')
    .replace(/\p{M}/gu, '').replace(/[’'‘`.´]/g, '').replace(/&/g, ' und ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function passende(titelListe, wunsch) {
  const titel = [...new Set(titelListe)];
  const q = normalisieren(wunsch);
  if (!q) return [];
  const exakt = titel.filter((t) => normalisieren(t) === q);
  if (exakt.length) return exakt;
  const alias = titel.filter((t) => t.split('|').some((teil) => normalisieren(teil) === q));
  if (alias.length) return alias;
  const woerter = q.split(' ');
  return titel.filter((t) => {
    const n = normalisieren(t);
    return n.includes(q) || woerter.every((wort) => n.split(' ').some((teil) => teil.startsWith(wort)));
  }).sort((a, b) => Number(normalisieren(b).startsWith(q)) - Number(normalisieren(a).startsWith(q)) || a.localeCompare(b, 'de'));
}

function abstand(a, b) {
  let zeile = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const neu = [i + 1];
    for (let j = 0; j < b.length; j++) neu.push(Math.min(neu[j] + 1, zeile[j + 1] + 1, zeile[j] + Number(a[i] !== b[j])));
    zeile = neu;
  }
  return zeile[b.length];
}

function vorschlaege(titelListe, wunsch) {
  const woerter = normalisieren(wunsch).split(' ').filter(Boolean);
  if (!woerter.length) return [];
  return [...new Set(titelListe)].map((titel) => {
    const teile = normalisieren(titel).split(' ');
    const distanzen = woerter.map((wort) => Math.min(...teile.map((teil) => abstand(wort, teil))));
    return { titel, wert: distanzen.reduce((a, b) => a + b, 0), passt: distanzen.every((d, i) => d <= (woerter[i].length >= 8 ? 2 : woerter[i].length >= 4 ? 1 : 0)) };
  }).filter((t) => t.passt).sort((a, b) => a.wert - b.wert || a.titel.localeCompare(b.titel, 'de')).slice(0, 12).map((t) => t.titel);
}

module.exports = { passende, vorschlaege, normalisieren };
