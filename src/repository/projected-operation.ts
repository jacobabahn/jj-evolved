import { run } from "./jj-process";

export async function projectOperation(root: string, operationId: string, args: string[]) {
  const output = await run(root, ["--at-op", operationId, "--no-integrate-operation", ...args], true);
  const announcement = /Operation left uncommitted because --no-integrate-operation was requested: ([0-9a-f]+)/;
  const projectedOperation = output.match(announcement)?.[1];
  if (!projectedOperation && !output.includes("Nothing changed.")) {
    throw new Error("jj did not return a preview operation ID. Cannot inspect the result.");
  }
  return { operationId: projectedOperation || operationId, diagnostics: output.replace(announcement, "").trim() };
}
