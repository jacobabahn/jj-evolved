## Screenshots on UI pull requests

- When a change affects what the app shows, put before/after screenshots in the PR description, as #102–#108, #112 and #115 do. Render them with the scenario tooling in `docs/ui-tooling.md` (`tooling/render.ts`, with `--gif` when motion matters). If no scenario shows the change, add or extend one in `tooling/scenarios.ts`. Take Before from the base branch and After from the task's branch, usually at 80x24. Alt text names the state and size, e.g. `![Before: bookmarks at 80x24](...)`.
- Upload them with `gh pr create --attach '<file>#<alt text>'` (or `gh pr edit <N> --attach`), and use the exact same path string in the body's `![alt](path)`. Never commit images or push an asset branch for them.
- A change with no visible effect needs no screenshots; say so in the PR description.
