with open('packages/core/test/session-compaction.test.ts') as f:
    lines = f.read().splitlines()
seen = set()
new_lines = []
i = 0
while i < len(lines):
    line = lines[i]
    stripped = line.strip()
    if stripped.startswith('test('):
        # Extract test name
        try:
            q1 = line.index('"')
            q2 = line.index('"', q1+1)
            name = line[q1+1:q2]
        except:
            # If we can't extract, just keep the line (shouldn't happen)
            new_lines.append(line)
            i += 1
            continue
        if name in seen:
            # Skip this entire test block until we find the closing brace of the test
            # We need to find the end of the test block.
            # Since test blocks can be nested, we need to find the matching closing brace for the test function.
            # However, test blocks are top-level; we can assume they end with a '})' that is not inside another block.
            # For safety, we'll just skip lines until we find a line that is exactly '})' at the same indentation level?
            # Instead, we'll just skip until we find a line that starts with 'test(' or 'test.each(' or end of file.
            # This is simpler and works because tests are top-level.
            i += 1
            while i < len(lines):
                nxt = lines[i].strip()
                if nxt.startswith('test(') or nxt.startswith('test.each('):
                    break
                i += 1
            # Now i points to the next test line or end
            continue
        else:
            seen.add(name)
            new_lines.append(line)
            i += 1
    else:
        new_lines.append(line)
        i += 1

with open('packages/core/test/session-compaction.test.ts', 'w') as f:
    f.write('\n'.join(new_lines) + '\n')
print(f'Processed lines: {len(lines)} -> {len(new_lines)}')
print(f'Removed duplicate tests, kept {len(seen)} unique tests.')
