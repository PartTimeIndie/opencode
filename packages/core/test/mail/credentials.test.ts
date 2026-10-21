import { expect, test } from "bun:test"
import { appPassword } from "../../src/mail/credentials"

test("BWS lookup rejects malformed IDs before invoking a process", async () => {
  await expect(appPassword("$(echo secret)", "missing.exe")).rejects.toThrow("Invalid BWS secret ID")
})

test("missing BWS authentication fails closed without exposing credentials", async () => {
  const previous = process.env.BWS_ACCESS_TOKEN
  delete process.env.BWS_ACCESS_TOKEN
  try {
    await expect(appPassword("12345678-1234-1234-1234-123456789abc", "missing.exe"))
      .rejects.toThrow("BWS access is not available")
  } finally {
    if (previous === undefined) delete process.env.BWS_ACCESS_TOKEN
    else process.env.BWS_ACCESS_TOKEN = previous
  }
})
