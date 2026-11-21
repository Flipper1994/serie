"""Kostenfreie Tests: ausschließlich nachgebildete API-Antworten."""
import asyncio
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch
from captcha_api import CaptchaFehler, ticket_holen


async def ohne_warten(_):
    pass


class CaptchaTests(unittest.IsolatedAsyncioTestCase):
    async def test_ein_auftrag_mehrere_ergebnisabfragen(self):
        aufrufe = []
        def api(methode, daten):
            aufrufe.append(methode)
            if methode == 'createTask':
                return {'errorId': 0, 'taskId': 123}
            if aufrufe.count('getTaskResult') == 1:
                return {'errorId': 0, 'status': 'processing'}
            return {'errorId': 0, 'status': 'ready', 'solution': {'gRecaptchaResponse': 'test-' * 20}, 'cost': '0.00299'}
        ticket, kosten = await ticket_holen('test', {}, lambda *a, **k: None, api, ohne_warten)
        self.assertTrue(ticket)
        self.assertEqual(kosten, '0.00299')
        self.assertEqual(aufrufe, ['createTask', 'getTaskResult', 'getTaskResult'])

    async def test_kein_guthaben_keine_wiederholung(self):
        aufrufe = []
        def api(methode, daten):
            aufrufe.append(methode)
            return {'errorId': 10, 'errorCode': 'ERROR_ZERO_BALANCE'}
        with self.assertRaisesRegex(CaptchaFehler, 'Guthaben'):
            await ticket_holen('test', {}, lambda *a, **k: None, api, ohne_warten)
        self.assertEqual(aufrufe, ['createTask'])

    async def test_unklare_netzwerkantwort_keine_wiederholung(self):
        aufrufe = []
        def api(methode, daten):
            aufrufe.append(methode)
            raise TimeoutError()
        with self.assertRaises(TimeoutError):
            await ticket_holen('test', {}, lambda *a, **k: None, api, ohne_warten)
        self.assertEqual(aufrufe, ['createTask'])

    async def test_ungeloest_keine_neue_aufgabe(self):
        aufrufe = []
        def api(methode, daten):
            aufrufe.append(methode)
            return {'errorId': 0, 'taskId': 123} if methode == 'createTask' else {'errorId': 12, 'errorCode': 'ERROR_CAPTCHA_UNSOLVABLE'}
        with self.assertRaises(CaptchaFehler):
            await ticket_holen('test', {}, lambda *a, **k: None, api, ohne_warten)
        self.assertEqual(aufrufe, ['createTask', 'getTaskResult'])

    async def test_timeout_beendet_bestehenden_auftrag(self):
        aufrufe = []
        def api(methode, daten):
            aufrufe.append(methode)
            return {'errorId': 0, 'taskId': 123} if methode == 'createTask' else {'errorId': 0, 'status': 'processing'}
        with self.assertRaises(asyncio.TimeoutError):
            await asyncio.wait_for(ticket_holen('test', {}, lambda *a, **k: None, api, asyncio.sleep), .05)
        self.assertEqual(aufrufe, ['createTask'])

    async def test_cache_und_kein_automatischer_zweiter_versuch(self):
        spec = importlib.util.spec_from_file_location('anbieter_test', Path(__file__).with_name('anbieter-link.py'))
        modul = importlib.util.module_from_spec(spec)
        with patch.dict('os.environ', {'ANBIETER_CAPTCHA': '2captcha'}):
            spec.loader.exec_module(modul)
        self.assertEqual(modul.MAX_VERSUCHE, 1)
        with tempfile.TemporaryDirectory() as tmp:
            modul.CACHE = Path(tmp) / 'anbieter.json'
            url = 'https://burningseries.ac/serie/Test/1/1-Test/de/VOE'
            ergebnis = {'ok': True, 'url': 'https://voe.sx/test', 'cached': False}
            freigeben = AsyncMock(return_value=ergebnis)
            with patch('captcha_api.freigeben', freigeben), patch.object(modul, 'status'):
                self.assertTrue((await modul.versuchen(url, tmp))['ok'])
                self.assertTrue((await modul.versuchen(url, tmp))['cached'])
                freigeben.assert_awaited_once()
                self.assertTrue(json.loads(modul.CACHE.read_text())[url]['bis'] > 0)
            freigeben = AsyncMock(side_effect=CaptchaFehler('Kontrollierter Fehler'))
            with patch('captcha_api.freigeben', freigeben), patch.object(modul, 'status'):
                self.assertFalse((await modul.versuchen(url.replace('/VOE', '/Vidmoly'), tmp))['ok'])
                freigeben.assert_awaited_once()


if __name__ == '__main__':
    unittest.main()
