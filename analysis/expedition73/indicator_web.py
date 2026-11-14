"""Public projection of real candidate indicator workflows, bound to a catalog."""
from __future__ import annotations
import hashlib
import json
import re
from pathlib import Path
from . import indicator_adapter as adapter, indicator_workflow as flow, precipitation_history, workflow, workflow_trace, regional
from .power import PilotError, loads

VERSION = '0.1.0'
HISTORY_VERSION = '0.2.0'

def definitions():
    def node(name, operation, contract, inputs):
        return dict(id=name, operation=operation, version=VERSION, parameters={}, inputs=inputs, output_contract=contract)
    def link(name, contract): return dict(node=name, output='result', contract=contract)
    return [node('Temperature','AdaptRecordedTemperature',flow.TEMPERATURE,{}),
            node('Precipitation','AdaptRecordedPrecipitation',flow.PRECIPITATION,{}),
            node('InputCheck','CheckCoindexedIndicators',flow.CHECK,{
                'temperature':link('Temperature',flow.TEMPERATURE),'precipitation':link('Precipitation',flow.PRECIPITATION)})]

def _annual(catalog):
    if catalog['output_type'] == 'recorded_temperature_year_catalog':
        return next((loads(s['data_json']) for s in catalog['snapshots'] if s['year']==2024),None)
    return catalog if catalog['dates'][0]=='2024-01' else None

def validate_payload(data, catalog_bytes):
    """Public contract and identities, without claiming a new raw-source replay."""
    if data.get('schema_version') == HISTORY_VERSION:
        historical = data.get('precipitation_history')
        legacy = {key: value for key, value in data.items() if key != 'precipitation_history'}
        validate_payload({**legacy, 'schema_version': VERSION}, catalog_bytes)
        if (not isinstance(historical, dict) or set(historical) != {'data_json', 'sha256'}
                or not isinstance(historical['data_json'], str) or len(historical['data_json'].encode()) > 300_000
                or hashlib.sha256(historical['data_json'].encode()).hexdigest() != historical['sha256']):
            raise PilotError('Invalid precipitation history content identity.')
        controls = {entry['id']: loads(entry['precipitation_json']) for entry in data['regions']}
        precipitation_history.validate_projection(loads(historical['data_json']), controls, loads(catalog_bytes))
        return data
    if (set(data)!={'schema_version','output_type','selection_status','data_mode','inference_performed','source_catalog_sha256','status','year','regions'}
        or data['schema_version']!=VERSION or data['output_type']!='recorded_indicator_web_preview'
        or data['selection_status']!='candidate' or data['data_mode']!='recorded_offline_replay'
        or data['inference_performed'] is not False or data['year']!=2024
        or data['source_catalog_sha256']!=hashlib.sha256(catalog_bytes).hexdigest()
        or not isinstance(data['regions'],list) or len(data['regions'])>8
        or data['status']!=('available' if data['regions'] else 'not_available')):
        raise PilotError('Invalid indicator web envelope or catalog identity.')
    annual=_annual(loads(catalog_bytes)) if data['regions'] else None; seen=set()
    for entry in data['regions']:
        if set(entry)!={'id','display_name','temperature_json','temperature_sha256','precipitation_json','precipitation_sha256','input_check','workflow'} or entry['id'] in seen:
            raise PilotError('Unexpected indicator region projection.')
        seen.add(entry['id'])
        baseline=next((r for r in annual['regions'] if r['id']==entry['id']),None) if annual else None
        if baseline is None or entry['display_name']!=baseline['display_name']: raise PilotError('Indicator region absent from catalog.')
        values=[]
        for name in ('temperature','precipitation'):
            raw=entry[name+'_json']
            if not isinstance(raw,str) or len(raw.encode())>100_000 or hashlib.sha256(raw.encode()).hexdigest()!=entry[name+'_sha256']:
                raise PilotError('Indicator text hash differs.')
            value=loads(raw); adapter.validate_result(value); values.append(value)
            details=value['module_details']
            allowed={'source_output_type','source_method','provider_annual_summary_handling'}
            if name=='precipitation': allowed|={'latitude_context','temperature_control_result_sha256','missing_counts'}
            if set(details)!=allowed or set(details['source_method'])-{'id','version','geometry','geometry_version','sphere_radius_m','missing_policy','inference','within_cell_assumption','provider_annual_summary'}:
                raise PilotError('Private or unexpected module details cannot be exported.')
        temperature,rain=values
        expected=adapter.assess_coindexed_inputs(temperature,rain)
        if expected['technical_status']!='compatible' or adapter.digest(expected)!=adapter.digest(entry['input_check']): raise PilotError('Indicator input check differs.')
        if temperature['region']['id']!=entry['id'] or temperature['time']!=baseline['time'] or not regional._same_result(temperature['region']['candidate_bbox'],baseline['region']['candidate_bbox']):
            raise PilotError('Indicator context differs from monthly catalog.')
        if temperature['provenance']['source_result_sha256']!=baseline['provenance']['source_files_sha256']['temperature']['result.json']:
            raise PilotError('Indicator temperature belongs to another source snapshot.')
        for common,row in zip(temperature['series'],baseline['series'],strict=True):
            if common['date']!=row['date'] or not regional._same_result(common['value'],row['unmasked']): raise PilotError('Indicator temperature differs from catalog values.')
        w=entry['workflow']
        if set(w)!={'context_json','trace'} or not isinstance(w['context_json'],str) or len(w['context_json'])>30_000: raise PilotError('Unexpected indicator workflow export.')
        context=loads(w['context_json']); sources=context.get('source_files_sha256',{})
        if set(context)!={'scope','region_id','source_files_sha256'} or context['scope']!='candidate_coindexed_indicators' or context['region_id']!=entry['id'] or set(sources)!={'temperature','precipitation'}:
            raise PilotError('Private or unexpected indicator context.')
        p=sources['precipitation']
        if set(p)!={'grid','audit','temperature_controls'} or set(p['temperature_controls'])!={'A','B'}:
            raise PilotError('Unexpected source context.')
        maps=[sources['temperature'],p['grid'],p['audit'],*p['temperature_controls'].values()]
        for mapping in maps:
            if not isinstance(mapping,dict) or not mapping or any(not re.fullmatch(r'(?:[ab]-)?tile-\d{3}\.json|request\.json|response\.json|result\.json|manifest\.json|capture\.json|report\.json',k) or not isinstance(v,str) or not re.fullmatch('[a-f0-9]{64}',v) for k,v in mapping.items()):
                raise PilotError('Unexpected source filename or hash.')
        if (sources['temperature']!=temperature['provenance']['input_files_sha256']['temperature']
            or p['grid']!=rain['provenance']['input_files_sha256']['grid'] or p['audit']!=rain['provenance']['input_files_sha256']['audit']
            or p['temperature_controls'][entry['id']]['result.json']!=rain['module_details']['temperature_control_result_sha256']): raise PilotError('Workflow sources differ from indicators.')
        spec={'schema_version':VERSION,'context':context,'nodes':definitions()}; plan=workflow.plan(spec,'InputCheck'); trace=w['trace']
        if (hashlib.sha256(w['context_json'].encode()).hexdigest()!=trace['context_sha256'] or workflow._hash(context)!=trace['context_sha256']
            or trace['target']!='InputCheck' or trace['execution_status']!='completed' or trace['scientific_validation']!='not_performed'
            or trace['identity_kind']!='workflow_plan_fingerprint' or len(trace['nodes'])!=3): raise PilotError('Invalid indicator trace.')
        for name,node in zip(plan['order'],trace['nodes'],strict=True):
            definition=plan['nodes'][name]
            inputs=[dict(alias=a,node=i['node'],output='result',definition_fingerprint=plan['fingerprints'][i['node']]) for a,i in sorted(definition['inputs'].items())]
            if (node['id']!=name or node['operation']!=definition['operation'] or node['operation_version']!=VERSION or node['output_contract']!=definition['output_contract']
                or node['definition_fingerprint']!=plan['fingerprints'][name] or node['inputs']!=inputs or node['status']!='completed' or node['executions']!=1): raise PilotError('Trace definition differs from indicator workflow.')
    return data

def payload(root, registry, catalog_bytes, *, history_path=None):
    from .web_preview import _directory
    root=Path(root)
    data=dict(schema_version=VERSION,output_type='recorded_indicator_web_preview',selection_status='candidate',data_mode='recorded_offline_replay',
              inference_performed=False,source_catalog_sha256=hashlib.sha256(catalog_bytes).hexdigest(),status='not_available',year=2024,regions=[])
    if registry is not None:
        if not isinstance(registry,list) or not 1<=len(registry)<=8: raise PilotError('Invalid indicator registry.')
        for entry in registry:
            if set(entry)!={'id','display_name','window','precipitation','audit'}: raise PilotError('Unexpected indicator registry field.')
            audit_name=entry['audit']
            if not isinstance(audit_name,str) or '\\' in audit_name or Path(audit_name).is_absolute() or '..' in Path(audit_name).parts:
                raise PilotError('Audit path must stay inside analysis.')
            audit=root/audit_name
            if audit.is_symlink() or not audit.resolve().is_relative_to(root.resolve()): raise PilotError('Audit path escapes analysis.')
            spec,run=flow.run(_directory(root,entry['window']),_directory(root,entry['precipitation']),audit,entry['id'],
                              control_directories={r:root/f'examples/{r.lower()}-window-2024' for r in ('A','B')})
            if run['status']!='completed': raise PilotError('Indicator workflow incomplete; no partial web export.')
            common={name:run['nodes'][node]['artifact']['value'] for name,node in [('temperature','Temperature'),('precipitation','Precipitation')]}
            texts={name:json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False) for name,value in common.items()}
            data['regions'].append(dict(id=entry['id'],display_name=entry['display_name'],**{name+'_json':raw for name,raw in texts.items()},
                **{name+'_sha256':hashlib.sha256(raw.encode()).hexdigest() for name,raw in texts.items()},input_check=run['nodes']['InputCheck']['artifact']['value'],
                workflow=dict(context_json=json.dumps(spec['context'],sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False),trace=workflow_trace.project(spec,run))))
        data['status']='available'
    if history_path is not None:
        controls = {entry['id']: loads(entry['precipitation_json']) for entry in data['regions']}
        if set(controls) != set(precipitation_history.grid.REGIONS):
            raise PilotError('Precipitation history requires the existing A/B indicator controls.')
        history = precipitation_history.replay(root, _directory(root, history_path), controls)
        raw = json.dumps(history, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
        data.update(schema_version=HISTORY_VERSION, precipitation_history={
            'data_json': raw, 'sha256': hashlib.sha256(raw.encode()).hexdigest()})
    return validate_payload(data,catalog_bytes)
