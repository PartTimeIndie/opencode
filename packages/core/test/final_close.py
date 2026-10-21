with open('packages/core/test/session-compaction.test.ts', 'r') as f:
    lines = f.read().splitlines()
lines.append('})')
with open('packages/core/test/session-compaction.test.ts', 'w') as f:
    f.write('\n'.join(lines) + '\n')
print('added close')
