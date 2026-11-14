import copy
import unittest

from expedition73 import indicator_adapter, precipitation_history as history
from expedition73.power import ROOT, PilotError, months


class PrecipitationHistoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        examples = ROOT / 'examples'
        cls.controls = {
            region: indicator_adapter.adapt_precipitation(
                examples / 'precipitation-grid-probe-2024', examples / 'precipitation-area-audit-2024.json', region)
            for region in ('A', 'B')
        }
        cls.source = examples / 'precipitation-history-2001-2023'
        cls.data = history.replay(ROOT, cls.source, cls.controls)

    def test_real_rates_keep_complete_months_and_recorded_2024_seed(self):
        history.validate_projection(self.data, self.controls, None)
        expected = {'A': (56, 0.876732698162801), 'B': (55, 0.8686186571882814)}
        for region in self.data['regions']:
            region_id = region['id']
            count, first_rate = expected[region_id]
            self.assertEqual([row['date'] for row in region['series']], months(2001, 2024))
            self.assertTrue(all(row['status'] == 'complete' and row['valid_cells'] == count for row in region['series']))
            self.assertAlmostEqual(region['series'][0]['value'], first_rate, places=12)
            self.assertEqual(region['series'][-12:], self.controls[region_id]['series'])

    def test_projection_rejects_changed_seed_duplicate_date_and_invalid_coverage(self):
        for month, field, value in [(-1, 'value', 0), (1, 'date', '2001-01'), (0, 'valid_cells', 55), (0, 'value', -1)]:
            with self.subTest(month=month, field=field):
                data = copy.deepcopy(self.data)
                data['regions'][0]['series'][month][field] = value
                with self.assertRaises(PilotError):
                    history.validate_projection(data, self.controls, None)

    def test_replay_rejects_mismatched_seed_geometry(self):
        controls = copy.deepcopy(self.controls)
        controls['B']['spatial_support']['cell_geometry_sha256'] = '0' * 64
        with self.assertRaises(PilotError):
            history.replay(ROOT, self.source, controls)
