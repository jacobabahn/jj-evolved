#!/bin/bash
W=$(cat /tmp/jj-bench-path); cd $W/scripts
for r in chain-400 lin-10k lin-100k jj git lin-1m rust linux; do
  RUN=2 bun run flows.ts $r search-all,picker >> $W/results/flows2-$r.log 2>&1
done
RUN=2 bun run flows.ts lin-1k startup,idle,reload-default,reload-all >> $W/results/flows2-lin-1k.log 2>&1
bun run micro.ts > $W/results/micro.log 2>&1
python3 -I trace.py lin-1k lin-1m br-50k rust linux > $W/results/trace.log 2>&1
pgrep -fc "[s]cripts/preload.ts" > $W/results/stale-after-queue2.txt
echo done > $W/results/queue2.done
