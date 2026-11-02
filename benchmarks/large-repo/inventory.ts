// @ts-nocheck
import { readdirSync, readFileSync } from "node:fs";
import { W, jj, sh, save } from "./lib";
for (const name of readdirSync(`${W}/repos`).sort()) {
  const repo = `${W}/repos/${name}`;
  const t = Date.now();
  jj(repo, "status");                // settles the working copy once before anything is timed
  const stats = jj(repo, "--ignore-working-copy", "debug", "index");
  const commits = Number(/Number of commits: (\d+)/.exec(stats)?.[1] ?? -1);
  const files = jj(repo, "--ignore-working-copy", "file", "list").split("\n").length - 1;
  const bookmarks = jj(repo, "--ignore-working-copy", "bookmark", "list", "--all-remotes", "-T", '"x\n"').split("\n").length - 1;
  const tags = jj(repo, "--ignore-working-copy", "tag", "list", "-T", '"x\n"').split("\n").length - 1;
  const ops = jj(repo, "--ignore-working-copy", "op", "log", "--no-graph", "-T", '"x\n"').split("\n").length - 1;
  const defaultRows = jj(repo, "--ignore-working-copy", "log", "--no-graph", "--limit", "1000", "-T", '"x\n"').split("\n").length - 1;
  const trunk = jj(repo, "--ignore-working-copy", "log", "--no-graph", "-r", "trunk()", "-T", 'commit_id ++ " " ++ change_id.shortest()').trim();
  const row = { name, commits, files, bookmarks, tags, ops, defaultRows, trunk, setupMs: Date.now() - t };
  save("inventory.jsonl", row); console.log(JSON.stringify(row));
}
