"""Offline checks for a candidate point probe; not a regional precipitation module."""
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

from expedition73 import precipitation_probe as probe
from expedition73.power import ROOT, PilotError, loads


class PrecipitationProbeTests(unittest.TestCase):
    def setUp(self):
        self.run = ROOT / 'examples/precipitation-point-probe-2024'
        self.raw = (self.run / 'a-response.json').read_bytes()
        self.data = loads(self.raw)
        self.config = probe.config_for('A')
        self.baseline = (ROOT / 'examples/a-point-2024/response.json').read_bytes()

    def inspect(self, data=None, baseline=None):
        return probe.inspect_response(self.raw if data is None else json.dumps(data).encode(), self.config,
                                      self.baseline if baseline is None else json.dumps(baseline).encode())

    def test_real_point_samples_are_complete_but_not_scientifically_accepted(self):
        report = probe.validate_run(self.run)
        self.assertEqual([r['joint_valid_months'] for r in report['regions']], [12, 12])
        self.assertFalse(report['scientific_compatibility_accepted'])
        self.assertFalse(report['region_mean_performed'])
        self.assertFalse(report['monthly_total_conversion_performed'])
        self.assertFalse(report['temperature_dependency_or_inference_performed'])
        self.assertEqual(report['regions'][0]['precipitation'][0]['value'], 0.73)
        self.assertEqual(report['regions'][1]['precipitation'][0]['value'], 0.81)
        self.assertTrue(all(r['recorded_t2m_control']['monthly_values_and_statuses_match'] for r in report['regions']))

    def test_provider_annual_value_is_not_a_thirteenth_month(self):
        report = self.inspect()
        self.assertEqual(len(report['precipitation']), 12)
        self.assertEqual(report['provider_annual_summaries_separate']['PRECTOTCORR'], 0.55)
        self.assertEqual(report['precipitation'][-1]['date'], '2024-12')

    def test_zero_fill_and_missing_remain_distinct(self):
        d = copy.deepcopy(self.data)
        d['properties']['parameter']['PRECTOTCORR'].update({'202401': 0, '202402': -999})
        del d['properties']['parameter']['PRECTOTCORR']['202403']
        rows = self.inspect(d)['precipitation']
        self.assertEqual([r['status'] for r in rows[:3]], ['valid', 'provider_fill', 'not_returned'])
        self.assertEqual([r['value'] for r in rows[:3]], [0, None, None])

    def test_definition_or_unit_changes_are_rejected_without_conversion(self):
        for key, field, val in [('PRECTOTCORR', 'units', 'mm'), ('PRECTOTCORR', 'longname', 'Rainfall'), ('T2M', 'units', 'K')]:
            with self.subTest(key=key, field=field):
                d = copy.deepcopy(self.data); d['parameters'][key][field] = val
                with self.assertRaises(PilotError): self.inspect(d)

    def test_negative_precipitation_in_month_or_annual_is_invalid(self):
        for key in ['202401', '202413']:
            d = copy.deepcopy(self.data); d['properties']['parameter']['PRECTOTCORR'][key] = -0.01
            with self.assertRaises(PilotError): self.inspect(d)

    def test_bool_nonfinite_and_duplicate_json_are_rejected(self):
        for val in [True, float('nan'), float('inf')]:
            d = copy.deepcopy(self.data); d['properties']['parameter']['PRECTOTCORR']['202401'] = val
            with self.assertRaises(PilotError): self.inspect(d)
        with self.assertRaises(PilotError): probe.inspect_response(b'{"type":1,"type":2}', self.config, self.baseline)

    def test_scope_time_source_point_and_extra_parameters_fail_closed(self):
        for kind in ['time', 'period', 'source', 'point', 'parameter']:
            d = copy.deepcopy(self.data)
            if kind == 'time': d['header']['time_standard'] = 'UTC'
            if kind == 'period': d['header']['start'] = '20230101'
            if kind == 'source': d['header']['sources'] = ['OTHER']
            if kind == 'point': d['geometry']['coordinates'][0] += 1
            if kind == 'parameter': d['properties']['parameter']['other'] = {}
            with self.subTest(kind=kind), self.assertRaises(PilotError): self.inspect(d)

    def test_extra_year_or_invalid_month_is_not_silently_ignored(self):
        for key in ['202301', '202400', '202414']:
            d = copy.deepcopy(self.data); d['properties']['parameter']['PRECTOTCORR'][key] = 1
            with self.assertRaises(PilotError): self.inspect(d)

    def test_control_value_or_api_drift_is_reported_not_accepted(self):
        d = copy.deepcopy(self.data); d['properties']['parameter']['T2M']['202401'] += 1
        self.assertFalse(self.inspect(d)['recorded_t2m_control']['monthly_values_and_statuses_match'])
        d = copy.deepcopy(self.data); d['header']['api']['version'] = 'candidate-other'
        self.assertFalse(self.inspect(d)['recorded_t2m_control']['api_version_matches'])

    def test_request_uses_explicit_parameters_coordinates_and_fixed_scope(self):
        query = parse_qs(urlsplit(probe.request_url(self.config)).query)
        self.assertEqual(query['parameters'], ['T2M,PRECTOTCORR'])
        self.assertEqual(query['longitude'], ['-111.0'])
        self.assertEqual(query['community'], ['AG'])
        self.assertEqual(query['start'], ['2024'])
        wrong = copy.deepcopy(self.config); wrong['start_year'] = 2023
        with self.assertRaises(PilotError): probe.request_url(wrong)

    def test_capture_hash_url_shape_and_time_must_match(self):
        capture = loads((self.run / 'capture.json').read_bytes())
        raws = {r: (self.run / f'{r.lower()}-response.json').read_bytes() for r in probe.REGIONS}
        for kind in ['hash', 'url', 'time', 'extra']:
            c = copy.deepcopy(capture)
            if kind == 'hash': c['requests']['A']['sha256'] = '0' * 64
            if kind == 'url': c['requests']['B']['url'] = 'https://example.invalid/'
            if kind == 'time': c['retrieved_at'] = '2026-10-28T00:00:00'
            if kind == 'extra': c['private'] = 'not allowed'
            with self.subTest(kind=kind), self.assertRaises(PilotError): probe.report_for(raws, c)
        for c in [[], {}, {'schema_version': '0.1.0', 'retrieved_at': 'x', 'requests': False}]:
            with self.assertRaises(PilotError): probe.report_for(raws, c)

    def test_modified_report_or_boolean_claim_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / 'run'; shutil.copytree(self.run, target)
            original = loads((target / 'report.json').read_bytes())
            for kind in ['value', 'claim', 'extra']:
                report = copy.deepcopy(original)
                if kind == 'value': report['regions'][0]['precipitation'][0]['value'] += 1
                if kind == 'claim': report['scientific_compatibility_accepted'] = 0
                if kind == 'extra': report['accepted_by_m2'] = True
                (target / 'report.json').write_text(json.dumps(report), encoding='utf-8')
                with self.subTest(kind=kind), self.assertRaises(PilotError): probe.validate_run(target)

    def test_tampered_raw_response_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / 'run'; shutil.copytree(self.run, target)
            with (target / 'a-response.json').open('ab') as f: f.write(b' ')
            with self.assertRaises(PilotError): probe.validate_run(target)

    def test_existing_output_is_preserved_without_network_access(self):
        with patch.object(probe, 'urlopen') as network:
            with self.assertRaises(PilotError): probe.fetch_probe(self.run)
            network.assert_not_called()

    def test_extra_run_file_is_not_treated_as_a_valid_package(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / 'run'; shutil.copytree(self.run, target)
            (target / 'extra.txt').write_text('extra', encoding='utf-8')
            with self.assertRaises(PilotError): probe.validate_run(target)

    def test_network_error_saves_no_output(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(probe, 'urlopen', side_effect=URLError('offline')):
            target = Path(temp) / 'new'
            with self.assertRaises(PilotError): probe.fetch_probe(target)
            self.assertFalse(target.exists())

    def test_size_limit_is_checked_before_parsing(self):
        with self.assertRaises(PilotError): probe.inspect_response(b' ' * (probe.LIMIT + 1), self.config, self.baseline)

    def test_validation_cli_replays_without_network(self):
        with patch.object(probe, 'urlopen', side_effect=AssertionError('network forbidden')), redirect_stdout(io.StringIO()) as out:
            probe.main(['validate', str(self.run)])
        self.assertEqual(json.loads(out.getvalue())['valid_months'], {'A': 12, 'B': 12})


if __name__ == '__main__': unittest.main()
