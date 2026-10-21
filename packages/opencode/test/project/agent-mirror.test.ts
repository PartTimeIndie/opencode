import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { AgentMirror } from "../../src/project/agent-mirror"
import { tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"

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
        import { AgentMirror } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/project/agent-mirror.ts"))};
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
})
