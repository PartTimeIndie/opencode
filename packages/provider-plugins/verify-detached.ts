import path from "node:path"
import os from "node:os"
import { cp, mkdir, mkdtemp } from "node:fs/promises"
import { createRequire } from "node:module"

const manifest = await Bun.file(path.join(import.meta.dir, "release-manifest.json")).json()
const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-provider-packages-"))
for (const artifact of manifest.artifacts) {
  const target = path.join(directory, artifact.directory)
  await mkdir(target)
  await cp(path.join(import.meta.dir, artifact.directory, "dist"), path.join(target, "dist"), { recursive: true })
  await cp(path.join(import.meta.dir, artifact.directory, "package.json"), path.join(target, "package.json"))
}
const script = path.join(directory, "verify.mjs")
await Bun.write(
  script,
  `import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const entries = ${JSON.stringify(
    manifest.artifacts.flatMap((entry: { directory: string; exports: Record<string, string> }) =>
      ["provider", "server"].flatMap((kind) =>
        entry.exports["./" + kind] ? [{ name: entry.directory, kind, file: entry.exports["./" + kind] }] : [],
      ),
    ),
  )};
const failures = [];
let chunks = 0;
let native = 0;
for (const name of new Set(entries.map(entry => entry.name))) {
  for (const file of await readdir(new URL('./'+name+'/dist/', import.meta.url))) {
    if (!file.endsWith('.js')) continue;
    try { await import('./'+name+'/dist/'+file); chunks++; }
    catch (error) { failures.push({name, file, error:String(error)}); }
  }
}
for (const entry of entries) {
  try {
    const module = (await import('./'+entry.name+'/'+entry.file)).default;
    if (typeof module?.[entry.kind] !== 'function') throw new Error('Missing public '+entry.kind);
    if (entry.kind !== 'provider') continue;
    for (const [npm, factory] of Object.entries(module.nativeModels ?? {})) {
      const result = await factory.resolve({model:{
        id:'detached-model', providerID:module.id, name:'Detached model',
        api:{id:'detached-model',npm,url:'http://127.0.0.1:1/v1'},
        request:{options:{},headers:{},generation:{},body:{}},
        limit:{context:8192,input:4096,output:1024}
      }});
      if (!result || result.error) throw new Error('Native factory did not resolve '+npm);
      native++;
    }
  } catch(error) { failures.push({...entry, error:String(error)}); }
}
console.log(JSON.stringify({runtime:process.versions.electron?'electron':process.versions.bun?'bun':'node',versions:{node:process.versions.node,bun:process.versions.bun,electron:process.versions.electron},packages:new Set(entries.map(entry=>entry.name)).size,provider:entries.filter(entry=>entry.kind==='provider').length,server:entries.filter(entry=>entry.kind==='server').length,chunks,native,directory:fileURLToPath(new URL('.',import.meta.url)),dependencies:'bundled',status:failures.length?'failed':'passed',failures}));
if (failures.length) process.exitCode = 1;
`,
)
// CLI packaging also verifies Node compatibility, without requiring Electron to be installed.
const electron = process.argv.includes("--skip-electron")
  ? undefined
  : createRequire(path.join(import.meta.dir, "../desktop/package.json"))("electron") as unknown
if (electron !== undefined && typeof electron !== "string") throw new Error("Could not resolve the Electron executable")
const results = ["bun", "node", ...(typeof electron === "string" ? [electron] : [])].map((runtime) => {
  const result = Bun.spawnSync([runtime, script], {
    cwd: directory,
    env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "", ELECTRON_RUN_AS_NODE: "1" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  })
  return { runtime, exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
})
await Bun.write(
  path.join(directory, "receipt.json"),
  JSON.stringify(
    { results },
    null,
    2,
  ),
)
for (const result of results) console.log(result.stdout)
console.log(`Detached runtime receipt: ${path.join(directory, "receipt.json")}`)
if (results.some((result) => result.exitCode)) throw new Error("Detached provider runtime verification failed")
