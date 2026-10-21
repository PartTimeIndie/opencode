import path from "node:path"
import { existsSync } from "node:fs"

const directory = path.resolve(import.meta.dir, "../dist")
for await (const relative of new Bun.Glob("**/*.{js,d.ts}").scan(directory)) {
  const file = path.join(directory, relative)
  const content = await Bun.file(file).text()
  const updated = content.replace(/((?:from\s*|import\s*(?:\(\s*)?)["'])(\.[^"']+)(["'])/g, (match, before, specifier, after) => {
    if (path.extname(specifier)) return match
    const target = path.resolve(path.dirname(file), specifier)
    const normalized = existsSync(`${target}.js`) ? `${specifier}.js` : existsSync(path.join(target, "index.js")) ? `${specifier}/index.js` : undefined
    if (!normalized) throw new Error(`Unresolved public LLM import ${specifier} in ${relative}`)
    return before + normalized + after
  })
  if (updated !== content) await Bun.write(file, updated)
}
