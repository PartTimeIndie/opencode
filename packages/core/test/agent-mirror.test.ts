import { describe, expect } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "fs/promises"
import { tmpdir as osTmpdir } from "os"
import path from "path"
import { execFileSync } from "node:child_process"
import { Effect } from "effect"
import { AgentMirror } from "@opencode-ai/core/session/workspace/agent-mirror"
import { MirrorRoot } from "@opencode-ai/core/session/workspace/mirror-root"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

async function git(directory: string, args: string[]) {
  const child = Bun.spawn(["git", "-c", "core.autocrlf=false", ...args], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(stderr)
  return stdout
}

describe("independent agent mirrors", () => {
  it.live("preflights a large Git index without truncating its path inventory", () =>
    Effect.promise(async () => {
      await using source = await tmpdir({ git: true })
      await using storage = await tmpdir()
      await fs.writeFile(path.join(storage.path, "blob"), "shared bytes")
      const blob = (await git(source.path, ["hash-object", "-w", path.join(storage.path, "blob")])).trim()
      const input = Array.from({ length: 35_000 }, (_, index) =>
        `100644 ${blob}\tbulk/${String(index).padStart(5, "0")}-${"x".repeat(175)}.txt\n`).join("")
      execFileSync("git", ["update-index", "--index-info"], { cwd: source.path, input, windowsHide: true })
      expect(Buffer.byteLength(await git(source.path, ["ls-files", "--stage", "-z"]))).toBeGreaterThan(8 * 1024 * 1024)
      await AgentMirror.preflight(source.path, [])
    }))

  for (const ignored of [false, true]) it.live(`only excludes ignored nested agent worktree gitlinks (ignored=${ignored})`, () =>
    Effect.promise(async () => {
      await using source = await tmpdir({ git: true })
      await using storage = await tmpdir()
      const nested = ".claude/worktrees/fixture-worker"
      const commit = (await git(source.path, ["rev-parse", "HEAD"])).trim()
      await fs.mkdir(path.join(source.path, nested), { recursive: true })
      await fs.writeFile(path.join(source.path, nested, "private.txt"), "must not copy")
      await git(source.path, ["update-index", "--add", "--cacheinfo", `160000,${commit},${nested}`])
      if (ignored) await fs.writeFile(path.join(source.path, ".gitignore"), ".claude/worktrees/\n")
      const request = { directory: source.path, mirrorRoot: storage.path, taskID: "nested-worktree",
        sourceSessionID: "ses_source", throughSeq: 1, untracked: [] }
      if (!ignored) {
        await expect(AgentMirror.create(request)).rejects.toThrow("symlinks or submodules")
        expect(await fs.readdir(storage.path)).toEqual([])
        return
      }
      const mirror = await AgentMirror.create(request)
      expect(mirror.basis.files.some((file) => file.path.startsWith(nested))).toBe(false)
      expect(mirror.basis.deletedPaths).not.toContain(nested)
      expect(await AgentMirror.integrationPaths(mirror.directory)).not.toContain(nested)
      await expect(fs.access(path.join(mirror.directory, nested))).rejects.toThrow()
      expect(await fs.readFile(path.join(source.path, nested, "private.txt"), "utf8")).toBe("must not copy")
      // A real product submodule stays unsupported even when ignored.
      await fs.writeFile(path.join(source.path, ".gitignore"), ".claude/worktrees/\nvendor/\n")
      await git(source.path, ["update-index", "--add", "--cacheinfo", `160000,${commit},vendor/module`])
      await expect(AgentMirror.create({ ...request, taskID: "product-module" })).rejects.toThrow("symlinks or submodules")
    }))

  it.live("creates an independent mirror from a shallow source without fetching history", () =>
    Effect.promise(async () => {
      await using origin = await tmpdir({ git: true })
      await using sourceRoot = await tmpdir()
      await using storage = await tmpdir()
      await fs.writeFile(path.join(origin.path, "tracked.txt"), "shallow bytes\n")
      await git(origin.path, ["add", "--", "tracked.txt"])
      await git(origin.path, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "shallow fixture"])
      const directory = path.join(sourceRoot.path, "shallow")
      await git(sourceRoot.path, ["clone", "--no-local", "--depth=1", "--", origin.path, directory])
      await git(directory, ["config", "extensions.worktreeConfig", "true"])
      expect((await git(directory, ["rev-parse", "--is-shallow-repository"])).trim()).toBe("true")
      const mirror = await AgentMirror.create({ directory, mirrorRoot: storage.path,
        taskID: "shallow-mirror", sourceSessionID: "ses_source", throughSeq: 1, untracked: [] })
      expect(await fs.readFile(path.join(mirror.directory, "tracked.txt"), "utf8")).toBe("shallow bytes\n")
      expect((await git(directory, ["rev-parse", "--is-shallow-repository"])).trim()).toBe("true")
      await expect(fs.access(path.join(mirror.directory, ".git", "objects", "info", "alternates"))).rejects.toThrow()
    }))

  it.live("discards exactly one explicitly authorized failed preparation artifact", () =>
    Effect.promise(async () => {
      await using source = await tmpdir({ git: true })
      await using storage = await tmpdir()
      await fs.writeFile(path.join(source.path, "tracked.txt"), "committed\n")
      await git(source.path, ["add", "--", "tracked.txt"])
      await git(source.path, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "c"])
      const first = await AgentMirror.create({ directory: source.path, mirrorRoot: storage.path,
        taskID: "ses_failed_prep", sourceSessionID: "ses_source", throughSeq: 3, untracked: [] })
      const second = await AgentMirror.create({ directory: source.path, mirrorRoot: storage.path,
        taskID: "ses_other_prep", sourceSessionID: "ses_source", throughSeq: 3, untracked: [] })
      const artifacts = await AgentMirror.listArtifacts(storage.path)
      expect(artifacts.map((artifact) => artifact.taskID).sort()).toEqual(["ses_failed_prep", "ses_other_prep"])
      // No Session row was ever admitted for the failed preparation: discard
      // is authorized only against that exact task/source pair.
      await AgentMirror.discardArtifact({ mirrorRoot: storage.path, taskID: "ses_failed_prep",
        sourceSessionID: "ses_source", sessionExists: () => Promise.resolve(false) })
      const remaining = await AgentMirror.listArtifacts(storage.path)
      expect(remaining.map((artifact) => artifact.taskID)).toEqual(["ses_other_prep"])
      await fs.access(second.directory)
      // A mismatched source authorization refuses without touching anything.
      await expect(AgentMirror.discardArtifact({ mirrorRoot: storage.path, taskID: "ses_other_prep",
        sourceSessionID: "ses_other_source", sessionExists: () => Promise.resolve(false) })).rejects.toThrow(
        /authorization mismatch/,
      )
      // An admitted task's mirror is never a discard candidate.
      await expect(AgentMirror.discardArtifact({ mirrorRoot: storage.path, taskID: "ses_other_prep",
        sourceSessionID: "ses_source", sessionExists: () => Promise.resolve(true) })).rejects.toThrow(
        /admitted task/,
      )
      await fs.access(second.directory)
      await expect(AgentMirror.discardArtifact({ mirrorRoot: storage.path, taskID: "ses_unknown",
        sourceSessionID: "ses_source", sessionExists: () => Promise.resolve(false) })).rejects.toThrow(
        /No mirror artifact/,
      )
    }))

  it.live("never executes repository fsmonitor callbacks during host-owned Git inspection", () =>
    Effect.promise(async () => {
      await using source = await tmpdir({ git: true })
      await using storage = await tmpdir()
      const sentinel = path.join(storage.path, "unexpected-callback.txt")
      const hook = path.join(storage.path, "fsmonitor.cjs")
      await fs.writeFile(hook, `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "executed")`)
      await git(source.path, ["config", "core.fsmonitor", `node "${hook.replaceAll("\\", "/")}"`])
      await fs.writeFile(path.join(source.path, "added.txt"), "legitimate change")
      expect(await AgentMirror.untrackedPaths(source.path)).toEqual(["added.txt"])
      expect(await fs.access(sentinel).then(() => true, () => false)).toBe(false)
    }),
  )

  it.live("creates a bundled mirror under Node without Bun runtime APIs", () =>
    Effect.promise(async () => {
      await using source = await tmpdir({ git: true })
      await using storage = await tmpdir()
      await fs.writeFile(path.join(source.path, "unicode-ä & file.txt"), "private bytes")
      const bundle = await Bun.build({
        entrypoints: [path.resolve(import.meta.dir, "../src/session/workspace/agent-mirror.ts")],
        target: "node",
      })
      expect(bundle.success).toBe(true)
      const runtime = path.join(storage.path, "mirror-runtime.mjs")
      await fs.writeFile(runtime, await bundle.outputs[0].text())
      const input = {
        directory: source.path,
        mirrorRoot: storage.path,
        taskID: "node-mirror",
        sourceSessionID: "ses_main",
        throughSeq: 1,
      }
      const child = Bun.spawn(["node", "--input-type=module", "-e", `
        import { pathToFileURL } from "node:url";
        const runtime = await import(pathToFileURL(${JSON.stringify(runtime)}));
        const input = ${JSON.stringify(input)};
        const untracked = await runtime.untrackedPaths(input.directory);
        const mirror = await runtime.create({ ...input, untracked });
        console.log(JSON.stringify({ files: mirror.basis.files, bun: typeof Bun }));
      `], { stdout: "pipe", stderr: "pipe" })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
      expect(JSON.parse(stdout)).toMatchObject({
        bun: "undefined",
        files: [expect.objectContaining({ path: "unicode-ä & file.txt", bytes: 13 })],
      })
      expect(await fs.readFile(path.join(source.path, "unicode-ä & file.txt"), "utf8")).toBe("private bytes")
    }),
  )

  it.live("pins child Git byte semantics and preserves source file modes", () =>
    Effect.promise(async () => {
      await using source = await tmpdir({ git: true })
      await using storage = await tmpdir()
      const bytes = "first\r\nsecond\r\n"
      await fs.writeFile(path.join(source.path, "lines.txt"), bytes)
      await fs.writeFile(path.join(source.path, "readonly.txt"), "read only")
      await fs.writeFile(path.join(source.path, "executable.sh"), "#!/bin/sh\nexit 0\n")
      await fs.chmod(path.join(source.path, "executable.sh"), 0o755)
      await git(source.path, ["add", "--all"])
      await git(source.path, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "test: modes and CRLF",
      ])
      await fs.chmod(path.join(source.path, "readonly.txt"), 0o444)
      const mirror = await AgentMirror.create({
        directory: source.path,
        mirrorRoot: storage.path,
        taskID: "modes",
        sourceSessionID: "ses_main",
        throughSeq: 1,
        untracked: [],
      })
      for (const file of mirror.basis.files) {
        expect((await fs.stat(path.join(mirror.directory, file.path))).mode & 0o777).toBe(file.mode)
        expect((await fs.stat(path.join(source.path, file.path))).mode & 0o777).toBe(file.mode)
      }
      const config = path.join(storage.path, "gitconfig")
      await fs.writeFile(config, "[core]\nautocrlf = true\n")
      const childGit = async (args: string[]) => {
        // No -c overrides here: exercise the same local/global configuration
        // a real child process would see, not the snapshot helper's flags.
        const child = Bun.spawn(["git", ...args], {
          cwd: mirror.directory,
          env: { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" },
          stdout: "pipe",
          stderr: "pipe",
        })
        const [code, output, error] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        if (code !== 0) throw new Error(error)
        return output
      }
      expect((await childGit(["config", "--get", "core.autocrlf"])).trim()).toBe("false")
      expect(await childGit(["status", "--porcelain"])).toBe("")
      await childGit(["add", "--", "lines.txt"])
      expect(await childGit(["show", ":lines.txt"])).toBe(bytes)
      expect(await fs.readFile(path.join(mirror.directory, "lines.txt"), "utf8")).toBe(bytes)
      // Restore writable fixture files for Windows cleanup.
      await fs.chmod(path.join(source.path, "readonly.txt"), 0o666)
      await fs.chmod(path.join(mirror.directory, "readonly.txt"), 0o666)
    }),
  )

  for (const mode of ["sparse", "unmerged"] as const) {
    it.live(`refuses ${mode} index state before allocating a mirror`, () =>
      Effect.promise(async () => {
        await using source = await tmpdir({ git: true })
        await using storage = await tmpdir()
        await fs.writeFile(path.join(source.path, "file.txt"), "seed")
        await git(source.path, ["add", "--all"])
        await git(source.path, [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "-m",
          "test: index",
        ])
        if (mode === "sparse") await git(source.path, ["update-index", "--skip-worktree", "--", "file.txt"])
        if (mode === "unmerged") {
          const hash = (await git(source.path, ["rev-parse", "HEAD:file.txt"])).trim()
          await git(source.path, ["update-index", "--force-remove", "--", "file.txt"])
          const child = Bun.spawn(["git", "update-index", "--index-info"], {
            cwd: source.path,
            stdin: Buffer.from(`100644 ${hash} 1\tfile.txt\n100644 ${hash} 2\tfile.txt\n`),
            stdout: "pipe",
            stderr: "pipe",
          })
          expect(await child.exited).toBe(0)
        }
        await expect(
          AgentMirror.create({
            directory: source.path,
            mirrorRoot: storage.path,
            taskID: mode,
            sourceSessionID: "ses_main",
            throughSeq: 1,
            untracked: [],
          }),
        ).rejects.toThrow(mode === "sparse" ? "sparse checkout" : "unresolved Git index")
        expect(await fs.readdir(storage.path)).toEqual([])
      }),
    )
  }

  it.live("excludes files ignored by the isolated user's global policy", () =>
    Effect.promise(async () => {
      await using source = await tmpdir({ git: true })
      await using storage = await tmpdir()
      await fs.writeFile(path.join(source.path, "tracked.txt"), "tracked")
      await git(source.path, ["add", "--", "tracked.txt"])
      await git(source.path, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "test: ignore policy",
      ])
      await fs.writeFile(path.join(source.path, "private.env"), "fixture only")
      const ignore = path.join(storage.path, "ignore")
      const config = path.join(storage.path, "gitconfig")
      await fs.writeFile(ignore, "private.env\n")
      await fs.writeFile(config, `[core]\nexcludesFile = "${ignore.replaceAll("\\", "/")}"\n`)
      // A separate process keeps the fixture's HOME/Git policy out of sibling tests.
      const child = Bun.spawn(
        [
          process.execPath,
          "--eval",
          `
        import { AgentMirror } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/session/workspace/agent-mirror.ts"))};
        const mirror = await AgentMirror.create(${JSON.stringify({ directory: source.path, mirrorRoot: storage.path, taskID: "global-ignore", sourceSessionID: "ses_main", throughSeq: 1, untracked: ["private.env"] })});
        console.log(JSON.stringify({ directory: mirror.directory, excluded: mirror.basis.excludedUntracked }));
      `,
        ],
        {
          env: {
            ...process.env,
            HOME: storage.path,
            USERPROFILE: storage.path,
            XDG_CONFIG_HOME: storage.path,
            GIT_CONFIG_GLOBAL: config,
            GIT_CONFIG_NOSYSTEM: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [code, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(error).toBe("")
      expect(code).toBe(0)
      const result = JSON.parse(output)
      expect(result.excluded).toEqual(["private.env"])
      expect(await Bun.file(path.join(result.directory, "private.env")).exists()).toBe(false)
    }),
  )

  it.live("rejects non-UTF-8 Git paths rather than recording a false deletion", () =>
    Effect.promise(async () => {
      if (process.platform === "win32") return
      await using source = await tmpdir({ git: true })
      await using storage = await tmpdir()
      const file = Buffer.concat([Buffer.from(`${source.path}/`), Buffer.from([0xff])])
      await fs.writeFile(file, "unsupported name")
      await git(source.path, ["add", "--all"])
      await git(source.path, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "test: invalid path",
      ])
      await expect(
        AgentMirror.create({
          directory: source.path,
          mirrorRoot: storage.path,
          taskID: "utf8",
          sourceSessionID: "ses_main",
          throughSeq: 1,
          untracked: [],
        }),
      ).rejects.toThrow()
      expect(await fs.readdir(storage.path)).toEqual([])
    }),
  )

  it.live("dissociates borrowed object stores before returning an independent mirror", () =>
    Effect.promise(async () => {
      await using donor = await tmpdir({ git: true })
      await using storage = await tmpdir()
      await fs.writeFile(path.join(donor.path, "file.txt"), "borrowed bytes")
      await git(donor.path, ["add", "--", "file.txt"])
      await git(donor.path, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "test: donor",
      ])
      const source = path.join(storage.path, "borrowed")
      await git(storage.path, ["clone", "--shared", "--", donor.path, source])
      expect(await Bun.file(path.join(source, ".git", "objects", "info", "alternates")).exists()).toBe(true)
      const mirror = await AgentMirror.create({
        directory: source,
        mirrorRoot: storage.path,
        taskID: "borrowed",
        sourceSessionID: "ses_main",
        throughSeq: 1,
        untracked: [],
      })
      expect(await Bun.file(path.join(mirror.directory, ".git", "objects", "info", "alternates")).exists()).toBe(false)
      await fs.rename(path.join(donor.path, ".git"), path.join(donor.path, ".git.unavailable"))
      await fs.rename(path.join(source, ".git"), path.join(source, ".git.unavailable"))
      expect(await git(mirror.directory, ["show", "HEAD:file.txt"])).toBe("borrowed bytes")
      await git(mirror.directory, ["fsck", "--full"])
    }),
  )

  it.live("rejects Windows path collisions before allocating a mirror", () =>
    Effect.promise(async () => {
      if (process.platform !== "win32") return
      await using source = await tmpdir({ git: true })
      await using storage = await tmpdir()
      await fs.writeFile(path.join(source.path, "seed.txt"), "seed")
      const hash = (await git(source.path, ["hash-object", "-w", "--", "seed.txt"])).trim()
      for (const file of ["Case.txt", "case.txt"])
        await git(source.path, ["update-index", "--add", "--cacheinfo", `100644,${hash},${file}`])
      await expect(
        AgentMirror.create({
          directory: source.path,
          mirrorRoot: storage.path,
          taskID: "collision",
          sourceSessionID: "ses_main",
          throughSeq: 1,
          untracked: [],
        }),
      ).rejects.toThrow("Case-colliding")
      expect(await fs.readdir(storage.path)).toEqual([])
    }),
  )

  it.live("captures dirty files and selected untracked files, not ignored data, without touching Main Git state", () =>
    Effect.promise(async () => {
      await using source = await tmpdir({ git: true })
      await using storage = await tmpdir()
      await fs.writeFile(path.join(source.path, "tracked.txt"), "committed")
      await fs.writeFile(path.join(source.path, "deleted.txt"), "committed deletion")
      await fs.writeFile(path.join(source.path, ".gitignore"), "secret.env\n")
      await git(source.path, ["add", "--", "tracked.txt", "deleted.txt", ".gitignore"])
      await git(source.path, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "test: mirror basis",
      ])
      const head = (await git(source.path, ["rev-parse", "HEAD"])).trim()
      await fs.writeFile(path.join(source.path, "tracked.txt"), "dirty Main")
      await fs.rm(path.join(source.path, "deleted.txt"))
      await fs.writeFile(path.join(source.path, "new.txt"), "relevant new file")
      await fs.writeFile(path.join(source.path, "unrelated.txt"), "unrelated")
      await fs.writeFile(path.join(source.path, "secret.env"), "do not copy")
      const status = await git(source.path, ["status", "--porcelain=v1", "-z"])
      const mirror = await AgentMirror.create({
        directory: source.path,
        mirrorRoot: storage.path,
        taskID: "task-mirror",
        sourceSessionID: "ses_main",
        throughSeq: 42,
        untracked: ["new.txt", "secret.env"],
      })
      expect(await fs.readFile(path.join(mirror.directory, "tracked.txt"), "utf8")).toBe("dirty Main")
      expect(await fs.readFile(path.join(mirror.directory, "new.txt"), "utf8")).toBe("relevant new file")
      for (const file of ["deleted.txt", "unrelated.txt", "secret.env"])
        expect(await Bun.file(path.join(mirror.directory, file)).exists()).toBe(false)
      expect(mirror.basis).toMatchObject({
        commit: head,
        taskID: "task-mirror",
        sourceSessionID: "ses_main",
        throughSeq: 42,
        deletedPaths: ["deleted.txt"],
        excludedUntracked: ["secret.env"],
      })
      expect(mirror.basis.files.map((file) => file.path)).toContain("tracked.txt")
      expect(await git(source.path, ["status", "--porcelain=v1", "-z"])).toBe(status)
      expect((await git(source.path, ["rev-parse", "HEAD"])).trim()).toBe(head)
      expect(await git(mirror.directory, ["remote"])).toBe("")
      expect(await Bun.file(path.join(mirror.directory, ".git", "commondir")).exists()).toBe(false)
      expect(await Bun.file(path.join(mirror.directory, ".git", "objects", "info", "alternates")).exists()).toBe(false)
      expect(mirror.metrics).toMatchObject({ copyMode: "private-files", cloneRequested: true, physicalBytes: null })
      expect(mirror.metrics.setupMs).toBeGreaterThan(0)
      expect(mirror.metrics.logicalBytes).toBeGreaterThan(0)
    }),
  )

  it.live("keeps Main and a second mirror unchanged under in-place child writes", () =>
    Effect.promise(async () => {
      await using source = await tmpdir({ git: true })
      await using storage = await tmpdir()
      await fs.writeFile(path.join(source.path, "shared.txt"), "original bytes")
      await git(source.path, ["add", "--", "shared.txt"])
      await git(source.path, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "test: private files",
      ])
      const input = {
        directory: source.path,
        mirrorRoot: storage.path,
        sourceSessionID: "ses_main",
        throughSeq: 1,
        untracked: [],
      }
      const first = await AgentMirror.create({ ...input, taskID: "task-one" })
      const second = await AgentMirror.create({ ...input, taskID: "task-two" })
      const handle = await fs.open(path.join(first.directory, "shared.txt"), "r+")
      try {
        await handle.write("CHILD", 0, "utf8")
      } finally {
        await handle.close()
      }
      expect(await fs.readFile(path.join(source.path, "shared.txt"), "utf8")).toBe("original bytes")
      expect(await fs.readFile(path.join(second.directory, "shared.txt"), "utf8")).toBe("original bytes")
      expect(await fs.readFile(path.join(first.directory, "shared.txt"), "utf8")).toBe("CHILDnal bytes")
      expect(first.basis.id).not.toBe(second.basis.id)
      const owner = await Bun.file(path.join(first.directory, "..", "owner.json")).json()
      expect(owner).toMatchObject({ id: first.basis.id, taskID: "task-one", sourceSessionID: "ses_main" })
      expect((await Bun.file(path.join(first.directory, ".git", "opencode-mirror.json")).json()).files).toEqual(
        first.basis.files,
      )
    }),
  )

  it.live("rejects escaping paths, nested storage and missing conversation boundaries", () =>
    Effect.promise(async () => {
      await using source = await tmpdir({ git: true })
      await using storage = await tmpdir()
      const input = {
        directory: source.path,
        mirrorRoot: storage.path,
        taskID: "task",
        sourceSessionID: "ses_main",
        throughSeq: 1,
        untracked: [],
      }
      for (const file of ["../escape", "C:/escape", "/absolute", ".git/config", "dir\\file"]) {
        await expect(AgentMirror.create({ ...input, untracked: [file] })).rejects.toThrow("repository-relative")
      }
      await expect(AgentMirror.create({ ...input, mirrorRoot: source.path })).rejects.toThrow("outside")
      await expect(AgentMirror.create({ ...input, throughSeq: -1 })).rejects.toThrow("stable conversation boundary")
      expect(await fs.readdir(storage.path)).toEqual([])
    }),
  )

  it.live("pins caller-owned placement, source identifiers and selected paths before asynchronous copying", () =>
    Effect.promise(async () => {
      await using source = await tmpdir({ git: true })
      await using storage = await tmpdir()
      await fs.writeFile(path.join(source.path, "selected.txt"), "selected source bytes")
      const input = { directory: source.path, mirrorRoot: storage.path, taskID: "task-pinned", sourceSessionID: "ses_main",
        throughSeq: 7, untracked: ["selected.txt"] }
      const pending = AgentMirror.create(input)
      input.directory = storage.path
      input.mirrorRoot = source.path
      input.taskID = "task-mutated"
      input.sourceSessionID = "ses_mutated"
      input.throughSeq = 99
      input.untracked.length = 0
      const mirror = await pending
      expect(mirror.basis).toMatchObject({ directory: await fs.realpath(source.path), taskID: "task-pinned", sourceSessionID: "ses_main", throughSeq: 7 })
      expect(await fs.readFile(path.join(mirror.directory, "selected.txt"), "utf8")).toBe("selected source bytes")
    }),
  )
  it.live("rejects a linked source ancestor even if it resolves inside the same checkout", () =>
    Effect.promise(async () => {
      await using source = await tmpdir({ git: true })
      await using storage = await tmpdir()
      await fs.mkdir(path.join(source.path, "nested"))
      await fs.writeFile(path.join(source.path, "nested", "file.txt"), "tracked bytes")
      await git(source.path, ["add", "--", "nested/file.txt"])
      await git(source.path, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "test: linked ancestor"])
      await fs.rename(path.join(source.path, "nested"), path.join(source.path, "actual"))
      await fs.symlink(path.join(source.path, "actual"), path.join(source.path, "nested"), process.platform === "win32" ? "junction" : "dir")
      await expect(AgentMirror.create({ directory: source.path, mirrorRoot: storage.path, taskID: "task-link",
        sourceSessionID: "ses_main", throughSeq: 1, untracked: [] })).rejects.toThrow("regular files and directories")
      expect(await fs.readFile(path.join(source.path, "actual", "file.txt"), "utf8")).toBe("tracked bytes")
    }),
  )
  for (const ignored of [true, false]) it.live(`refuses a retained HEAD-only file without untracked consent (ignored=${ignored})`, () =>
    Effect.promise(async () => {
      await using source = await tmpdir({ git: true })
      await using storage = await tmpdir()
      await fs.writeFile(path.join(source.path, "private.txt"), "public placeholder")
      await git(source.path, ["add", "--", "private.txt"])
      await git(source.path, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "test: tracked placeholder"])
      await git(source.path, ["rm", "--cached", "--", "private.txt"])
      if (ignored) await fs.writeFile(path.join(source.path, ".gitignore"), "private.txt\n")
      await fs.writeFile(path.join(source.path, "private.txt"), "private sentinel must not be copied")
      await expect(AgentMirror.create({ directory: source.path, mirrorRoot: storage.path, taskID: "task-private",
        sourceSessionID: "ses_main", throughSeq: 1, untracked: [] })).rejects.toThrow("HEAD-only")
      expect(await fs.readdir(storage.path)).toEqual([])
    }),
  )
  for (const selected of [true, false]) it.live(`requires explicit selection for a repopulated rename source (selected=${selected})`, () =>
    Effect.promise(async () => {
      await using source = await tmpdir({ git: true })
      await using storage = await tmpdir()
      await fs.writeFile(path.join(source.path, "original.txt"), "approved original bytes")
      await git(source.path, ["add", "--", "original.txt"])
      await git(source.path, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "test: rename source"])
      await git(source.path, ["mv", "--", "original.txt", "renamed.txt"])
      await fs.writeFile(path.join(source.path, "original.txt"), "new explicitly selectable bytes")
      const result = AgentMirror.create({ directory: source.path, mirrorRoot: storage.path, taskID: "task-rename",
        sourceSessionID: "ses_main", throughSeq: 1, untracked: selected ? ["original.txt"] : [] })
      if (!selected) {
        await expect(result).rejects.toThrow("HEAD-only")
        expect(await fs.readdir(storage.path)).toEqual([])
        return
      }
      const mirror = await result
      expect(await fs.readFile(path.join(mirror.directory, "original.txt"), "utf8")).toBe("new explicitly selectable bytes")
      expect(await fs.readFile(path.join(mirror.directory, "renamed.txt"), "utf8")).toBe("approved original bytes")
      expect(mirror.basis.deletedPaths).toEqual([])
    }),
  )
})

// Another volume than the OS temp dir, when this machine has one. The probe
// only stats roots; nothing is ever written there.
const otherVolume = async () => {
  const roots = process.platform === "win32"
    ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => `${letter}:\\`)
    : ["/dev/shm", "/Volumes", "/mnt", "/media", "/run"]
  const temp = String((await fs.stat(osTmpdir())).dev)
  for (const root of roots) {
    const stat = await fs.stat(root).catch(() => undefined)
    if (stat?.isDirectory() && String(stat.dev) !== temp) return root
  }
  return undefined
}
const otherVolumeRoot = await otherVolume()

describe("mirror root placement", () => {
  const volume = async (directory: string) => String((await fs.stat(directory)).dev)
  const formAnswer = (formID: string | undefined, values: Record<string, unknown>) =>
    [[JSON.stringify({ version: 1, type: "opencode.form.answer", formID, values })]]
  const refusal = (answers: ReadonlyArray<ReadonlyArray<string | { type: "file"; mime: string; url: string }>>, input: MirrorRoot.Choice) => {
    try {
      MirrorRoot.chosenPath(answers, input)
      return undefined
    } catch (error) {
      return error instanceof MirrorRoot.Refused ? error.code : String(error)
    }
  }

  it.effect("derives one deterministic default folder beside the checkout and none at a volume root", () =>
    Effect.sync(() => {
      const root = path.parse(process.cwd()).root
      const checkout = path.join(root, "srv", "repos", "Project")
      const first = MirrorRoot.defaultRoot(checkout)
      expect(first).toBe(MirrorRoot.defaultRoot(checkout))
      expect(path.dirname(path.dirname(first!))).toBe(path.join(root, "srv", "repos"))
      expect(path.basename(path.dirname(first!))).toBe(".opencode-task-mirrors")
      expect(path.basename(first!)).toMatch(/^Project-[a-f0-9]{12}$/)
      expect(first!.startsWith(checkout + path.sep)).toBe(false)
      expect(MirrorRoot.defaultRoot(path.join(root, "Project"))).toBeUndefined()
    }))

  it.live("prepares the default root on the checkout's volume, outside it, and creates mirrors there", () =>
    Effect.promise(async () => {
      await using parent = await tmpdir()
      const source = path.join(parent.path, "Project")
      await fs.mkdir(source)
      await git(source, ["init", "--quiet"])
      await fs.writeFile(path.join(source, "tracked.txt"), "committed\n")
      await git(source, ["add", "--", "tracked.txt"])
      await git(source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "test: default root"])
      const checkout = await fs.realpath(source)
      const root = MirrorRoot.defaultRoot(checkout)
      expect(root).toBeDefined()
      await expect(fs.stat(root!)).rejects.toMatchObject({ code: "ENOENT" })
      const prepared = await MirrorRoot.prepare({ checkout, root: root! })
      expect(prepared).toBe(await fs.realpath(root!))
      expect(path.dirname(path.dirname(prepared))).toBe(await fs.realpath(parent.path))
      expect(AgentMirror.inside(checkout, prepared)).toBe(false)
      expect(await volume(prepared)).toBe(await volume(checkout))
      expect(JSON.parse(await fs.readFile(path.join(prepared, ".opencode-mirror-root.json"), "utf8"))).toEqual({ version: 1, kind: "native-task-mirror-root" })
      const mirror = await AgentMirror.create({ directory: checkout, mirrorRoot: prepared, taskID: "task-default-root",
        sourceSessionID: "ses_main", throughSeq: 1, untracked: [] })
      expect(AgentMirror.inside(prepared, mirror.directory)).toBe(true)
      expect(await fs.readFile(path.join(mirror.directory, "tracked.txt"), "utf8")).toBe("committed\n")
      // Parallel admissions of the same checkout share one root; a raced marker write is not a refusal.
      expect(await Promise.all([MirrorRoot.prepare({ checkout, root: root! }), MirrorRoot.prepare({ checkout, root: root! })])).toEqual([prepared, prepared])
      const fresh = path.join(parent.path, "fresh-root")
      expect(await Promise.all([MirrorRoot.prepare({ checkout, root: fresh }), MirrorRoot.prepare({ checkout, root: fresh })]))
        .toEqual([await fs.realpath(fresh), await fs.realpath(fresh)])
      expect(await fs.readdir(fresh)).toEqual([".opencode-mirror-root.json"])
      // Beside the checkout the rule adds only the hidden container (plus the explicit fresh root above);
      // the container holds one root per checkout.
      expect((await fs.readdir(path.dirname(path.dirname(prepared)))).sort()).toEqual([".opencode-task-mirrors", "Project", "fresh-root"])
      expect(await fs.readdir(path.dirname(prepared))).toEqual([path.basename(prepared)])
    }))

  it.live("refuses a root inside the checkout, an alias into it, a file, a populated folder and a foreign marker", () =>
    Effect.promise(async () => {
      await using source = await tmpdir({ git: true })
      await using storage = await tmpdir()
      const checkout = await fs.realpath(source.path)
      await fs.symlink(checkout, path.join(storage.path, "alias"), process.platform === "win32" ? "junction" : "dir")
      await fs.writeFile(path.join(storage.path, "file"), "occupied")
      await fs.mkdir(path.join(storage.path, "populated"))
      await fs.writeFile(path.join(storage.path, "populated", "keep.txt"), "user content")
      await fs.mkdir(path.join(storage.path, "foreign"))
      await fs.writeFile(path.join(storage.path, "foreign", ".opencode-mirror-root.json"), JSON.stringify({ version: 1, kind: "someone-elses-root" }))
      for (const [root, code] of [
        [path.join(source.path, "mirrors"), "inside"],
        [path.join(storage.path, "alias"), "inside"],
        [path.join(storage.path, "alias", "mirrors"), "inside"],
        [path.join(storage.path, "file"), "not-folder"],
        [path.join(storage.path, "file", "child"), "not-folder"],
        [path.join(storage.path, "populated"), "unowned"],
        [path.join(storage.path, "foreign"), "unowned"],
      ] as const) {
        await expect(MirrorRoot.prepare({ checkout, root })).rejects.toMatchObject({ code })
      }
      expect(await fs.readdir(source.path)).not.toContain("mirrors")
      expect(await fs.readdir(path.join(storage.path, "populated"))).toEqual(["keep.txt"])
      expect(await fs.readFile(path.join(storage.path, "foreign", ".opencode-mirror-root.json"), "utf8")).toContain("someone-elses-root")
    }))

  it.live("refuses a root without enough free space before creating it", () =>
    Effect.promise(async () => {
      await using source = await tmpdir({ git: true })
      await using storage = await tmpdir()
      const root = path.join(storage.path, "mirror-root")
      await expect(MirrorRoot.prepare({ checkout: source.path, root, minimumFreeBytes: Number.MAX_SAFE_INTEGER }))
        .rejects.toMatchObject({ code: "space" })
      await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" })
    }))

  // Windows has no chmod; the same refusal path is covered there by the
  // not-folder and space cases above.
  const writableLive = process.platform === "win32" ? it.live.skip : it.live
  writableLive("refuses an unwritable root without touching its parent", () =>
    Effect.promise(async () => {
      await using source = await tmpdir({ git: true })
      await using storage = await tmpdir()
      const parent = path.join(storage.path, "locked")
      await fs.mkdir(parent)
      await fs.chmod(parent, 0o500)
      try {
        await expect(MirrorRoot.prepare({ checkout: source.path, root: path.join(parent, "mirror-root") }))
          .rejects.toMatchObject({ code: "unwritable" })
        expect(await fs.readdir(parent)).toEqual([])
      } finally {
        await fs.chmod(parent, 0o700)
      }
    }))

  it.effect("accepts exactly one folder path from a folder_picker answer bound to the same start", () =>
    Effect.sync(() => {
      const root = path.parse(process.cwd()).root
      const input = { childID: "ses_child", checkout: path.join(root, "srv", "repos", "project"), dispatchDigest: "a".repeat(64), refused: "the folder is on another volume" }
      const question = MirrorRoot.choiceQuestion(input)
      expect(question.type).toBe("form")
      expect(question.body?.[0]).toMatchObject({ type: "markdown", content: expect.stringContaining("another volume") })
      const fields = question.form!.fields
      expect(fields.map((field) => [field.id, field.type, field.required])).toEqual([["binding", "hidden", undefined], ["folder", "folder_picker", true]])
      const binding = String(fields[0]!.defaultValue)
      const folder = path.join(root, "oc-mirrors")
      expect(MirrorRoot.chosenPath(formAnswer(question.form!.id, { binding, folder: [folder] }), input)).toBe(folder)
      expect(MirrorRoot.chosenPath(formAnswer(question.form!.id, { binding, folder }), input)).toBe(folder)
      expect(MirrorRoot.chosenPath([[folder]], input)).toBe(folder)
      for (const answers of [
        formAnswer(question.form!.id, { binding: `${binding}drift`, folder: [folder] }),
        formAnswer(question.form!.id, { binding, folder: [folder, path.join(root, "second")] }),
        formAnswer(question.form!.id, { binding, folder: [] }),
        formAnswer(question.form!.id, { binding, folder: ["relative/path"] }),
        [[JSON.stringify({ version: 1, type: "opencode.question.answer", values: { folder: [folder] } })]],
        [[{ type: "file", mime: "text/plain", url: "file:///tmp/upload" }]],
        [],
      ] as const) {
        expect(refusal(answers, input)).toBe("answer")
      }
    }))

  // Without a second volume the case is skipped explicitly; volume selection
  // then stays covered by the pure default-root rule above.
  const volumeLive = otherVolumeRoot ? it.live : it.live.skip
  volumeLive("refuses a root on another volume before creating anything", () =>
    Effect.promise(async () => {
      await using source = await tmpdir({ git: true })
      const root = path.join(otherVolumeRoot!, `opencode-mirror-root-probe-${randomUUID()}`, "root")
      await expect(MirrorRoot.prepare({ checkout: source.path, root })).rejects.toMatchObject({ code: "volume" })
      await expect(fs.stat(path.dirname(root))).rejects.toMatchObject({ code: "ENOENT" })
    }))
})
