// Sidebar for `bun run compare`: live counts of keys sent and jj processes started by the app.
// Usage: bun tooling/terminal-monitor.ts <jj-log> <key-log>
import { jjCommand, parseJjLog } from "./terminal-compare";

const [jjLog, keyLog] = process.argv.slice(2);
if (!jjLog || !keyLog) { console.error("Usage: bun tooling/terminal-monitor.ts <jj-log> <key-log>"); process.exit(1); }
const bold = (text: string) => `\u001b[1m${text}\u001b[0m`;
const read = async (path: string) => { try { return await Bun.file(path).text(); } catch { return ""; } };
const short = (args: string) => args
  .replace(/--(ignore-working-copy|no-pager|color=never|at-op=@|config ui\.log-word-wrap=false) ?/g, "")
  .replace(/[0-9a-f]{40,64}/g, "<id>").trim().slice(0, 30);

process.stdout.write("\u001b[?25l");
setInterval(async () => {
  const calls = parseJjLog(await read(jjLog));
  const keys = (await read(keyLog)).split("\n").filter(Boolean).length;
  const now = Date.now();
  const lines = [
    bold(`keys sent  ${String(keys).padStart(5)}`), "",
    bold("jj processes"),
    ` total      ${String(calls.length).padStart(5)}`,
    ` last 10s   ${String(calls.filter(call => now - call.at <= 10_000).length).padStart(5)}`,
    ` jj diff    ${String(calls.filter(call => jjCommand(call.args) === "diff").length).padStart(5)}`, "",
    bold("recent"),
    ...calls.slice(-14).map(call => ` ${short(call.args)}`),
  ];
  process.stdout.write(`\u001b[H\u001b[2J${lines.join("\n")}`);
}, 200);
