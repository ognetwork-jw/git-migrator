# Trims api.github.com.json to the paths in docs/providers/github.md plus referenced components.
# Usage: python3 -I trim-openapi.py <api.github.com.json> <out.json>  (injects info.x-git-migrator-source; update the pin in this script when re-pinning)
import json,sys,re
d=json.load(open(sys.argv[1]))
P=d['paths']
want=[]
def add(p,methods=None): want.append((p,methods))
exact=[
('/app/installations/{installation_id}/access_tokens',['post']),
('/orgs/{org}',['get']),
('/orgs/{org}/members',['get']),
('/orgs/{org}/invitations',['get','post']),
('/users/{username}',['get']),
('/orgs/{org}/teams',['get','post']),
('/orgs/{org}/teams/{team_slug}/memberships/{username}',['put','get','delete']),
('/orgs/{org}/teams/{team_slug}/members',['get']),
('/orgs/{org}/repos',['post']),
('/repos/{owner}/{repo}',['get','patch','delete']),
('/repos/{owner}/{repo}/branches',['get']),
('/repos/{owner}/{repo}/collaborators',['get']),
('/repos/{owner}/{repo}/collaborators/{username}',['put','delete','get']),
('/repos/{owner}/{repo}/teams',['get']),
('/orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}',['put','delete']),
('/repos/{owner}/{repo}/branches/{branch}/protection',None),
('/repos/{owner}/{repo}/keys',['get','post']),
('/repos/{owner}/{repo}/keys/{key_id}',['get','delete']),
('/repos/{owner}/{repo}/environments',['get']),
('/repos/{owner}/{repo}/environments/{environment_name}',['get','put','delete']),
('/repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies',None),
('/repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies/{branch_policy_id}',None),
('/repos/{owner}/{repo}/contents/{path}',['get']),
('/repos/{owner}/{repo}/git/refs',None),
('/repos/{owner}/{repo}/git/refs/{ref}',None),
('/repos/{owner}/{repo}/git/trees',['post']),
('/repos/{owner}/{repo}/git/commits',['post']),
('/repos/{owner}/{repo}/pulls',None),
('/repos/{owner}/{repo}/pulls/{pull_number}',None),
('/repos/{owner}/{repo}/compare/{basehead}',['get']),
('/rate_limit',['get']),
('/repos/{owner}/{repo}/git/ref/{ref}',['get']),
('/repos/{owner}/{repo}/git/matching-refs/{ref}',['get']),
('/repos/{owner}/{repo}/git/commits/{commit_sha}',['get']),
('/repos/{owner}/{repo}/git/trees/{tree_sha}',['get']),
('/repos/{owner}/{repo}/git/blobs',['post']),
('/orgs/{org}/teams/{team_slug}',['get']),
('/orgs/{org}/outside_collaborators',['get']),
('/orgs/{org}/invitations/{invitation_id}',['delete']),
('/repos/{owner}/{repo}/invitations',['get']),
('/app',['get']),('/apps/{app_slug}',['get']),
('/repos/{owner}/{repo}/installation',['get']),
('/orgs/{org}/installation',['get']),
('/installation/repositories',['get']),
('/orgs/{org}/memberships/{username}',['get']),
('/orgs/{org}/failed_invitations',['get']),
]
pref=['/repos/{owner}/{repo}/actions/variables','/repos/{owner}/{repo}/environments/{environment_name}/variables','/orgs/{org}/actions/variables','/repos/{owner}/{repo}/actions/secrets','/repos/{owner}/{repo}/environments/{environment_name}/secrets','/orgs/{org}/actions/secrets','/repos/{owner}/{repo}/hooks','/orgs/{org}/hooks']
out={}
missing=[]
for p,m in exact:
    if p not in P: missing.append(p);continue
    out[p]={k:v for k,v in P[p].items() if (m is None or k in m or k in('parameters','summary','description','servers'))}
for p in P:
    if any(p==x or p.startswith(x+'/') for x in pref): out[p]=P[p]
print('missing',missing)
spec={k:v for k,v in d.items() if k not in('paths','components','webhooks','x-webhooks')}
spec['paths']=out
comp=d['components']
need={}
seen=set()
def walk(o):
    if isinstance(o,dict):
        for k,v in o.items():
            if k=='$ref' and isinstance(v,str) and v.startswith('#/components/'):
                ref(v)
            else: walk(v)
    elif isinstance(o,list):
        for x in o: walk(x)
def ref(r):
    if r in seen: return
    seen.add(r)
    _,_,sec,name=r.split('/',3)
    walk(comp[sec][name])
walk(out)
nc={}
for r in seen:
    _,_,sec,name=r.split('/',3)
    nc.setdefault(sec,{})[name]=comp[sec][name]
for k in ('securitySchemes',):
    if k in comp: nc[k]=comp[k]
for s in nc: nc[s]=dict(sorted(nc[s].items()))
spec['components']=nc
spec['tags']=[t for t in d.get('tags',[])]
# drop unused top-level tags? keep
spec['info'] = dict(spec['info']); spec['info']['x-git-migrator-source']={'repository':'github/rest-api-description','commit':'2eba8c3ba02f022011539cf01efc43e0251502f8','path':'descriptions/api.github.com/api.github.com.json','retrieved':'2026-10-08','trimmed':True}
json.dump(spec,open(sys.argv[2],'w'),indent=1,sort_keys=False,ensure_ascii=False)
open(sys.argv[2],'a').write('\n')
print(len(out),{k:len(v) for k,v in nc.items()})
