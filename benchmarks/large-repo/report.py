import json,statistics as st,sys,collections
W=open('/tmp/jj-bench-path').read().strip()
rows=[json.loads(l) for l in open(f'{W}/results/flows.jsonl')]
# Rerun rows replace earlier rows for the same repo and flow.
rerun={(r['repo'],r['flow']) for r in rows if r.get('run')=='2'}
rows=[r for r in rows if r.get('run')=='2' or (r['repo'],r['flow']) not in rerun]
g=collections.defaultdict(list)
for r in rows: g[(r['repo'],r['flow'])].append(r)
m=lambda xs,k:st.median(x.get(k) or 0 for x in xs)
def f(v): return f"{v:.0f}"
def row(repo,flow):
    xs=g.get((repo,flow))
    if not xs: return None
    w=[x['wall'] for x in xs]
    return dict(n=len(xs),wall=m(xs,'wall'),lo=min(w),hi=max(w),jj=m(xs,'jjUnion'),p=m(xs,'jjCount'),jjcpu=m(xs,'jjCpu'),ts=m(xs,'tsMs'),render=m(xs,'renderMs'),workers=m(xs,'workerCpu'),stall=max(x.get('maxStall') or 0 for x in xs),rss=max(x.get('hwm') or 0 for x in xs),ready=m(xs,'readyMs'),setSnap=m(xs,'setSnapshotMs'),preview=m(xs,'previewMs'),timeouts=sum(1 for x in xs if x.get('timedOut')),catch=m(xs,'catchUp'))
repos=sys.argv[1].split(',') if len(sys.argv)>1 else ['chain-400','lin-1k','lin-10k','jj','git','lin-100k','rust','lin-1m','linux']
flows=sys.argv[2].split(',') if len(sys.argv)>2 else ['startup','reload-default','reload-all','select-step','select-held45','search-default-open','search-all-open','search-all-type','search-all-accept','picker-open','picker-type']
for flow in flows:
    print(f'\n## {flow}')
    print('repo        n   wall [lo..hi]              jj(p)            jjcpu    ts  render workers maxstall   rss  extra')
    for repo in repos:
        r=row(repo,flow)
        if not r: continue
        extra=(f"ready={f(r['ready'])} " if flow=='startup' else '')+(f"catchup={f(r['catch'])} " if flow=='select-held45' else '')+(f"setSnap={r['setSnap']:.1f} " if r['setSnap'] else '')+(f"TIMEOUTS={r['timeouts']}" if r['timeouts'] else '')
        print(f"{repo:11}{r['n']:3} {f(r['wall']):>7} [{f(r['lo'])}..{f(r['hi'])}]".ljust(38)+f"{f(r['jj']):>7}({f(r['p'])}p) {f(r['jjcpu']):>7} {f(r['ts']):>6} {f(r['render']):>5} {f(r['workers']):>6} {f(r['stall']):>6} {f(r['rss']):>6}  {extra}")
idle=[r for r in rows if r['flow']=='idle']
print('\n## idle'); 
for r in idle: print(f"{r['repo']:11} polls={r['polls']} wall={r['pollWall']['median']:.0f} [{r['pollWall']['min']:.0f}..{r['pollWall']['max']:.0f}] pollcpu={r['pollCpu']['median']:.0f} jjcpu/s={r['jjCpuPerSec']:.1f} buncpu/s={r['bunCpuPerSec']:.1f}")
