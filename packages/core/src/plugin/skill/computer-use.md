# Computer Use

This skill activates only the Browser Dock capabilities that the host has
already granted to this exact skill and that the current agent's tool policy
and Permission V2 rules already allow.

- `browser_read` enables inspection and bounded waits.
- `browser_write` enables click, type, and HTTP(S) navigation.

Activation is limited to the current Session and agent, expires automatically,
is not inherited by subagents, and never creates a permission. If a Browser
tool is not visible after loading this skill, the host, agent, permission, or
Desktop bridge did not authorize it; do not work around that boundary.
