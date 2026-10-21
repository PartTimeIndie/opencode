import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { prepareExternalRelease, readExternalRelease, readExternalReleaseReceipt, createManifest, verifyPreparedArtifact } from "../script/desktop-prod-deploy"
import { installReleaseFiles, rollbackReleaseFiles, verifyReleaseFiles } from "../script/desktop-release-files"

test("pins the external release into the complete desktop artifact and preserves rollback data", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-plugin-release-"))
  try {
    const source = path.join(root, "new-plugin.js")
    const target = path.join(root, "installed-plugin.js")
    const descriptor = path.join(root, "input.json")
    fs.writeFileSync(source, "new plugin")
    fs.writeFileSync(target, "old plugin")
    fs.writeFileSync(descriptor, JSON.stringify({ entries: [{ source, target }], packages: [] }))
    const release = prepareExternalRelease(descriptor, path.join(root, "transaction"))!
    expect(fs.readFileSync(target, "utf8")).toBe("old plugin")
    const manifest = readExternalRelease(release)
    verifyReleaseFiles(manifest)
    const stage = path.join(root, "app")
    fs.mkdirSync(stage)
    fs.writeFileSync(path.join(stage, ".opencode-plugin-release.json"), JSON.stringify(release))
    const build = createManifest(stage, "test-build", "test-source")
    fs.writeFileSync(path.join(stage, ".opencode-build-manifest.json"), JSON.stringify(build))
    expect(verifyPreparedArtifact(stage, build).buildID).toBe("test-build")
    const receipt = installReleaseFiles(manifest)
    expect(fs.readFileSync(target, "utf8")).toBe("new plugin")
    expect(readExternalReleaseReceipt(release)).toEqual(receipt)
    const receiptFile = path.join(manifest.directory, "receipt.json")
    const tampered = structuredClone(receipt)
    tampered.manifest.entries[0]!.sha256 = "f".repeat(64)
    fs.writeFileSync(receiptFile, JSON.stringify(tampered))
    expect(() => readExternalReleaseReceipt(release)).toThrow("pinned manifest")
    expect(fs.readFileSync(target, "utf8")).toBe("new plugin")
    fs.writeFileSync(receiptFile, JSON.stringify(receipt))
    rollbackReleaseFiles(receipt)
    expect(fs.readFileSync(target, "utf8")).toBe("old plugin")
    fs.appendFileSync(release.externalManifestPath, " ")
    expect(() => readExternalRelease(release)).toThrow("manifest changed")
    fs.appendFileSync(path.join(stage, ".opencode-plugin-release.json"), " ")
    expect(() => verifyPreparedArtifact(stage, build)).toThrow("manifest")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("an external target changed after prepare blocks before installation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-plugin-release-"))
  try {
    const source = path.join(root, "candidate.json")
    const target = path.join(root, "config.json")
    const descriptor = path.join(root, "input.json")
    fs.writeFileSync(source, "candidate")
    fs.writeFileSync(target, "original")
    fs.writeFileSync(descriptor, JSON.stringify({ entries: [{ source, target }], packages: [] }))
    expect(() => prepareExternalRelease(descriptor, path.join(root, "overlap"), root)).toThrow("overlaps the application")
    expect(fs.existsSync(path.join(root, "overlap"))).toBe(false)
    const release = prepareExternalRelease(descriptor, path.join(root, "transaction"))!
    fs.writeFileSync(target, "new user work")
    expect(() => verifyReleaseFiles(readExternalRelease(release))).toThrow("changed since preparation")
    expect(fs.readFileSync(target, "utf8")).toBe("new user work")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
