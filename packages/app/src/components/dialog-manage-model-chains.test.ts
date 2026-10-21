import { expect, test } from "bun:test"

test("model chain editor uses a bounded ScrollView with a persistent, themed overflow thumb", async () => {
  const source = await Bun.file(new URL("./dialog-manage-model-chains.tsx", import.meta.url)).text()
  const body = source.match(/<Dialog\b[^>]*>\s*<ScrollView class="([^"]+)"/)?.[1].split(/\s+/) ?? []
  // The dialog body clips overflow, so its scroll owner must shrink. Real layout,
  // thumb visibility and editing are covered by the Playwright regression.
  expect(body).toContain("min-h-0")
  expect(body).toContain("flex-1")
  expect(body).toContain("model-chain-editor")
  expect(source).toContain('import "./dialog-manage-model-chains.css"')
  const stylesheet = new CSSStyleSheet()
  stylesheet.replaceSync(await Bun.file(new URL("./dialog-manage-model-chains.css", import.meta.url)).text())
  const rules = Array.from(stylesheet.cssRules).filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
  expect(
    rules
      .find((rule) => rule.selectorText === ".model-chain-editor .scroll-view__viewport")
      ?.style.getPropertyValue("overscroll-behavior"),
  ).toBe("contain")
  expect(rules.find((rule) => rule.selectorText === ".model-chain-editor .scroll-view__thumb")?.style.opacity).toBe("1")
  const thumb = rules.find((rule) => rule.selectorText === ".model-chain-editor .scroll-view__thumb::after")
  expect(thumb?.style.width).toBe("6px")
  expect(thumb?.style.backgroundColor).toBe("var(--text-weak)")
})
