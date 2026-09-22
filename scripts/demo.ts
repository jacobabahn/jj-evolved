import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!Bun.which("jj")) {
  process.stderr.write("Install Jujutsu first: jj must be on PATH.\n");
  process.exit(1);
}
const directory = await mkdtemp(join(tmpdir(), "jj-evolved-demo-"));
async function jj(...args: string[]) {
  const proc = Bun.spawn(["jj", "--no-pager", "--color=never", ...args], {
    cwd: directory, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, JJ_CONFIG: "", JJ_USER: "Demo Developer", JJ_EMAIL: "demo@example.com" },
  });
  const [, error, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (code !== 0) throw new Error(error);
}
try {
  await jj("git", "init");
  await jj("config", "set", "--repo", "user.name", "Demo Developer");
  await jj("config", "set", "--repo", "user.email", "demo@example.com");
  await Bun.write(join(directory, "README.md"), "# A small jj workspace\n\nBrowse revisions with j and k.\n");
  await jj("describe", "-m", "Start the workspace");
  await jj("bookmark", "create", "main");
  async function change({ parents, description, files, bookmarks }: {
    parents: string[];
    description: string;
    files: Record<string, string>;
    bookmarks: string[];
  }) {
    await jj("new", ...parents, "-m", description);
    for (const [path, content] of Object.entries(files)) await Bun.write(join(directory, path), content);
    if (bookmarks.length) await jj("bookmark", "create", ...bookmarks);
  }
  await change({
    parents: ["main"], description: "Add a greeting", bookmarks: ["greeting"],
    files: { "hello.ts": 'export const greeting = "Hello, Jujutsu!";\n' },
  });
  await change({
    parents: ["greeting"], description: "Polish the greeting", bookmarks: ["greeting-polish", "ready-for-review"],
    files: { "hello.ts": 'export const greeting = "Hello from jj-evolved!";\n' },
  });
  await change({
    parents: ["main"], description: "Document the keyboard controls", bookmarks: ["docs"],
    files: { "docs/controls.md": "# Controls\n\nj/k: browse changes\nR: rebase a change\nS: squash changes\n" },
  });
  await change({
    parents: ["docs"], description: "Explain drag and drop", bookmarks: ["docs-drag"],
    files: { "docs/controls.md": "# Controls\n\nj/k: browse changes\nR: rebase a change\nS: squash changes\n\nDrag a change onto another change to preview a rebase.\nDrag a bookmark label to move just that bookmark.\n" },
  });
  await change({
    parents: ["main"], description: "Add command-line options", bookmarks: ["cli"],
    files: { "options.ts": 'export const options = { color: true, verbose: false };\n' },
  });
  await change({
    parents: ["cli"], description: "Support verbose output", bookmarks: ["cli-verbose"],
    files: {
      "options.ts": 'export const options = { color: true, verbose: true };\n',
      "logging.ts": 'export function log(message: string) {\n  console.log(message);\n}\n',
    },
  });
  await change({
    parents: ["cli-verbose"], description: "Document CLI usage", bookmarks: ["cli-ready"],
    files: { "docs/cli.md": "# CLI usage\n\nEnable verbose output to inspect each operation.\n" },
  });
  await change({
    parents: ["greeting-polish", "docs-drag"], description: "Merge greeting and documentation", bookmarks: ["integration"],
    files: {},
  });
  await change({
    parents: ["greeting"], description: "Try an alternative greeting", bookmarks: ["greeting-alternative"],
    files: { "hello.ts": 'export const greeting = "Welcome to the workspace!";\n' },
  });
  await change({
    parents: ["greeting-polish", "greeting-alternative"], description: "Conflicting greeting proposals", bookmarks: ["greeting-conflict"],
    files: {},
  });
  await change({
    parents: ["integration"], description: "Prepare a release", bookmarks: [],
    files: { "CHANGELOG.md": "# Next release\n\n- Friendlier greeting\n- Keyboard and mouse documentation\n\nStill to review: CLI options and alternative greeting.\n" },
  });
  await change({
    parents: ["@"],
    description: "Try multiline descriptions\n\nPress d on this change to edit its description in the app.\nPress Shift+Enter (or Alt+Enter) for newlines, then Enter to save.\n\nThis final paragraph lets you check that blank lines are preserved.",
    bookmarks: ["multiline-demo"],
    files: { "docs/descriptions.md": "# Multiline descriptions\n\nPress d to edit a description. Shift+Enter or Alt+Enter adds a newline.\nEnter saves; Escape cancels. Space → Edit description in editor opens an external editor.\n" },
  });
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/index.ts"), directory], {
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  process.exitCode = await child.exited;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
