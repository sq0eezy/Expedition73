"""Bounded candidate precipitation-grid access and support audit, without means.

Reuses the existing T2M request geometry, not its temperature decoder or weights.
Precipitation stays in mm/day; scientific compatibility remains unaccepted.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from . import regional, tiled
from .power import ROOT, PilotError, finite, loads
from .precipitation_probe import _series

VERSION = '0.1.0'
LIMIT = 2_000_000
REGIONS = ('A', 'B')


def _check_scope(region, config):
    if region not in REGIONS:
        raise PilotError('Only the existing A/B 2024 candidate windows are supported.')
    regional.validate_config(config, tiled=True)
    if config['region_id'] != region or config['start_year'] != 2024 or config['end_year'] != 2024 or config['mask'] != 'none':
        raise PilotError('Unsupported grid-probe scope.')
    return config


def config_for(region):
    if region not in REGIONS:
        raise PilotError('Only the existing A/B 2024 candidate windows are supported.')
    return _check_scope(region, loads((ROOT / f'examples/{region.lower()}-window-2024/request.json').read_bytes()))


def plan_for(region, *, config=None, start_year=2024, end_year=2024):
    result = []
    for tile in tiled.plan(config_for(region) if config is None else _check_scope(region, config)):
        west, south, east, north = tile['request_bbox']
        url = regional.ENDPOINT + '?' + urlencode({
            'parameters': 'PRECTOTCORR', 'community': 'AG', 'longitude-min': west,
            'longitude-max': east, 'latitude-min': south, 'latitude-max': north,
            'format': 'JSON', 'start': start_year, 'end': end_year})
        result.append({**tile, 'filename': f"{region.lower()}-{tile['id']}.json", 'precipitation_url': url})
    return result


def _decode_tile(raw, tile, *, start_year=2024, end_year=2024):
    if len(raw) > LIMIT:
        raise PilotError('Grid response exceeds the bounded size limit.')
    data = loads(raw)
    try:
        if data['type'] != 'FeatureCollection' or not isinstance(data['features'], list):
            raise PilotError('Expected a regional FeatureCollection.')
        header = data['header']
        if (header['start'] != f'{start_year}0101' or header['end'] != f'{end_year}1231' or header['time_standard'] != 'LST'
                or header['sources'] != ['MERRA2'] or header['api']['name'] != 'POWER Monthly and Annual API'
                or not isinstance(header['api']['version'], str) or not header['api']['version']):
            raise PilotError('Unexpected precipitation source/time metadata.')
        if data['parameters'] != {'PRECTOTCORR': {'units': 'mm/day', 'longname': 'Precipitation Corrected'}}:
            raise PilotError('Unexpected parameter definition/unit; no conversion.')
        fill = finite(header['fill_value'], 'fill')
        if fill >= 0:
            raise PilotError('Fill must be outside the nonnegative precipitation range.')
        messages = data.get('messages')
        if not isinstance(messages, list) or not all(isinstance(m, str) for m in messages):
            raise PilotError('Unsupported source messages.')
        cells = {}
        west, south, east, north = tile['request_bbox']
        for feature in data['features']:
            if feature['type'] != 'Feature' or feature['geometry']['type'] != 'Point':
                raise PilotError('Expected native grid-centre features.')
            coordinates = feature['geometry']['coordinates']
            if not isinstance(coordinates, list) or len(coordinates) < 2:
                raise PilotError('Missing grid coordinates.')
            lon, lat = [finite(v, 'grid coordinate') for v in coordinates[:2]]
            if not (west <= lon <= east and south <= lat <= north):
                raise PilotError('Grid coordinate outside the requested halo.')
            for value, origin, step in [(lon, -180, regional.DLON), (lat, -90, regional.DLAT)]:
                index = (value - origin) / step
                if not math.isclose(index, round(index), rel_tol=0, abs_tol=1e-8):
                    raise PilotError('Precipitation is not on the declared MERRA2 grid.')
            key = (lon, lat)
            if key in cells:
                raise PilotError('Duplicate cell within one response.')
            parameters = feature['properties']['parameter']
            if set(parameters) != {'PRECTOTCORR'}:
                raise PilotError('Unexpected feature parameter set.')
            values = parameters['PRECTOTCORR']
            series = _series(values, fill, True, start_year=start_year, end_year=end_year)
            annual_key = f'{start_year}13'
            annual = (finite(values[annual_key], 'annual') if start_year == end_year
                      and annual_key in values and values[annual_key] != fill else None)
            cells[key] = {'raw_feature': feature, 'longitude': lon, 'latitude': lat, 'series': series,
                          'provider_annual_summary_separate': annual}
        if set(regional.expected_cells(tile['config']['candidate_bbox'])) - set(cells):
            raise PilotError('Tile omits intersecting cells; another tile cannot hide the omission.')
    except (KeyError, TypeError, IndexError) as exc:
        raise PilotError('Incomplete/malformed grid response.') from exc
    return cells, header, messages


def merge_tiles(config, plans, raws, *, start_year=2024, end_year=2024):
    cells, duplicate_count, first, messages = {}, 0, None, {}
    for tile in plans:
        found, header, notes = _decode_tile(raws[tile['filename']], tile, start_year=start_year, end_year=end_year)
        if first is None:
            first = header
        elif header != first:
            raise PilotError('Tile source/time/API/fill metadata differs; refusing a mixed snapshot.')
        messages[tile['filename']] = notes
        for key, cell in found.items():
            if key in cells:
                if cell['raw_feature'] != cells[key]['raw_feature']:
                    raise PilotError('Overlapping precipitation cell differs; no blending performed.')
                duplicate_count += 1
            else:
                cells[key] = cell
    expected = set(regional.expected_cells(config['candidate_bbox']))
    if expected - set(cells):
        raise PilotError('Candidate window is missing grid cells.')
    selected = [{k: v for k, v in cells[key].items() if k != 'raw_feature'} for key in sorted(expected, key=lambda p: (p[1], p[0]))]
    return selected, cells, expected, duplicate_count, first, messages


def inspect_region(region, raws, *, temperature_files=None):
    config = config_for(region) if temperature_files is None else _check_scope(region, loads(temperature_files['request.json']))
    plans = plan_for(region, config=config)
    selected, cells, expected, duplicate_count, first, messages = merge_tiles(config, plans, raws)
    # Replay the existing temperature run instead of trusting a stored cell list.
    if temperature_files is None:
        base = ROOT / f'examples/{region.lower()}-window-2024'
        temperature = regional.validate_run(base) if region == 'A' else tiled.validate_run(base)
        baseline_raw = (base / 'result.json').read_bytes()
    else:
        from .surface_workflow import _window_replay
        temperature = _window_replay(temperature_files)['result']
        baseline_raw = temperature_files['result.json']
    baseline_cells = {(c['longitude'], c['latitude']) for c in temperature['module_details']['cells']}
    provenance = temperature['provenance']
    counts = [sum(c['series'][month]['status'] == 'valid' for c in selected) for month in range(12)]
    return {'region_id': region, 'candidate_bbox': config['candidate_bbox'],
            'spatial_support': 'candidate_window_grid_centres', 'unit': 'mm/day',
            'grid_definition': {'longitude_step_deg': regional.DLON, 'latitude_step_deg': regional.DLAT,
                                'window_cell_selection': 'reconstructed_midpoint_intersection'},
            'tile_count': len(plans), 'duplicate_cells_removed': duplicate_count,
            'returned_unique_cells': len(cells), 'halo_only_cells': len(set(cells) - expected),
            'window_cell_count': len(selected), 'valid_cells_by_month': counts,
            'complete_months': sum(count == len(selected) for count in counts), 'cells': selected,
            'provider_header': first, 'provider_messages': messages,
            'temperature_control': {'coordinate_sets_match': expected == baseline_cells,
                'time_source_api_match': (temperature['time']['start'] == '2024-01' and temperature['time']['end'] == '2024-12'
                    and temperature['time']['provider_time_standard'] == first['time_standard']
                    and provenance['api_version'] == first['api']['version'] and provenance['sources'] == first['sources']),
                'baseline_result_sha256': hashlib.sha256(baseline_raw).hexdigest()}}


def validate_capture(raws, capture, plans):
    names = {t['filename'] for t in plans}
    if (set(raws) != names or not isinstance(capture, dict) or set(capture) != {'schema_version', 'retrieved_at', 'requests'}
            or capture['schema_version'] != VERSION or not isinstance(capture['requests'], dict) or set(capture['requests']) != names):
        raise PilotError('Capture does not describe the exact deterministic grid request plan.')
    try:
        stamp = datetime.fromisoformat(capture['retrieved_at'])
        if stamp.tzinfo is None or stamp.utcoffset().total_seconds() != 0:
            raise ValueError('UTC required')
    except (ValueError, TypeError) as exc:
        raise PilotError('Capture timestamp must be explicit UTC.') from exc
    for tile in plans:
        raw = raws[tile['filename']]
        if capture['requests'][tile['filename']] != {'url': tile['precipitation_url'], 'sha256': hashlib.sha256(raw).hexdigest()}:
            raise PilotError('Grid source hash or request identity differs from capture.')


def report_for(raws, capture, *, temperature_files=None):
    if temperature_files is not None and set(temperature_files) != set(REGIONS):
        raise PilotError('Frozen grid replay requires both recorded temperature controls.')
    plans = [tile for r in REGIONS for tile in plan_for(r, config=None if temperature_files is None
                                                      else loads(temperature_files[r]['request.json']))]
    validate_capture(raws, capture, plans)
    return {'schema_version': VERSION, 'output_type': 'candidate_precipitation_grid_probe',
            'selection_status': 'candidate', 'scientific_compatibility_accepted': False,
            'precipitation_region_mean_performed': False, 'monthly_total_conversion_performed': False,
            'mask_or_inference_performed': False, 'capture': capture,
            'regions': [inspect_region(r, raws, temperature_files=None if temperature_files is None
                                      else temperature_files[r]) for r in REGIONS]}


def fetch_probe(destination):
    destination = Path(destination)
    if destination.exists() or destination.is_symlink():
        raise PilotError('Preserve existing output; choose a new directory.')
    raws, requests = {}, {}
    for region in REGIONS:
        for tile in plan_for(region):
            url = tile['precipitation_url']
            try:
                with urlopen(Request(url, headers={'User-Agent': 'Expedition73-candidate-grid-probe/0.1'}), timeout=90) as response:
                    if response.status != 200 or response.url != url:
                        raise PilotError('Unexpected source status or redirect.')
                    raw = response.read(LIMIT + 1)
            except (HTTPError, URLError, TimeoutError) as exc:
                raise PilotError('Public NASA grid request failed; no output saved. Retry explicitly.') from exc
            if len(raw) > LIMIT:
                raise PilotError('Grid response exceeds size limit.')
            raws[tile['filename']] = raw
            requests[tile['filename']] = {'url': url, 'sha256': hashlib.sha256(raw).hexdigest()}
    capture = {'schema_version': VERSION, 'retrieved_at': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'requests': requests}
    report = report_for(raws, capture)
    destination.mkdir(parents=True, exist_ok=False)
    for name, raw in raws.items(): (destination / name).write_bytes(raw)
    for name, value in [('capture.json', capture), ('report.json', report)]:
        (destination / name).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8', newline='\n')
    return report


def validate_run(directory):
    directory = Path(directory)
    names = {t['filename'] for r in REGIONS for t in plan_for(r)}
    files = names | {'capture.json', 'report.json'}
    if directory.is_symlink() or {p.name for p in directory.iterdir()} != files:
        raise PilotError('Expected exactly the grid probe files.')
    if any((directory / name).is_symlink() or not (directory / name).is_file() or (directory / name).stat().st_size > LIMIT for name in files):
        raise PilotError('Unsupported probe file or size.')
    capture = loads((directory / 'capture.json').read_bytes())
    expected = report_for({name: (directory / name).read_bytes() for name in names}, capture)
    actual = loads((directory / 'report.json').read_bytes())
    if json.dumps(actual, sort_keys=True) != json.dumps(expected, sort_keys=True):
        raise PilotError('Stored grid report differs from complete raw replay.')
    return expected


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('fetch').add_argument('--output-dir', required=True)
    commands.add_parser('validate').add_argument('run')
    args = parser.parse_args(argv)
    try:
        result = fetch_probe(args.output_dir) if args.command == 'fetch' else validate_run(args.run)
        print(json.dumps({'status': 'inspected' if args.command == 'fetch' else 'replay_passed',
                          'regions': [{k: r[k] for k in ('region_id', 'window_cell_count', 'complete_months', 'duplicate_cells_removed', 'temperature_control')} for r in result['regions']],
                          'scientific_compatibility_accepted': False}))
    except (PilotError, OSError) as exc:
        parser.exit(1, f'ERROR: {exc}\n')


if __name__ == '__main__': main()
