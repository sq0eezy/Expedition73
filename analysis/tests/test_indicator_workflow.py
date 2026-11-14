"""Frozen sources, real common outputs, engine lineage and failure isolation."""
import copy
import io
import json
import shutil
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from expedition73 import indicator_adapter as adapter, indicator_workflow as flow, workflow_trace
from expedition73.power import ROOT, PilotError, loads
from expedition73.workflow import Operation, compare_snapshot, execute, validate_artifact


class IndicatorWorkflowTests(unittest.TestCase):
    def args(self, region='A'):
        return (ROOT / f'examples/{region.lower()}-window-2024', ROOT / 'examples/precipitation-grid-probe-2024',
                ROOT / 'examples/precipitation-area-audit-2024.json', region)

    def copied(self, directory):
        base = Path(directory)
        controls = {r: base / r for r in ('A', 'B')}
        for r, dest in controls.items(): shutil.copytree(ROOT / f'examples/{r.lower()}-window-2024', dest)
        grid = base / 'grid'; shutil.copytree(self.args()[1], grid)
        audit = base / 'audit.json'; shutil.copyfile(self.args()[2], audit)
        return (controls['A'], grid, audit, 'A'), {'control_directories': controls}

    def test_real_a_b_outputs_match_prior_common_examples_and_actual_lineage(self):
        for region in ('A', 'B'):
            spec, report = flow.run(*self.args(region))
            self.assertEqual(report['status'], 'completed')
            self.assertEqual(report['order'], ['Precipitation', 'Temperature', 'InputCheck'])
            self.assertEqual(report['scientific_validation'], 'not_performed')
            for node, filename in (('Temperature', 'temperature.json'), ('Precipitation', 'precipitation.json'), ('InputCheck', 'input-check.json')):
                artifact = report['nodes'][node]['artifact']; validate_artifact(artifact)
                expected = loads((ROOT / f'examples/indicator-adapter-{region.lower()}-2024/{filename}').read_bytes())
                self.assertEqual(artifact['value'], expected)
            target = report['nodes']['InputCheck']['artifact']
            self.assertEqual(target['inputs'], {alias: report['nodes'][node]['artifact']['artifact_id']
                                               for alias, node in (('temperature', 'Temperature'), ('precipitation', 'Precipitation'))})
            self.assertEqual(target['lineage'], {node: report['nodes'][node]['artifact']['artifact_id'] for node in ('Temperature', 'Precipitation')})
            self.assertEqual(target['value']['paired_valid_months'], 12)
            self.assertFalse(target['value']['relationship_calculated'])
            trace = workflow_trace.project(spec, report)
            self.assertEqual((len(trace['nodes']), sum(len(n['inputs']) for n in trace['nodes'])), (3, 2))
            self.assertNotIn(str(ROOT), json.dumps(spec))
            self.assertNotIn(report['run_id'], json.dumps(trace))

    def test_callbacks_do_not_reopen_data_sources_use_token_or_network(self):
        spec, registry = flow.build(*self.args())
        original_open = Path.open
        def only_schema(path, *args, **kwargs):
            if path.parent == ROOT / 'schemas': return original_open(path, *args, **kwargs)
            raise AssertionError('A captured data source was reopened')
        with patch.object(Path, 'open', only_schema), \
                patch.object(adapter, '_read', side_effect=AssertionError('source reopened')), \
                patch('expedition73.precipitation_grid_probe.config_for', side_effect=AssertionError('live config read')), \
                patch('expedition73.earthdata.get_token', side_effect=AssertionError('token used')), \
                patch('expedition73.power.urlopen', side_effect=AssertionError('network used')), \
                patch('expedition73.precipitation_grid_probe.urlopen', side_effect=AssertionError('network used')):
            report = execute(spec, 'InputCheck', registry)
        self.assertEqual(report['status'], 'completed')

    def test_each_registered_operation_runs_once_and_inputs_are_named(self):
        spec, registry = flow.build(*self.args())
        calls = []
        for key, old in list(registry.items()):
            def record(inputs, parameters, context, old=old, key=key):
                calls.append((key, sorted(inputs)))
                return old.compute(inputs, parameters, context)
            registry[key] = Operation(old.version, old.contract, record, old.validate)
        self.assertEqual(execute(spec, 'InputCheck', registry)['status'], 'completed')
        self.assertEqual(calls, [('AdaptRecordedPrecipitation', []), ('AdaptRecordedTemperature', []),
                                 ('CheckCoindexedIndicators', ['precipitation', 'temperature'])])

    def test_bad_precipitation_keeps_temperature_and_blocks_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            args, kwargs = self.copied(tmp)
            (args[1] / 'a-tile-001.json').write_bytes(b'corrupt raw')
            spec, report = flow.run(*args, **kwargs)
        self.assertEqual(report['status'], 'incomplete')
        self.assertEqual(report['nodes']['Precipitation']['reason'], 'COMPUTE_FAILED')
        self.assertEqual(report['nodes']['Temperature']['status'], 'completed')
        self.assertEqual(report['nodes']['InputCheck']['status'], 'blocked')
        self.assertNotIn('artifact', report['nodes']['InputCheck'])
        with self.assertRaises(PilotError): workflow_trace.project(spec, report)

    def test_changed_precipitation_audit_cannot_become_a_verified_artifact(self):
        with tempfile.TemporaryDirectory() as tmp:
            args, kwargs = self.copied(tmp); value = loads(args[2].read_bytes())
            value['regions'][0]['series'][0]['mean_rate_mm_per_day'] += 1
            args[2].write_text(json.dumps(value))
            _, report = flow.run(*args, **kwargs)
        self.assertEqual(report['nodes']['Precipitation']['status'], 'failed')
        self.assertEqual(report['nodes']['InputCheck']['status'], 'blocked')

    def test_bad_shared_temperature_control_fails_both_replays(self):
        with tempfile.TemporaryDirectory() as tmp:
            args, kwargs = self.copied(tmp)
            (args[0] / 'response.json').write_bytes(b'bad temperature raw')
            _, report = flow.run(*args, **kwargs)
        self.assertTrue(all(report['nodes'][node]['status'] == 'failed' for node in ('Temperature', 'Precipitation')))
        self.assertEqual(report['nodes']['InputCheck']['status'], 'blocked')

    def test_old_snapshot_survives_file_change_new_snapshot_is_stale_and_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            args, kwargs = self.copied(tmp)
            spec, registry = flow.build(*args, **kwargs)
            (args[1] / 'a-tile-001.json').write_bytes(b'new invalid raw')
            report = execute(spec, 'InputCheck', registry)
            self.assertEqual(report['status'], 'completed')
            changed, next_registry = flow.build(*args, **kwargs)
            self.assertEqual(compare_snapshot(report, changed, 'InputCheck'),
                             {node: 'stale' for node in report['order']})
            self.assertEqual(execute(changed, 'InputCheck', next_registry)['status'], 'incomplete')

    def test_context_region_or_hash_cannot_be_relabelled(self):
        for mode in ('region', 'hash'):
            spec, registry = flow.build(*self.args()); bad = copy.deepcopy(spec)
            if mode == 'region': bad['context']['region_id'] = 'B'
            else: bad['context']['source_files_sha256']['temperature']['result.json'] = '0' * 64
            report = execute(bad, 'InputCheck', registry)
            self.assertTrue(all(report['nodes'][node]['status'] == 'failed' for node in ('Temperature', 'Precipitation')))
            self.assertEqual(report['nodes']['InputCheck']['status'], 'blocked')

    def test_parameter_override_fails_only_its_source_and_blocks_consumer(self):
        spec, registry = flow.build(*self.args()); spec['nodes'][0]['parameters'] = {'mask': 'land'}
        report = execute(spec, 'InputCheck', registry)
        self.assertEqual(report['nodes']['Temperature']['status'], 'failed')
        self.assertEqual(report['nodes']['Precipitation']['status'], 'completed')
        self.assertEqual(report['nodes']['InputCheck']['status'], 'blocked')

    def test_registered_unit_contract_mismatch_is_rejected_before_callbacks(self):
        spec, registry = flow.build(*self.args())
        spec['nodes'][2]['inputs']['temperature']['contract']['unit'] = 'mm/day'
        with self.assertRaises(PilotError): execute(spec, 'InputCheck', registry)

    def test_resigned_output_tampering_is_rejected_by_source_bound_validator(self):
        spec, registry = flow.build(*self.args()); old = registry['AdaptRecordedPrecipitation']
        def altered(inputs, params, context):
            value = old.compute(inputs, params, context)
            value['series'][0]['value'] += .1
            value.pop('result_id'); value['result_id'] = 'sha256:' + adapter.digest(value)
            return value
        registry['AdaptRecordedPrecipitation'] = Operation(old.version, old.contract, altered, old.validate)
        report = execute(spec, 'InputCheck', registry)
        self.assertEqual(report['nodes']['Precipitation']['reason'], 'OUTPUT_INVALID')
        self.assertEqual(report['nodes']['InputCheck']['status'], 'blocked')

    def test_input_check_output_cannot_claim_scientific_acceptance(self):
        spec, registry = flow.build(*self.args()); old = registry['CheckCoindexedIndicators']
        def altered(inputs, params, context):
            value = old.compute(inputs, params, context); value['scientific_acceptance'] = 'accepted'; return value
        registry['CheckCoindexedIndicators'] = Operation(old.version, old.contract, altered, old.validate)
        report = execute(spec, 'InputCheck', registry)
        self.assertEqual(report['nodes']['InputCheck']['reason'], 'OUTPUT_INVALID')

    def test_wrong_selected_region_cannot_complete_input_check(self):
        args = list(self.args()); args[-1] = 'B'
        _, report = flow.run(*args)
        self.assertEqual(report['nodes']['Temperature']['status'], 'failed')
        self.assertEqual(report['nodes']['Precipitation']['status'], 'completed')
        self.assertEqual(report['nodes']['InputCheck']['status'], 'blocked')

    def test_valid_different_year_is_rejected_by_the_final_input_gate(self):
        args = list(self.args()); args[0] = ROOT / 'examples/a-history-2023-2024/year-2023'
        _, report = flow.run(*args)
        self.assertTrue(all(report['nodes'][node]['status'] == 'completed' for node in ('Temperature', 'Precipitation')))
        self.assertEqual(report['nodes']['InputCheck']['status'], 'failed')
        self.assertEqual(report['nodes']['InputCheck']['reason'], 'COMPUTE_FAILED')
        self.assertNotIn('artifact', report['nodes']['InputCheck'])

    def test_trace_checks_actual_artifact_id_and_edges(self):
        spec, report = flow.run(*self.args()); bad = copy.deepcopy(report)
        bad['nodes']['InputCheck']['artifact']['inputs']['temperature'] = 'sha256:' + '0' * 64
        with self.assertRaises(PilotError): workflow_trace.project(spec, bad)

    def test_cli_success_six_files_and_preserves_existing_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'out'; source, grid, audit, region = self.args('B')
            args = ['--temperature-run', str(source), '--precipitation-run', str(grid), '--precipitation-audit', str(audit),
                    '--region', region, '--output-dir', str(target)]
            with redirect_stdout(io.StringIO()) as text: flow.main(args)
            self.assertEqual(json.loads(text.getvalue())['status'], 'completed')
            self.assertEqual(len(list(target.iterdir())), 6)
            self.assertEqual(loads((target / 'input-check.json').read_bytes())['paired_valid_months'], 12)
            before = {p.name: p.read_bytes() for p in target.iterdir()}
            with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit): flow.main(args)
            self.assertEqual({p.name: p.read_bytes() for p in target.iterdir()}, before)

    def test_failed_cli_writes_only_diagnostics_with_nonzero_exit(self):
        with tempfile.TemporaryDirectory() as tmp:
            args, kwargs = self.copied(tmp); (args[1] / 'a-tile-001.json').write_bytes(b'bad raw')
            target = Path(tmp) / 'out'
            original = flow.build
            with patch.object(flow, 'build', wraps=lambda *a, **k: original(*a, **kwargs)):
                with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
                    flow.main(['--temperature-run', str(args[0]), '--precipitation-run', str(args[1]),
                               '--precipitation-audit', str(args[2]), '--region', 'A', '--output-dir', str(target)])
            self.assertEqual(error.exception.code, 1)
            self.assertEqual({p.name for p in target.iterdir()}, {'workflow-request.json', 'workflow-run.json'})


if __name__ == '__main__': unittest.main()
