---
description: Set a session goal
action: session-goal
---

Session goal control request:

```text
$ARGUMENTS
```

This command only handles goal controls. Do not restart the session, restate a plan, or begin the user's work from scratch.

If the arguments are empty, ask what the session goal should be.

If the arguments are exactly one of: clear, stop, off, reset, none, cancel — acknowledge that the visible session goal was cleared and wait for the next task.

If the arguments are exactly one of: status, history, list, pause, resume, or start with "focus " — report the current goal without replacing it unless the user provided a new goal text.

If the arguments start with "edit " or "add " and there is no remaining goal text, ask what to change.
