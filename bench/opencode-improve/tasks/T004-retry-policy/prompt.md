Fix the retry helper in this repository.

Requirements:
- A successful initial call returns immediately.
- TransientError is retried up to initial call plus retries.
- FatalError is not retried.
- If all transient attempts fail, raise the final transient error.

Run the unit tests and keep the patch minimal.
