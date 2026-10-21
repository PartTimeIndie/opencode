#!/usr/bin/env bun
import { $ } from "bun"

import { resolveChannel } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

await $`bun ../provider-plugins/build.ts`
await $`bun ../provider-plugins/verify-detached.ts`
await $`bun ../tui-plugins/build.ts`
await $`cd ../opencode && bun script/build-node.ts`
