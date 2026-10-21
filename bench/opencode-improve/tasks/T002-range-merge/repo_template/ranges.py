def merge_intervals(intervals):
    if not intervals:
        return []

    ordered = sorted([list(interval) for interval in intervals], key=lambda interval: interval[0])
    merged = [ordered[0]]
    for start, end in ordered[1:]:
        current = merged[-1]
        if start < current[1]:
            current[1] = max(current[1], end)
            continue
        merged.append([start, end])
    return merged
