# Catalogue-backed voice settings

App plugins can register an additive `AppSettingsField` variant:

```js
{ key: "voice", type: "voice", label: "Stimme", default: "",
  targetKey: "speechTarget", languageKey: "language", allowCustom: true }
```

`targetKey` references a flat model-target setting in the same settings item and
storage/server scope. `languageKey` is an optional flat summary-language setting:
it supplies an informational hint, never language filtering or automatic choice.
`allowCustom` defaults to false and enables explicit custom-ID entry. The saved
value is always the original voice-ID string; empty means provider default.

The app owns catalogue access and rendering. It resolves direct/legacy model
references and all steps of an explicit chain through the existing model-target
resolver. Speech does not implicitly use the text default chain. Options use
`useModels` / `supported_voices`, merging identical IDs while listing supporting
models. Plugins do not fetch provider catalogues, handle credentials or import
private host code. Existing `ui:settings` registration permissions still apply.

Language labels are conservative locale-prefix hints (hyphen/underscore accepted),
not quality measurements, provider guarantees or accent certification. Unknown
language is labelled unknown. Do not invent language from a person's name or
model-generated quality notes. Every catalogued language remains selectable.

Opening settings, loading/changing a catalogue or selecting another model does
not persist a different voice. Unknown saved IDs remain visible even when custom
entry is disabled; missing catalogues are **unverified**, not proof of invalidity.
When a populated catalogue omits the stored voice, explain the possible provider
fallback without deleting or rewriting the value. Partial chain support is shown.
Custom edits have explicit apply/cancel; cancellation preserves the prior value.
Keep unapplied custom drafts open through target, language and catalogue updates.
Select components can re-emit the unchanged selection when options refresh: ignore
that callback before closing the editor or writing settings, and cover this with
a mounted-browser regression test.
Only user selection/application writes the voice setting. No database migration,
background polling, TTS preview call or new audio storage is involved.

## Text language, overrides and acoustic acceptance

Summary language controls generated text. Per-model TTS overrides take precedence
over the main voice, and an unsupported voice may resolve to a provider default.
The picker does not change those existing rules. Plugin descriptions must explain
them so a displayed German voice is not mistaken for the guaranteed effective
voice or an accent-free result.

For pronunciation issues, first reproduce the real call and compare requested
voice, per-model override, resolved model/chain step and adapter voice with returned
metadata. Use only minimal IDs and synthetic text in diagnostics, never credentials
or private chat dumps. Fix proven transport/selection bugs with a regression test;
do not add speculative language-enforcement logic. If correct selection still
sounds wrong, human listening on varied ordinary text is the acceptance gate.
A transcript or silent PCM interaction fixture cannot establish accent quality.

## Verification and rollout

Pure option contracts live in `settings-voice-picker-model.test.ts`. Real picker
mounting, free selection, persistence, custom cancellation and voice-to-TTS payload
checks run through Vite/Solid/Playwright in `spoken-summary-plugin.spec.ts`, at
both desktop and mobile viewports. Do not claim Solid rendering from plain Bun
TSX plus DOM globals. Reactive non-JSX tests use the browser condition.

Ship the host renderer with the plugin declaration. Preserve source/runtime edits
before a scoped plugin sync; never use a full sync for a one-plugin change.
Rollback can restore the old text field without migrating or erasing saved IDs.
Source/browser verification is not installed desktop acceptance. Restart and
production deployment retain their own explicit approval requirements.
