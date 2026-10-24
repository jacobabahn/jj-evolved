import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const revsetHistoryLimit = 50;

/** Where successfully applied revsets are kept between sessions. */
export interface RevsetHistoryStore {
  load(): Promise<string[]>;
  /** Records an applied expression on top of the stored history, which another instance may have changed, and returns the result. */
  record(expression: string): Promise<string[]>;
}

/** Moves an applied expression to the front, without duplicates; empty input (the default revset) isn't recorded. */
export function recordRevset(entries: readonly string[], expression: string): string[] {
  const applied = expression.trim();
  if (!applied) return [...entries];
  return [applied, ...entries.filter(entry => entry !== applied)].slice(0, revsetHistoryLimit);
}

export function memoryRevsetHistory(initial: readonly string[] = []): RevsetHistoryStore {
  let entries = [...initial];
  return { load: async () => [...entries], record: async expression => [...(entries = recordRevset(entries, expression))] };
}

export function revsetHistoryPath() {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "jj-evolved", "revset-history.json");
}

type HistoryFile = { repositories: Record<string, string[]> };
async function readHistoryFile(path: string): Promise<HistoryFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const repositories = typeof parsed === "object" && parsed && "repositories" in parsed ? parsed.repositories : null;
    if (typeof repositories !== "object" || !repositories) return { repositories: {} };
    return { repositories: Object.fromEntries(Object.entries(repositories)
      .map(([root, entries]) => [root, Array.isArray(entries) ? entries.filter((entry): entry is string => typeof entry === "string") : []])) };
  } catch (error) {
    // A missing or unreadable history only costs suggestions; it never blocks the prompt.
    if (error instanceof SyntaxError || (error instanceof Error && "code" in error && error.code === "ENOENT")) return { repositories: {} };
    throw error;
  }
}

/** History for one repository, in a file shared by all repositories under the XDG state directory. */
export function fileRevsetHistory(root: string, path = revsetHistoryPath()): RevsetHistoryStore {
  return {
    async load() { return (await readHistoryFile(path)).repositories[root]?.slice(0, revsetHistoryLimit) ?? []; },
    async record(expression) {
      // Reading just before writing keeps entries other repositories and other app instances saved meanwhile.
      const { repositories } = await readHistoryFile(path);
      const entries = recordRevset(repositories[root]?.slice(0, revsetHistoryLimit) ?? [], expression);
      repositories[root] = entries;
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${crypto.randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify({ repositories }, null, 2)}\n`, { flag: "wx" });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
      return entries;
    },
  };
}
