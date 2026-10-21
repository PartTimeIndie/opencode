import ts from "typescript"
import path from "node:path"

export function auditSource(source: string, filename: string) {
  const suffix = auditExport(source)
  if (!suffix) return
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const replacements = file.statements
    .flatMap((node) => {
      if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) return []
      const specifier = node.moduleSpecifier
      if (!specifier || !ts.isStringLiteral(specifier)) return []
      const resolved = Bun.resolveSync(specifier.text, path.dirname(filename))
      return [
        { start: specifier.getStart(file), end: specifier.end, text: JSON.stringify(resolved.replaceAll("\\", "/")) },
      ]
    })
    .sort((a, b) => b.start - a.start)
  const rewritten = replacements.reduce(
    (text, item) => text.slice(0, item.start) + item.text + text.slice(item.end),
    source,
  )
  return rewritten + suffix
}

// Read the existing Tool.make's static contract; do not approximate schemas from text.
// Dynamic closure-owned expressions are explicitly left unmeasured.
export function auditExport(source: string) {
  const file = ts.createSourceFile("tool.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const globals = new Set(
    file.statements.flatMap((node) =>
      ts.isVariableStatement(node)
        ? node.declarationList.declarations.flatMap((item) => (ts.isIdentifier(item.name) ? [item.name.text] : []))
        : [],
    ),
  )
  const candidates: string[] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(file) === "Tool.make" &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const fields = node.arguments[0].properties.flatMap((property) => {
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return []
        const key = property.name.getText(file)
        if (!["input", "inputSchema", "output", "description"].includes(key)) return []
        const expression = ts.isPropertyAssignment(property) ? property.initializer : property.name
        const safe =
          ts.isStringLiteral(expression) ||
          ts.isNoSubstitutionTemplateLiteral(expression) ||
          (ts.isIdentifier(expression) && globals.has(expression.text))
        return safe ? [`${key}: ${expression.getText(file)}`] : []
      })
      if (fields.some((field) => field.startsWith("input:"))) candidates.push(`{${fields.join(",")}}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return candidates.length === 1 ? `\nexport const __contextAudit = ${candidates[0]}\n` : undefined
}
