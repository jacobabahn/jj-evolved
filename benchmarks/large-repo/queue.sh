#!/bin/bash
W=$(cat /tmp/jj-bench-path); cd $W/scripts
for r in chain-400 lin-1k lin-10k lin-100k jj git lin-1m rust linux; do
  bun run flows.ts $r >> $W/results/flows-$r.log 2>&1
done
for r in files-10k files-100k files-300k br-1k br-10k br-50k stack-100 stack-1k stack-5k stack-20k; do
  bun run flows.ts $r startup,idle,reload-default,reload-all,select >> $W/results/flows-$r.log 2>&1
done
echo queue done > $W/results/queue.done
