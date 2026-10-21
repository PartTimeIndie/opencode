# Scheduler task sources

The packaging-safe task sources live in `src/server/scheduler/managed-tasks.ts`. On Windows, server initialization atomically refreshes only the two known managed task copies under `%USERPROFILE%\.config\opencode\scheduler\tasks`. It never starts either job.
