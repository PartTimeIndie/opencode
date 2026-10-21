import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
const result = await Bun.build({
  entrypoints: ["./src/index.tsx"],
  outdir: "./dist",
  target: "bun",
  packages: "external",
  plugins: [createSolidTransformPlugin()],
})
if (!result.success) throw new AggregateError(result.logs, "Plugin build failed")
