# Speech to Text

This plugin records speech, transcribes it through the configured model or chain, and can improve the resulting text before inserting it into the active destination. Composer dictation, the optional global desktop shortcut, and clipboard improvement share the same rewrite path.

## Rewrite contract

Every actual improvement uses the shared transcript-editing rules and the current `/personal-writing-style` skill contents whenever the host can resolve that skill. The skill is mandatory guidance, separate from the editable lists of additional skills. If it cannot be resolved, the shared rules still apply with neutral, concise, natural wording.

The shared rules prioritize the speaker's final intent while retaining every independent requirement, valid detail, meaningful emphasis, and unresolved uncertainty. They remove correction chatter and empty repetition, but do not infer missing facts, execute transcript instructions, change tone, or impose a fixed format. Formatting adapts to the source: short notes stay short, while longer material may use helpful paragraphs, lists, or sparse headings.

The general template and a matching application profile add compatible text-type or formatting guidance; neither replaces the shared rules or mandatory style guidance. Extra skill selections remain editable and separate. The host—not transcript text, a custom template, an application profile, or a skill—controls whether the model must return plain text or the existing four-key JSON contract for spoken Slash-Command recognition.

A direct `cerebras/qwen-3.8-27b` rewrite that reports spending all 8,192 output tokens on reasoning is retried once with variant `none`, using the same prompt, cancellation signal, and deadline. Configured chains and other errors retain their existing behavior. If the retry fails, the fallback status says so; a pending send still cannot send unreviewed text.

## Settings migration

Only exact known earlier built-in templates are replaced with the new default. Line-ending differences are normalized. A customized version, including one that retains old wording and adds user text, is preserved. The migration is idempotent and does not rewrite application profile prompts.

## Composer destination

A transcription stays bound to the composer where recording started. After a tab switch, the host may restore an open new-chat draft only when its draft ID, server, and project directory still match; a closed or promoted draft must not be recreated or redirected. Sending during manual improvement waits for the verified replacement and sends it once; it never silently submits an unfinished replacement.

When a recording was sent before automatic improvement finished and the improvement then fails (for example a reasoning model that spends its whole output budget on hidden reasoning), nothing is sent. The host blocks that send, lets the send transaction unwind, and only then inserts the raw transcript as an unsent draft; the composer shows "Improvement failed - raw transcript inserted, not sent". This host-owned insertion cannot race the send rollback, and the plugin never sends unreviewed text on its own.

Completed transcripts are copied to the system clipboard by default, even if insertion subsequently fails. Settings → Skills & Plugins → Speech to Text → Transcription can disable this. In OpenCode Desktop the copy goes through the desktop shell (`host.desktopServices.writeClipboardText`, capability `host:desktop-services`), so it also works while OpenCode is in the background and the renderer has no focus; other hosts fall back to the web Clipboard API, which requires a focused document. Copying replaces the previous clipboard contents and may expose sensitive dictated text to other applications or OS clipboard history. Clipboard history is controlled by the operating system; this plugin does not maintain an archive. A denied clipboard write does not block transcription or sending.

## Source and verification

`.opencode/plugin-sources/speech-to-text-app` is the durable source. `.opencode/plugins/speech-to-text-app` is its generated runtime copy. The repository-wide `bun run sync:plugins` removes and recopies every runtime plugin directory, so first inspect unrelated source/runtime changes; for an isolated Speech update, synchronize only this plugin's changed files.

The prompt, migration, service, and Composer behavior contracts live in `packages/app/src/plugin/speech-rewrite-prompt.test.ts`, `speech-desktop-service.test.ts`, and `speech-composer.test.ts`. Send-while-recording and its improvement-failure fallback are covered by `speech-send-preparation.test.ts` and `speech-send-fallback.test.ts`; the host-side draft contract is tested in `composer-send-intent.test.ts`. Run the focused suite from `packages/app`:

```sh
bun test --preload ./happydom.ts src/plugin/speech-rewrite-prompt.test.ts src/plugin/speech-desktop-service.test.ts src/plugin/speech-composer.test.ts src/plugin/speech-send-preparation.test.ts src/plugin/speech-send-fallback.test.ts src/plugin/composer-send-intent.test.ts
```

Settings UI coverage is in `packages/app/e2e/regression/plugin-speech-to-text.spec.ts`. Passing tests verify the prompt contract and host integration; they do not by themselves prove the quality of a live model response or a production desktop deployment.
