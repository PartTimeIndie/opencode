import fs from "node:fs"
import path from "node:path"
import ts from "typescript"
import { isBuiltin } from "node:module"

/** Enforce package boundaries before release, including type-only imports. */
export function auditPluginSources(directory: string) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"))
  const declared = new Set(Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }))
  const failures: string[] = []
  const visit = (folder: string) => fs.readdirSync(folder, { withFileTypes: true }).forEach((entry) => {
    if (["dist", "node_modules", "test", "tests", "script", "scripts", ".git"].includes(entry.name)) return
    const filename = path.join(folder, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Plugin source symlink: ${filename}`)
    if (entry.isDirectory()) return visit(filename)
    if (!/\.[cm]?[jt]sx?$/.test(entry.name) || /\.(test|spec)\./.test(entry.name)) return
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true)
    const check = (specifier: string) => {
      if (specifier.startsWith(".")) {
        const relative = path.relative(directory, path.resolve(path.dirname(filename), specifier))
        if (relative === ".." || relative.startsWith(`..${path.sep}`)) failures.push(`${filename}: import escapes package: ${specifier}`)
        return
      }
      if (isBuiltin(specifier) || /^bun(?::|$)/.test(specifier)) return
      if (/^(?:@\/|@opencode-ai\/(?:core|app|opencode|tui)(?:\/|$)|file:|[A-Za-z]:|\/)/.test(specifier)) {
        failures.push(`${filename}: private host import: ${specifier}`)
        return
      }
      const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]
      if (!declared.has(name) && name !== manifest.name) failures.push(`${filename}: undeclared dependency: ${specifier}`)
    }
    const inspect = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) check(node.moduleSpecifier.text)
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) check(node.argument.literal.text)
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) check(node.arguments[0].text)
      ts.forEachChild(node, inspect)
    }
    inspect(source)
  })
  visit(directory)
  if (failures.length) throw new Error(failures.join("\n"))
  return manifest.name as string
}

if (import.meta.main) process.argv.slice(2).forEach(directory => console.log(auditPluginSources(path.resolve(directory))))
