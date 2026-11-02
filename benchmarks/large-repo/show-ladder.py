import json,sys
W=open('/tmp/jj-bench-path').read().strip()
rows=[json.loads(l) for l in open(f'{W}/results/ladder.jsonl')]
repos=[]; cmds=[]
for r in rows:
    if r['repo'] not in repos: repos.append(r['repo'])
    if r['cmd'] not in cmds: cmds.append(r['cmd'])
d={(r['repo'],r['cmd']):r for r in rows}
print('cmd'.ljust(22)+''.join(x[:9].rjust(10) for x in repos))
for c in cmds:
    print(c.ljust(22)+''.join((f"{d[(x,c)]['median']:.0f}" if (x,c) in d and d[(x,c)]['median']>=20 else f"{d[(x,c)]['median']:.1f}" if (x,c) in d else '-').rjust(10) for x in repos))
print('spread (max/min) worst per repo:', {x: round(max(d[(x,c)]['max']/d[(x,c)]['min'] for c in cmds if (x,c) in d),2) for x in repos})
print('nonzero rc:', [(r['repo'],r['cmd']) for r in rows if r['code']])
