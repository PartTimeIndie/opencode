export function verifyBrowserControlBundle(sources: readonly string[]) {
  if (sources.some((source) => /playwright-core|chromium-bidi/.test(source))) {
    throw new Error("Desktop Browser control bundle contains a Playwright or chromium-bidi runtime dependency")
  }
  if (!sources.some((source) => /webContents\.fromId/.test(source))) {
    throw new Error("Desktop Browser control bundle does not resolve the exact Electron webContents")
  }
  if (!sources.some((source) => /executeJavaScript/.test(source))) {
    throw new Error("Desktop Browser control bundle does not contain the direct webContents execution path")
  }
  if (!sources.some((source) => source.includes("browser.snapshot"))) {
    throw new Error("Desktop Browser control actions are missing from the main bundle")
  }
}

if (import.meta.main) {
  const files = await Array.fromAsync(new Bun.Glob("**/*.js").scan({ cwd: "out/main", absolute: true }))
  const sources = await Promise.all(files.map((file) => Bun.file(file).text()))
  verifyBrowserControlBundle(sources)

  console.log(`verified Browser control in ${files.length} deployable main bundle files`)
}
