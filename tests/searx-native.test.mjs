import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {searchParams} from '../core/search-upstream.js';

// Execute upstream's actual parsing functions, not a rewritten approximation.
// Local source-only checkouts may point to a fetched copy with this variable.
const adapter=process.env.SEARX_WEBADAPTER_PATH || 'searxng/src/searx/webadapter.py';
const native=`
import ast,json,sys
from types import SimpleNamespace
from typing import List,Dict,Optional
source=ast.parse(open(sys.argv[1]).read())
names={'parse_category_form','get_selected_categories','get_engineref_from_category_list','parse_generic'}
functions=[n for n in source.body if isinstance(n,ast.FunctionDef) and n.name in names]
assert len(functions)==len(names)
class EngineRef:
 def __init__(self,name,category):self.name=name;self.category=category
engines={n:SimpleNamespace(name=n,categories=['images']) for n in ['qwant images','google cse images','brave images']}
categories={'images':list(engines.values()),'general':[]}
preferences=SimpleNamespace(cfg=SimpleNamespace(lock=[]),get_value=lambda k:['general'])
Preferences=object
exec(compile(ast.Module(body=functions,type_ignores=[]),'native-webadapter','exec'),globals())
forms=json.loads(sys.stdin.read())
print(json.dumps([[e.name for e in parse_generic(preferences,f,[])] for f in forms]))
`;
test('native SearX parser: explicit engines never carry category fanout',()=>{
 const forms=['qwant images','google cse images','brave images'].map(engine=>Object.fromEntries(searchParams('fixture',2,'images',1,engine)));
 for(const f of forms){assert(!('categories' in f));assert.equal(f.pageno,'2');assert.equal(f.safesearch,'1');}
 const bad={...forms[0],categories:'images'};
 const categoryOnly=Object.fromEntries(searchParams('fixture',1,'images',0,''));assert.equal(categoryOnly.categories,'images');
 const result=JSON.parse(execFileSync('python3',['-c',native,adapter],{input:JSON.stringify([...forms,bad,categoryOnly]),encoding:'utf8'}));
 assert.deepEqual(result.slice(0,3),[['qwant images'],['google cse images'],['brave images']]);
 assert(result[3].includes('google cse images'));assert(result[3].includes('brave images'));
 assert.deepEqual(result[4],['qwant images','google cse images','brave images']);
});
