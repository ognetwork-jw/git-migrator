import {parse,buildSchema,print,Kind,visit} from 'graphql';
import fs from 'fs';
const src=fs.readFileSync(process.argv[2],'utf8');
const doc=parse(src,{noLocation:true});
const defs=new Map();
for(const d of doc.definitions){ if(d.name) defs.set(d.name.value,d); }
// whitelist trimmed object types: name -> {fields:[...], implements:[...]}
const trim={
 Query:{fields:['node','repository','user','organization','rateLimit'],impl:[]},
 Mutation:{fields:['createBranchProtectionRule','updateBranchProtectionRule','deleteBranchProtectionRule'],impl:[]},
 Repository:{fields:['id','databaseId','name','nameWithOwner','isPrivate','isEmpty','branchProtectionRules'],impl:['Node']},
 BranchProtectionRule:{fields:null,drop:['matchingRefs','branchProtectionRuleConflicts','creator','reviewDismissalAllowances'],impl:['Node']},
 User:{fields:['id','databaseId','login'],impl:['Node']},
 Team:{fields:['id','databaseId','slug','name','combinedSlug'],impl:['Node']},
 App:{fields:['id','databaseId','slug','name'],impl:['Node']},
 Organization:{fields:['id','databaseId','login'],impl:['Node']},
};
const keepFieldNames=(d,t)=>{
  let f=d.fields;
  if(t.fields) f=f.filter(x=>t.fields.includes(x.name.value));
  if(t.drop) f=f.filter(x=>!t.drop.includes(x.name.value));
  return f;
};
const out=new Map();
function typeName(t){ while(t.kind!==Kind.NAMED_TYPE) t=t.type; return t.name.value; }
const q=[];
function need(n){ if(out.has(n)||!defs.has(n)) return; const d=defs.get(n); let nd=d;
  if(trim[n]){ nd={...d,fields:keepFieldNames(d,trim[n]),interfaces:trim[n].impl.map(i=>({kind:Kind.NAMED_TYPE,name:{kind:Kind.NAME,value:i}}))}; }
  else if(d.kind===Kind.OBJECT_TYPE_DEFINITION && d.interfaces?.length){
    nd={...d,interfaces:d.interfaces.filter(i=>['Node'].includes(i.name.value))};
  }
  if(nd.directives) nd={...nd,directives:[]};
  if(nd.fields) nd={...nd,fields:nd.fields.map(f=>({...f,directives:[]}))};
  out.set(n,nd); q.push(nd);
}
need('Query');need('Mutation');need('Node');
while(q.length){ const d=q.shift();
  const refs=[];
  (d.fields||[]).forEach(f=>{refs.push(typeName(f.type)); (f.arguments||[]).forEach(a=>refs.push(typeName(a.type)));});
  (d.types||[]).forEach(t=>refs.push(t.name.value));
  (d.interfaces||[]).forEach(t=>refs.push(t.name.value));
  refs.forEach(need);
}
// restrict union/ interface implementers not needed. Build SDL
const scal=['String','Int','Float','Boolean','ID'];
const kept=[...out.values()].filter(d=>!scal.includes(d.name.value));
// interface Node: fine. 
const sdl=print({kind:Kind.DOCUMENT,definitions:[{kind:Kind.SCHEMA_DEFINITION,operationTypes:[{kind:Kind.OPERATION_TYPE_DEFINITION,operation:'query',type:{kind:Kind.NAMED_TYPE,name:{kind:Kind.NAME,value:'Query'}}},{kind:Kind.OPERATION_TYPE_DEFINITION,operation:'mutation',type:{kind:Kind.NAMED_TYPE,name:{kind:Kind.NAME,value:'Mutation'}}}]},...kept.sort((a,b)=>a.name.value.localeCompare(b.name.value))]});
buildSchema(sdl);
fs.writeFileSync(process.argv[3],sdl+'\n');
console.log(kept.length,'types',sdl.length,'bytes');
console.log(kept.map(d=>d.name.value).join(' '));
