"""Replay regional NASA POWER precipitation across the existing 2001–2024 period."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

from . import indicator_adapter as adapter, precipitation_area_audit as area, precipitation_grid_probe as grid, regional
from .power import ROOT, PilotError, loads, months

START, LAST_CAPTURE, END = 2001, 2023, 2024
VARIABLE = {'provider_parameter': 'PRECTOTCORR', 'unit': 'mm/day'}
TIME = {'frequency': 'monthly', 'calendar': 'gregorian', 'provider_time_standard': 'LST',
        'start': f'{START}-01', 'end': f'{END}-12'}


def replay(root, source, controls):
    """Replay the three new tiles, then append the existing verified 2024 monthly rates."""
    root, source = Path(root), Path(source)
    configs = {r: loads(adapter._read(root / f'examples/{r.lower()}-window-2024/request.json')) for r in grid.REGIONS}
    plans = {r: grid.plan_for(r, config=configs[r], start_year=START, end_year=LAST_CAPTURE) for r in grid.REGIONS}
    tiles = [tile for plan in plans.values() for tile in plan]
    names = {tile['filename'] for tile in tiles}
    if source.is_symlink() or {p.name for p in source.iterdir()} != names | {'capture.json'}:
        raise PilotError('Expected only the precipitation history capture and its three tiles.')
    raws = {name: adapter._read(source / name) for name in sorted(names)}
    capture = adapter._read(source / 'capture.json')
    grid.validate_capture(raws, loads(capture), tiles)
    regions = []
    for region_id in grid.REGIONS:
        control = controls[region_id]
        config = configs[region_id]
        cells, _, _, _, header, _ = grid.merge_tiles(
            config, plans[region_id], raws, start_year=START, end_year=LAST_CAPTURE)
        provenance = control['provenance']
        geometry = adapter._geometry([
            {'longitude': lon, 'latitude': lat, 'intersection_bbox': bounds}
            for (lon, lat), bounds in regional.expected_cells(config['candidate_bbox']).items()])
        coordinates_match = geometry == control['spatial_support']['cell_geometry_sha256']
        if (control['region']['candidate_bbox'] != config['candidate_bbox']
                or header['api']['version'] != provenance['api_version']
                or header['api']['name'] != provenance['product'] or header['sources'] != provenance['sources']
                or header['time_standard'] != control['time']['provider_time_standard']):
            raise PilotError('Precipitation history and the 2024 control disagree on boundary, API, source or time standard.')
        result = area.summarize_region({
            'region_id': region_id, 'candidate_bbox': config['candidate_bbox'], 'cells': cells, 'unit': VARIABLE['unit'],
            'temperature_control': {'coordinate_sets_match': coordinates_match, 'time_source_api_match': True},
        }, start_year=START, end_year=LAST_CAPTURE)
        series = [{**{key: row[key] for key in ('date', 'status', 'valid_cells', 'valid_area_fraction')},
                   'value': row['mean_rate_mm_per_day']} for row in result['series']]
        missing = [{key: row[key] for key in ('date', 'provider_fill_cells', 'not_returned_cells')}
                   for row in result['series']]
        regions.append({'id': region_id, 'series': series + control['series'],
                        'missing_counts': missing + control['module_details']['missing_counts']})
    return {'time': TIME, 'variable': VARIABLE, 'source_files_sha256': {
        name: hashlib.sha256(raw).hexdigest() for name, raw in {**raws, 'capture.json': capture}.items()},
        'regions': regions}


def validate_projection(data, controls, catalog):
    """Check public date slots, coverage and technical alignment with the monthly catalog."""
    dates = months(START, END)
    if (set(data) != {'time', 'variable', 'source_files_sha256', 'regions'} or data['time'] != TIME
            or data['variable'] != VARIABLE or not isinstance(data['regions'], list)
            or [entry['id'] for entry in data['regions']] != list(grid.REGIONS) or set(controls) != set(grid.REGIONS)):
        raise PilotError('Unexpected precipitation history contract.')
    hashes = data['source_files_sha256']
    if set(hashes) != {'capture.json', 'a-tile-001.json', 'b-tile-001.json', 'b-tile-002.json'} or any(
            not isinstance(value, str) or len(value) != 64 or set(value) - set('0123456789abcdef') for value in hashes.values()):
        raise PilotError('Unexpected precipitation history source identities.')
    for entry in data['regions']:
        control = controls[entry['id']]
        series, missing = entry['series'], entry['missing_counts']
        if (set(entry) != {'id', 'series', 'missing_counts'} or [row['date'] for row in series] != dates
                or [row['date'] for row in missing] != dates or series[-12:] != control['series']
                or missing[-12:] != control['module_details']['missing_counts']):
            raise PilotError('Precipitation months do not align or differ from the 2024 seed.')
        count = control['spatial_support']['cell_count']
        for row, absent in zip(series, missing, strict=True):
            valid, fraction, value = row['valid_cells'], row['valid_area_fraction'], row['value']
            complete = valid == count
            gaps = [absent[key] for key in ('provider_fill_cells', 'not_returned_cells')]
            if (set(row) != {'date', 'status', 'valid_cells', 'valid_area_fraction', 'value'}
                    or set(absent) != {'date', 'provider_fill_cells', 'not_returned_cells'}
                    or type(valid) is not int or not 0 <= valid <= count or type(fraction) not in (float, int)
                    or any(type(gap) is not int or gap < 0 for gap in gaps) or sum(gaps) != count - valid
                    or (row['status'] != ('complete' if complete else 'incomplete'))
                    or (not math.isclose(fraction, 1, rel_tol=0, abs_tol=1e-12) if complete else not 0 <= fraction < 1)
                    or (valid == 0 and fraction != 0)
                    or (not (type(value) in (float, int) and math.isfinite(value) and value >= 0) if complete else value is not None)):
                raise PilotError('Invalid precipitation rate or cell coverage.')
    if catalog is None:
        return
    snapshots = catalog.get('snapshots', [])
    if [snapshot['year'] for snapshot in snapshots] != list(range(START, END + 1)):
        raise PilotError('Precipitation history requires the matching 24-year temperature catalog.')
    for snapshot in snapshots:
        annual = loads(snapshot['data_json'])
        year = snapshot['year']
        if annual['dates'] != months(year, year):
            raise PilotError('Catalog dates differ from precipitation history.')
        by_id = {region['id']: region for region in annual['regions']}
        for region_id, control in controls.items():
            region = by_id.get(region_id)
            provenance = control['provenance']
            if (region is None or any(region['region'][key] != value for key, value in control['region'].items())
                    or region['time'] != {**TIME, 'start': f'{year}-01', 'end': f'{year}-12'}
                    or region['support']['cell_count'] != control['spatial_support']['cell_count']
                    or adapter._geometry(region['spatial']['cells']) != control['spatial_support']['cell_geometry_sha256']
                    or any(region['provenance']['temperature'][key] != provenance[key]
                           for key in ('provider', 'product', 'api_version', 'sources'))):
                raise PilotError('Temperature catalog disagrees with precipitation spatial or source support.')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('capture_directory', type=Path)
    args = parser.parse_args(argv)
    try:
        controls = {r: adapter.adapt_precipitation(ROOT / 'examples/precipitation-grid-probe-2024',
                    ROOT / 'examples/precipitation-area-audit-2024.json', r) for r in grid.REGIONS}
        result = replay(ROOT, args.capture_directory, controls)
        validate_projection(result, controls, None)
        print(json.dumps({'status': 'replay_passed', 'time': result['time'], 'unit': VARIABLE['unit'],
                          'regions': {entry['id']: {'months': len(entry['series']), 'complete_months': sum(
                              row['status'] == 'complete' for row in entry['series'])} for entry in result['regions']}}))
    except (PilotError, OSError) as exc:
        parser.exit(1, f'ERROR: {exc}\n')


if __name__ == '__main__':
    main()
