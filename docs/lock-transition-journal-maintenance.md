# Lock transition journal maintenance

OpenCode file locks use an append-only transition journal beside each lock directory. Runtime deletion is deliberately disabled: on Windows, Node cannot portably prove that a newly published floor directory entry reached durable storage before older entries are deleted. Deleting entries online could therefore reintroduce an epoch after a crash and break mutual exclusion.

Runtime lock transitions enumerate journal names to find the active frontier, but they only open and validate the highest floor and active transition. Historical claims remain as permanent mixed-version fences and are not reopened on every lock operation. Use `Flock.transitionJournalStatus(key, { dir })` when a full integrity audit and exact entry counts are required; that explicit diagnostic validates every recognized historical claim, barrier, and floor marker. Growth is expected and is not permission to delete files while OpenCode is running.

Offline maintenance has two hard preconditions:

1. Upgrade every application, CLI, service, scheduler, watcher, and helper that can access the lock root to a build that understands atomic `.claim` and `.released` entries, floor markers, and post-publish floor validation. A mixed-version restart after maintenance is unsafe because an older binary can ignore the floor and reuse a retired epoch.
2. Stop every such lock user on every account and machine that can access the directory. Verify that no process can retain a selected-but-unpublished epoch. Merely observing an empty lock directory is insufficient.

Only a dedicated platform-aware offline tool may then advance a floor. It must write and flush the complete marker, publish it atomically, durably flush the parent-directory metadata, re-read and validate the marker, and only then delete claims, completion markers, and legacy epoch directories at or below that floor. The tool must preserve every higher epoch and the highest valid floor. If the filesystem cannot provide or prove these ordering guarantees, abort maintenance and leave the append-only journal intact.

Never create a floor manually, delete individual journal entries, run maintenance concurrently with OpenCode, or downgrade any lock user after a floor has been introduced. Back up the journal before maintenance and treat malformed recognized markers as a fail-closed condition.
