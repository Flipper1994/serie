#!/usr/bin/env python3
"""Anbieter-Freigabe mit Camoufox: 2Captcha bei hinterlegtem Schlüssel, sonst lokal.

Installation: deploy/install-anbieter.sh. JSON und Fortschritt auf stdout.
Die Fremdprojekte und Modellgewichte werden auf feste Git-Stände festgelegt.
"""
import asyncio
import contextlib
import io
import json
import logging
import os
from pathlib import Path
import sys
import tempfile
import time
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ROOT / '.anbieter'
PROJECT = RUNTIME / 'recaptcha_ia_solver'
CACHE = Path(os.getenv('DATEN_ORDNER', str(ROOT / 'daten'))) / 'anbieter.json'
VERSUCH = 0
KEYDATEI = Path(os.getenv('TWOCAPTCHA_KEY_FILE', str(ROOT / '.2captcha-key')))
MODUS = os.getenv('ANBIETER_CAPTCHA', '2captcha' if KEYDATEI.is_file() else 'lokal')
MAX_VERSUCHE = 1 if MODUS == '2captcha' else 3


def status(phase, detail, **daten):
    print(json.dumps({'fortschritt': {'phase': phase, 'detail': detail, 'versuch': VERSUCH, 'maxVersuche': MAX_VERSUCHE, **daten}}), file=sys.__stdout__, flush=True)


def cache_speichern(url, result):
    try:
        cache = json.loads(CACHE.read_text())
    except (OSError, ValueError):
        cache = {}
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    cache = {k: v for k, v in cache.items() if v.get('bis', 0) > time.time()}
    cache[url] = {'url': result['url'], 'bis': time.time() + 6 * 3600}
    temp = CACHE.with_suffix('.tmp')
    temp.write_text(json.dumps(cache), encoding='utf-8')
    temp.chmod(0o600)
    temp.replace(CACHE)


async def aufloesen(url, workspace):
    parsed = urlparse(url)
    if parsed.scheme != 'https' or parsed.hostname not in ('burningseries.ac', 'www.burningseries.ac') or not parsed.path.startswith('/serie/'):
        raise ValueError('Ungültige Anbieter-Adresse')
    try:
        cache = json.loads(CACHE.read_text())
    except (OSError, ValueError):
        cache = {}
    hit = cache.get(url)
    if hit and hit['bis'] > time.time():
        status('cache', 'Gespeicherte Freigabe gefunden. Die Sicherheitsprüfung entfällt.')
        return {'ok': True, 'url': hit['url'], 'cached': True}

    if MODUS == '2captcha':
        from captcha_api import CaptchaFehler, freigeben
        try:
            result = await freigeben(url, KEYDATEI, status)
        except CaptchaFehler as fehler:
            return {'ok': False, 'fehler': str(fehler)}
        status('hoster', '2Captcha-Freigabe erfolgreich. Der Videolink wird für sechs Stunden gespeichert.')
        cache_speichern(url, result)
        return result
    if MODUS != 'lokal':
        return {'ok': False, 'fehler': 'Ungültige Einstellung für ANBIETER_CAPTCHA.'}

    status('modell', 'Die lokale Bilderkennung wird vorbereitet.')
    os.chdir(PROJECT)
    sys.path.insert(0, str(PROJECT))
    sys.path.insert(0, str(RUNTIME / 'cf-solver' / 'solvers' / 'recaptcha'))
    import torch
    torch.set_num_threads(2)
    from ultralytics import YOLO
    from PIL import Image
    from camoufox.async_api import AsyncCamoufox
    from recaptcha_ia_solver.solver import _resolve_target_classes, classify_grid_cells, dynamic_and_selection_solver, square_solver
    import image_solve

    classifier = YOLO(str(PROJECT / 'models' / 'recaptcha_classifier.pt'))
    detector = None
    bildrunde = 0
    os.chdir(workspace)
    Path('recaptcha_images').mkdir(exist_ok=True)

    def erkennen(png, target, n):
        nonlocal detector
        Image.open(io.BytesIO(png)).convert('RGB').save('recaptcha_images/0.png')
        targets = _resolve_target_classes(target, classifier) if n == 3 else set()
        if targets:
            answers = classify_grid_cells(targets, n, False, classifier)
        else:
            if detector is None:
                detector = YOLO(str(PROJECT / 'models' / 'yolov8x-oiv7.pt'))
            targets = _resolve_target_classes(target, detector)
            answers = (dynamic_and_selection_solver if n == 3 else square_solver)(targets, False, detector) if targets else []
        return [x - 1 for x in answers]

    async def grid(frame, pool, target, n):
        nonlocal bildrunde
        bildrunde += 1
        status('pruefung', 'Neue Bilder werden geprüft.', runde=bildrunde)
        try:
            await frame.locator('.rc-imageselect-dynamic-selected').first.wait_for(state='hidden', timeout=12000)
        except Exception:
            pass
        table = await frame.query_selector('table')
        answers = await asyncio.to_thread(erkennen, await table.screenshot(), target, n) if table else []
        status('pruefung', f'{len(answers)} passende Bilder erkannt. Auswahl und Antwort des Anbieters werden abgewartet.', runde=bildrunde)
        return answers

    image_solve._classify_grid = grid
    status('browser', 'Der Browser auf dem Server wird gestartet.')
    async with AsyncCamoufox(headless=False, humanize=True, locale='en-US', os='linux') as browser:
        context = await browser.new_context(locale='en-US')
        page = await context.new_page()
        result = {}
        abgelehnt = False

        async def response(r):
            nonlocal abgelehnt
            if urlparse(r.url).hostname in ('burningseries.ac', 'www.burningseries.ac') and urlparse(r.url).path.endswith('/ajax/embed.php'):
                data = await r.json()
                if data.get('success') and urlparse(str(data.get('link', ''))).scheme in ('http', 'https'):
                    result.update(ok=True, url=data['link'], cached=False)
                elif not data.get('success'):
                    abgelehnt = True

        page.on('response', response)
        status('anbieter', 'Die Anbieter-Seite wird geöffnet.')
        await page.goto(url, wait_until='domcontentloaded', timeout=30000)
        await page.locator('.hoster-player').wait_for(timeout=30000)
        try:
            await page.get_by_text('Got it!', exact=True).first.click(timeout=2000)
        except Exception:
            pass
        await page.locator('.hoster-player').click()
        status('pruefung', 'Die Sicherheitsprüfung beim Anbieter startet.', runde=0)
        for _ in range(8):
            await asyncio.sleep(4)
            if result or abgelehnt:
                break
            try:
                await asyncio.wait_for(image_solve.solve_image_challenge(page, None, max_rounds=20), timeout=180)
            except Exception:
                pass
            await asyncio.sleep(3)
            if result or abgelehnt:
                break
            frame = next((f for f in page.frames if '/bframe' in f.url), None)
            if frame:
                text = await frame.locator('body').inner_text()
                if 'Try again later' in text or 'QR code' in text:
                    break
        await context.close()
    if not result:
        return {'ok': False, 'fehler': 'Die Sicherheitsprüfung beim Anbieter konnte nicht automatisch abgeschlossen werden. Bitte erneut versuchen.'}
    status('hoster', 'Sicherheitsprüfung abgeschlossen. Der freigegebene Link wird gespeichert.')
    cache_speichern(url, result)
    return result


async def versuchen(url, workspace):
    global VERSUCH
    for VERSUCH in range(1, MAX_VERSUCHE + 1):
        limit = 270 if MODUS == '2captcha' else 180
        status('browser', f'Freigabeversuch {VERSUCH} von {MAX_VERSUCHE} startet.', versuchSeit=int(time.time() * 1000), versuchLimit=limit)
        try:
            result = await asyncio.wait_for(aufloesen(url, workspace), timeout=limit)
            if result['ok']:
                return result
        except asyncio.TimeoutError:
            result = {'ok': False, 'fehler': 'Zeitlimit bei der Anbieter-Freigabe'}
        if VERSUCH < MAX_VERSUCHE:
            status('wiederholung', 'Der Versuch war nicht erfolgreich. Ein neuer Versuch wird vorbereitet.')
            await asyncio.sleep(3)
    return result


if __name__ == '__main__':
    logging.basicConfig(level=logging.ERROR)
    try:
        with contextlib.redirect_stdout(sys.stderr), tempfile.TemporaryDirectory(prefix='serie-anbieter-') as workspace:
            result = asyncio.run(asyncio.wait_for(versuchen(sys.argv[1], workspace), timeout=600))
    except Exception as exc:
        result = {'ok': False, 'fehler': 'Zeitlimit bei der Anbieter-Freigabe' if isinstance(exc, asyncio.TimeoutError) else 'Anbieter-Freigabe fehlgeschlagen'}
    print(json.dumps(result))
    sys.exit(0 if result['ok'] else 1)
