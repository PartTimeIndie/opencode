# Legacy projection provenance in session checkpoints

`session-v2-projection@3` distinguishes replayed state from legacy rows whose complete value never existed in the
durable event contract. It must not infer those bytes from a plausible shape, timestamp, filename, provider metadata,
or synthetic flag.

The checkpoint baseline keeps such rows in `legacyMessages` and `legacyParts` and lists them in
`legacyCheckpointOnly@1`. Each entry identifies one part and its parent message and contains SHA-256 digests of both
exact database rows. The manifest has a digest of its own. Reading or replaying the checkpoint fails closed unless:

- the manifest has the exact versioned schema and strictly increasing, unique part IDs;
- its entries exactly cover every row with checkpoint-only fields;
- every part and parent decodes through the V1 schema and has the same Session/Message relationship;
- every row digest and the manifest digest match.

Checkpoint-only currently includes V1-only cards, patch file lists, compaction payloads, file-source details,
`synthetic`/`ignored` flags, and legacy metadata not carried by the relevant V2 event. The event-backed core still has
to agree wherever a contract exists: prompt text/file identity, assistant text/reasoning content and time, patch
snapshot and step boundary, tool lifecycle, and the compaction prompt/summary pair.

`compaction.tail_start_id` has no event field that records the selected retention boundary. Version 3 therefore does
not claim that its value is event-authenticated. It does require durable evidence introducing the referenced message
(a legacy message update or a V2 prompt/step event) to precede the compaction prompt, and requires the prompt to bind
to its actual compaction summary assistant. The exact pointer is then preserved by the checkpoint digest.

Adapter versions 1 and 2 remain readable for existing checkpoints. A newly captured version 3 baseline upgrades the
provenance contract without renumbering events. Checkpoint compaction retains the baseline containing checkpoint-only
rows; those rows are never treated as independently reconstructible event data.
