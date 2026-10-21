## Long-Session Message Paging

- Any change to session message stores, timeline windowing, message virtualization, prefetch, `loadOlder`, force-refresh, hash navigation, active-message restoration, or page-boundary assistant rendering must include an explicit paging checklist in the PR/test notes.
- The minimum checklist is: open a long session from a prefetched state, verify initial open hydration, trigger `loadOlder` at least once, cross a page boundary containing assistant output, run a force-refresh, restore from a hash or active-message target, and confirm the older loaded messages remain visible after each step.
- Cover sessions with more than 160 user turns when changing paging behavior. Smaller fixture coverage is not enough unless the change is provably unrelated to message window selection.
- Add or update a regression test for paging-sensitive changes. The test must fail if messages loaded through `loadOlder` disappear after prefetch->open->loadOlder, force-refresh, hash/active-message recovery, or assistant page-boundary rendering.
- For app-facing paging changes, run Visual QA against a long session and capture desktop plus mobile evidence that older messages, the current active message, and assistant content around page boundaries are still rendered.
