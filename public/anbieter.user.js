// ==UserScript==
// @name         Serien-Katalog: Anbieter an Videoseite übergeben
// @namespace    https://flippercapital.duckdns.org/serie/
// @version      1.0.0
// @description  Übergibt den nach einer regulären Freigabe sichtbaren Hoster-Link an die Videoseite.
// @match        https://burningseries.ac/serie/*
// @match        https://www.burningseries.ac/serie/*
// @match        https://flippercapital.duckdns.org/serie/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  if (window.top !== window.self) return;

  const ziel = 'https://flippercapital.duckdns.org/serie/video';
  if (location.origin === 'https://flippercapital.duckdns.org') {
    const bereit = () => {
      document.documentElement.dataset.anbieterBruecke = '1';
      document.dispatchEvent(new Event('anbieter-bruecke-bereit'));
    };
    if (document.documentElement) bereit();
    else document.addEventListener('DOMContentLoaded', bereit, { once: true });
    return;
  }
  // Nur vom Katalog aus ausdrücklich markierte Aufrufe übernehmen.
  if (new URLSearchParams(location.hash.slice(1)).get('serienKatalog') !== '1') return;

  let uebergeben = false;
  function hosterAdresse(wert) {
    try {
      const url = new URL(wert, location.href);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
      if (url.origin === location.origin) return null;
      return url.href;
    } catch { return null; }
  }

  function uebergebenAnVideo(wert) {
    const adresse = hosterAdresse(wert);
    if (!adresse || uebergeben) return;
    uebergeben = true;
    beobachter.disconnect();
    // Kein API-Token verlässt den Katalog. Die Videoseite liest ihren lokalen Zugang.
    // Den laufenden Klick-Handler der Anbieter-Seite erst abschließen lassen.
    setTimeout(() => location.replace(`${ziel}?${new URLSearchParams({ url: adresse })}`), 0);
  }

  function sichtbarenLinkUebernehmen() {
    const quelle = document.querySelector('section.serie .hoster-player iframe[src], section.serie .hoster-player a[href]');
    if (quelle) uebergebenAnVideo(quelle.getAttribute(quelle.tagName === 'IFRAME' ? 'src' : 'href'));
  }

  const beobachter = new MutationObserver(sichtbarenLinkUebernehmen);
  beobachter.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href'] });

  // embed=0 hängt erst den Link an und öffnet ihn danach. Nur genau dieses
  // Fenster übernehmen; andere Fensteraufrufe der Seite bleiben unberührt.
  const urspruenglichOeffnen = window.open;
  window.open = function (url, ...argumente) {
    const adresse = hosterAdresse(url);
    const freigegeben = [...document.querySelectorAll('section.serie .hoster-player a[href]')]
      .some((a) => hosterAdresse(a.getAttribute('href')) === adresse);
    if (adresse && freigegeben) {
      uebergebenAnVideo(adresse);
      return null;
    }
    return urspruenglichOeffnen.call(this, url, ...argumente);
  };

  sichtbarenLinkUebernehmen();
})();
