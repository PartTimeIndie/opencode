import { createOpencodeClient, createOpencodeServer } from "@opencode-ai/sdk/v2"
import { pathToFileURL } from "bun"

const server = await createOpencodeServer()
const client = createOpencodeClient({ baseUrl: server.url })

const input = await Array.fromAsync(new Bun.Glob("packages/core/*.ts").scan())

const tasks: Array<Promise<unknown>> = []
for await (const file of input) {
  console.log("processing", file)
  const session = await client.v2.session.create({}, { throwOnError: true })
  tasks.push(
    client.v2.session.prompt(
      {
        sessionID: session.data.id,
        prompt: {
          text: "Write tests for every public function in this file.",
          files: [{ uri: pathToFileURL(file).href, mime: "text/plain" }],
        },
      },
      { throwOnError: true },
    ),
  )
  console.log("done", file)
}

await Promise.all(
  input.map(async (file) => {
    const session = await client.v2.session.create({}, { throwOnError: true })
    console.log("processing", file)
    await client.v2.session.prompt(
      {
        sessionID: session.data.id,
        prompt: {
          text: "Write tests for every public function in this file.",
          files: [{ uri: pathToFileURL(file).href, mime: "text/plain" }],
        },
      },
      { throwOnError: true },
    )
    console.log("done", file)
  }),
)
