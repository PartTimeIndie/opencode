Fix the email summary parser.

Requirements:
- Return a dictionary with `from`, `subject`, and `body`.
- Handle folded and encoded headers.
- Handle `str` or `bytes` input.
- Prefer `text/plain` bodies over `text/html` in multipart messages.
- Ignore attachments.

Keep the patch minimal and prefer Python's stdlib email package.
