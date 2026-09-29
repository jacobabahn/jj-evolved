// Scripted keystrokes for `bun run compare`. Keys use tmux send-keys names (C-l is Ctrl+L)
// and target the default jjui key preset. Both sides of a comparison replay identical timing.
export type TerminalStep =
  | { keys: string[]; interval: number; label: string }
  | { wait: number };

export type TerminalScenario = {
  name: string;
  title: string;
  steps: TerminalStep[];
  /** Screen text whose appearances are counted, e.g. loading placeholders. */
  watch?: string[];
};

const repeat = (key: string, count: number) => Array.from({ length: count }, () => key);

export const terminalScenarios: TerminalScenario[] = [
  {
    name: "selection",
    title: "Hold j/k through 400 loaded revisions",
    steps: [
      { keys: ["C-l"], interval: 0, label: "load 200 more" }, { wait: 2500 },
      { keys: repeat("j", 45), interval: 30, label: "45 × j" }, { wait: 2500 },
      { keys: repeat("k", 45), interval: 30, label: "45 × k" }, { wait: 2500 },
    ],
  },
  {
    name: "diff-preview",
    title: "Step through revisions, then revisit them",
    watch: ["Loading diff"],
    steps: [
      { keys: repeat("j", 12), interval: 120, label: "12 × j (new rows)" }, { wait: 1000 },
      { keys: repeat("k", 12), interval: 250, label: "12 × k (revisit)" }, { wait: 1000 },
      { keys: repeat("j", 12), interval: 250, label: "12 × j (revisit)" }, { wait: 1500 },
    ],
  },
  {
    name: "idle-refresh",
    title: "Idle polling around an explicit refresh",
    steps: [{ wait: 9000 }, { keys: ["C-r"], interval: 0, label: "refresh" }, { wait: 9000 }],
  },
];
