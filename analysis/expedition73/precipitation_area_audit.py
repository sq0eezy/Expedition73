"""Candidate unmasked precipitation-rate means from a verified 2024 grid probe.

Geometry is shared with T2M; precipitation decoding and semantics stay separate.
No totals, land fractions, comparison inference or scientific acceptance.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

from . import precipitation_grid_probe as grid, regional
from .power import PilotError, loads, months

VERSION = '0.1.0'
LIMIT = 250_000


def summarize_region(region, *, start_year=2024, end_year=2024):
    """Internal calculation on the strict grid decoder's verified result."""
    bbox = region['candidate_bbox']
    intersections = regional.expected_cells(bbox)
    cells = region['cells']
    keys = [(c['longitude'], c['latitude']) for c in cells]
    if len(keys) != len(set(keys)) or set(keys) != set(intersections):
        raise PilotError('Area audit requires every intersecting precipitation cell exactly once.')
    if region['unit'] != 'mm/day':
        raise PilotError('Area audit requires precipitation rates in mm/day.')
    if not all(region['temperature_control'][k] is True for k in ('coordinate_sets_match', 'time_source_api_match')):
        raise PilotError('Recorded T2M technical support differs; audit scope cannot silently drift.')
    weights = []
    for cell in cells:
        key = (cell['longitude'], cell['latitude'])
        intersection = intersections[key]
        weights.append({'longitude': key[0], 'latitude': key[1],
                        'intersection_bbox': intersection, 'area_m2': regional.spherical_area(intersection)})
    area = math.fsum(w['area_m2'] for w in weights)
    if not math.isclose(area, regional.spherical_area(bbox), rel_tol=1e-10):
        raise PilotError('Reconstructed intersections do not conserve the candidate window area.')
    for weight in weights:
        weight['area_weight'] = weight['area_m2'] / area
    rows = []
    dates = months(start_year, end_year)
    for month, expected_date in enumerate(dates):
        entries = []
        for cell, weight in zip(cells, weights):
            if len(cell['series']) != len(dates) or cell['series'][month]['date'] != expected_date:
                raise PilotError('Area audit requires aligned monthly slots for the requested period.')
            row = cell['series'][month]
            value, status = row['value'], row['status']
            if status == 'valid':
                if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
                    raise PilotError('Invalid precipitation rate in verified grid result.')
            elif status not in ('provider_fill', 'not_returned') or value is not None:
                raise PilotError('Invalid missing precipitation status/value.')
            entries.append((row, weight))
        valid = [(r, w) for r, w in entries if r['status'] == 'valid']
        complete = len(valid) == len(cells)
        rows.append({'date': expected_date, 'mean_rate_mm_per_day': math.fsum(
            r['value'] * w['area_weight'] for r, w in valid) if complete else None,
            'status': 'complete' if complete else 'incomplete', 'expected_cells': len(cells),
            'valid_cells': len(valid), 'provider_fill_cells': sum(r['status'] == 'provider_fill' for r, _ in entries),
            'not_returned_cells': sum(r['status'] == 'not_returned' for r, _ in entries),
            'valid_area_fraction': math.fsum(w['area_m2'] for _, w in valid) / area})
    # A geographical hint to the cited MERRA-2 regime, never a pixel QA flag,
    # station-coverage estimate, land classification or numerical correction.
    low, high = (0 if bbox[1] <= 0 <= bbox[3] else min(abs(bbox[1]), abs(bbox[3])),
                 max(abs(bbox[1]), abs(bbox[3])))
    band = ('entirely_equatorward_42_5' if high <= 42.5 else
            'entirely_poleward_62_5' if low >= 62.5 else 'transition_or_mixed_latitudes')
    return {'region_id': region['region_id'], 'candidate_bbox': bbox,
            'unit': 'mm/day', 'surface_target': 'unmasked_candidate_rectangle',
            'window_area_m2': area, 'window_cell_count': len(cells), 'cell_weights': weights,
            'latitude_context': {'absolute_latitude_range_deg': [low, high], 'regime_hint': band,
                                 'observational_support_equivalence_accepted': False},
            'complete_months': sum(r['status'] == 'complete' for r in rows), 'series': rows}


def capture_source(source, *, temperature_files=None):
    source = Path(source)
    names = sorted({'capture.json', 'report.json'} | {
        t['filename'] for r in grid.REGIONS for t in grid.plan_for(r, config=None if temperature_files is None
                                                                else loads(temperature_files[r]['request.json']))})
    if source.is_symlink() or {p.name for p in source.iterdir()} != set(names):
        raise PilotError('Expected exactly the grid probe source files.')
    if any((source / name).is_symlink() or not (source / name).is_file() for name in names):
        raise PilotError('Unsupported grid probe source file.')
    # Decode and hash the same bounded byte snapshot; do not reopen files after
    # verification to assign an identity to potentially changed source content.
    snapshot = {}
    for name in names:
        with (source / name).open('rb') as stream:
            snapshot[name] = stream.read(grid.LIMIT + 1)
        if len(snapshot[name]) > grid.LIMIT:
            raise PilotError('Grid source exceeds size limit.')
    return snapshot


def summarize_snapshot(snapshot, *, temperature_files=None):
    """Replay immutable source bytes; supplied temperature controls avoid disk I/O."""
    names = sorted({'capture.json', 'report.json'} | {
        t['filename'] for r in grid.REGIONS for t in grid.plan_for(r, config=None if temperature_files is None
                                                                else loads(temperature_files[r]['request.json']))})
    if set(snapshot) != set(names) or any(not isinstance(raw, bytes) or len(raw) > grid.LIMIT for raw in snapshot.values()):
        raise PilotError('Frozen grid files differ from the bounded request plan.')
    capture = loads(snapshot['capture.json'])
    verified = grid.report_for({n: snapshot[n] for n in names if n not in ('capture.json', 'report.json')}, capture,
                               temperature_files=temperature_files)
    if json.dumps(loads(snapshot['report.json']), sort_keys=True) != json.dumps(verified, sort_keys=True):
        raise PilotError('Grid report differs from complete raw replay.')
    return {'schema_version': VERSION, 'output_type': 'candidate_precipitation_area_audit',
            'selection_status': 'candidate', 'scientific_compatibility_accepted': False,
            'land_mask_performed': False, 'totals_or_inference_performed': False,
            'source_files_sha256': {name: hashlib.sha256(snapshot[name]).hexdigest() for name in names},
            'temperature_control_result_sha256': {r['region_id']: r['temperature_control']['baseline_result_sha256']
                                                 for r in verified['regions']},
            'variable': {'provider_parameter': 'PRECTOTCORR', 'unit': 'mm/day'},
            'time': {'start': '2024-01', 'end': '2024-12', 'provider_time_standard': 'LST'},
            'method': {'id': 'candidate_unmasked_precipitation_rate_area_mean', 'version': VERSION,
                       'geometry': 'spherical_midpoint_cell_intersection', 'geometry_version': regional.VERSION,
                       'sphere_radius_m': regional.RADIUS_M, 'within_cell_assumption': 'spatially_constant_rate',
                       'missing_policy': 'require_all_intersecting_cells',
                       'provider_annual_summary': 'not_consumed'},
            'warnings': ['CANDIDATE_WINDOW_AND_METHOD_NOT_ACCEPTED', 'NO_LAND_WATER_MASK',
                         'RECONSTRUCTED_CELL_BOUNDS_SPHERICAL_AREA', 'NO_SUBCELL_PRECIPITATION_INFORMATION',
                         'HIGH_LATITUDE_CORRECTION_REGIME_DIFFERS', 'NO_OBSERVATIONAL_ACCURACY_VALIDATION'],
            'regions': [summarize_region(r) for r in verified['regions']]}


def build_audit(source):
    return summarize_snapshot(capture_source(source))


def write_audit(source, output):
    output = Path(output)
    if output.exists() or output.is_symlink():
        raise PilotError('Preserve existing output; choose a new file.')
    result = build_audit(source)
    with output.open('x', encoding='utf-8', newline='\n') as stream:
        stream.write(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + '\n')
    return result


def _same(left, right):
    # Only derived floating-point results tolerate cross-platform libm noise.
    # Hashes, booleans, counts, types, names and ordering remain exact.
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(_same(left[k], right[k]) for k in left)
    if isinstance(left, list):
        return len(left) == len(right) and all(_same(a, b) for a, b in zip(left, right))
    if isinstance(left, float):
        return math.isfinite(left) and math.isfinite(right) and math.isclose(left, right, rel_tol=1e-12, abs_tol=1e-10)
    return left == right


def validate_audit(source, output):
    output = Path(output)
    if output.is_symlink() or not output.is_file() or output.stat().st_size > LIMIT:
        raise PilotError('Unsupported audit file or size.')
    actual = loads(output.read_bytes())
    expected = build_audit(source)
    if not _same(actual, expected):
        raise PilotError('Stored precipitation area audit differs from complete source replay.')
    return expected


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('audit', 'validate'):
        cmd = commands.add_parser(name)
        cmd.add_argument('source_run')
        cmd.add_argument('audit_file')
    args = parser.parse_args(argv)
    try:
        result = (write_audit if args.command == 'audit' else validate_audit)(args.source_run, args.audit_file)
        print(json.dumps({'status': 'candidate_audit_written' if args.command == 'audit' else 'replay_passed',
                          'regions': [{k: r[k] for k in ('region_id', 'window_cell_count', 'complete_months')} for r in result['regions']],
                          'scientific_compatibility_accepted': False}))
    except (PilotError, OSError) as exc:
        parser.exit(1, f'ERROR: {exc}\n')


if __name__ == '__main__':
    main()
