# jj-evolved-helper protocol

A long-lived, strictly read-only process that embeds jj through `jj-cli`/`jj-lib`, so hot reads skip spawning `jj`.
The contract is **fidelity**: a successful response's payload is byte-identical to the stdout of the `jj` command listed
for that request. The TypeScript parsers do not change, and the difference can be tested directly.

## Invariants

- Never writes to the repository: no snapshot, no transaction, no operation merge, no working-copy update.
- Any failure is reported as `ok: false`, and the client re-runs the read through the CLI. The CLI therefore stays the
  only source of user-visible errors, including invalid revsets, and the helper never needs to reproduce their text.
- Exits on stdin EOF, so it cannot outlive the app.
- Killing it at any moment is safe. Timeout and cancellation are implemented by killing it.

## Launch

    jj-evolved-helper --repository <root> --ignore-working-copy --at-op=@ --no-pager --color=never \
      --config ui.log-word-wrap=false serve

## Framing

Client to helper: one JSON object per line. Helper to client: one JSON header line, then exactly `len` raw payload
bytes, then nothing else. Requests are answered strictly in order, one at a time. Concurrency comes from running more
than one process. Stderr is not part of the protocol.

The first output is an unsolicited header, with no payload:

    {"ready":true,"jjVersion":"0.45.1","protocol":1,"len":0}

Failure to start: `{"ready":false,"error":"...","len":0}`, then exit.

Response: `{"id":<id>,"ok":true,"len":<n>}` or `{"id":<id>,"ok":false,"error":"<text>","len":0}`.

## Requests

Every request has `id` (integer) and `kind`. `op` is optional: omitted or `"@"` means the current head operation; an
operation ID is served only if it equals the current head, otherwise `ok: false`.

| kind | fields | Payload is byte-identical to stdout of |
|---|---|---|
| `opId` | | `jj --ignore-working-copy --at-op=@ op log --no-graph --limit 1 -T id` (trimmed by the caller) |
| `log` | `revset`, `template`, `limit?`, `graph` | `jj --ignore-working-copy --at-op=<op> log [--no-graph] [--limit <limit>] -r <revset> -T <template>` with `ui.log-word-wrap=false` |
| `diff` | `commitId`, `paths` (fileset strings) | `jj --ignore-working-copy --at-op=@ diff --revision <commitId> --git -- <paths>` |
| `files` | `commitId`, `template` | `jj --ignore-working-copy diff -r <commitId> -T <template>` |
| `bookmarks` | `template` | `jj --ignore-working-copy --at-op=@ bookmark list --all-remotes -T <template>` |
| `tags` | `template` | `jj --ignore-working-copy --at-op=@ tag list -T <template>` |
| `remotes` | | `jj --ignore-working-copy git remote list` |

## Freshness

Before each request, read the op heads directly. Exactly one head equal to the cached one: reuse the cached workspace
state, including the short-prefix index. One different head: reload. More than one head: `ok: false`, so the CLI handles
it. Config is captured at launch, so a change to any config file the helper read, or could read, must make it exit; the
client restarts it on the next read. Remotes are the exception: they live in Git config, which changes without a new
operation, so `remotes` reopens the Git repository on every request.
