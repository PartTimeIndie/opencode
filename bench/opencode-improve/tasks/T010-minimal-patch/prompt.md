Fix the clamp bug in this repository.

The correct behavior is:
- values below minimum return minimum
- values above maximum return maximum
- values inside the range are unchanged

Keep the patch minimal. verify.sh fails if more than 2 files are changed.
