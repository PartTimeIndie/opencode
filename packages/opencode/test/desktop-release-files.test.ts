import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { installReleaseFiles, parseReleaseFiles, parseReleaseFilesReceipt, prepareReleaseFiles, rollbackReleaseFiles, verifyReleaseFiles } from "../script/desktop-release-files"

function fixture(directory: string) {
  const source = path.join(directory,"sources")
  const target = path.join(directory,"installed")
  fs.mkdirSync(source)
  fs.mkdirSync(target)
  fs.mkdirSync(path.join(source,"plugin"))
  fs.mkdirSync(path.join(target,"plugin"))
  fs.writeFileSync(path.join(source,"plugin","index.js"),"new plugin")
  fs.writeFileSync(path.join(target,"plugin","index.js"),"old plugin")
  fs.writeFileSync(path.join(source,"config.json"),'{"new":true}')
  fs.writeFileSync(path.join(target,"config.json"),'{"old":true}')
  return {source,target,manifest:prepareReleaseFiles({directory:path.join(directory,"transaction"),entries:[
    {source:path.join(source,"plugin"),target:path.join(target,"plugin")},
    {source:path.join(source,"config.json"),target:path.join(target,"config.json")},
    {source:path.join(source,"plugin"),target:path.join(target,"new-plugin")},
  ]})}
}

test("snapshots and restores whole external plugin directories and configuration files",async () => {
  await using directory = await tmpdir()
  const f = fixture(directory.path)
  fs.writeFileSync(path.join(f.source,"plugin","index.js"),"later source edits")
  verifyReleaseFiles(f.manifest)
  const receipt = installReleaseFiles(f.manifest)
  expect(fs.readFileSync(path.join(f.target,"plugin","index.js"),"utf8")).toBe("new plugin")
  expect(fs.readFileSync(path.join(f.target,"config.json"),"utf8")).toBe('{"new":true}')
  expect(fs.readFileSync(path.join(f.manifest.entries[0].backup,"index.js"),"utf8")).toBe("old plugin")
  expect(fs.existsSync(path.join(f.target,"new-plugin"))).toBe(true)
  const restored = rollbackReleaseFiles(receipt)
  expect(restored.status).toBe("rolled-back")
  expect(fs.readFileSync(path.join(f.target,"plugin","index.js"),"utf8")).toBe("old plugin")
  expect(fs.readFileSync(path.join(f.target,"config.json"),"utf8")).toBe('{"old":true}')
  expect(fs.existsSync(path.join(f.target,"new-plugin"))).toBe(false)
  expect(rollbackReleaseFiles(restored).status).toBe("rolled-back")
})

test("preflights every baseline before any installation mutation",async () => {
  await using directory = await tmpdir()
  const f = fixture(directory.path)
  fs.writeFileSync(path.join(f.target,"config.json"),"user changed configuration")
  expect(() => installReleaseFiles(f.manifest)).toThrow("changed since preparation")
  expect(fs.readFileSync(path.join(f.target,"plugin","index.js"),"utf8")).toBe("old plugin")
  expect(fs.existsSync(f.manifest.entries[0].backup)).toBe(false)
})

test("rejects changed immutable artifacts and forged manifest paths",async () => {
  await using directory = await tmpdir()
  const f = fixture(directory.path)
  expect(() => parseReleaseFiles({...f.manifest,entries:[{...f.manifest.entries[0],snapshot:path.join(directory.path,"outside")}]})).toThrow("Invalid release snapshot")
  expect(() => parseReleaseFiles({...f.manifest,entries:[{...f.manifest.entries[0],target:path.parse(directory.path).root}]})).toThrow("filesystem root")
  fs.writeFileSync(path.join(f.manifest.entries[0].snapshot,"index.js"),"tampered")
  expect(() => verifyReleaseFiles(f.manifest)).toThrow("artifact changed")
  expect(fs.readFileSync(path.join(f.target,"plugin","index.js"),"utf8")).toBe("old plugin")
})

test("rejects overlapping targets and junctions without modifying them",async () => {
  await using directory = await tmpdir()
  const f = fixture(directory.path)
  expect(() => prepareReleaseFiles({directory:path.join(directory.path,"overlap"),entries:[
    {source:path.join(f.source,"plugin"),target:f.target},
    {source:path.join(f.source,"config.json"),target:path.join(f.target,"config.json")},
  ]})).toThrow("Overlapping")
  fs.symlinkSync(path.join(f.target,"plugin"),path.join(f.source,"linked"),process.platform === "win32" ? "junction" : "dir")
  expect(() => prepareReleaseFiles({directory:path.join(directory.path,"links"),entries:[{source:path.join(f.source,"linked"),target:path.join(f.target,"linked")}]})).toThrow("Symbolic links")
  expect(fs.existsSync(path.join(directory.path,"links"))).toBe(false)
})

test("restores promoted entries on a partial install failure and journals the outcome",async () => {
  await using directory = await tmpdir()
  const f = fixture(directory.path)
  expect(() => installReleaseFiles(f.manifest,{beforePromote:(_target,index) => {if (index === 1) throw new Error("simulated failure")}})).toThrow("simulated failure")
  expect(fs.readFileSync(path.join(f.target,"plugin","index.js"),"utf8")).toBe("old plugin")
  expect(fs.readFileSync(path.join(f.target,"config.json"),"utf8")).toBe('{"old":true}')
  expect(parseReleaseFilesReceipt(JSON.parse(fs.readFileSync(path.join(f.manifest.directory,"receipt.json"),"utf8"))).status).toBe("rolled-back")
})

test("preserves concurrent edits during failed install instead of overwriting them",async () => {
  await using directory = await tmpdir()
  const f = fixture(directory.path)
  expect(() => installReleaseFiles(f.manifest,{beforePromote:(_target,index) => {
    if (index !== 1) return
    fs.writeFileSync(path.join(f.target,"plugin","index.js"),"new user work")
    throw new Error("simulated failure")
  }})).toThrow("requires recovery")
  expect(fs.readFileSync(path.join(f.target,"plugin","index.js"),"utf8")).toBe("new user work")
  expect(fs.readFileSync(path.join(f.manifest.entries[0].displaced,"index.js"),"utf8")).toBe("old plugin")
  expect(fs.readFileSync(path.join(f.target,"config.json"),"utf8")).toBe('{"old":true}')
})

test("does not report installation success when an earlier target changes during later promotions",async () => {
  await using directory = await tmpdir()
  const f = fixture(directory.path)
  expect(() => installReleaseFiles(f.manifest,{beforePromote:(_target,index) => {
    if (index === 1) fs.writeFileSync(path.join(f.target,"plugin","index.js"),"new user work")
  }})).toThrow("requires recovery")
  expect(fs.readFileSync(path.join(f.target,"plugin","index.js"),"utf8")).toBe("new user work")
  expect(parseReleaseFilesReceipt(JSON.parse(fs.readFileSync(path.join(f.manifest.directory,"receipt.json"),"utf8"))).status).toBe("conflict")
})

test("rejects a changed staged artifact before moving its original target",async () => {
  await using directory = await tmpdir()
  const f = fixture(directory.path)
  expect(() => installReleaseFiles(f.manifest,{beforePromote:(_target,index) => {
    if (index === 0) fs.writeFileSync(path.join(f.manifest.entries[0].staged,"index.js"),"unexpected staged content")
  }})).toThrow("staging")
  expect(fs.readFileSync(path.join(f.target,"plugin","index.js"),"utf8")).toBe("old plugin")
  expect(fs.existsSync(f.manifest.entries[0].displaced)).toBe(false)
  expect(fs.readFileSync(path.join(f.manifest.entries[0].staged,"index.js"),"utf8")).toBe("unexpected staged content")
})

test("refuses the whole rollback when one deployed target changed",async () => {
  await using directory = await tmpdir()
  const f = fixture(directory.path)
  const receipt = installReleaseFiles(f.manifest)
  fs.writeFileSync(path.join(f.target,"config.json"),"new user config")
  expect(() => rollbackReleaseFiles(receipt)).toThrow("Rollback conflict")
  expect(fs.readFileSync(path.join(f.target,"plugin","index.js"),"utf8")).toBe("new plugin")
  expect(fs.readFileSync(path.join(f.target,"config.json"),"utf8")).toBe("new user config")
  expect(fs.existsSync(path.join(f.target,"new-plugin"))).toBe(true)
})

test("a preexisting rollback staging conflict preserves every installed target",async () => {
  await using directory = await tmpdir()
  const f = fixture(directory.path)
  const receipt = installReleaseFiles(f.manifest)
  fs.writeFileSync(f.manifest.entries[0].staged, "unrelated work")
  expect(() => rollbackReleaseFiles(receipt)).toThrow("staging")
  expect(fs.readFileSync(path.join(f.target,"plugin","index.js"),"utf8")).toBe("new plugin")
  expect(fs.readFileSync(path.join(f.target,"config.json"),"utf8")).toBe('{"new":true}')
  expect(fs.existsSync(path.join(f.target,"new-plugin"))).toBe(true)
  const saved = parseReleaseFilesReceipt(JSON.parse(fs.readFileSync(path.join(f.manifest.directory,"receipt.json"),"utf8")))
  expect(saved.status).toBe("conflict")
  expect(saved.entries).toEqual(["installed", "installed", "installed"])
})

test("recovers completed atomic renames when the persisted operation state lagged",async () => {
  await using directory = await tmpdir()
  const f = fixture(directory.path)
  const receipt = installReleaseFiles(f.manifest)
  const stale = {...receipt,status:"installing" as const,entries:receipt.entries.map(() => "pending" as const)}
  expect(rollbackReleaseFiles(stale).status).toBe("rolled-back")
  expect(fs.readFileSync(path.join(f.target,"plugin","index.js"),"utf8")).toBe("old plugin")
  expect(fs.existsSync(path.join(f.target,"new-plugin"))).toBe(false)
})

test("resumes rollback after moving a replacement aside but before restoring the original",async () => {
  await using directory = await tmpdir()
  const f = fixture(directory.path)
  const receipt = installReleaseFiles(f.manifest)
  const entry = f.manifest.entries[0]
  fs.renameSync(entry.target,entry.staged)
  expect(rollbackReleaseFiles({...receipt,status:"rolling-back"}).status).toBe("rolled-back")
  expect(fs.readFileSync(path.join(f.target,"plugin","index.js"),"utf8")).toBe("old plugin")
  expect(fs.existsSync(path.join(f.target,"new-plugin"))).toBe(false)
})
