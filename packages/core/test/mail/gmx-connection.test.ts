import { expect, test } from "bun:test"
import type { ImapFlowOptions } from "imapflow"
import { inboxConnectionOptions } from "../../src/mail/gmx"

test("GMX connection options pin the custom client identity and LOGIN auth", () => {
  // Compile-time compatibility: an imapflow upgrade that drops or renames
  // loginMethod/clientInfo must fail typecheck instead of silently ignoring them.
  const options: ImapFlowOptions = inboxConnectionOptions(
    { id: "gmx-test", name: "test", email: "user@gmx.de", secretID: "00000000-0000-0000-0000-000000000000", enabled: true },
    "secret-password",
  )
  // GMX rejects logins when the connection identified itself as ImapFlow via IMAP ID beforehand
  expect(options.clientInfo?.name).toBe("opencode-mail")
  expect(options.clientInfo?.vendor).toBe("opencode")
  // GMX rejects AUTHENTICATE PLAIN for this account's app passwords; only LOGIN is accepted
  expect(options.auth?.loginMethod).toBe("LOGIN")
  expect(options.host).toBe("imap.gmx.net")
  expect(options.port).toBe(993)
  expect(options.secure).toBe(true)
})
