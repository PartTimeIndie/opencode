Fix the public messaging API typo in this repository.

The intended public API is send_message. Multiple files still use send_mesage. Update the implementation and call sites so the tests pass. A backwards-compatible alias is optional, but the new API must work.

Run the unit tests and keep the patch minimal.
