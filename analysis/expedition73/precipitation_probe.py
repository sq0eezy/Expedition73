"""Isolated 2024 point-access experiment, not a registered scientific module.

Precipitation stays in the provider's mm/day. No monthly-total conversion,
area average, masking, temperature relationship or inference is performed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .power import ROOT, ENDPOINT, PilotError, finite, loads, validate_config

VERSION = '0.1.0'
LIMIT = 200_000
REGIONS = ('A', 'B')
FILES = {'a-response.json', 'b-response.json', 'capture.json', 'report.json'}


def _validate_scope(config):
    validate_config(config)
    if config['region_id'] not in REGIONS or config['start_year'] != 2024 or config['end_year'] != 2024:
        raise PilotError('Probe scope must remain the recorded A/B 2024 candidate points.')


def config_for(region):
    if region not in REGIONS:
        raise PilotError('This probe only supports the existing A/B 2024 point samples.')
    config = loads((ROOT / f'examples/{region.lower()}-point-2024.config.json').read_bytes())
    _validate_scope(config)
    if config['region_id'] != region:
        raise PilotError('Probe scope must remain the recorded 2024 candidate points.')
    return config


def request_url(config):
    _validate_scope(config)
    return ENDPOINT + '?' + urlencode({
        'parameters': 'T2M,PRECTOTCORR', 'community': 'AG',
        'longitude': float(config['point']['longitude']), 'latitude': float(config['point']['latitude']),
        'start': 2024, 'end': 2024, 'format': 'JSON',
    })


def _series(values, fill, nonnegative, *, start_year=2024, end_year=2024):
    if not isinstance(values, dict):
        raise PilotError('Parameter values must be an object.')
    keys = {f'{year}{month:02d}' for year in range(start_year, end_year + 1) for month in range(1, 14)}
    for key, value in values.items():
        if key not in keys:
            raise PilotError('Unexpected point probe month/year.')
        n = finite(value, key)
        if n != fill and nonnegative and n < 0:
            raise PilotError('Negative precipitation is not a valid non-fill value.')
    series = []
    for year in range(start_year, end_year + 1):
        for month in range(1, 13):
            key = f'{year}{month:02d}'
            status = 'not_returned' if key not in values else 'provider_fill' if values[key] == fill else 'valid'
            series.append({'date': f'{year}-{month:02d}', 'value': finite(values[key], key) if status == 'valid' else None, 'status': status})
    return series


def inspect_response(raw, config, baseline_raw):
    if len(raw) > LIMIT or len(baseline_raw) > LIMIT:
        raise PilotError('Point probe response exceeds the size limit.')
    _validate_scope(config)
    data, baseline = loads(raw), loads(baseline_raw)
    try:
        header, meta = data['header'], data['parameters']
        if data['type'] != 'Feature' or data['geometry']['type'] != 'Point':
            raise PilotError('This experiment cannot consume region averages or grids.')
        if header['start'] != '20240101' or header['end'] != '20241231' or header['time_standard'] != 'LST':
            raise PilotError('Unexpected period/time standard; no implicit alignment.')
        if header['sources'] != ['MERRA2'] or not isinstance(header['api']['version'], str) or not header['api']['version']:
            raise PilotError('Unexpected source/API metadata.')
        if meta['PRECTOTCORR'] != {'units': 'mm/day', 'longname': 'Precipitation Corrected'}:
            raise PilotError('Unexpected precipitation definition/unit; no conversion.')
        if meta['T2M'] != {'units': 'C', 'longname': 'Temperature at 2 Meters'}:
            raise PilotError('Unexpected T2M control definition/unit.')
        coordinates = data['geometry']['coordinates']
        if len(coordinates) < 2 or any(abs(finite(coordinates[i], 'coordinate') - config['point'][key]) > 1e-6 for i, key in enumerate(('longitude', 'latitude'))):
            raise PilotError('Returned point differs from the request.')
        fill = finite(header['fill_value'], 'fill')
        if fill >= 0:
            raise PilotError('Precipitation fill must be outside the valid nonnegative range.')
        values = data['properties']['parameter']
        if set(values) != {'T2M', 'PRECTOTCORR'} or set(meta) != set(values):
            raise PilotError('Unexpected parameter set.')
        temperature = _series(values['T2M'], fill, False)
        precipitation = _series(values['PRECTOTCORR'], fill, True)
        previous = _series(baseline['properties']['parameter']['T2M'], finite(baseline['header']['fill_value'], 'baseline fill'), False)
        annual = {key: None if p.get('202413') == fill else finite(p['202413'], 'annual summary') for key, p in values.items() if '202413' in p}
        if not isinstance(data.get('messages'), list) or not all(isinstance(m, str) for m in data['messages']):
            raise PilotError('Invalid provider messages.')
        baseline_context = (baseline['geometry']['type'] == 'Point'
            and baseline['geometry']['coordinates'][:2] == coordinates[:2]
            and all(baseline['header'][k] == header[k] for k in ('start', 'end', 'time_standard', 'sources'))
            and baseline['parameters']['T2M'] == meta['T2M'])
        baseline_version = baseline['header']['api']['version']
        if not isinstance(baseline_version, str) or not baseline_version:
            raise PilotError('Baseline API identity is missing.')
    except (KeyError, TypeError, IndexError) as exc:
        raise PilotError('Incomplete/malformed precipitation probe response.') from exc
    return {
        'region_id': config['region_id'], 'spatial_support': {'kind': 'point_sample', **config['point']},
        'precipitation_unit': 'mm/day', 'temperature_unit': 'degC',
        'precipitation': precipitation, 'temperature_control': temperature,
        'joint_valid_months': sum(p['status'] == t['status'] == 'valid' for p, t in zip(precipitation, temperature)),
        'valid_precipitation_months': sum(p['status'] == 'valid' for p in precipitation),
        'provider_annual_summaries_separate': annual,
        'provider': {'api_version': header['api']['version'], 'sources': header['sources'], 'time_standard': header['time_standard'], 'messages': data['messages']},
        'recorded_t2m_control': {'context_matches': baseline_context, 'monthly_values_and_statuses_match': temperature == previous,
            'api_version_matches': header['api']['version'] == baseline_version,
            'baseline_response_sha256': hashlib.sha256(baseline_raw).hexdigest()},
        'point_config_canonical_sha256': hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest(),
    }


def report_for(raws, capture):
    if (not isinstance(capture, dict) or set(capture) != {'schema_version', 'retrieved_at', 'requests'}
            or capture['schema_version'] != VERSION or not isinstance(capture['requests'], dict)
            or set(capture['requests']) != set(REGIONS)):
        raise PilotError('Unsupported capture record.')
    try:
        when = datetime.fromisoformat(capture['retrieved_at'])
        if when.tzinfo is None or when.utcoffset().total_seconds() != 0:
            raise ValueError('UTC required')
    except (ValueError, TypeError) as exc:
        raise PilotError('Capture time must be an explicit UTC datetime.') from exc
    regions = []
    for region in REGIONS:
        config, raw = config_for(region), raws[region]
        expected = {'url': request_url(config), 'sha256': hashlib.sha256(raw).hexdigest()}
        if capture['requests'][region] != expected:
            raise PilotError('Source hash or request identity differs from capture.')
        baseline = (ROOT / f'examples/{region.lower()}-point-2024/response.json').read_bytes()
        regions.append(inspect_response(raw, config, baseline))
    return {'schema_version': VERSION, 'output_type': 'candidate_precipitation_point_probe',
            'selection_status': 'candidate', 'scientific_compatibility_accepted': False,
            'region_mean_performed': False, 'monthly_total_conversion_performed': False,
            'temperature_dependency_or_inference_performed': False,
            'capture': capture, 'regions': regions}


def fetch_probe(destination):
    destination = Path(destination)
    if destination.exists() or destination.is_symlink():
        raise PilotError('Preserve existing output; choose a new directory.')
    raws, requests = {}, {}
    for region in REGIONS:
        url = request_url(config_for(region))
        try:
            with urlopen(Request(url, headers={'User-Agent': 'Expedition73-candidate-probe/0.1'}), timeout=90) as response:
                if response.status != 200 or response.url != url:
                    raise PilotError('Unexpected source status/redirect.')
                raw = response.read(LIMIT + 1)
        except (HTTPError, URLError, TimeoutError) as exc:
            raise PilotError('Public NASA point request failed; no output saved. Retry explicitly.') from exc
        if len(raw) > LIMIT:
            raise PilotError('Source response exceeds probe size limit.')
        raws[region] = raw
        requests[region] = {'url': url, 'sha256': hashlib.sha256(raw).hexdigest()}
    capture = {'schema_version': VERSION, 'retrieved_at': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'requests': requests}
    report = report_for(raws, capture)
    destination.mkdir(parents=True, exist_ok=False)
    for region, raw in raws.items():
        (destination / f'{region.lower()}-response.json').write_bytes(raw)
    for name, value in [('capture.json', capture), ('report.json', report)]:
        (destination / name).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8', newline='\n')
    return report


def validate_run(directory):
    directory = Path(directory)
    if directory.is_symlink() or {p.name for p in directory.iterdir()} != FILES or any((directory / name).is_symlink() for name in FILES):
        raise PilotError('Expected exactly four regular probe files.')
    if any(not (directory / name).is_file() or (directory / name).stat().st_size > LIMIT for name in FILES):
        raise PilotError('Unsupported probe file/size.')
    capture = loads((directory / 'capture.json').read_bytes())
    actual = loads((directory / 'report.json').read_bytes())
    expected = report_for({r: (directory / f'{r.lower()}-response.json').read_bytes() for r in REGIONS}, capture)
    if json.dumps(actual, sort_keys=True) != json.dumps(expected, sort_keys=True):
        raise PilotError('Stored probe report differs from source replay.')
    return expected


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('fetch').add_argument('--output-dir', required=True)
    commands.add_parser('validate').add_argument('run')
    args = parser.parse_args(argv)
    try:
        report = fetch_probe(args.output_dir) if args.command == 'fetch' else validate_run(args.run)
        print(json.dumps({'status': 'inspected' if args.command == 'fetch' else 'replay_passed', 'output_type': report['output_type'],
                          'valid_months': {r['region_id']: r['joint_valid_months'] for r in report['regions']}, 'scientific_compatibility_accepted': False}))
    except (PilotError, OSError) as exc:
        parser.exit(1, f'ERROR: {exc}\n')


if __name__ == '__main__':
    main()
