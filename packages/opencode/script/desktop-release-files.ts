import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { z } from "zod"

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const manifestSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  directory: z.string(),
  entries: z.array(z.object({
    source: z.string(), target: z.string(), snapshot: z.string(), backup: z.string(),
    staged: z.string(), displaced: z.string(), kind: z.enum(["file", "directory"]),
    sha256: hash, baseHash: hash.nullable(),
  }).strict()),
}).strict()
export type ReleaseFilesManifest = z.infer<typeof manifestSchema>
const receiptSchema = z.object({
  manifest: manifestSchema,
  status: z.enum(["installing", "installed", "rolling-back", "rolled-back", "conflict"]),
  entries: z.array(z.enum(["pending", "displaced", "installed", "restored"])),
}).strict()
export type ReleaseFilesReceipt = z.infer<typeof receiptSchema>

export function parseReleaseFilesReceipt(input: unknown): ReleaseFilesReceipt {
  const receipt = receiptSchema.parse(input)
  receipt.manifest = parseReleaseFiles(receipt.manifest)
  if (receipt.entries.length !== receipt.manifest.entries.length) throw new Error("Invalid release receipt entry count")
  return receipt
}

/** Validate persisted manifests before trusting any path for file operations. */
export function parseReleaseFiles(input: unknown): ReleaseFilesManifest {
  const manifest = manifestSchema.parse(input)
  absolute(manifest.directory)
  manifest.entries.forEach((entry, index) => {
    absolute(entry.source)
    absolute(entry.target)
    if (same(entry.target, path.parse(entry.target).root)) throw new Error(`Refusing filesystem root: ${entry.target}`)
    const expected = paths(manifest.directory, manifest.id, entry.target, index)
    for (const key of ["snapshot", "backup", "staged", "displaced"] as const)
      if (!same(entry[key], expected[key])) throw new Error(`Invalid release ${key} path: ${entry[key]}`)
  })
  nonoverlap(manifest.directory, manifest.entries)
  for (const entry of manifest.entries)
    for (const transient of [entry.staged,entry.displaced])
      if (manifest.entries.some((other) => contains(transient,other.target) || contains(other.target,transient) || contains(transient,other.source) || contains(other.source,transient)))
        throw new Error(`Release working path overlaps source or target: ${transient}`)
  return manifest
}

/** Capture source artifacts and the expected target baseline without modifying targets. */
export function releaseTargetHash(target: string) {
  return fingerprint(target)?.hash ?? null
}

export function prepareReleaseFiles(input: {directory: string; entries: Array<{source: string; target: string; expectedBaseHash?: string | null}>}): ReleaseFilesManifest {
  absolute(input.directory)
  const directory = path.resolve(input.directory)
  const entries = input.entries.map((entry) => {
    absolute(entry.source)
    absolute(entry.target)
    return {source:path.resolve(entry.source),target:path.resolve(entry.target),expectedBaseHash:entry.expectedBaseHash}
  })
  nonoverlap(directory, entries)
  noLinks(directory)
  if (fs.existsSync(directory)) throw new Error(`Release snapshot directory already exists: ${directory}`)
  const id = randomUUID()
  const manifest = parseReleaseFiles({version:1,id,directory,entries:entries.map((entry,index) => {
    const source = fingerprint(entry.source)
    if (!source) throw new Error(`Release source is missing: ${entry.source}`)
    const base = fingerprint(entry.target)
    if (entry.expectedBaseHash !== undefined && entry.expectedBaseHash !== (base?.hash ?? null)) throw new Error(`Release target changed since descriptor creation: ${entry.target}`)
    return {source:entry.source,target:entry.target,...paths(directory,id,entry.target,index),kind:source.kind,sha256:source.hash,baseHash:base?.hash ?? null}
  })})
  fs.mkdirSync(directory,{recursive:true})
  for (const entry of manifest.entries) {
    fs.cpSync(entry.source,entry.snapshot,{recursive:true,errorOnExist:true,force:false,preserveTimestamps:true})
    expectHash(entry.snapshot,entry.sha256,"Source changed while creating release snapshot")
  }
  fs.writeFileSync(path.join(directory,"manifest.json"),JSON.stringify(manifest,null,2),{flag:"wx"})
  return manifest
}

/** Launch preflight: all baselines and immutable artifacts are checked before target mutation. */
export function verifyReleaseFiles(input: ReleaseFilesManifest) {
  const manifest = parseReleaseFiles(input)
  noLinks(manifest.directory)
  for (const entry of manifest.entries) {
    const snapshot = fingerprint(entry.snapshot)
    if (snapshot?.hash !== entry.sha256 || snapshot.kind !== entry.kind) throw new Error(`Release artifact changed: ${entry.snapshot}`)
    expectHash(entry.target,entry.baseHash,"Release target changed since preparation")
    for (const transient of [entry.backup,entry.staged,entry.displaced])
      if (fingerprint(transient)) throw new Error(`Release working path already exists: ${transient}`)
  }
  if (fs.existsSync(path.join(manifest.directory,"receipt.json"))) throw new Error("Release has already been installed or attempted")
}

/** Install whole targets with same-directory renames; retain every original for rollback. */
export function installReleaseFiles(input: ReleaseFilesManifest, options: {beforePromote?: (target: string,index: number) => void} = {}): ReleaseFilesReceipt {
  const manifest = parseReleaseFiles(input)
  verifyReleaseFiles(manifest)
  const receipt: ReleaseFilesReceipt = {manifest,status:"installing",entries:manifest.entries.map(() => "pending")}
  save(receipt)
  try {
    // Finish every backup and stage before replacing the first target.
    for (const entry of manifest.entries) {
      if (entry.baseHash !== null) {
        fs.cpSync(entry.target,entry.backup,{recursive:true,errorOnExist:true,force:false,preserveTimestamps:true})
        expectHash(entry.backup,entry.baseHash,"Target changed while backing up")
      }
      fs.mkdirSync(path.dirname(entry.staged),{recursive:true})
      fs.cpSync(entry.snapshot,entry.staged,{recursive:true,errorOnExist:true,force:false,preserveTimestamps:true})
      expectHash(entry.staged,entry.sha256,"Release artifact changed while staging")
    }
    for (const entry of manifest.entries) expectHash(entry.target,entry.baseHash,"Release target changed before promotion")
    for (const [index,entry] of manifest.entries.entries()) {
      options.beforePromote?.(entry.target,index)
      expectHash(entry.staged,entry.sha256,"Release artifact changed after staging")
      expectHash(entry.target,entry.baseHash,"Release target changed during promotion")
      if (entry.baseHash !== null) {
        fs.renameSync(entry.target,entry.displaced)
        receipt.entries[index] = "displaced"
        save(receipt)
        expectHash(entry.displaced,entry.baseHash,"Original target changed during promotion")
      }
      fs.renameSync(entry.staged,entry.target)
      receipt.entries[index] = "installed"
      save(receipt)
      expectHash(entry.target,entry.sha256,"Installed target changed during promotion")
    }
    for (const entry of manifest.entries) expectHash(entry.target,entry.sha256,"Installed release target changed")
    receipt.status = "installed"
    save(receipt)
    return receipt
  } catch (error) {
    try { rollbackReleaseFiles(receipt) }
    catch (rollbackError) {
      throw new AggregateError([error,rollbackError],`External release failed and requires recovery; originals preserved in ${manifest.directory}`)
    }
    throw error
  }
}

/** Refuse the entire rollback if any deployed target or retained original changed. */
export function rollbackReleaseFiles(input: ReleaseFilesReceipt): ReleaseFilesReceipt {
  const receipt = parseReleaseFilesReceipt(input)
  if (receipt.status === "rolled-back") return receipt
  try {
    for (const [index,entry] of receipt.manifest.entries.entries()) {
      // Recover a crash between an atomic rename and the following journal write.
      const target = fingerprint(entry.target)?.hash ?? null
      const displaced = fingerprint(entry.displaced)?.hash ?? null
      const staged = fingerprint(entry.staged)?.hash ?? null
      if (receipt.entries[index] === "pending" && entry.baseHash !== null && displaced === entry.baseHash && target === null)
        receipt.entries[index] = "displaced"
      if (["pending","displaced"].includes(receipt.entries[index]) && target === entry.sha256 && displaced === entry.baseHash && staged === null)
        receipt.entries[index] = "installed"
      if (receipt.entries[index] === "installed" && target === null && displaced === entry.baseHash && staged === entry.sha256)
        receipt.entries[index] = entry.baseHash === null ? "restored" : "displaced"
      if (target === entry.baseHash && displaced === null && staged === entry.sha256 && ["installed","displaced"].includes(receipt.entries[index]))
        receipt.entries[index] = "restored"
      const state = receipt.entries[index]
      if (state === "installed") {
        expectHash(entry.target,entry.sha256,"Rollback conflict; installed target changed")
        expectHash(entry.staged,null,"Rollback staging path appeared")
      }
      if (state === "displaced") expectHash(entry.target,null,"Rollback conflict; replacement target appeared")
      if (state === "installed" || state === "displaced") {
        expectHash(entry.displaced,entry.baseHash,"Rollback conflict; retained original changed")
        if (entry.baseHash !== null) expectHash(entry.backup,entry.baseHash,"Rollback backup changed")
      }
    }
  } catch (error) {
    receipt.status = "conflict"
    save(receipt)
    throw error
  }
  receipt.status = "rolling-back"
  save(receipt)
  for (const [index,entry] of [...receipt.manifest.entries.entries()].reverse()) {
    const state = receipt.entries[index]
    if (state === "installed") {
      // The path is validated and its complete content matched above; preserve any later edit.
      expectHash(entry.target,entry.sha256,"Rollback conflict during restore")
      if (fingerprint(entry.staged)) throw new Error(`Rollback staging path appeared: ${entry.staged}`)
      fs.renameSync(entry.target,entry.staged)
    }
    if ((state === "installed" || state === "displaced") && entry.baseHash !== null)
      fs.renameSync(entry.displaced,entry.target)
    receipt.entries[index] = "restored"
    save(receipt)
  }
  receipt.status = "rolled-back"
  save(receipt)
  return receipt
}

function paths(directory: string,id: string,target: string,index: number) {
  return {snapshot:path.join(directory,`snapshot-${index}`),backup:path.join(directory,`backup-${index}`),
    staged:path.join(path.dirname(target),`.opencode-release-${id}-${index}.new`),
    displaced:path.join(path.dirname(target),`.opencode-release-${id}-${index}.old`)}
}

function save(receipt: ReleaseFilesReceipt) {
  noLinks(receipt.manifest.directory)
  const filename = path.join(receipt.manifest.directory,"receipt.json")
  noLinks(filename)
  noLinks(`${filename}.tmp`)
  fs.writeFileSync(`${filename}.tmp`,JSON.stringify(receipt,null,2),{flag:"w"})
  fs.renameSync(`${filename}.tmp`,filename)
}

function expectHash(filename: string,expected: string | null,message: string) {
  if ((fingerprint(filename)?.hash ?? null) !== expected) throw new Error(`${message}: ${filename}`)
}

function absolute(filename: string) {
  if (!path.isAbsolute(filename) || filename.includes("\0")) throw new Error(`Release path must be absolute: ${filename}`)
}
function same(left: string,right: string) {
  return process.platform === "win32" ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right)
}
function contains(parent: string,child: string) {
  const relative = path.relative(parent,child)
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}
function nonoverlap(directory: string,entries: Array<{source: string;target: string}>) {
  entries.forEach((entry,index) => {
    if (contains(entry.target,directory) || contains(directory,entry.target) || contains(entry.source,directory) || contains(directory,entry.source)) throw new Error("Release transaction directory overlaps source or target")
    if (entries.some((other,otherIndex) => otherIndex !== index && (contains(entry.target,other.target) || contains(other.target,entry.target)))) throw new Error(`Overlapping release targets: ${entry.target}`)
    if (entries.some((other) => contains(entry.target,other.source) || contains(other.source,entry.target))) throw new Error(`Release source overlaps target: ${entry.target}`)
  })
}
function noLinks(filename: string) {
  absolute(filename)
  const parent = path.dirname(filename)
  if (parent !== filename) noLinks(parent)
  const stat = fs.lstatSync(filename,{throwIfNoEntry:false})
  if (stat?.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in releases: ${filename}`)
}
function fingerprint(filename: string): {hash: string;kind:"file"|"directory"} | undefined {
  noLinks(filename)
  const stat = fs.lstatSync(filename,{throwIfNoEntry:false})
  if (!stat) return
  if (!stat.isFile() && !stat.isDirectory()) throw new Error(`Unsupported release file: ${filename}`)
  const digest = createHash("sha256")
  const visit = (current: string,relative: string) => {
    const item = fs.lstatSync(current)
    if (item.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in releases: ${current}`)
    if (item.isDirectory()) {
      digest.update(JSON.stringify(["directory",relative]))
      fs.readdirSync(current).sort().forEach((name) => visit(path.join(current,name),`${relative}/${name}`))
      return
    }
    if (!item.isFile()) throw new Error(`Unsupported release file: ${current}`)
    digest.update(JSON.stringify(["file",relative,item.size]))
    digest.update(fs.readFileSync(current))
  }
  visit(filename,"")
  return {hash:digest.digest("hex"),kind:stat.isFile()?"file":"directory"}
}
