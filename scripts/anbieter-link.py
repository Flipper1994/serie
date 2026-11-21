#!/usr/bin/env python3
"""Anbieter-Freigabe mit Camoufox und den vorhandenen lokalen Bild-Solvern.

Installation: deploy/install-anbieter.sh. JSON auf stdout, keine externen APIs.
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
import time
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ROOT / '.anbieter'
PROJECT = RUNTIME / 'recaptcha_ia_solver'
CACHE = Path(os.getenv('DATEN_ORDNER', str(ROOT / 'daten'))) / 'anbieter.json'


async def aufloesen(url):
    parsed = urlparse(url)
    if parsed.scheme != 'https' or parsed.hostname not in ('burningseries.ac', 'www.burningseries.ac') or not parsed.path.startswith('/serie/'):
        raise ValueError('Ungültige Anbieter-Adresse')
    try:
        cache = json.loads(CACHE.read_text())
    except (OSError, ValueError):
        cache = {}
    hit = cache.get(url)
    if hit and hit['bis'] > time.time():
        return {'ok': True, 'url': hit['url'], 'cached': True}

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
    (PROJECT / 'recaptcha_images').mkdir(exist_ok=True)

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
        try:
            await frame.locator('.rc-imageselect-dynamic-selected').first.wait_for(state='hidden', timeout=12000)
        except Exception:
            pass
        table = await frame.query_selector('table')
        return await asyncio.to_thread(erkennen, await table.screenshot(), target, n) if table else []

    image_solve._classify_grid = grid
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
        await page.goto(url, wait_until='domcontentloaded', timeout=30000)
        await page.locator('.hoster-player').wait_for(timeout=30000)
        try:
            await page.get_by_text('Got it!', exact=True).first.click(timeout=2000)
        except Exception:
            pass
        await page.locator('.hoster-player').click()
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
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    cache = {k: v for k, v in cache.items() if v.get('bis', 0) > time.time()}
    cache[url] = {'url': result['url'], 'bis': time.time() + 6 * 3600}
    temp = CACHE.with_suffix('.tmp')
    temp.write_text(json.dumps(cache), encoding='utf-8')
    temp.chmod(0o600)
    temp.replace(CACHE)
    return result


async def versuchen(url):
    for _ in range(3):
        try:
            result = await asyncio.wait_for(aufloesen(url), timeout=180)
            if result['ok']:
                return result
        except asyncio.TimeoutError:
            result = {'ok': False, 'fehler': 'Zeitlimit bei der Anbieter-Freigabe'}
        await asyncio.sleep(3)
    return result


if __name__ == '__main__':
    logging.basicConfig(level=logging.ERROR)
    try:
        with contextlib.redirect_stdout(sys.stderr):
            result = asyncio.run(asyncio.wait_for(versuchen(sys.argv[1]), timeout=600))
    except Exception as exc:
        result = {'ok': False, 'fehler': 'Zeitlimit bei der Anbieter-Freigabe' if isinstance(exc, asyncio.TimeoutError) else 'Anbieter-Freigabe fehlgeschlagen'}
    print(json.dumps(result))
    sys.exit(0 if result['ok'] else 1)
