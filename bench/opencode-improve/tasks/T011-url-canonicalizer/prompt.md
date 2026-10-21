Fix the URL builder in this repository.

Requirements:
- Preserve the base URL scheme, host, and existing base path.
- Join relative path segments without double slashes.
- A path starting with `/` is still relative to the base path, not the domain root.
- Reject absolute target URLs such as `https://evil.example/x`.
- Encode query parameters with stdlib URL semantics, including spaces and repeated keys.
- Preserve existing percent escapes in path segments where possible.

Run the visible tests if needed and keep the patch minimal.
