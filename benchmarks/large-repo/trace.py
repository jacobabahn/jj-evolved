import json,subprocess,sys,os
W=open('/tmp/jj-bench-path').read().strip()
env={**os.environ,"JJ_CONFIG":f"{W}/jj-config.toml"}
RO=["--ignore-working-copy","--at-op=@"]
cmds={"null":RO+["log","--no-graph","-r","none()","-T",'""'],"poll":["op","log","--no-graph","--limit","1","-T","id"]}
for repo in sys.argv[1:]:
  for label,args in cmds.items():
    f=f"{W}/results/trace-{repo}-{label}.json"
    subprocess.run(["jj","--no-pager","--color=never",*args],cwd=f"{W}/repos/{repo}",env={**env,"JJ_TRACE":f},stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    raw=open(f).read().rstrip().rstrip(',')
    ev=json.loads(raw if raw.endswith(']') else raw+']')
    spans=[]; st={}
    for e in ev:
        k=(e.get('tid'),e.get('name'))
        if e.get('ph')=='B': st.setdefault(k,[]).append(e['ts'])
        elif e.get('ph')=='E' and st.get(k): spans.append((e['ts']-st[k].pop(),e['name']))
        elif e.get('ph')=='X': spans.append((e.get('dur',0),e['name']))
    agg={}
    for d,n in spans: agg[n]=agg.get(n,0)+d
    print(repo,label,[(n,round(d/1000,1)) for n,d in sorted(agg.items(),key=lambda x:-x[1])[:12]])
