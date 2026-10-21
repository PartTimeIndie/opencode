import { execFile } from "node:child_process"
import { join } from "node:path"
import { homedir } from "node:os"

export async function appPassword(secretID: string, cli = join(homedir(), "AppData", "Local", "Programs", "bws", "bws.exe")) {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(secretID)) throw new Error("Invalid BWS secret ID")
  if (!process.env.BWS_ACCESS_TOKEN) throw new Error("BWS access is not available to the mail backend")
  const output = await new Promise<string>((resolve, reject) =>
    execFile(cli, ["secret", "get", secretID, "--output", "json"], {
      windowsHide: true, timeout: 15_000, maxBuffer: 16_384, encoding: "utf8",
    }, (error, stdout) => error ? reject(new Error("Unable to resolve GMX credentials from BWS")) : resolve(stdout)),
  )
  // Never expose parser errors: they can include excerpts of a secret returned by the CLI.
  const parsed: unknown = await Promise.resolve().then(() => JSON.parse(output)).catch(() => {
    throw new Error("Invalid BWS credential response")
  })
  if (!parsed || typeof parsed !== "object" || !("value" in parsed) || typeof parsed.value !== "string" || !parsed.value)
    throw new Error("GMX credential is missing in BWS")
  return parsed.value
}
