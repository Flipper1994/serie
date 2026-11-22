// Optionaler gemeinsamer Browserdienst: Videoquelle und Freigabe im selben Browser.
const MAX_ANTWORT = 1024 * 1024;
function webUrl(wert) {
  try { const u = new URL(wert); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; }
  catch { return false; }
}
async function suchen(link) {
  const endpoint = process.env.VIDEO_SOLVER_URL;
  if (!endpoint) return { ok: false, fehler: 'Kein VIDEO_SOLVER_URL konfiguriert' };
  if (!webUrl(link) || !webUrl(endpoint)) return { ok: false, fehler: 'Browser-Solver: ungültige Adresse' };
  try {
    const antwort = await fetch(new URL('video', endpoint.endsWith('/') ? endpoint : `${endpoint}/`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: link, maxTimeout: 90000 }), signal: AbortSignal.timeout(100000),
    });
    const reader = antwort.body.getReader();
    const teile = []; let laenge = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      laenge += value.byteLength;
      if (laenge > MAX_ANTWORT) { await reader.cancel(); throw new Error('Antwort zu groß'); }
      teile.push(Buffer.from(value));
    }
    const daten = JSON.parse(Buffer.concat(teile).toString('utf8'));
    if (!antwort.ok || daten.ok !== true) return { ok: false, fehler: `Browser-Solver: ${String(daten.fehler || daten.detail || `HTTP ${antwort.status}`).split('\n')[0].slice(0, 200)}` };
    if (!webUrl(daten.url) || !webUrl(daten.referer) || !['datei', 'hls'].includes(daten.art) ||
        typeof daten.userAgent !== 'string' || !daten.userAgent || daten.userAgent.length > 2048 || /[\r\n]/.test(daten.userAgent) ||
        !Array.isArray(daten.cookies) || daten.cookies.length > 500 || daten.cookies.some((c) =>
          !c || typeof c.name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(c.name) ||
          typeof c.value !== 'string' || /[\r\n;]/.test(c.value) || typeof c.domain !== 'string' || !/^\.?[a-z0-9.-]+$/i.test(c.domain) ||
          (c.path !== undefined && (typeof c.path !== 'string' || !c.path.startsWith('/'))) ||
          (c.expires !== undefined && !Number.isFinite(c.expires)))) {
      return { ok: false, fehler: 'Browser-Solver: ungültige Videoantwort' };
    }
    return { ok: true, url: daten.url, art: daten.art, titel: String(daten.titel || '').slice(0, 200),
      referer: daten.referer, userAgent: daten.userAgent, resolver: 'byparr',
      cookies: daten.cookies.map((c) => ({ ...c, path: c.path || '/', expires: c.expires ?? -1 })) };
  } catch (e) { return { ok: false, fehler: `Browser-Solver: ${String(e.message).split('\n')[0].slice(0, 200)}` }; }
}
module.exports = { suchen };
