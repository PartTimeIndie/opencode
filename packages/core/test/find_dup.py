with open('packages/core/test/session-compaction.test.ts') as f:
    lines = f.read().splitlines()
seen = {}
for i, l in enumerate(lines):
    ls = l.strip()
    if ls.startswith('test('):
        try:
            q1 = ls.index('"')
            q2 = ls.index('"', q1+1)
            name = ls[q1+1:q2]
        except:
            name = ls[:60]
        if name in seen:
            print(f'DUPLICATE: "{name}" at lines {seen[name]} and {i+1}')
        else:
            seen[name] = i+1
print('Total unique tests:', len(seen))
