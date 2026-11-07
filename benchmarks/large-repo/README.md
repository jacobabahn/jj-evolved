# Large-repository benchmark harness

Measures jj-evolved on large repositories: the real app in tmux with real keystrokes, timed from outside the product
code. Nothing here is imported by `src/`. Files carry `// @ts-nocheck` because `tsconfig.json` has no `include`.

Setup: a work directory outside the repo, with its path in `/tmp/jj-bench-path`, holding `app-ab/` (a copy of the app
with `node_modules`), `helper-bin/jj-evolved-helper` (stripped release build), `repos/`, `results/targets.json`,
`results-ab/`, `scripts-ab/` (these files), `xdg/`, `tmp/` and `jj-config.toml`. `gen.py <work>` makes the synthetic
repos, with their Git refs packed as a real clone has them; real repos come from `jj git clone`. A work directory made
before refs were packed needs `git pack-refs --all` in each colocated repo, or its snapshot times are not comparable.

Run `queue-ab.ts` from `scripts-ab/`: every target runs with the helper off and on, alternating which goes first. Then
`ab-report.py` tabulates `results-ab/flows.jsonl`.

`preload.ts` wraps `Bun.spawn`, OpenTUI's render calls and app prototypes. A helper request counts as one span, from the
line written to the frame received, so the `jj` bucket means CLI or helper time, not spawned processes. `ab-report.py`
shows how many CLI processes remained. Main-thread CPU comes from `/proc/<pid>/task/<pid>/schedstat`, read from outside.

Limits: a process exit is observed on the main thread, so a blocked main thread inflates the `jj` bucket. "TS" is
main-thread CPU minus frame time, so OpenTUI work outside frames lands there. `queue-ab.ts` commits to and restores the
rust and linux bench repos for rebase previews, so never point the harness at a repository you care about.
