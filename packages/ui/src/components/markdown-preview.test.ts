import { describe, expect, test } from "bun:test"
import {
  loadMarkdownPreview,
  loadMarkdownPreviewImage,
  markdownPreviewBody,
  markdownPreviewFilename,
  markdownPreviewMaxBytes,
  markdownPreviewTarget,
} from "./markdown-preview"

const base = "http://localhost:4457/project/session/ses_test"

describe("Markdown preview loading", () => {
  test("reads relative project links through the scoped file reader, without web requests", async () => {
    const paths: string[] = []
    const text = await loadMarkdownPreview({
      href: "docs/project%20history.md#entries",
      base,
      readFile: async (path) => {
        paths.push(path)
        return { type: "text", content: "# History" }
      },
      fetch: async () => {
        throw new Error("must not fetch a renderer route")
      },
    })
    expect(paths).toEqual(["docs/project history.md"])
    expect(text).toBe("# History")
  })

  test("also works from the installed renderer's non-HTTP origin", async () => {
    expect(
      await loadMarkdownPreview({
        href: "./history.md?raw=1",
        base: "oc://renderer/index.html",
        readFile: async (path) => ({ type: "text", content: path }),
      }),
    ).toBe("history.md")
  })

  test("rejects traversal, malformed encoding, and Windows drives before any file read", async () => {
    for (const href of [
      "../history.md",
      "docs/../../history.md",
      "..%5Csecret.md",
      "..%2Fsecret.md",
      "docs/%ZZ.md",
      "%E0%A4%A.md",
      "C:/notes.md",
      "C:\\notes.md",
      "C:/docs/../notes.md",
      "C%3A%2Fnotes.md",
      "/C:/notes.md",
    ]) {
      await expect(
        loadMarkdownPreview({
          href,
          base,
          readFile: async () => {
            throw new Error("unexpected file read")
          },
          fetch: async () => {
            throw new Error("unexpected fetch")
          },
        }),
      ).rejects.toThrow("Unsupported Markdown preview path")
    }
  })

  test("normalizes project-relative spellings for the scoped file reader", async () => {
    const paths: string[] = []
    for (const href of ["./history.md?raw=1", "/history.md#entries", "docs/./history.md", "docs/a/./b.md"]) {
      await loadMarkdownPreview({
        href,
        base,
        readFile: async (path) => {
          paths.push(path)
          return { type: "text", content: path }
        },
      })
    }
    expect(paths).toEqual(["history.md", "history.md", "docs/history.md", "docs/a/b.md"])
  })

  test("does not fall back to a UI route for missing or binary project files", async () => {
    for (const file of [
      undefined,
      { type: "binary" as const, content: "AA==", encoding: "base64" as const },
      { type: "text" as const, content: "AA==", encoding: "base64" as const },
    ]) {
      await expect(
        loadMarkdownPreview({
          href: "history.md",
          base,
          readFile: async () => file,
          fetch: async () => {
            throw new Error("unexpected fetch")
          },
        }),
      ).rejects.toThrow("could not be read as text")
    }
  })

  test("preserves file-reader errors instead of trying another origin", async () => {
    await expect(
      loadMarkdownPreview({
        href: "history.md",
        base,
        readFile: async () => {
          throw new Error("Access denied")
        },
      }),
    ).rejects.toThrow("Access denied")
  })

  test("fetches remote Markdown without using the local file API or cross-origin credentials", async () => {
    for (const href of ["https://example.com/history.md", "//example.com/history.md"]) {
      const requests: { url: string; credentials: RequestCredentials | undefined }[] = []
      expect(
        await loadMarkdownPreview({
          href,
          base,
          readFile: async () => {
            throw new Error("unexpected file read")
          },
          fetch: async (url, init) => {
            requests.push({ url: String(url), credentials: init?.credentials })
            return new Response("# Remote")
          },
        }),
      ).toBe("# Remote")
      expect(requests).toEqual([
        { url: href.startsWith("https") ? href : "http://example.com/history.md", credentials: "omit" },
      ])
    }
  })

  test("does not fetch project-relative links without a session file reader", async () => {
    await expect(
      loadMarkdownPreview({
        href: "/history.md",
        base,
        fetch: async () => {
          throw new Error("unexpected fetch")
        },
      }),
    ).rejects.toThrow("needs a session file reader")
  })

  test("rejects unsafe schemes without invoking either transport", async () => {
    for (const href of ["file:///tmp/history.md", "javascript:history.md", "data:text/plain,history.md"]) {
      await expect(
        loadMarkdownPreview({
          href,
          base,
          readFile: async () => {
            throw new Error("unexpected file read")
          },
          fetch: async () => {
            throw new Error("unexpected fetch")
          },
        }),
      ).rejects.toThrow("Unsupported Markdown preview URL")
    }
  })

  test("reports HTTP failures", async () => {
    await expect(
      loadMarkdownPreview({
        href: "https://example.com/history.md",
        base,
        fetch: async () => new Response("", { status: 404 }),
      }),
    ).rejects.toThrow("status 404")
  })

  test("resolves nested remote links without reading project files", async () => {
    expect(markdownPreviewTarget("next.md", base, "https://example.com/docs/index.md").url?.href).toBe(
      "https://example.com/docs/next.md",
    )
    expect(
      await loadMarkdownPreview({
        href: "next.md",
        base,
        source: "https://example.com/docs/index.md",
        readFile: async () => {
          throw new Error("unexpected read")
        },
        fetch: async (url) => {
          expect(url.href).toBe("https://example.com/docs/next.md")
          return new Response("# Next")
        },
      }),
    ).toBe("# Next")
    expect(markdownPreviewTarget("next.md", base).path).toBe("next.md")
  })

  test("includes credentials only for a matching renderer origin", async () => {
    expect(
      await loadMarkdownPreview({
        href: "http://localhost:4457/history.md",
        base,
        fetch: async (_url, init) => {
          expect(init.credentials).toBe("include")
          return new Response("# Same origin")
        },
      }),
    ).toBe("# Same origin")
  })

  test("invalid network bases fail with a controlled error", async () => {
    await expect(
      loadMarkdownPreview({
        href: "https://example.com/history.md",
        base: "not a URL",
        fetch: async () => {
          throw new Error("unexpected fetch")
        },
      }),
    ).rejects.toThrow("Unsupported Markdown preview URL")
  })

  test("aborted loads never read a file or fetch, and delayed reads respect cancellation", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      loadMarkdownPreview({
        href: "history.md",
        base,
        signal: controller.signal,
        readFile: async () => {
          throw new Error("unexpected read")
        },
      }),
    ).rejects.toHaveProperty("name", "AbortError")
    const delayed = new AbortController()
    await expect(
      loadMarkdownPreview({
        href: "history.md",
        base,
        signal: delayed.signal,
        readFile: async () => {
          delayed.abort()
          return { type: "text", content: "# Late" }
        },
      }),
    ).rejects.toHaveProperty("name", "AbortError")
  })

  test("passes cancellation to network fetches", async () => {
    const controller = new AbortController()
    await loadMarkdownPreview({
      href: "https://example.com/history.md",
      base,
      signal: controller.signal,
      fetch: async (_url, init) => {
        expect(init.signal).toBe(controller.signal)
        return new Response("# Done")
      },
    })
  })

  test("rejects oversized local and remote documents before Markdown parsing", async () => {
    const content = "x".repeat(markdownPreviewMaxBytes + 1)
    await expect(
      loadMarkdownPreview({ href: "history.md", base, readFile: async () => ({ type: "text", content }) }),
    ).rejects.toThrow("too large")
    await expect(
      loadMarkdownPreview({ href: "https://example.com/history.md", base, fetch: async () => new Response(content) }),
    ).rejects.toThrow("too large")
  })

  test("loads preview-owned local images and remote siblings through separate boundaries", async () => {
    const signal = new AbortController().signal
    expect(
      await loadMarkdownPreviewImage({
        href: "images/card.png",
        base,
        signal,
        readFile: async (path) => {
          expect(path).toBe("images/card.png")
          return { type: "binary", encoding: "base64", content: "AA==", mimeType: "image/png" }
        },
      }),
    ).toBe("data:image/png;base64,AA==")
    expect(
      await loadMarkdownPreviewImage({
        href: "images/card.png",
        base,
        source: "https://example.com/docs/index.md",
        signal,
        readFile: async () => {
          throw new Error("unexpected read")
        },
      }),
    ).toBe("https://example.com/docs/images/card.png")
    await expect(
      loadMarkdownPreviewImage({
        href: "..%5Csecret.png",
        base,
        signal,
        readFile: async () => {
          throw new Error("unexpected read")
        },
      }),
    ).rejects.toThrow("Unsupported Markdown preview path")
  })

  test("strips only closed frontmatter and keeps filename query/hash out of downloads", () => {
    expect(markdownPreviewBody("---\ntitle: hidden\n---\n# Body")).toBe("# Body")
    expect(markdownPreviewBody("---\ntitle: open\n# Body")).toBe("---\ntitle: open\n# Body")
    expect(markdownPreviewFilename("docs/project%20history.md?raw=1#section")).toBe("project history.md")
  })
})
