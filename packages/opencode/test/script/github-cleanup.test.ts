import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { requireRepository } from "../../../../script/github/repository"

const root = fileURLToPath(new URL("../../../../", import.meta.url))

async function runCleanup(script: string, repository: string, args: string[] = []) {
  const dir = await mkdtemp(path.join(tmpdir(), "github-cleanup-"))
  try {
    const preload = path.join(dir, "fetch.ts")
    // Only replace the external API boundary. Run the real scripts and argument parser.
    await Bun.write(
      preload,
      `globalThis.fetch = async (input, init) => {
        const url = String(input)
        console.log("REQUEST " + JSON.stringify({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined }))
        if (url.endsWith("/graphql")) return Response.json({ data: {
          rateLimit: { cost: 1, remaining: 5000, resetAt: new Date().toISOString() },
          repository: { pullRequests: { nodes: [{
            number: 42, title: "Old PR", url: "https://example.test/pull/42", createdAt: "2000-01-01T00:00:00Z",
            reactionGroups: [], labels: { nodes: [] }
          }], pageInfo: { hasNextPage: false, endCursor: null } } }
        } })
        if (url.includes("/issues?")) return Response.json(url.endsWith("page=1") ? [{ number: 42, updated_at: "2000-01-01T00:00:00Z" }] : [])
        return Response.json({})
      }`,
    )
    const proc = Bun.spawn([process.execPath, "--preload", preload, `script/github/${script}.ts`, ...args], {
      cwd: root,
      env: { ...process.env, GITHUB_REPOSITORY: repository, GITHUB_TOKEN: "test-token", GH_TOKEN: "" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const requests = stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("REQUEST "))
      .map((line) => JSON.parse(line.slice(8)) as { url: string; method: string; body?: unknown })
    return { stdout, stderr, code, requests }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("cleanup repository", () => {
  test("accepts a fork or an explicitly selected repository", () => {
    expect(requireRepository("PartTimeIndie/opencode")).toEqual({ owner: "PartTimeIndie", name: "opencode" })
    expect(requireRepository("my-team/.github")).toEqual({ owner: "my-team", name: ".github" })
  })

  test.each([
    undefined,
    "",
    "opencode",
    "/opencode",
    "owner/",
    "owner/repo/extra",
    "owner/..",
    "owner/.",
    "owner/repo?x=1",
    "owner/repo\n",
  ])("rejects a missing or unsafe repository: %s", (value) => {
    expect(() => requireRepository(value)).toThrow()
  })

  test("issue listing, comments and closes all target the workflow repository", async () => {
    const result = await runCleanup("close-issues", "PartTimeIndie/opencode")
    expect(result.stderr).toBe("")
    expect(result.code).toBe(0)
    expect(result.requests.map((request) => request.method)).toEqual(["GET", "POST", "PATCH", "GET"])
    expect(
      result.requests.every((request) =>
        request.url.startsWith("https://api.github.com/repos/PartTimeIndie/opencode/issues"),
      ),
    ).toBe(true)
    expect(result.requests[1].url).toEndWith("/42/comments")
    expect(result.requests[2].body).toEqual({ state: "closed", state_reason: "not_planned" })
  })

  test("PR cleanup queries the workflow repository and stays dry-run by default", async () => {
    const result = await runCleanup("close-prs", "PartTimeIndie/opencode")
    expect(result.stderr).toBe("")
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("DRY RUN: PR cleanup for PartTimeIndie/opencode")
    expect(result.stdout).toContain("Showing 1 of 1 matching PRs")
    expect(result.requests).toHaveLength(1)
    expect(result.requests[0].body).toMatchObject({ variables: { owner: "PartTimeIndie", name: "opencode" } })
  })

  test("PR cleanup still accepts an explicit local repository", async () => {
    const result = await runCleanup("close-prs", "", ["--repo", "my-team/my-repo"])
    expect(result.code).toBe(0)
    expect(result.requests[0].body).toMatchObject({ variables: { owner: "my-team", name: "my-repo" } })
  })

  test("PR cleanup writes only to the selected repository when explicitly executed", async () => {
    const result = await runCleanup("close-prs", "PartTimeIndie/opencode", ["--execute", "--sleep-ms", "0"])
    expect(result.stderr).toBe("")
    expect(result.code).toBe(0)
    expect(result.requests.map((request) => request.method)).toEqual(["POST", "GET", "POST", "PATCH", "POST"])
    expect(
      result.requests
        .slice(1)
        .every((request) => request.url.startsWith("https://api.github.com/repos/PartTimeIndie/opencode/")),
    ).toBe(true)
    expect(result.requests[3].url).toEndWith("/pulls/42")
    expect(result.requests[3].body).toEqual({ state: "closed" })
  })

  for (const script of ["close-issues", "close-prs"]) {
    test.each(["", "owner/repo/extra"])(`${script} fails before any request for repository %s`, async (repository) => {
      const result = await runCleanup(script, repository)
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain(repository ? "Invalid repository" : "Repository is required")
      expect(result.requests).toEqual([])
    })
  }
})
