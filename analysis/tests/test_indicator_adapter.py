"""Two recorded scientific calculations, one candidate transport language."""
import copy
import hashlib
import io
import json
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path
from unittest.mock import patch

from expedition73 import indicator_adapter as adapter, precipitation_area_audit as area, regional
from expedition73.power import ROOT, PilotError, loads


class IndicatorAdapterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.grid = ROOT / 'examples/precipitation-grid-probe-2024'
        cls.audit = ROOT / 'examples/precipitation-area-audit-2024.json'
        cls.temperature = {r: adapter.adapt_temperature(ROOT / f'examples/{r.lower()}-window-2024') for r in ('A', 'B')}
        cls.rain = {r: adapter.adapt_precipitation(cls.grid, cls.audit, r) for r in ('A', 'B')}

    def resign(self, value):
        value.pop('result_id', None)
        value['result_id'] = 'sha256:' + adapter.digest(value)
        return value

    def test_real_two_variables_and_two_regions_preserve_values_and_source_ids(self):
        original = loads(self.audit.read_bytes())
        for index, region in enumerate(('A', 'B')):
            t, p = self.temperature[region], self.rain[region]
            for value in (t, p): adapter.validate_result(value)
            source = ROOT / f'examples/{region.lower()}-window-2024/result.json'
            self.assertEqual(t['series'], loads(source.read_bytes())['series'])
            self.assertEqual(t['provenance']['source_result_sha256'], hashlib.sha256(source.read_bytes()).hexdigest())
            self.assertEqual([r['value'] for r in p['series']], [r['mean_rate_mm_per_day'] for r in original['regions'][index]['series']])
            self.assertEqual(p['provenance']['source_result_sha256'], hashlib.sha256(self.audit.read_bytes()).hexdigest())
            self.assertEqual(t['spatial_support']['cell_geometry_sha256'], p['spatial_support']['cell_geometry_sha256'])
            self.assertEqual((t['variable']['unit'], p['variable']['unit']), ('degC', 'mm/day'))

    def test_real_same_region_is_technically_coindexed_not_scientific_acceptance(self):
        for region in ('A', 'B'):
            result = adapter.assess_coindexed_inputs(self.temperature[region], self.rain[region])
            self.assertEqual((result['technical_status'], result['paired_valid_months']), ('compatible', 12))
            self.assertEqual(result['scientific_acceptance'], 'not_performed')
            self.assertIs(result['relationship_calculated'], False)
            self.assertIn('HIGH_LATITUDE_CORRECTION_REGIME_DIFFERS', result['warnings'])

    def test_other_region_or_source_snapshot_cannot_be_mixed(self):
        result = adapter.assess_coindexed_inputs(self.temperature['A'], self.rain['B'])
        self.assertEqual(result['technical_status'], 'incompatible')
        self.assertIn('REGION_DIFFERS', result['reasons'])
        self.assertIn('TEMPERATURE_CONTROL_SNAPSHOT_DIFFERS', result['reasons'])
        self.assertEqual(result['paired_valid_months'], 0)

    def test_named_ports_cannot_be_swapped_or_same_indicator_substituted(self):
        for first, second in ((self.rain['A'], self.temperature['A']), (self.temperature['A'], self.temperature['A'])):
            with self.assertRaises(PilotError): adapter.assess_coindexed_inputs(first, second)

    def test_units_are_not_implicitly_converted_or_indicators_relabelled(self):
        for mode in ('unit', 'module', 'parameter', 'method'):
            value = copy.deepcopy(self.rain['A'])
            if mode == 'unit': value['variable']['unit'] = 'mm'
            if mode == 'module': value['module']['id'] = 'air_temperature_2m'
            if mode == 'parameter': value['variable']['provider_parameter'] = 'T2M'
            if mode == 'method': value['method']['id'] = 'spherical_midpoint_cell_intersection'
            with self.subTest(mode=mode), self.assertRaises(PilotError): adapter.validate_result(self.resign(value))

    def test_warning_acceptance_and_annual_semantics_cannot_be_dropped(self):
        for mode in ('warning', 'observations', 'acceptance', 'annual', 'control'):
            value = copy.deepcopy(self.rain['A'])
            if mode == 'warning': value['quality']['warnings'].remove('HIGH_LATITUDE_CORRECTION_REGIME_DIFFERS')
            if mode == 'observations': value['module_details']['latitude_context']['observational_support_equivalence_accepted'] = True
            if mode == 'acceptance': value['quality']['scientific_acceptance'] = 'accepted'
            if mode == 'annual': value['module_details']['provider_annual_summary_handling'] = 'included_as_month'
            if mode == 'control': del value['module_details']['temperature_control_result_sha256']
            with self.subTest(mode=mode), self.assertRaises(PilotError): adapter.validate_result(self.resign(value))

    def test_period_or_grid_source_drift_has_explanatory_reasons(self):
        for mode, reason in (('api', 'SOURCE_API_VERSION_DIFFERS'), ('geometry', 'SPATIAL_SUPPORT_DIFFERS'), ('period', 'TIME_DIFFERS')):
            value = copy.deepcopy(self.rain['A'])
            if mode == 'api': value['provenance']['api_version'] = 'v2.11.0'
            elif mode == 'geometry': value['spatial_support']['cell_geometry_sha256'] = '0' * 64
            else:
                value['time'].update(start='2023-01', end='2023-12')
                for row in value['series']: row['date'] = row['date'].replace('2024', '2023')
                for row in value['module_details']['missing_counts']: row['date'] = row['date'].replace('2024', '2023')
            result = adapter.assess_coindexed_inputs(self.temperature['A'], self.resign(value))
            self.assertEqual(result['technical_status'], 'incompatible')
            self.assertIn(reason, result['reasons'])

    def test_zero_negative_temperature_and_null_survive_without_renormalization(self):
        value = copy.deepcopy(self.rain['A'])
        value['series'][0]['value'] = 0
        value['series'][1].update(value=None, status='incomplete', valid_cells=55, valid_area_fraction=.98)
        value['module_details']['missing_counts'][1]['not_returned_cells'] = 1
        value['quality']['complete_months'] = 11
        self.resign(value); adapter.validate_result(value)
        result = adapter.assess_coindexed_inputs(self.temperature['A'], value)
        self.assertEqual(result['paired_valid_months'], 11)
        self.assertEqual(value['series'][0]['value'], 0)
        self.assertIsNone(value['series'][1]['value'])
        self.assertLess(self.temperature['B']['series'][0]['value'], 0)

    def test_invalid_slots_coverage_values_and_claimed_completion_rejected(self):
        for mode in ('date', 'fill', 'negative', 'count', 'area', 'nan', 'quality'):
            value = copy.deepcopy(self.rain['A']); row = value['series'][0]
            if mode == 'date': row['date'] = '2024-02'
            if mode == 'fill': row['value'] = None
            if mode == 'negative': row['value'] = -1
            if mode == 'count': row['valid_cells'] = 55
            if mode == 'area': row['valid_area_fraction'] = .99
            if mode == 'nan': row['value'] = float('nan')
            if mode == 'quality': value['quality']['complete_months'] = 11
            with self.subTest(mode=mode), self.assertRaises((PilotError, ValueError)):
                adapter.validate_result(self.resign(value))

    def test_content_identity_detects_changes_without_resigning(self):
        value = copy.deepcopy(self.rain['A']); value['series'][0]['value'] += .01
        with self.assertRaises(PilotError): adapter.validate_result(value)

    def test_shared_envelope_keeps_module_specific_details_separate(self):
        self.assertEqual(set(self.temperature['A']), set(self.rain['A']))
        self.assertIn('latitude_context', self.rain['A']['module_details'])
        self.assertNotIn('latitude_context', self.temperature['A']['module_details'])
        self.assertEqual(len(self.rain['A']['module_details']['missing_counts']), 12)
        self.assertNotIn(str(ROOT), json.dumps(self.rain['A']))

    def test_temperature_source_replay_rejects_changed_raw_or_result(self):
        for name in ('response.json', 'result.json'):
            with tempfile.TemporaryDirectory() as tmp:
                directory = Path(tmp) / 'source'; shutil.copytree(ROOT / 'examples/a-window-2024', directory)
                path = directory / name; value = loads(path.read_bytes())
                if name == 'response.json': value['features'][0]['properties']['parameter']['T2M']['202401'] += 1
                else: value['series'][0]['value'] += 1
                path.write_text(json.dumps(value))
                with self.assertRaises(PilotError): adapter.adapt_temperature(directory)

    def test_precipitation_source_replay_rejects_audit_tamper(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / 'audit.json'; value = loads(self.audit.read_bytes())
            value['regions'][0]['series'][0]['mean_rate_mm_per_day'] += .1
            file.write_text(json.dumps(value))
            with self.assertRaises(PilotError): adapter.adapt_precipitation(self.grid, file, 'A')
        with self.assertRaises(PilotError): adapter.adapt_precipitation(self.grid, self.audit, 'C')

    def test_replay_is_offline_and_does_not_recompute_a_new_scientific_formula(self):
        with patch('expedition73.precipitation_grid_probe.urlopen', side_effect=AssertionError('network used')), \
                patch('expedition73.power.urlopen', side_effect=AssertionError('network used')):
            self.assertEqual(adapter.adapt_temperature(ROOT / 'examples/a-window-2024'), self.temperature['A'])
            self.assertEqual(adapter.adapt_precipitation(self.grid, self.audit, 'A'), self.rain['A'])

    def test_cli_success_three_outputs_and_existing_target_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'out'
            args = ['--temperature-run', str(ROOT / 'examples/b-window-2024'), '--precipitation-run', str(self.grid),
                    '--precipitation-audit', str(self.audit), '--region', 'B', '--output-dir', str(output)]
            with redirect_stdout(io.StringIO()) as text: adapter.main(args)
            self.assertEqual(json.loads(text.getvalue())['paired_valid_months'], 12)
            self.assertEqual({p.name for p in output.iterdir()}, {'temperature.json', 'precipitation.json', 'input-check.json'})
            for name in ('temperature.json', 'precipitation.json'): adapter.validate_result(loads((output / name).read_bytes()))
            before = {p.name: p.read_bytes() for p in output.iterdir()}
            with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit): adapter.main(args)
            self.assertEqual({p.name: p.read_bytes() for p in output.iterdir()}, before)

    def test_cli_incompatible_pair_creates_no_completed_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'out'
            with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit): adapter.main([
                '--temperature-run', str(ROOT / 'examples/a-window-2024'), '--precipitation-run', str(self.grid),
                '--precipitation-audit', str(self.audit), '--region', 'B', '--output-dir', str(output)])
            self.assertFalse(output.exists())

    def test_recorded_common_samples_are_exact_outputs_of_real_adapters(self):
        for region in ('A', 'B'):
            directory = ROOT / f'examples/indicator-adapter-{region.lower()}-2024'
            self.assertEqual(loads((directory / 'temperature.json').read_bytes()), self.temperature[region])
            self.assertEqual(loads((directory / 'precipitation.json').read_bytes()), self.rain[region])
            self.assertEqual(loads((directory / 'input-check.json').read_bytes()),
                             adapter.assess_coindexed_inputs(self.temperature[region], self.rain[region]))

    def test_verify_cli_replays_sources_and_rejects_tampered_output_without_writing(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / 'out'; shutil.copytree(ROOT / 'examples/indicator-adapter-a-2024', directory)
            args = ['--temperature-run', str(ROOT / 'examples/a-window-2024'), '--precipitation-run', str(self.grid),
                    '--precipitation-audit', str(self.audit), '--region', 'A', '--verify-dir', str(directory)]
            with redirect_stdout(io.StringIO()) as text: adapter.main(args)
            self.assertEqual(json.loads(text.getvalue())['status'], 'adapter_replay_passed')
            file = directory / 'precipitation.json'; value = loads(file.read_bytes())
            value['quality']['scientific_acceptance'] = 'accepted'; file.write_text(json.dumps(self.resign(value)))
            before = {p.name: p.read_bytes() for p in directory.iterdir()}
            with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit): adapter.main(args)
            self.assertEqual({p.name: p.read_bytes() for p in directory.iterdir()}, before)


if __name__ == '__main__': unittest.main()
