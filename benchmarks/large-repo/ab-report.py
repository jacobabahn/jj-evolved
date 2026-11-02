import json,statistics as st,collections
W=open('/tmp/jj-bench-path').read().strip()
rows=[json.loads(l) for l in open(f'{W}/results-ab/flows.jsonl')]
g=collections.defaultdict(list)
for r in rows: g[(r['repo'],r['flow'],r['mode'])].append(r)
keys=sorted({(a,b) for a,b,_ in g})
def rng(xs): 
    w=[x['wall'] for x in xs]; return f"{st.median(w):.0f} [{min(w):.0f}-{max(w):.0f}]"
print("repo flow | n | off wall | on wall | ratio | on: jj-bucket/ts/render | stall off/on | cli-procs on | helper rss | bun rss off/on | timeouts")
for k in keys:
    a,b=g.get(k+('off',)),g.get(k+('on',))
    if k[1]=='idle' or not a or not b: continue
    m=lambda xs,f:st.median(x.get(f) or 0 for x in xs)
    cli=st.median(sum(1 for p in x.get('procs',[]) if not p['args'].startswith('helper:')) for x in b)
    ratio=m(b,'wall')/max(m(a,'wall'),1)
    print(f"{k[0]:10} {k[1]:30} n={len(a)}/{len(b)} {rng(a):>24} {rng(b):>24} x{ratio:.2f}  {m(b,'jjUnion'):.0f}/{m(b,'tsMs'):.0f}/{m(b,'renderMs'):.0f} stall {max(x.get('maxStall',0) for x in a):.0f}/{max(x.get('maxStall',0) for x in b):.0f} cli={cli:.0f} hrss={max(x.get('helperHwm',0) or 0 for x in b):.0f} rss={max(x.get('hwm',0) or 0 for x in a):.0f}/{max(x.get('hwm',0) or 0 for x in b):.0f} to={sum(1 for x in a if x.get('timedOut'))}/{sum(1 for x in b if x.get('timedOut'))}")
print()
for r in rows:
    if r['flow']=='idle': print(r['repo'],r['mode'],'polls',r['polls'],'wall',r['pollWall']['median'],'cpu',r['pollCpu']['median'],'jjcpu/s %.1f'%r['jjCpuPerSec'],'hrss',round(r.get('helperHwm') or 0))
