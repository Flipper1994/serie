"""2Captcha v2: ein Auftrag je Freigabe, danach ausschließlich Ergebnisabfragen."""
import asyncio
import json
import re
import time
from urllib.parse import urlparse
from urllib.request import Request, urlopen


class CaptchaFehler(Exception):
    pass


def api(methode, daten):
    request = Request('https://api.2captcha.com/' + methode,
                      data=json.dumps(daten).encode(),
                      headers={'Content-Type': 'application/json'}, method='POST')
    with urlopen(request, timeout=20) as response:
        return json.load(response)


def api_pruefen(daten):
    if daten.get('errorId'):
        code = daten.get('errorCode')
        if code == 'ERROR_ZERO_BALANCE':
            raise CaptchaFehler('Das 2Captcha-Guthaben ist aufgebraucht.')
        if code in ('ERROR_KEY_DOES_NOT_EXIST', 'ERROR_WRONG_USER_KEY', 'ERROR_IP_NOT_ALLOWED'):
            raise CaptchaFehler('2Captcha hat den API-Zugang abgelehnt. Bitte die Server-Konfiguration prüfen.')
        raise CaptchaFehler('2Captcha konnte diese Sicherheitsprüfung nicht abschließen. Es wird kein weiterer Auftrag angelegt.')


async def ticket_holen(key, task, status, anfragen=api, warten=asyncio.sleep):
    # Auch bei unklarer Netzwerkantwort niemals createTask wiederholen.
    daten = await asyncio.to_thread(anfragen, 'createTask', {'clientKey': key, 'task': task})
    api_pruefen(daten)
    taskid = daten.get('taskId')
    if not isinstance(taskid, int):
        raise CaptchaFehler('2Captcha hat keine Auftragsnummer geliefert. Es wird kein zweiter Auftrag angelegt.')
    start = time.monotonic()
    while True:
        await warten(5)
        daten = await asyncio.to_thread(anfragen, 'getTaskResult', {'clientKey': key, 'taskId': taskid})
        api_pruefen(daten)
        if daten.get('status') == 'ready':
            ticket = daten.get('solution', {}).get('gRecaptchaResponse')
            if not isinstance(ticket, str) or len(ticket) < 30:
                raise CaptchaFehler('2Captcha hat kein verwendbares Ticket geliefert.')
            return ticket, daten.get('cost')
        if daten.get('status') != 'processing':
            raise CaptchaFehler('2Captcha hat einen unerwarteten Auftragsstatus geliefert.')
        status('captcha_api', f'2Captcha bearbeitet die Sicherheitsprüfung seit {round(time.monotonic() - start)} Sekunden. Kein neuer Auftrag nötig.')


async def freigeben(url, keydatei, status):
    try:
        key = keydatei.read_text().strip()
    except OSError:
        raise CaptchaFehler('Der 2Captcha-Schlüssel ist auf dem Server nicht verfügbar.') from None
    if not re.fullmatch(r'[a-fA-F0-9]{32}', key):
        raise CaptchaFehler('Der 2Captcha-Schlüssel hat ein ungültiges Format.')
    from camoufox.async_api import AsyncCamoufox
    status('browser', 'Der Browser für die Anbieter-Sitzung wird gestartet.')
    async with AsyncCamoufox(headless=False, humanize=True, locale='en-US', os='linux') as browser:
        context = await browser.new_context(locale='en-US')
        # Das Ticket kommt von 2Captcha; das lokale Google-Widget wird nicht benötigt.
        await context.route('https://www.google.com/recaptcha/**', lambda route: route.abort())
        await context.route('https://www.recaptcha.net/recaptcha/**', lambda route: route.abort())
        page = await context.new_page()
        status('anbieter', 'Anbieter-Seite, Sitzungs-Token und Captcha-Parameter werden geladen.')
        await page.goto(url, wait_until='domcontentloaded', timeout=30000)
        await page.locator('.hoster-player').wait_for(timeout=20000)
        scripts = '\n'.join(await page.locator('script').all_text_contents())
        match = re.search(r"series\.init\s*\(\s*\d+\s*,\s*\d+\s*,\s*['\"]([^'\"]+)['\"]", scripts)
        if not match or len(match[1]) < 20:
            raise CaptchaFehler('Die Captcha-Parameter des Anbieters konnten nicht gelesen werden.')
        parameter = await page.evaluate('''() => ({
          lid: document.querySelector('.hoster-player')?.dataset.lid,
          token: document.querySelector('meta[name="security_token"]')?.content,
          endpoint: new URL('ajax/embed.php', document.baseURI).href
        })''')
        endpoint = urlparse(parameter.get('endpoint', ''))
        seite = urlparse(page.url)
        if (seite.hostname not in ('burningseries.ac', 'www.burningseries.ac') or
                endpoint.scheme != 'https' or endpoint.netloc != seite.netloc or
                not str(parameter.get('lid', '')).isdigit() or int(parameter['lid']) <= 0 or
                not parameter.get('token')):
            raise CaptchaFehler('Die Anbieter-Sitzung ist unvollständig. Es wurde kein Captcha-Auftrag angelegt.')
        task = {'type': 'RecaptchaV2TaskProxyless', 'websiteURL': page.url,
                'websiteKey': match[1], 'isInvisible': True,
                'userAgent': await page.evaluate('navigator.userAgent')}
        status('captcha_api', '2Captcha löst die Sicherheitsprüfung. Es wird genau ein Lösungsauftrag erstellt.',
               versuchSeit=int(time.time() * 1000), versuchLimit=180)
        try:
            ticket, kosten = await asyncio.wait_for(ticket_holen(key, task, status), timeout=180)
        except asyncio.TimeoutError:
            raise CaptchaFehler('2Captcha hat das Zeitlimit erreicht. Es wird kein weiterer Auftrag angelegt.') from None
        except CaptchaFehler:
            raise
        except Exception:
            raise CaptchaFehler('Die Verbindung zu 2Captcha wurde unterbrochen. Es wird kein zweiter Lösungsauftrag erstellt.') from None
        status('captcha_api', '2Captcha hat die Lösung geliefert. Der Anbieter prüft das Ticket jetzt.')
        # Gleiche Sitzung und Formularfelder wie beim ursprünglichen jQuery-Aufruf.
        # Sitzungscookies und CSRF-Token werden nicht an 2Captcha weitergegeben.
        antwort = await page.evaluate('''async ({parameter, ticket}) => {
          const response = await fetch(parameter.endpoint, {
            method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(20000),
            headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest'},
            body: new URLSearchParams({LID: parameter.lid, token: parameter.token, ticket})
          });
          return {status: response.status, data: await response.json()};
        }''', {'parameter': parameter, 'ticket': ticket})
        daten = antwort['data']
        if antwort['status'] != 200 or daten.get('success') is not True:
            raise CaptchaFehler('Der Anbieter hat das Captcha-Ticket abgelehnt. Es wird kein weiterer Lösungsauftrag erstellt.')
        link = str(daten.get('link', ''))
        if urlparse(link).scheme not in ('http', 'https'):
            raise CaptchaFehler('Der Anbieter hat keinen gültigen Videolink geliefert.')
        return {'ok': True, 'url': link, 'cached': False, 'captchaDienst': '2captcha', 'kostenUSD': kosten}
