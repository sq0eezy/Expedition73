"""Recorded grid support, duplicate handling and missing-value audit checks."""
import copy
import io
import json
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch
from urllib.error import URLError
from urllib.parse import parse_qs, urlsplit

from expedition73 import precipitation_grid_probe as probe
from expedition73.power import ROOT, PilotError, loads


class PrecipitationGridProbeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sample = ROOT / 'examples/precipitation-grid-probe-2024'
        cls.raws = {t['filename']: (cls.sample / t['filename']).read_bytes() for r in probe.REGIONS for t in probe.plan_for(r)}
        cls.capture = loads((cls.sample / 'capture.json').read_bytes())

    def tile(self, name='a-tile-001.json'):
        return copy.deepcopy(loads(self.raws[name]))

    def region(self, region='A', changed=None):
        raws = dict(self.raws)
        if changed:
            for name, data in changed.items(): raws[name] = json.dumps(data).encode()
        return probe.inspect_region(region, raws)

    def decode(self, data):
        return probe._decode_tile(json.dumps(data).encode(), probe.plan_for('A')[0])

    def test_real_grid_has_exact_support_and_separate_scientific_gate(self):
        report = probe.validate_run(self.sample)
        self.assertEqual([r['window_cell_count'] for r in report['regions']], [56, 55])
        self.assertEqual([r['complete_months'] for r in report['regions']], [12, 12])
        self.assertTrue(all(r['temperature_control']['coordinate_sets_match'] for r in report['regions']))
        self.assertTrue(all(r['temperature_control']['time_source_api_match'] for r in report['regions']))
        for key in ['scientific_compatibility_accepted', 'precipitation_region_mean_performed', 'monthly_total_conversion_performed', 'mask_or_inference_performed']:
            self.assertIs(report[key], False)

    def test_request_geometry_uses_three_bounded_single_parameter_calls(self):
        a, b = probe.plan_for('A'), probe.plan_for('B')
        self.assertEqual([len(a), len(b)], [1, 2])
        self.assertEqual(b[0]['request_bbox'], [-156.3125, 67.75, -152.6875, 70.25])
        for tile in a + b:
            q = parse_qs(urlsplit(tile['precipitation_url']).query)
            self.assertEqual(q['parameters'], ['PRECTOTCORR'])
            self.assertEqual(q['community'], ['AG'])
            w, s, e, n = tile['request_bbox']
            self.assertLessEqual(e - w, 5); self.assertLessEqual(n - s, 5)

    def test_duplicate_overlap_is_removed_only_when_raw_cells_agree(self):
        r = self.region('B')
        self.assertEqual(r['duplicate_cells_removed'], 5)
        self.assertEqual(r['returned_unique_cells'], 55)
        self.assertEqual(len({(c['longitude'], c['latitude']) for c in r['cells']}), 55)

    def test_conflicting_overlap_is_rejected_not_averaged(self):
        left, right = self.tile('b-tile-001.json'), self.tile('b-tile-002.json')
        keys = {tuple(c['geometry']['coordinates'][:2]) for c in left['features']}
        duplicate = next(c for c in right['features'] if tuple(c['geometry']['coordinates'][:2]) in keys)
        duplicate['properties']['parameter']['PRECTOTCORR']['202401'] += 1
        with self.assertRaisesRegex(PilotError, 'Overlapping'): self.region('B', {'b-tile-002.json': right})

    def test_missing_overlap_in_one_tile_cannot_be_hidden_by_the_other(self):
        left, right = self.tile('b-tile-001.json'), self.tile('b-tile-002.json')
        keys = {tuple(c['geometry']['coordinates'][:2]) for c in left['features']}
        right['features'] = [c for c in right['features'] if tuple(c['geometry']['coordinates'][:2]) not in keys]
        with self.assertRaisesRegex(PilotError, 'Tile omits'): self.region('B', {'b-tile-002.json': right})

    def test_a_missing_window_cell_is_not_a_smaller_valid_region(self):
        d = self.tile(); d['features'].pop()
        with self.assertRaisesRegex(PilotError, 'omits'): self.decode(d)

    def test_duplicate_inside_one_response_is_rejected(self):
        d = self.tile(); d['features'].append(copy.deepcopy(d['features'][0]))
        with self.assertRaisesRegex(PilotError, 'Duplicate'): self.decode(d)

    def test_rate_zero_fill_and_not_returned_are_distinct_without_renormalization(self):
        d = self.tile(); values = d['features'][0]['properties']['parameter']['PRECTOTCORR']
        values['202401'] = 0; values['202402'] = -999; del values['202403']
        result = self.region(changed={'a-tile-001.json': d})
        self.assertEqual(result['window_cell_count'], 56)
        self.assertEqual(result['valid_cells_by_month'][:3], [56, 55, 55])
        self.assertEqual(result['complete_months'], 10)
        self.assertEqual([r['status'] for r in result['cells'][0]['series'][:3]], ['valid', 'provider_fill', 'not_returned'])

    def test_annual_summary_is_not_an_extra_month(self):
        r = self.region()
        self.assertEqual(len(r['cells'][0]['series']), 12)
        self.assertIsInstance(r['cells'][0]['provider_annual_summary_separate'], float)
        self.assertEqual(r['unit'], 'mm/day')

    def test_metadata_or_parameter_changes_are_rejected(self):
        for kind in ['unit', 'name', 'source', 'time', 'period', 'feature-parameter']:
            d = self.tile()
            if kind == 'unit': d['parameters']['PRECTOTCORR']['units'] = 'mm'
            if kind == 'name': d['parameters']['PRECTOTCORR']['longname'] = 'Rainfall'
            if kind == 'source': d['header']['sources'] = ['OTHER']
            if kind == 'time': d['header']['time_standard'] = 'UTC'
            if kind == 'period': d['header']['end'] = '20231231'
            if kind == 'feature-parameter': d['features'][0]['properties']['parameter']['T2M'] = {}
            with self.subTest(kind=kind), self.assertRaises(PilotError): self.decode(d)

    def test_irregular_or_outside_coordinates_are_rejected(self):
        for offset in [0.01, 20]:
            d = self.tile(); d['features'][0]['geometry']['coordinates'][0] += offset
            with self.assertRaises(PilotError): self.decode(d)

    def test_negative_bool_nonfinite_and_extra_period_are_rejected(self):
        for value in [-0.01, True, float('nan'), float('inf')]:
            d = self.tile(); d['features'][0]['properties']['parameter']['PRECTOTCORR']['202401'] = value
            with self.subTest(value=value), self.assertRaises(PilotError): self.decode(d)
        d = self.tile(); d['features'][0]['properties']['parameter']['PRECTOTCORR']['202301'] = 1
        with self.assertRaises(PilotError): self.decode(d)

    def test_mixed_tile_api_metadata_is_not_blended(self):
        d = self.tile('b-tile-002.json'); d['header']['api']['version'] = 'other-api'
        with self.assertRaisesRegex(PilotError, 'metadata differs'): self.region('B', {'b-tile-002.json': d})

    def test_baseline_api_difference_is_reported_without_scientific_acceptance(self):
        d = self.tile(); d['header']['api']['version'] = 'other-api'
        self.assertFalse(self.region(changed={'a-tile-001.json': d})['temperature_control']['time_source_api_match'])

    def test_capture_identity_time_shape_and_partial_requests_are_rejected(self):
        for kind in ['hash', 'url', 'time', 'missing', 'extra']:
            c = copy.deepcopy(self.capture)
            if kind == 'hash': c['requests']['a-tile-001.json']['sha256'] = '0' * 64
            if kind == 'url': c['requests']['b-tile-002.json']['url'] = 'https://example.invalid/'
            if kind == 'time': c['retrieved_at'] = '2026-10-28T00:00:00'
            if kind == 'missing': del c['requests']['b-tile-002.json']
            if kind == 'extra': c['private'] = 'not allowed'
            with self.subTest(kind=kind), self.assertRaises(PilotError): probe.report_for(self.raws, c)
        with self.assertRaises(PilotError): probe.report_for(self.raws, [])

    def test_saved_report_and_source_tampering_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / 'run'; shutil.copytree(self.sample, target)
            original = loads((target / 'report.json').read_bytes())
            for field, val in [('scientific_compatibility_accepted', 0), ('precipitation_region_mean_performed', True), ('extra', 'not allowed')]:
                changed = copy.deepcopy(original); changed[field] = val
                (target / 'report.json').write_text(json.dumps(changed), encoding='utf-8')
                with self.assertRaises(PilotError): probe.validate_run(target)
            (target / 'report.json').write_text(json.dumps(original), encoding='utf-8')
            with (target / 'a-tile-001.json').open('ab') as f: f.write(b' ')
            with self.assertRaises(PilotError): probe.validate_run(target)

    def test_existing_target_and_network_failure_preserve_output(self):
        with patch.object(probe, 'urlopen') as network:
            with self.assertRaises(PilotError): probe.fetch_probe(self.sample)
            network.assert_not_called()
        with tempfile.TemporaryDirectory() as temp, patch.object(probe, 'urlopen', side_effect=URLError('offline')):
            target = Path(temp) / 'new'
            with self.assertRaises(PilotError): probe.fetch_probe(target)
            self.assertFalse(target.exists())

    def test_file_set_is_bounded_to_the_computed_plan(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / 'run'; shutil.copytree(self.sample, target)
            (target / 'other.txt').write_text('extra', encoding='utf-8')
            with self.assertRaises(PilotError): probe.validate_run(target)
        with self.assertRaises(PilotError): probe._decode_tile(b' ' * (probe.LIMIT + 1), probe.plan_for('A')[0])

    def test_duplicate_json_and_malformed_features_are_rejected(self):
        with self.assertRaises(PilotError): probe._decode_tile(b'{"type":1,"type":2}', probe.plan_for('A')[0])
        for malformed in [None, [], 'not an object']:
            d = self.tile(); d['features'][0] = malformed
            with self.assertRaises(PilotError): self.decode(d)

    def test_cli_validation_does_not_open_network(self):
        with patch.object(probe, 'urlopen', side_effect=AssertionError('network forbidden')), redirect_stdout(io.StringIO()) as out:
            probe.main(['validate', str(self.sample)])
        result = json.loads(out.getvalue())
        self.assertEqual(result['status'], 'replay_passed')
        self.assertEqual([r['window_cell_count'] for r in result['regions']], [56, 55])


if __name__ == '__main__': unittest.main()
