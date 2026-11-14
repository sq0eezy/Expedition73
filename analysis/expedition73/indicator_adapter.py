"""Shared candidate monthly envelope; separate recorded T2M/precipitation adapters.

No new scientific calculation, unit conversion, engine registration or web route.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
from pathlib import Path

from . import precipitation_area_audit as precipitation, regional, surface_workflow, tiled
from .power import ROOT, PilotError, loads, validate_schema

VERSION = '0.1.0'
SCHEMA = 'candidate-monthly-indicator.schema.json'
LIMIT = 2_000_000


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def _read(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise PilotError('Expected a regular recorded file.')
    with path.open('rb') as stream:
        raw = stream.read(LIMIT + 1)
    if len(raw) > LIMIT:
        raise PilotError('Recorded adapter input exceeds size limit.')
    return raw


def _geometry(cells):
    return digest(sorted([[float(c['longitude']), float(c['latitude']),
                           [float(v) for v in c['intersection_bbox']]] for c in cells]))


def _finish(value):
    value['result_id'] = 'sha256:' + digest(value)
    validate_result(value)
    return value


def validate_result(value):
    """Envelope/semantic/content check only; raw replay belongs to each adapter."""
    validate_schema(value, SCHEMA)
    body = {k: v for k, v in value.items() if k != 'result_id'}
    if value['result_id'] != 'sha256:' + digest(body):
        raise PilotError('Candidate result content identity differs.')
    indicator = value['variable']['id']
    if value['module']['id'] != indicator:
        raise PilotError('Module and indicator identities differ.')
    expected_method = ('spherical_midpoint_cell_intersection' if indicator == 'air_temperature_2m'
                       else 'candidate_unmasked_precipitation_rate_area_mean')
    if value['method']['id'] != expected_method:
        raise PilotError('Indicator method was relabelled.')
    start, end = [int(y) * 12 + int(m) - 1 for y, m in (value['time'][key].split('-') for key in ('start', 'end'))]
    expected_dates = [f'{n // 12:04d}-{n % 12 + 1:02d}' for n in range(start, end + 1)]
    rows = value['series']; quality = value['quality']; count = value['spatial_support']['cell_count']
    if ([r['date'] for r in rows] != expected_dates or quality['expected_months'] != len(rows)
            or quality['complete_months'] != sum(r['status'] == 'complete' for r in rows)):
        raise PilotError('Monthly slots/coverage differ from declared period.')
    for row in rows:
        complete = row['valid_cells'] == count
        if (row['valid_cells'] > count or (row['status'] == 'complete') != complete
                or (row['value'] is not None) != complete
                or (complete and not math.isclose(row['valid_area_fraction'], 1, rel_tol=0, abs_tol=1e-12))
                or (not complete and row['valid_area_fraction'] >= 1)
                or (row['valid_cells'] == 0 and row['valid_area_fraction'] != 0)):
            raise PilotError('Missing data cannot be renormalized or labelled complete.')
        if indicator == 'precipitation_rate' and row['value'] is not None and row['value'] < 0:
            raise PilotError('Negative precipitation rate.')
    if indicator == 'precipitation_rate':
        details = value['module_details']
        if (details.get('latitude_context', {}).get('observational_support_equivalence_accepted') is not False
                or 'HIGH_LATITUDE_CORRECTION_REGIME_DIFFERS' not in quality['warnings']
                or details.get('provider_annual_summary_handling') != 'not_consumed'
                or details.get('source_output_type') != 'candidate_precipitation_area_audit'
                or not isinstance(details.get('temperature_control_result_sha256'), str)
                or len(details['temperature_control_result_sha256']) != 64
                or not isinstance(details.get('missing_counts'), list)
                or len(details['missing_counts']) != len(rows)):
            raise PilotError('Precipitation-specific limits must survive translation.')
        for row, missing in zip(rows, details['missing_counts'], strict=True):
            if (missing['date'] != row['date'] or
                    missing['provider_fill_cells'] + missing['not_returned_cells'] != count - row['valid_cells']):
                raise PilotError('Module-specific missing counts differ from the common coverage.')
    return value


def _base(region, variable, time, support, method, provenance, warnings, series, details, source_version):
    return _finish({'schema_version': VERSION, 'output_type': 'candidate_monthly_indicator_result',
        'module': {'id': variable['id'], 'adapter_version': VERSION, 'source_version': source_version},
        'region': region, 'variable': variable, 'time': time, 'spatial_support': support, 'method': method,
        'provenance': provenance, 'quality': {'expected_months': len(series),
            'complete_months': sum(r['status'] == 'complete' for r in series), 'warnings': sorted(set(warnings)),
            'scientific_acceptance': 'not_performed', 'inference': 'not_performed'},
        'series': series, 'module_details': details})


def capture_temperature(directory):
    directory = Path(directory)
    files = {n: _read(directory / n) for n in ('request.json', 'result.json')}
    request = loads(files['request.json'])
    if (directory / 'manifest.json').exists():
        files['manifest.json'] = _read(directory / 'manifest.json')
        for tile in tiled.plan(request): files[tile['id'] + '.json'] = _read(directory / (tile['id'] + '.json'))
    else:
        files['response.json'] = _read(directory / 'response.json')
    return files


def temperature_from_files(files):
    """Translate a captured, raw-replayed temperature source without reopening it."""
    surface_workflow._window_replay(files)
    # Preserve source floats after a complete raw replay has checked them.
    source = loads(files['result.json']); region = {k: source['region'][k] for k in ('id', 'candidate_bbox', 'candidate_window_version', 'selection_status')}
    if source['spatial_support']['mask'] != 'none':
        raise PilotError('This adapter slice only supports unmasked candidate windows.')
    support = {k: source['spatial_support'][k] for k in ('kind', 'mask', 'cell_count', 'window_area_m2', 'grid_step_degrees')}
    support['cell_geometry_sha256'] = _geometry(source['module_details']['cells'])
    method = {k: source['method'][k] for k in ('id', 'version', 'sphere_radius_m', 'missing_policy')}
    method.update(geometry=source['method']['id'], geometry_version=source['method']['version'])
    provenance = {k: source['provenance'][k] for k in ('provider', 'product', 'api_version', 'sources')}
    hashes = surface_workflow._hashes(files)
    provenance.update(source_result_sha256=hashes['result.json'], input_files_sha256={'temperature': hashes})
    return _base(region, {**source['variable'], 'provider_parameter': 'T2M'}, source['time'], support, method, provenance,
        source['quality']['warnings'], copy.deepcopy(source['series']),
        {'source_output_type': source['output_type'], 'source_method': source['method'],
         'provider_annual_summary_handling': 'preserved_in_source_not_in_common_months'}, source['schema_version'])


def adapt_temperature(directory):
    return temperature_from_files(capture_temperature(directory))


def capture_precipitation(source_run, audit_file, *, temperature_files=None):
    controls = ({r: capture_temperature(ROOT / f'examples/{r.lower()}-window-2024') for r in ('A', 'B')}
                if temperature_files is None else copy.deepcopy(temperature_files))
    if set(controls) != {'A', 'B'}:
        raise PilotError('Frozen precipitation requires both temperature controls.')
    return {'grid': precipitation.capture_source(source_run, temperature_files=controls),
            'audit': _read(audit_file), 'controls': controls}


def precipitation_from_snapshot(snapshot, region_id):
    """Raw replay, candidate calculation and translation on immutable bytes only."""
    if region_id not in ('A', 'B'):
        raise PilotError('Precipitation access slice only has recorded A/B candidates.')
    raw = snapshot['audit']; actual = loads(raw)
    expected = precipitation.summarize_snapshot(snapshot['grid'], temperature_files=snapshot['controls'])
    if not precipitation._same(actual, expected):
        raise PilotError('Precipitation audit differs from raw grid replay.')
    # Metadata is read with an exact hash check against that verified snapshot.
    grid_raw = snapshot['grid']['report.json']
    if hashlib.sha256(grid_raw).hexdigest() != actual['source_files_sha256']['report.json']:
        raise PilotError('Grid metadata changed after verified snapshot.')
    grid_report = loads(grid_raw)
    source = next(r for r in actual['regions'] if r['region_id'] == region_id)
    grid_region = next(r for r in grid_report['regions'] if r['region_id'] == region_id)
    control_raw = snapshot['controls'][region_id]['result.json']
    if hashlib.sha256(control_raw).hexdigest() != actual['temperature_control_result_sha256'][region_id]:
        raise PilotError('Temperature boundary identity changed after verified snapshot.')
    control = loads(control_raw)['region']
    if control['candidate_bbox'] != source['candidate_bbox'] or control['id'] != region_id:
        raise PilotError('Candidate boundary differs from verified precipitation snapshot.')
    region = {'id': region_id, 'candidate_bbox': source['candidate_bbox'],
              'candidate_window_version': control['candidate_window_version'], 'selection_status': 'candidate'}
    support = {'kind': 'unmasked_rectangular_window', 'mask': 'none', 'cell_count': source['window_cell_count'],
        'window_area_m2': source['window_area_m2'], 'grid_step_degrees': {'longitude': .625, 'latitude': .5},
        'cell_geometry_sha256': _geometry(source['cell_weights'])}
    method = {k: actual['method'][k] for k in ('id', 'version', 'geometry', 'geometry_version', 'sphere_radius_m', 'missing_policy')}
    provenance = {'provider': 'NASA POWER', 'product': grid_region['provider_header']['api']['name'],
        'api_version': grid_region['provider_header']['api']['version'], 'sources': grid_region['provider_header']['sources'],
        'source_result_sha256': hashlib.sha256(raw).hexdigest(),
        'input_files_sha256': {'grid': actual['source_files_sha256'], 'audit': {'result.json': hashlib.sha256(raw).hexdigest()}}}
    series = [{**{k: r[k] for k in ('date', 'status', 'valid_cells', 'valid_area_fraction')},
               'value': r['mean_rate_mm_per_day']} for r in source['series']]
    return _base(region, {'id': 'precipitation_rate', 'unit': 'mm/day', 'provider_parameter': 'PRECTOTCORR'},
        {**actual['time'], 'frequency': 'monthly', 'calendar': 'gregorian'}, support, method, provenance, actual['warnings'], series,
        {'source_output_type': actual['output_type'], 'source_method': actual['method'],
         'latitude_context': source['latitude_context'], 'provider_annual_summary_handling': 'not_consumed',
         'temperature_control_result_sha256': actual['temperature_control_result_sha256'][region_id],
         'missing_counts': [{k: r[k] for k in ('date', 'provider_fill_cells', 'not_returned_cells')} for r in source['series']]}, actual['schema_version'])


def adapt_precipitation(source_run, audit_file, region_id):
    return precipitation_from_snapshot(capture_precipitation(source_run, audit_file), region_id)


def assess_coindexed_inputs(temperature, precipitation_result):
    """Named distinct-variable inputs for a future consumer; no numeric relation."""
    for value in (temperature, precipitation_result): validate_result(value)
    if (temperature['variable']['id'], precipitation_result['variable']['id']) != ('air_temperature_2m', 'precipitation_rate'):
        raise PilotError('Named temperature/precipitation ports cannot be swapped or relabelled.')
    reasons = []
    for field in ('region', 'time', 'spatial_support'):
        if not regional._same_result(temperature[field], precipitation_result[field]): reasons.append(field.upper() + '_DIFFERS')
    for field in ('api_version', 'sources', 'provider', 'product'):
        if temperature['provenance'][field] != precipitation_result['provenance'][field]: reasons.append('SOURCE_' + field.upper() + '_DIFFERS')
    if precipitation_result['module_details']['temperature_control_result_sha256'] != temperature['provenance']['source_result_sha256']:
        reasons.append('TEMPERATURE_CONTROL_SNAPSHOT_DIFFERS')
    paired = sum(a['value'] is not None and b['value'] is not None for a, b in zip(temperature['series'], precipitation_result['series'])) if not reasons else 0
    return {'schema_version': VERSION, 'output_type': 'candidate_indicator_input_check',
        'input_result_ids': {'temperature': temperature['result_id'], 'precipitation': precipitation_result['result_id']},
        'technical_status': 'compatible' if not reasons else 'incompatible', 'reasons': reasons,
        'paired_valid_months': paired, 'scientific_acceptance': 'not_performed', 'relationship_calculated': False,
        'units': {'temperature': 'degC', 'precipitation': 'mm/day'},
        'warnings': sorted(set(temperature['quality']['warnings'] + precipitation_result['quality']['warnings']))}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--temperature-run', required=True)
    parser.add_argument('--precipitation-run', required=True)
    parser.add_argument('--precipitation-audit', required=True)
    parser.add_argument('--region', choices=('A', 'B'), required=True)
    destination = parser.add_mutually_exclusive_group(required=True)
    destination.add_argument('--output-dir')
    destination.add_argument('--verify-dir')
    args = parser.parse_args(argv)
    try:
        output = Path(args.output_dir or args.verify_dir)
        if args.output_dir and (output.exists() or output.is_symlink()):
            raise PilotError('Preserve existing output; choose a new directory.')
        temperature = adapt_temperature(args.temperature_run)
        rain = adapt_precipitation(args.precipitation_run, args.precipitation_audit, args.region)
        check = assess_coindexed_inputs(temperature, rain)
        if check['technical_status'] != 'compatible': raise PilotError('Named input supports differ: ' + ', '.join(check['reasons']))
        outputs = {'temperature.json': temperature, 'precipitation.json': rain, 'input-check.json': check}
        if args.verify_dir:
            if output.is_symlink() or {p.name for p in output.iterdir()} != set(outputs):
                raise PilotError('Expected exactly the three common adapter outputs.')
            for name, value in outputs.items():
                if digest(loads(_read(output / name))) != digest(value):
                    raise PilotError('Stored adapter result differs from full source replay.')
        else:
            output.mkdir(parents=True, exist_ok=False)
            for name, value in outputs.items():
                (output / name).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8', newline='\n')
        print(json.dumps({'status': 'adapter_replay_passed' if args.verify_dir else 'adapter_outputs_written', **check}))
    except (PilotError, OSError) as exc:
        parser.exit(1, f'ERROR: {exc}\n')


if __name__ == '__main__': main()
