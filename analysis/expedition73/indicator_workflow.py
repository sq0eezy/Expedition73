"""Frozen recorded sources -> two common indicators -> technical input check.

Sequential execution through the existing engine; no inference or web integration.
"""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path

from . import indicator_adapter as adapter, surface_workflow, workflow_trace
from .power import ROOT, PilotError
from .workflow import Operation, execute

VERSION = '0.1.0'
TEMPERATURE = {'type': 'candidate_monthly_indicator_result', 'schema_version': VERSION, 'unit': 'degC'}
PRECIPITATION = {'type': 'candidate_monthly_indicator_result', 'schema_version': VERSION, 'unit': 'mm/day'}
CHECK = {'type': 'candidate_indicator_input_check', 'schema_version': VERSION, 'unit': '1'}


def build(temperature_directory, precipitation_directory, audit_file, region_id, *, control_directories=None):
    """Capture bounded files once per source. Callbacks use only captured bytes."""
    if region_id not in ('A', 'B'):
        raise PilotError('Only the recorded A/B precipitation pilot is supported.')
    directories = ({r: ROOT / f'examples/{r.lower()}-window-2024' for r in ('A', 'B')}
                   if control_directories is None else control_directories)
    if set(directories) != {'A', 'B'}:
        raise PilotError('Both recorded temperature controls are required.')
    controls, temperature_files = {}, None
    for region, directory in directories.items():
        files = adapter.capture_temperature(directory)
        controls[region] = files
        if Path(directory).resolve() == Path(temperature_directory).resolve():
            temperature_files = files
    if temperature_files is None:
        temperature_files = adapter.capture_temperature(temperature_directory)
    precipitation_files = adapter.capture_precipitation(precipitation_directory, audit_file, temperature_files=controls)
    temperature_files = copy.deepcopy(temperature_files)
    context = {'scope': 'candidate_coindexed_indicators', 'region_id': region_id,
        'source_files_sha256': {'temperature': surface_workflow._hashes(temperature_files),
            'precipitation': {'grid': surface_workflow._hashes(precipitation_files['grid']),
                'audit': surface_workflow._hashes({'result.json': precipitation_files['audit']}),
                'temperature_controls': {r: surface_workflow._hashes(f) for r, f in controls.items()}}}}
    expected_context = adapter.digest(context)

    def check_context(actual):
        if adapter.digest(actual) != expected_context:
            raise PilotError('Indicator context differs from the captured source snapshot.')

    def temperature(inputs):
        if inputs:
            raise PilotError('Temperature adapter has no upstream overrides.')
        value = adapter.temperature_from_files(temperature_files)
        if value['region']['id'] != region_id:
            raise PilotError('Temperature belongs to a different selected region.')
        return value

    def precipitation(inputs):
        if inputs:
            raise PilotError('Precipitation adapter has no upstream overrides.')
        return adapter.precipitation_from_snapshot(precipitation_files, region_id)

    def check(inputs):
        if set(inputs) != {'temperature', 'precipitation'}:
            raise PilotError('Both named indicator inputs are required.')
        value = adapter.assess_coindexed_inputs(inputs['temperature']['value'], inputs['precipitation']['value'])
        if value['technical_status'] != 'compatible':
            raise PilotError('Indicator inputs differ in technical support or source control identity.')
        return value

    def operation(name, contract, compute_value):
        # These values are only an output-verifier reference for this build.
        # Every execute still runs every selected callback; no persistent cache.
        expected = {}

        def compute(inputs, parameters, actual):
            check_context(actual)
            if parameters:
                raise PilotError('Indicator workflow has no implicit parameter overrides.')
            value = compute_value(inputs)
            expected['value'] = copy.deepcopy(value)
            return value

        def validate(value, actual):
            check_context(actual)
            if name != 'InputCheck':
                adapter.validate_result(value)
            if 'value' not in expected or adapter.digest(value) != adapter.digest(expected['value']):
                raise PilotError('Workflow output differs from its verified computation.')

        return Operation(VERSION, dict(contract), compute, validate)

    def link(node, contract):
        return {'node': node, 'output': 'result', 'contract': dict(contract)}

    nodes = [
        {'id': 'Temperature', 'operation': 'AdaptRecordedTemperature', 'version': VERSION,
         'parameters': {}, 'inputs': {}, 'output_contract': dict(TEMPERATURE)},
        {'id': 'Precipitation', 'operation': 'AdaptRecordedPrecipitation', 'version': VERSION,
         'parameters': {}, 'inputs': {}, 'output_contract': dict(PRECIPITATION)},
        {'id': 'InputCheck', 'operation': 'CheckCoindexedIndicators', 'version': VERSION,
         'parameters': {}, 'inputs': {'temperature': link('Temperature', TEMPERATURE),
                                      'precipitation': link('Precipitation', PRECIPITATION)},
         'output_contract': dict(CHECK)},
    ]
    registry = {'AdaptRecordedTemperature': operation('Temperature', TEMPERATURE, temperature),
                'AdaptRecordedPrecipitation': operation('Precipitation', PRECIPITATION, precipitation),
                'CheckCoindexedIndicators': operation('InputCheck', CHECK, check)}
    return {'schema_version': VERSION, 'context': copy.deepcopy(context), 'nodes': nodes}, registry


def run(*args, **kwargs):
    spec, registry = build(*args, **kwargs)
    return spec, execute(spec, 'InputCheck', registry)


def write_run(output, spec, report):
    output = Path(output)
    if output.exists() or output.is_symlink():
        raise PilotError('Preserve existing output; choose a new directory.')
    values = {'workflow-request.json': spec, 'workflow-run.json': report}
    if report['status'] == 'completed':
        values['workflow-trace.json'] = workflow_trace.project(spec, report)
        for node, filename in (('Temperature', 'temperature.json'), ('Precipitation', 'precipitation.json'),
                               ('InputCheck', 'input-check.json')):
            values[filename] = report['nodes'][node]['artifact']['value']
    encoded = {name: json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n'
               for name, value in values.items()}
    output.mkdir(parents=True, exist_ok=False)
    for name, value in encoded.items():
        (output / name).write_text(value, encoding='utf-8', newline='\n')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--temperature-run', required=True)
    parser.add_argument('--precipitation-run', required=True)
    parser.add_argument('--precipitation-audit', required=True)
    parser.add_argument('--region', choices=('A', 'B'), required=True)
    parser.add_argument('--output-dir', required=True)
    args = parser.parse_args(argv)
    try:
        output = Path(args.output_dir)
        if output.exists() or output.is_symlink():
            raise PilotError('Preserve existing output; choose a new directory.')
        spec, report = run(args.temperature_run, args.precipitation_run, args.precipitation_audit, args.region)
        write_run(output, spec, report)
        print(json.dumps({'status': report['status'], 'scientific_validation': report['scientific_validation'],
                          'nodes': {name: data['status'] for name, data in report['nodes'].items()}}))
        if report['status'] != 'completed':
            parser.exit(1, 'ERROR: Workflow incomplete; only diagnostic files were written.\n')
    except (PilotError, OSError) as exc:
        parser.exit(1, f'ERROR: {exc}\n')


if __name__ == '__main__':
    main()
