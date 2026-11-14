"""Candidate geometry/rate calculation, fixed support and source replay."""
import copy
import hashlib
import io
import json
import math
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from expedition73 import precipitation_area_audit as audit, precipitation_grid_probe as grid
from expedition73.power import ROOT, PilotError, loads


class PrecipitationAreaAuditTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = ROOT / 'examples/precipitation-grid-probe-2024'
        cls.probe = grid.validate_run(cls.source)
        cls.result = audit.build_audit(cls.source)

    def region(self, index=0):
        return copy.deepcopy(self.probe['regions'][index])

    def test_real_complete_scope_and_identities(self):
        result = self.result
        self.assertEqual(result['output_type'], 'candidate_precipitation_area_audit')
        self.assertEqual([r['window_cell_count'] for r in result['regions']], [56, 55])
        self.assertEqual([r['complete_months'] for r in result['regions']], [12, 12])
        for key in ('scientific_compatibility_accepted', 'land_mask_performed', 'totals_or_inference_performed'):
            self.assertIs(result[key], False)
        for name, digest in result['source_files_sha256'].items():
            self.assertEqual(digest, hashlib.sha256((self.source / name).read_bytes()).hexdigest())
        self.assertEqual(result['variable']['unit'], 'mm/day')
        self.assertEqual(result['method']['provider_annual_summary'], 'not_consumed')

    def test_real_means_against_independent_raw_geometry_oracle(self):
        # No expected_cells/spherical_area helper: reconstruct each intersection
        # directly from native raw centres and integrate sin(latitude).
        for index, code in enumerate(('A', 'B')):
            original = self.probe['regions'][index]
            west, south, east, north = original['candidate_bbox']
            raw_cells = {}
            for tile in grid.plan_for(code):
                for f in loads((self.source / tile['filename']).read_bytes())['features']:
                    lon, lat = f['geometry']['coordinates'][:2]
                    raw_cells[(lon, lat)] = f['properties']['parameter']['PRECTOTCORR']
            weights = {}
            for (lon, lat), values in raw_cells.items():
                lo, hi = max(west, lon - .3125), min(east, lon + .3125)
                bottom, top = max(south, lat - .25), min(north, lat + .25)
                if hi > lo and top > bottom:
                    weights[(lon, lat)] = (hi - lo) * (math.sin(math.radians(top)) - math.sin(math.radians(bottom)))
            denominator = math.fsum(weights.values())
            for month, row in enumerate(self.result['regions'][index]['series'], 1):
                expected = math.fsum(w * raw_cells[key][f'2024{month:02d}'] for key, w in weights.items()) / denominator
                self.assertAlmostEqual(row['mean_rate_mm_per_day'], expected, places=12)

    def test_constant_field_is_preserved_and_weights_sum_to_one(self):
        region = self.region()
        for cell in region['cells']:
            for row in cell['series']: row['value'] = 2.5
        result = audit.summarize_region(region)
        self.assertAlmostEqual(math.fsum(c['area_weight'] for c in result['cell_weights']), 1)
        self.assertTrue(all(abs(r['mean_rate_mm_per_day'] - 2.5) < 1e-12 for r in result['series']))

    def test_missing_fill_and_zero_keep_full_denominator(self):
        region = self.region()
        for cell in region['cells']: cell['series'][0]['value'] = 0
        region['cells'][0]['series'][1].update(value=None, status='provider_fill')
        region['cells'][1]['series'][2].update(value=None, status='not_returned')
        result = audit.summarize_region(region)
        self.assertEqual(result['series'][0]['mean_rate_mm_per_day'], 0)
        for row, flag in zip(result['series'][1:3], ('provider_fill_cells', 'not_returned_cells')):
            self.assertIsNone(row['mean_rate_mm_per_day'])
            self.assertEqual((row['expected_cells'], row['valid_cells'], row[flag]), (56, 55, 1))
            self.assertLess(row['valid_area_fraction'], 1)
        self.assertEqual(result['complete_months'], 10)

    def test_all_missing_is_null_with_zero_coverage(self):
        region = self.region(1)
        for cell in region['cells']: cell['series'][0].update(value=None, status='not_returned')
        row = audit.summarize_region(region)['series'][0]
        self.assertIsNone(row['mean_rate_mm_per_day'])
        self.assertEqual((row['valid_cells'], row['valid_area_fraction']), (0, 0))

    def test_no_annual_provider_value_is_used(self):
        region = self.region()
        before = audit.summarize_region(region)
        for cell in region['cells']: cell['provider_annual_summary_separate'] = 1e20
        self.assertEqual(audit.summarize_region(region), before)
        self.assertEqual(len(before['series']), 12)

    def test_missing_duplicate_or_changed_cell_is_rejected(self):
        for mode in ('missing', 'duplicate', 'coordinate'):
            region = self.region()
            if mode == 'missing': region['cells'].pop()
            if mode == 'duplicate': region['cells'].append(copy.deepcopy(region['cells'][0]))
            if mode == 'coordinate': region['cells'][0]['longitude'] += .01
            with self.subTest(mode=mode), self.assertRaises(PilotError): audit.summarize_region(region)

    def test_wrong_units_support_and_month_are_rejected(self):
        for mode in ('unit', 'grid', 'time', 'date', 'length'):
            region = self.region()
            if mode == 'unit': region['unit'] = 'mm'
            if mode == 'grid': region['temperature_control']['coordinate_sets_match'] = False
            if mode == 'time': region['temperature_control']['time_source_api_match'] = False
            if mode == 'date': region['cells'][0]['series'][0]['date'] = '2025-01'
            if mode == 'length': region['cells'][0]['series'].pop()
            with self.subTest(mode=mode), self.assertRaises(PilotError): audit.summarize_region(region)

    def test_invalid_values_and_statuses_are_rejected(self):
        for value in (-1, True, float('nan'), float('inf'), None):
            region = self.region(); region['cells'][0]['series'][0]['value'] = value
            with self.subTest(value=value), self.assertRaises(PilotError): audit.summarize_region(region)
        region = self.region(); region['cells'][0]['series'][0]['status'] = 'complete'
        with self.assertRaises(PilotError): audit.summarize_region(region)

    def test_latitude_hint_never_implies_equal_observational_support(self):
        a, b = [r['latitude_context'] for r in self.result['regions']]
        self.assertEqual(a['regime_hint'], 'entirely_equatorward_42_5')
        self.assertEqual(b['regime_hint'], 'entirely_poleward_62_5')
        self.assertEqual(a['absolute_latitude_range_deg'], [36, 39])
        self.assertEqual(b['absolute_latitude_range_deg'], [68, 70])
        self.assertIs(a['observational_support_equivalence_accepted'], False)
        self.assertIs(b['observational_support_equivalence_accepted'], False)

    def test_source_report_and_raw_tampering_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / 'source'; shutil.copytree(self.source, source)
            file = source / 'report.json'; original = file.read_bytes()
            data = loads(original); data['regions'][0]['cells'][0]['series'][0]['value'] += 1
            file.write_text(json.dumps(data))
            with self.assertRaises(PilotError): audit.build_audit(source)
            file.write_bytes(original)
            raw = source / 'a-tile-001.json'; raw.write_bytes(raw.read_bytes() + b' ')
            with self.assertRaises(PilotError): audit.build_audit(source)

    def test_output_tamper_cannot_enable_claims_or_change_source(self):
        for field in ('claim', 'value', 'hash', 'count', 'unit'):
            result = copy.deepcopy(self.result)
            if field == 'claim': result['scientific_compatibility_accepted'] = 0
            if field == 'value': result['regions'][0]['series'][0]['mean_rate_mm_per_day'] += .01
            if field == 'hash': result['source_files_sha256']['capture.json'] = '0' * 64
            if field == 'count': result['regions'][0]['series'][0]['expected_cells'] = 56.0
            if field == 'unit': result['variable']['unit'] = 'mm'
            with tempfile.TemporaryDirectory() as tmp:
                output = Path(tmp) / 'audit.json'; output.write_text(json.dumps(result))
                with self.subTest(field=field), self.assertRaises(PilotError): audit.validate_audit(self.source, output)

    def test_float_noise_only_with_exact_metadata_types(self):
        data = copy.deepcopy(self.result)
        data['regions'][0]['series'][0]['mean_rate_mm_per_day'] += 1e-13
        self.assertTrue(audit._same(data, self.result))
        data['scientific_compatibility_accepted'] = 0
        self.assertFalse(audit._same(data, self.result))

    def test_write_replay_cli_offline_and_preserve_existing_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'audit.json'
            with patch.object(grid, 'urlopen', side_effect=AssertionError('network forbidden')):
                audit.write_audit(self.source, output)
                expected = output.read_bytes()
                self.assertEqual(audit.validate_audit(self.source, output), self.result)
                with self.assertRaises(PilotError): audit.write_audit(self.source, output)
                self.assertEqual(output.read_bytes(), expected)
                with redirect_stdout(io.StringIO()) as text:
                    audit.main(['validate', str(self.source), str(output)])
                self.assertEqual(json.loads(text.getvalue())['status'], 'replay_passed')

    def test_invalid_source_leaves_no_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / 'source'; shutil.copytree(self.source, source)
            (source / 'capture.json').write_bytes(b'{}')
            output = Path(tmp) / 'audit.json'
            with self.assertRaises(PilotError): audit.write_audit(source, output)
            self.assertFalse(output.exists())

    def test_bounded_exact_files_and_duplicate_json_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / 'source'; shutil.copytree(self.source, source)
            extra = source / 'extra.json'; extra.write_bytes(b'{}')
            with self.assertRaises(PilotError): audit.build_audit(source)
            extra.unlink()
            with patch.object(grid, 'LIMIT', 100):
                with self.assertRaises(PilotError): audit.build_audit(source)
            output = Path(tmp) / 'audit.json'; output.write_bytes(b'{"x":0,"x":1}')
            with self.assertRaises(PilotError): audit.validate_audit(self.source, output)
            output.write_bytes(b' ' * (audit.LIMIT + 1))
            with self.assertRaises(PilotError): audit.validate_audit(self.source, output)


if __name__ == '__main__':
    unittest.main()
