# Kurz anhören

One explicit click in the lower composer toolbar turns the last agent result
and open questions/permissions into a short natural spoken update. No automatic
completion announcement, microphone, live conversation, auxiliary agent session,
question answer or permission grant.

Configure a summary model/chain and a speech-capable model/chain in plugin
Settings. Summary defaults to the configured text chain; speech must be chosen
explicitly unless only one matching target exists. German, at most 40 words and
speed 0.9 are defaults. The configurable word limit is 30–60 and is enforced
without overflow tolerance, including on the single correction attempt. Older
saved word limits above 60 are bounded to 60; explicit saved speed/language
choices are preserved. Duration depends on voice.
The summary model receives only the bounded visible context; TTS only the short
spoken text. Providers can be external/paid; no provider or credential is baked in.

## Spoken summary contract

Use simple language: result first, then only the important blocker and at most
two concrete next steps with an explicit owner (agent or user). For blocked work,
explain what stopped progress and why, using only evidenced reasons. Distinguish
technical obstacles, missing approval and a check explicitly deferred by the
user; acknowledge unknown causes rather than guessing. Never invent user work
or use vague “clarify/check/approve” instructions without their object and purpose.
Omit test inventories, individual counts, paths and internal jargon, not material
failures, missing checks or approvals. Completed implementation is not completed
live acceptance. Examples in the prompt illustrate style only, never session facts.
Actual pending questions/permissions and bounded-context warnings remain binding.

The voice dropdown uses the selected model's current `supported_voices` catalogue;
for an explicit chain it lists the voices of every step and identifies supporting
models. Language labels come from locale prefixes in voice IDs, not listening
tests or quality scores. Other languages and explicit custom IDs remain allowed.
Unknown saved IDs are retained with an unverified/unsupported hint. Opening the
settings or changing the model never silently replaces the saved voice.

“Sprache der Zusammenfassung” controls text, not pronunciation. Entries under
“Stimmen pro Modell” override the main voice for their model. An empty or
unsupported voice may use that model's provider default, possibly in another
language. A German ID does not prove accent-free speech: verify the actual
model/voice and privately listen to real returned audio on varied normal texts.
There is no automatic language gate or permanent preview/evaluation feature.
See the [public voice field contract](../../../docs/plugins/voice-settings.md).

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

Use durable source and scoped `bun run sync:plugins --only=spoken-summary-app`.
Compare and preserve runtime-only edits before sync, which replaces that runtime
directory; never regenerate unrelated plugins for this change. Never stop/restart
the installed app without explicit current permission and never call source-only
changes deployed. Rollback: disable the plugin or hide its toolbar item; no DB
migration or persistent chat/audio cache must be restored.
