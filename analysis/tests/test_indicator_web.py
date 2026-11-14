"""Real workflow projection, catalog/source binding and failure isolation."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from expedition73 import indicator_web as view, indicator_workflow, web_preview
from expedition73.power import ROOT, PilotError, loads

class IndicatorWebTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.web=ROOT.parent/'web'
        cls.annual=web_preview.payload(ROOT,loads((cls.web/'regions.json').read_bytes()))
        cls.raw=(json.dumps(cls.annual,ensure_ascii=False,indent=2)+'\n').encode()
        cls.registry=loads((cls.web/'indicator-regions.json').read_bytes())
        cls.data=view.payload(ROOT,cls.registry,cls.raw)

    def test_real_records_keep_common_ids_and_three_node_trace(self):
        for entry in self.data['regions']:
            for name in ('temperature','precipitation'):
                expected=loads((ROOT/f"examples/indicator-adapter-{entry['id'].lower()}-2024/{name}.json").read_bytes())
                self.assertEqual(loads(entry[name+'_json']),expected)
            self.assertEqual(entry['input_check']['paired_valid_months'],12)
            self.assertEqual(len(entry['workflow']['trace']['nodes']),3)
        self.assertEqual(view.validate_payload(self.data,self.raw),self.data)
        self.assertNotIn(str(ROOT),json.dumps(self.data))

    def test_missing_registry_is_explicitly_unavailable(self):
        value=view.payload(ROOT,None,self.raw)
        self.assertEqual((value['status'],value['regions']),('not_available',[]))

    def test_catalog_identity_and_values_cannot_drift(self):
        with self.assertRaises(PilotError): view.validate_payload(self.data,self.raw+b' ')
        annual=copy.deepcopy(self.annual);annual['regions'][0]['series'][0]['unmasked']+=1
        raw=json.dumps(annual).encode(); data=copy.deepcopy(self.data);data['source_catalog_sha256']=hashlib.sha256(raw).hexdigest()
        with self.assertRaises(PilotError): view.validate_payload(data,raw)

    def test_raw_common_text_and_logical_unit_tamper_are_rejected(self):
        for resign in (False,True):
            data=copy.deepcopy(self.data);entry=data['regions'][0]
            value=loads(entry['precipitation_json']);value['variable']['unit']='mm'
            entry['precipitation_json']=json.dumps(value)
            if resign: entry['precipitation_sha256']=hashlib.sha256(entry['precipitation_json'].encode()).hexdigest()
            with self.assertRaises(PilotError): view.validate_payload(data,self.raw)

    def test_private_context_and_module_details_are_not_exportable(self):
        for field in ('context','module'):
            data=copy.deepcopy(self.data);entry=data['regions'][0]
            if field=='context':
                context=loads(entry['workflow']['context_json']);context['private_note']='PRIVATE_FIXTURE'
                entry['workflow']['context_json']=json.dumps(context)
            else:
                value=loads(entry['temperature_json']);value['module_details']['private_note']='PRIVATE_FIXTURE'
                body={k:v for k,v in value.items() if k!='result_id'}
                from expedition73.indicator_adapter import digest
                value['result_id']='sha256:'+digest(body)
                entry['temperature_json']=json.dumps(value);entry['temperature_sha256']=hashlib.sha256(entry['temperature_json'].encode()).hexdigest()
            with self.assertRaises(PilotError): view.validate_payload(data,self.raw)

    def test_trace_and_context_sources_must_match_actual_indicators(self):
        for mode in ('trace','source','claim'):
            data=copy.deepcopy(self.data);entry=data['regions'][0]
            if mode=='trace': entry['workflow']['trace']['nodes'][0]['definition_fingerprint']='0'*64
            elif mode=='claim': entry['input_check']['relationship_calculated']=True
            else:
                c=loads(entry['workflow']['context_json']);c['source_files_sha256']['temperature']['result.json']='0'*64
                entry['workflow']['context_json']=json.dumps(c)
            with self.assertRaises(PilotError): view.validate_payload(data,self.raw)

    def test_registry_rejects_traversal_private_fields_and_duplicates(self):
        for registry in ([{**self.registry[0],'audit':'../.env'}],[{**self.registry[0],'private_note':'PRIVATE'}],self.registry[:1]*2):
            with self.assertRaises(PilotError): view.payload(ROOT,registry,self.raw)

    def test_failed_execution_is_not_projected(self):
        with patch.object(indicator_workflow,'run',return_value=({},dict(status='incomplete'))),self.assertRaises(PilotError):
            view.payload(ROOT,self.registry,self.raw)

    def test_builder_preserves_existing_output_if_new_indicator_export_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            out=Path(tmp);(out/'index.html').write_bytes(b'previous public build')
            with patch.object(web_preview,'catalog',return_value=self.annual),patch.object(web_preview,'annual_payload',return_value={}),patch.object(view,'payload',side_effect=PilotError('source changed')):
                with self.assertRaises(PilotError): web_preview.build(ROOT,self.web,out)
            self.assertEqual({p.name for p in out.iterdir()},{'index.html'})
            self.assertEqual((out/'index.html').read_bytes(),b'previous public build')

if __name__=='__main__': unittest.main()
