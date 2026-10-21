import { expect, test } from "bun:test"
import { Effect } from "effect"
import { ImageGeneration } from "@opencode-ai/core/image-generation"

test("project icon thumbnail is bounded to 128 pixels", async () => {
  const photon = await import("@silvia-odwyer/photon-node")
  const source = new photon.PhotonImage(
    new Uint8Array(Array.from({ length: 256 * 256 * 4 }, (_, index) => (index % 4 === 3 ? 255 : index % 251))),
    256,
    256,
  )
  const result = await Effect.runPromise(
    ImageGeneration.thumbnail(
      { data: source.get_bytes(), mime: "image/png", filename: "generated.png" },
      128,
    ),
  )
  const thumbnail = photon.PhotonImage.new_from_byteslice(result.data)

  source.free()
  expect(thumbnail.get_width()).toBe(128)
  expect(thumbnail.get_height()).toBe(128)
  expect(result.mime).toBe("image/png")
  thumbnail.free()
})
