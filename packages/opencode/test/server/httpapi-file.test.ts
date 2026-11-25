import { afterEach, describe, expect, test } from "bun:test"
import { Context } from "effect"
import path from "path"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { ignoreEntryPath } from "../../src/server/routes/instance/httpapi/handlers/file"
import { FilePaths } from "../../src/server/routes/instance/httpapi/groups/file"
import { InstancePaths } from "../../src/server/routes/instance/httpapi/groups/instance"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, query?: Record<string, string>) {
  const url = new URL(`http://localhost${route}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value)
  }
  return HttpApiApp.webHandler().handler(
    new Request(url, {
      headers: {
        "x-opencode-directory": directory,
      },
    }),
    context,
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("file HttpApi", () => {
  test("serves read endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "hello")

    const [instance, list, content, status] = await Promise.all([
      request(InstancePaths.path, tmp.path),
      request(FilePaths.list, tmp.path, { path: "." }),
      request(FilePaths.content, tmp.path, { path: "hello.txt" }),
      request(FilePaths.status, tmp.path),
    ])

    expect(instance.status).toBe(200)
    expect(list.status).toBe(200)
    expect(await list.json()).toContainEqual(
      expect.objectContaining({ name: "hello.txt", path: "hello.txt", type: "file" }),
    )

    expect(content.status).toBe(200)
    expect(await content.json()).toMatchObject({ type: "text", content: "hello" })

    expect(status.status).toBe(200)
    expect(await status.json()).toEqual([])
  })

  test("serves search endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "needle")

    const [text, files, symbols] = await Promise.all([
      request(FilePaths.findText, tmp.path, { pattern: "needle" }),
      request(FilePaths.findFile, tmp.path, { query: "hello", type: "file" }),
      request(FilePaths.findSymbol, tmp.path, { query: "hello" }),
    ])

    expect(text.status).toBe(200)
    expect(await text.json()).toContainEqual(expect.objectContaining({ line_number: 1 }))

    expect(files.status).toBe(200)
    expect(await files.json()).toContain("hello.txt")

    expect(symbols.status).toBe(200)
    expect(await symbols.json()).toEqual([])
  })
})

describe("ignoreEntryPath", () => {
  test("prefers the project-relative path for matching ignore rules", () => {
    const key = ignoreEntryPath({
      projectDirectory: "C:/repo",
      directory: "C:/repo/worktree",
      absolute: "C:/repo/worktree/node_modules",
      isDirectory: true,
      pathModule: path.posix,
    })
    expect(key).toBe("worktree/node_modules/")
  })

  test("falls back to the instance-relative path when roots cannot be relativized", () => {
    // Windows mount/drive aliases can expose one checkout under two roots; the
    // ignore library throws a RangeError for the absolute path path.relative
    // returns in that case, so the key must stay relative to the instance.
    const key = ignoreEntryPath({
      projectDirectory: "E:\\GitRepros\\opencode",
      directory: "C:\\GitRepros\\opencode",
      absolute: "C:\\GitRepros\\opencode\\.agent-tmp",
      isDirectory: true,
      pathModule: path.win32,
    })
    expect(key).toBe(".agent-tmp/")
    expect(path.win32.isAbsolute(key)).toBe(false)
  })

  test("appends the directory suffix only for directories", () => {
    const file = ignoreEntryPath({
      projectDirectory: "C:/repo",
      directory: "C:/repo",
      absolute: "C:/repo/hello.txt",
      isDirectory: false,
      pathModule: path.posix,
    })
    const dir = ignoreEntryPath({
      projectDirectory: "C:/repo",
      directory: "C:/repo",
      absolute: "C:/repo/hello",
      isDirectory: true,
      pathModule: path.posix,
    })
    expect(file).toBe("hello.txt")
    expect(dir).toBe("hello/")
  })
})
