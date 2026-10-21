#!/usr/bin/env bun
import path from "path"
import { createClient } from "@hey-api/openapi-ts"

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/v2/gen",
    tsConfigPath: path.resolve("./tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "OpencodeClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})
