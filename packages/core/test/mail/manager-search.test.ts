import { expect, test } from "bun:test"
import { gmailSourceLabel, managerArguments } from "../../src/mail/manager-search"

test("Gmail source is an exact label ID or INBOX, never an arbitrary display name", () => {
  const destinations = [{ id: "Label_12", label: "Receipts", kind: "label" as const }]
  expect(gmailSourceLabel(undefined, destinations)).toBe("INBOX")
  expect(gmailSourceLabel("Label_12", destinations)).toBe("Label_12")
  expect(() => gmailSourceLabel("Receipts", destinations)).toThrow("Unknown Gmail label ID")
})

test("search arguments reject ambiguous flags and unbound sessions", () => {
  const args = ["--provider", "gmail", "--directory", "C:/repo", "--session-id", "ses_valid"]
  expect(managerArguments(args).provider).toBe("gmail")
  expect(() => managerArguments([...args, "--subject", "x", "--subject", "y"])).toThrow("duplicate")
  expect(() => managerArguments([...args, "--surprise", "x"])).toThrow("Invalid")
  expect(() => managerArguments([...args.slice(0, -1), "wrong"])).toThrow("Session")
  expect(() => managerArguments([...args.slice(0, 3), "relative", ...args.slice(4)])).toThrow("absolute")
})
