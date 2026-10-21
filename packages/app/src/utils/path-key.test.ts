import { expect, test } from "bun:test"
import { projectDirectoryKey } from "./path-key"

test("project identity normalizes Windows aliases without folding POSIX case", () => {
  expect(projectDirectoryKey("C:\\Projects\\PU\\.\\")).toBe(projectDirectoryKey("c:/projects/pu"))
  expect(projectDirectoryKey("C:/")).toBe("c:/")
  expect(projectDirectoryKey("/work/PU")).not.toBe(projectDirectoryKey("/work/pu"))
  expect(projectDirectoryKey("//Host/Share/../PU")).toBe("//host/pu")
})
