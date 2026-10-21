with open('packages/core/test/session-compaction.test.ts') as f: lines = f.read().splitlines()
# Remove duplicate fixture block (starting at line 2441)
# Identify end of duplicate fixture (should be before 2477 or after actual end)
# We'll cut from line 2441 (0-indexed 2440) up to the line before next original test (line 2272?)
# Simpler: find last '})' before end that belongs to fixture (search for '})' after 2470)
# But easier: truncate file at last original test line (around 2272)
# Let's find last line number of original tests before duplicated fixture starts
orig_end = 2272  # from earlier observation: test lines up to 2272 were original
# If actual file longer, we must find the line where duplicate begins (2441) and remove from there to 2477
# We'll take everything before 2441 and everything after 2477 (but after 2477 is nothing)
new_lines = lines[:2440] + lines[2476:]
# Remove duplicate fixture lines (2441-2477 inclusive)
with open('packages/core/test/session-compaction.test.ts','w') as f: f.write('\n'.join(new_lines)+'\n')
print('Trimmed duplicate fixture, total lines', len(new_lines))
