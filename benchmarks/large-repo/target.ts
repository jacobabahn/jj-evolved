// @ts-nocheck
import { W, jj, save } from "./lib";
import { writeFileSync } from "node:fs";
const list = [["git","bf5ce434db6234fb6cd86935a553263c16f890ce"],["rust","3fba180bb74610ef2fb44d5dfb18d385e2e1534a"],["linux","4532e525b286328b33c2be592406464f4e671689"]].map(([repo, big]) => {
  const small = jj(`${W}/repos/${repo}`, "--ignore-working-copy", "log", "--no-graph", "--limit", "1", "-r", `${big}+`, "-T", "commit_id").trim();
  return { repo, label: `${repo}-largest`, big, small };
});
writeFileSync(`${W}/results/targets.json`, JSON.stringify(list)); console.log(list);
