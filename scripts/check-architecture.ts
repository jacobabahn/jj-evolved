import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "..");
const repository = resolve(root, "src/repository");
const publicFiles = new Set(["repository.ts", "model.ts"].map(file => resolve(repository, file)));
const graph = new Map<string, string[]>();
const errors: string[] = [];
const name = (file: string) => relative(root, file);

for await (const path of new Bun.Glob("src/**/*.ts").scan({ cwd: root })) {
  const file = resolve(root, path);
  const source = ts.createSourceFile(file, await Bun.file(file).text(), ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  function visit(node: ts.Node) {
    const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
      : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
    if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith(".")) {
      const target = resolve(dirname(file), specifier.text.replace(/\.ts$/, "") + ".ts");
      imports.push(target);
      if (dirname(file) !== repository && dirname(target) === repository && !publicFiles.has(target)) {
        errors.push(`${name(file)} imports repository implementation ${name(target)}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  graph.set(file, imports);
}

const visited = new Set<string>();
function check(file: string, stack: string[]) {
  if (stack.includes(file)) {
    errors.push(`Import cycle: ${[...stack.slice(stack.indexOf(file)), file].map(name).join(" -> ")}`);
    return;
  }
  if (visited.has(file)) return;
  visited.add(file);
  for (const target of graph.get(file) ?? []) {
    if (!graph.has(target)) errors.push(`${name(file)} imports missing module ${name(target)}`);
    else check(target, [...stack, file]);
  }
}
for (const file of graph.keys()) check(file, []);
if (errors.length) throw new Error(errors.join("\n"));
process.stdout.write(`Checked ${graph.size} modules: repository imports use its public interface; no missing modules or import cycles.\n`);
