"""Video-Endpunkt im unveränderten, fest gepinnten Byparr-Browserimage.

Behält Freigabe, Player und eingebettete Turnstile-Prüfung im selben Browser.
Nur über die lokale Containerbindung erreichbar; keine Browserdaten im Log.
"""
import asyncio
import re
from typing import Annotated
from urllib.parse import urlparse

from fastapi import Depends
from pydantic import BaseModel, Field
import uvicorn
from main import app
from src.challenge import challenge_present, solve_challenge, click_checkbox, checkbox_already_answered
from src.utils import BrowserDepClass, TimeoutTimer, get_browser, remaining_ms


class VideoRequest(BaseModel):
    url: str = Field(max_length=2048)
    maxTimeout: int = Field(default=90000, ge=1000, le=120000)


@app.post('/video')
async def video(request: VideoRequest, dep: Annotated[BrowserDepClass, Depends(get_browser)]):
    parsed = urlparse(request.url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname:
        return {'ok': False, 'fehler': 'Ungültige Video-URL'}
    page, context = dep.page, dep.context
    timer = TimeoutTimer(duration=request.maxTimeout / 1000)
    sources = []
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)[:160]))

    def response(r):
        if r.status >= 400 or not r.url.startswith(('http:', 'https:')):
            return
        headers = r.headers
        content_type = headers.get('content-type', '')
        path = urlparse(r.url).path
        if re.search('html|javascript|mp2t', content_type, re.I) or re.search(r'\.(ts|m4s)$', path, re.I):
            return
        hls = bool(re.search('mpegurl', content_type, re.I) or re.search(r'\.m3u8$', path, re.I))
        if not hls and not content_type.lower().startswith('video/') and not ('octet-stream' in content_type and re.search(r'\.(mp4|webm)$', path, re.I)):
            return
        try:
            size = int(headers.get('content-range', '/0').split('/')[-1]) or int(headers.get('content-length', '0'))
        except ValueError:
            size = 0
        sources.append({'url': r.url, 'art': 'hls' if hls else 'datei', 'referer': r.request.headers.get('referer', page.url), 'size': size})

    context.on('response', response)
    async def popup(p):
        if p != page:
            await p.close()
    context.on('page', popup)
    try:
        await page.goto(request.url, wait_until='domcontentloaded', timeout=remaining_ms(timer))
        if await challenge_present(page):
            await solve_challenge(page, timer)
        first_source = None
        attempt = 0
        while timer.remaining() > 0:
            if sources:
                first_source = first_source or asyncio.get_running_loop().time()
                if any(s['art'] == 'hls' or s['size'] > 5 * 1024**2 for s in sources) or asyncio.get_running_loop().time() - first_source > 4:
                    break
            # Dood/Playmogo verlangt zusätzlich zur Schutzseite einen Token im Player.
            if not await checkbox_already_answered(page):
                await click_checkbox(page)
            for frame in page.frames:
                if 'challenges.cloudflare.com' in frame.url:
                    continue
                try:
                    await asyncio.wait_for(frame.evaluate('''() => { for (const v of document.querySelectorAll('video')) { v.muted = true; v.play().catch(() => {}); } }'''), timeout=1.5)
                    play = frame.locator('.vjs-big-play-button, .jw-icon-display, .plyr__control--overlaid, #play-button, .play-button, button[aria-label="Play"]').first
                    if await asyncio.wait_for(play.is_visible(), timeout=1.5):
                        await play.click(timeout=800)
                except Exception:
                    # Leere Werberahmen haben teilweise keine installierte Utility-World.
                    pass
            if attempt % 3 == 0:
                await page.mouse.click(640, 360)
            attempt += 1
            await asyncio.sleep(1)
        if not sources:
            return {'ok': False, 'fehler': 'Browser-Fallback: Player geöffnet, aber keine Videoquelle gefunden',
                    'diagnose': {'title': (await page.title())[:150], 'playerFehler': errors[:3]}}
        source = next((s for s in sources if s['art'] == 'hls'), max(sources, key=lambda s: s['size']))
        source.pop('size', None)
        return {'ok': True, **source, 'titel': (await page.title())[:200],
                'cookies': await context.cookies(), 'userAgent': await page.evaluate('navigator.userAgent'), 'resolver': 'byparr'}
    except Exception as exc:
        return {'ok': False, 'fehler': f'Browser-Fallback: {type(exc).__name__}: {str(exc).splitlines()[0][:200]}'}


if __name__ == '__main__':
    uvicorn.run(app, host='0.0.0.0', port=8191, log_level='warning')
