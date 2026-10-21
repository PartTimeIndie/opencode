#!/usr/bin/env bun
import { readdir } from "node:fs/promises"
import { join } from "node:path"

const root = join(import.meta.dirname, "..", "out")
const preload = Bun.file(join(root, "preload", "speech-overlay.js"))
const overlay = Bun.file(join(root, "renderer", "speech-overlay.html"))
if (!(await preload.exists())) throw new Error("Speech overlay preload is missing from the desktop bundle.")
if (!(await overlay.exists())) throw new Error("Speech overlay HTML is missing from the desktop bundle.")

const html = await overlay.text()
for (const reference of [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((match) => match[1])) {
  if (!(await Bun.file(join(root, "renderer", reference)).exists())) {
    throw new Error(`Speech overlay asset is missing from the desktop bundle: ${reference}`)
  }
}

const main = await bundleText(join(root, "main"))
for (const marker of ["desktop-service-register", "desktop-service-insert-text", "SendInput", "speech-overlay.html"]) {
  if (!main.includes(marker)) throw new Error(`Desktop speech service bundle marker is missing: ${marker}`)
}

const preloadText = await preload.text()
if (!preloadText.includes("speech-overlay-state")) throw new Error("Speech overlay preload does not subscribe to state updates.")
if (html.toLowerCase().includes("transcript")) throw new Error("Speech overlay markup must not contain transcript preview UI.")

console.log("verified desktop speech service helper, IPC, preload, and privacy-safe overlay bundle")

async function bundleText(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true })
  return (
    await Promise.all(
      entries.map((entry) => {
        const file = join(directory, entry.name)
        if (entry.isDirectory()) return bundleText(file)
        if (!entry.isFile() || !entry.name.endsWith(".js")) return ""
        return Bun.file(file).text()
      }),
    )
  ).join("\n")
}
