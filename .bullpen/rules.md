## Screenshots on UI pull requests

- When a change affects what the app shows, put before/after screenshots in the PR description, as #102–#108, #112 and #115 do. Render them with the scenario tooling in `docs/ui-tooling.md` (`tooling/render.ts`, with `--gif` when motion matters). If no scenario shows the change, add or extend one in `tooling/scenarios.ts`. Take Before from the base branch and After from the task's branch, usually at 80x24. Alt text names the state and size, e.g. `![Before: bookmarks at 80x24](...)`.
- Upload them with `gh pr create --attach '<file>#<alt text>'` (or `gh pr edit <N> --attach`), and use the exact same path string in the body's `![alt](path)`. Never commit images or push an asset branch for them.
- A change with no visible effect needs no screenshots; say so in the PR description.

## Worker model and effort

- This rule is for the coordinator, which starts workers; a worker can't choose its own model, so workers and reviewers have nothing to do here.
- Code tasks (the result is a change to the app's code or tests) run on Claude Opus 5.5 (`claude-opus-5-5`) at high effort. Every other task (docs, rules, reports, audits, investigations) runs on Claude Opus 5.5 at medium effort.
- Model: the repository's `worker_model` setting is already `claude-opus-5-5`; a task can also be given it with `bullpen add --model` or `bullpen model <ID>`.
- Effort: bullpen has no setting for it. Right after `bullpen start <ID>`, and again after `bullpen resume`, type `/effort high` or `/effort medium` into the worker's pane: `rex send -b <block> '/effort high'`, then `rex send-key -b <block> enter` (`bullpen show <ID>` prints the block).
