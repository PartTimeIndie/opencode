const chunkBytes = 0x7ffe

export function encodeAudioBase64(audio: Uint8Array) {
  return Array.from({ length: Math.ceil(audio.length / chunkBytes) }, (_, index) => {
    const start = index * chunkBytes
    return btoa(String.fromCharCode(...audio.subarray(start, start + chunkBytes)))
  }).join("")
}
