# Kurz anhören

One explicit click in the lower composer toolbar turns the last agent result
and open questions/permissions into a short natural spoken update. No automatic
completion announcement, microphone, live conversation, auxiliary agent session,
question answer or permission grant.

Configure a summary model/chain and a speech-capable model/chain in plugin
Settings. Summary defaults to the configured text chain; speech must be chosen
explicitly unless only one matching target exists. German, approximately 60
words/two to three sentences and speed 1 are defaults. Duration depends on voice.
The summary model receives only the bounded visible context; TTS only the short
spoken text. Providers can be external/paid; no provider or credential is baked in.

Switching session/project tabs leaves the selected source playing. Another
listen click replaces it; the stop button remains reachable in other composers.
Toolbar unmount releases only UI listeners, not the audio owner. Plugin unload
or server switch stops requests, streams and audio. The public session-context
fingerprint is rechecked before TTS and again before playback so a delayed result
does not speak an already-answered question. Once started, audio is a captured
snapshot, not live commentary.

Commands: `spoken-summary.listen`, `spoken-summary.stop`, `spoken-summary.show`.
Show opens an optional popup with the text and repeat/stop controls, not a dock.
The single cached successful buffer is RAM-only, revalidated on each listen and
invalidated by settings changes/unload. `cacheEnabled: false` disables the speed
optimization; it does not disable tests or other safety checks.

The implementation consumes only public app APIs; no privileged plugin ID,
private imports, `client`, `host:sessions`, microphone or permission reply access.
The [context API](../../../docs/plugins/session-context.md) is reusable by every
plugin with `host:session-context`. Missing host support produces an update hint,
never a DOM scrape or an original-report read-aloud fallback.

Behavior tests are included by `packages/app/src/plugin/spoken-summary.test.ts`;
the lifecycle test covers source-independent Stop and toolbar unmount. The
Playwright regression exercises real plugin mounting/WebAudio and multiple tabs
at desktop/mobile viewports. Synthetic silent PCM is a deterministic interaction
fixture, **not** evidence of live provider speech or installed Windows output.

Use durable source and the repository sync/release process. Never stop/restart
the installed app without explicit current permission and never call source-only
changes deployed. Rollback: disable the plugin or hide its toolbar item; no DB
migration or persistent chat/audio cache must be restored.
