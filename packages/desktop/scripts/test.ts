import { resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const files = (
  await Promise.all(
    ["**/*.test.ts", "**/*.test.tsx"].map((pattern) =>
      Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: root, absolute: true, onlyFiles: true })),
    ),
  )
)
  .flat()
  .sort()

for (const file of files) {
  const test = Bun.spawn([process.execPath, "test", file], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = await test.exited
  if (code !== 0) process.exit(code)
}
