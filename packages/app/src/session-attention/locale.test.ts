import { expect, test } from "bun:test"
import { dict as en } from "@/i18n/en"
import { dict as de } from "@/i18n/de"

test("important-session labels have English and German copy", () => {
  for (const key of Object.keys(en).filter((key) => key.startsWith("session.attention."))) {
    expect(de[key as keyof typeof de]).toBeTruthy()
    expect(de[key as keyof typeof de]).not.toBe(en[key as keyof typeof en])
  }
})
