import path from "node:path"
import { mkdir } from "node:fs/promises"

export const MAX_RECORDING_BYTES = 2 * 1024 * 1024

/** A loopback-only, explicit recording fixture; no audio is sent to a provider here. */
export function speechRecorderHandler(input: {
  token: string
  save: (audio: Uint8Array, mimeType: string) => Promise<void>
}) {
  return async (request: Request) => {
    const url = new URL(request.url)
    if (url.hostname !== "127.0.0.1" || !/^[a-f0-9]{32}$/.test(input.token)) return new Response(null, { status: 403 })
    const origin = request.headers.get("origin")
    if (origin && origin !== url.origin) return new Response(null, { status: 403 })
    if (url.pathname !== `/${input.token}`) return new Response(null, { status: 404 })
    if (request.method === "GET")
      return new Response(recorderPage, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        },
      })
    if (request.method !== "POST") return new Response(null, { status: 405 })
    const mimeType = request.headers.get("content-type") ?? ""
    if (!/^audio\/(webm|ogg|mp4)(;.*)?$/i.test(mimeType)) return new Response("Unsupported audio", { status: 415 })
    if (Number(request.headers.get("content-length")) > MAX_RECORDING_BYTES) return new Response(null, { status: 413 })
    if (!request.body) return new Response(null, { status: 400 })
    const reader = request.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_RECORDING_BYTES) {
        await reader.cancel()
        return new Response(null, { status: 413 })
      }
      chunks.push(chunk.value)
    }
    if (!bytes) return new Response(null, { status: 400 })
    await input.save(Buffer.concat(chunks), mimeType)
    return Response.json({ ok: true, bytes }, { headers: { "cache-control": "no-store" } })
  }
}

const recorderPage = `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Diktat-Geschwindigkeit testen</title><style>
body{font:17px/1.6 system-ui;color:#eee;background:#17191d;max-width:660px;margin:8vh auto;padding:24px}button,a{font:inherit}button{padding:12px 20px;margin:8px 8px 8px 0;border:0;border-radius:8px;cursor:pointer}button:disabled{opacity:.5;cursor:default}#start{background:#e8e8e8;color:#17191d}#stop{background:#e8b6b6;color:#17191d}audio{display:block;margin:20px 0;width:100%}a{color:#c8dcff}#status{min-height:3em}
</style><h1>Kurze Testaufnahme</h1><p>Sprich bitte 15–30 Sekunden auf Deutsch mit ein paar englischen Fachbegriffen. Die Aufnahme bleibt zunächst <strong>lokal auf diesem Rechner</strong>. Danach wird genau diese Datei für den von dir beauftragten Anbieter-Vergleich verwendet.</p>
<button id="start">Aufnahme starten</button><button id="stop" disabled>Stoppen und lokal speichern</button><p id="status" role="status">Bereit. Maximal 60 Sekunden.</p><audio id="preview" controls hidden></audio><a id="download" hidden>Aufnahme herunterladen</a>
<script>
const start=document.getElementById('start'),stop=document.getElementById('stop'),status=document.getElementById('status'),preview=document.getElementById('preview'),download=document.getElementById('download');
let recorder,stream,timer,objectURL;
start.onclick=async()=>{start.disabled=true;status.textContent='Mikrofon wird angefragt …';try{stream=await navigator.mediaDevices.getUserMedia({audio:true});const chunks=[];recorder=new MediaRecorder(stream);recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};recorder.onstop=async()=>{clearTimeout(timer);stream.getTracks().forEach(t=>t.stop());stop.disabled=true;const audio=new Blob(chunks,{type:recorder.mimeType});if(objectURL)URL.revokeObjectURL(objectURL);objectURL=URL.createObjectURL(audio);preview.src=objectURL;preview.hidden=false;download.href=objectURL;download.download='speech-benchmark.'+(audio.type.includes('mp4')?'m4a':audio.type.includes('ogg')?'ogg':'webm');download.hidden=false;status.textContent='Wird lokal gespeichert …';try{const response=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':audio.type},body:audio});if(!response.ok)throw new Error('Speichern fehlgeschlagen: '+response.status);status.textContent='Aufnahme gespeichert. Du kannst jetzt zu OpenCode zurückkehren.'}catch(error){status.textContent=error.message+' – bitte die Aufnahme herunterladen.'}start.disabled=false};recorder.start();stop.disabled=false;status.textContent='Aufnahme läuft. Bitte 15–30 Sekunden sprechen.';timer=setTimeout(()=>recorder.state==='recording'&&recorder.stop(),60000)}catch(error){stream?.getTracks().forEach(t=>t.stop());status.textContent=error.message;start.disabled=false}};
stop.onclick=()=>{if(recorder?.state==='recording')recorder.stop()};window.addEventListener('pagehide',()=>stream?.getTracks().forEach(t=>t.stop()));
</script></html>`

if (import.meta.main) {
  const directory = path.resolve(Bun.argv[2] ?? ".agent-tmp/speech-benchmark")
  await mkdir(directory, { recursive: true })
  const token = crypto.randomUUID().replaceAll("-", "")
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: MAX_RECORDING_BYTES,
    fetch: speechRecorderHandler({
      token,
      save: async (audio, mimeType) => {
        await Bun.write(path.join(directory, "recording.audio"), audio)
        await Bun.write(
          path.join(directory, "recording.json"),
          JSON.stringify({ mimeType, bytes: audio.byteLength, recordedAt: new Date().toISOString() }),
        )
        console.log(JSON.stringify({ event: "saved", bytes: audio.byteLength }))
      },
    }),
  })
  const info = { url: `http://127.0.0.1:${server.port}/${token}`, pid: process.pid, directory }
  await Bun.write(path.join(directory, "server.json"), JSON.stringify(info))
  console.log(JSON.stringify(info))
}
