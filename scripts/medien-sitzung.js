// Cookies bleiben im Server-Prozess. Der Client erhält nur eine signierte ID.
const crypto = require('node:crypto');
const sitzungen = new Map();
function anlegen(daten, dauer) {
  if (!Array.isArray(daten.cookies) || !daten.userAgent) return '';
  for (const [id, s] of sitzungen) if (s.bis <= Date.now()) sitzungen.delete(id);
  if (sitzungen.size >= 100) sitzungen.delete(sitzungen.keys().next().value);
  const id = crypto.randomBytes(24).toString('base64url');
  sitzungen.set(id, { cookies: daten.cookies, userAgent: daten.userAgent, bis: Date.now() + dauer });
  return id;
}
function lesen(id) {
  const s = sitzungen.get(id);
  return s && s.bis > Date.now() ? s : null;
}
function kopfFuer(adresse, kopf, sitzung) {
  if (!sitzung) return kopf;
  const jetzt = Date.now() / 1000;
  const cookies = sitzung.cookies.filter((c) => {
    const domain = c.domain.replace(/^\./, '').toLowerCase();
    const host = adresse.hostname.toLowerCase();
    const domainPasst = host === domain || (c.domain.startsWith('.') && host.endsWith(`.${domain}`));
    const pfad = c.path || '/';
    const pfadPasst = adresse.pathname === pfad || (adresse.pathname.startsWith(pfad) && (pfad.endsWith('/') || adresse.pathname[pfad.length] === '/'));
    return domainPasst && pfadPasst && (!c.secure || adresse.protocol === 'https:') && (c.expires <= 0 || c.expires > jetzt);
  }).sort((a, b) => b.path.length - a.path.length);
  const ausgang = { ...kopf, 'User-Agent': sitzung.userAgent };
  if (cookies.length) ausgang.Cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  return ausgang;
}
module.exports = { anlegen, lesen, kopfFuer };
