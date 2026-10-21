#!/usr/bin/env bun
import { writeFileSync } from "node:fs"
import { resolveChannel } from "./utils"

// Written at the end of every desktop build so deploy-asar.ts can refuse
// to pack a dev-channel renderer into the installed production app.
const channel = resolveChannel()
writeFileSync(new URL("../out/.build-channel", import.meta.url), `${channel}\n`, "utf8")
console.log(`stamped build channel: ${channel}`)
