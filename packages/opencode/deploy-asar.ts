#!/usr/bin/env bun

console.error(
  "FAILED: deploy-asar.ts was retired because partial ASAR replacement can mix old and new application files.",
)
console.error("Use the verified full-package workflow instead:")
console.error("  bun run desktop:deploy prepare")
console.error("  bun run desktop:deploy launch --approved-close --force-close-approved --restart")
process.exit(1)
