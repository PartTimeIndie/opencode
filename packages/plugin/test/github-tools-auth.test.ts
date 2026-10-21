import { describe, expect, test } from "bun:test"
import { githubFetch as searchGithub } from "../../../.opencode/tools/github-pr-search"
import { githubFetch as triageGithub } from "../../../.opencode/tools/github-triage"

describe("GitHub tool authentication", () => {
  test("search omits authorization when no token is configured", async () => {
    const requests: RequestInit[] = []
    await searchGithub(
      "/search/issues?q=public",
      { headers: { Authorization: "Bearer stale-token" } },
      async (_input, init) => {
        requests.push(init ?? {})
        return Response.json({ total_count: 0, items: [] })
      },
      "",
    )

    expect(new Headers(requests[0]?.headers).has("Authorization")).toBe(false)
  })

  test("search sends the configured token", async () => {
    const requests: RequestInit[] = []
    await searchGithub(
      "/search/issues?q=authenticated",
      { headers: { Authorization: "Bearer stale-token" } },
      async (_input, init) => {
        requests.push(init ?? {})
        return Response.json({ total_count: 0, items: [] })
      },
      " github-token ",
    )

    expect(new Headers(requests[0]?.headers).get("Authorization")).toBe("Bearer github-token")
  })

  test("triage without a token fails before a mutating request", async () => {
    const requests: RequestInit[] = []
    const result = triageGithub(
      "/repos/anomalyco/opencode/issues/1/assignees",
      { method: "POST", body: JSON.stringify({ assignees: ["Hona"] }) },
      async (_input, init) => {
        requests.push(init ?? {})
        return Response.json({})
      },
      "   ",
    )

    await expect(result).rejects.toThrow("GITHUB_TOKEN env var is required to assign GitHub issues")
    expect(requests).toHaveLength(0)
  })

  test("triage uses the validated token for its mutating request", async () => {
    const requests: RequestInit[] = []
    await triageGithub(
      "/repos/anomalyco/opencode/issues/1/assignees",
      {
        method: "POST",
        headers: { Authorization: "Bearer stale-token", "X-Test": "preserved" },
        body: JSON.stringify({ assignees: ["Hona"] }),
      },
      async (_input, init) => {
        requests.push(init ?? {})
        return Response.json({})
      },
      " github-token ",
    )

    expect(new Headers(requests[0]?.headers).get("Authorization")).toBe("Bearer github-token")
    expect(new Headers(requests[0]?.headers).get("X-Test")).toBe("preserved")
  })
})
