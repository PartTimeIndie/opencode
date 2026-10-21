def write_rows(rows, headers):
    lines = [",".join(headers)]
    for row in rows:
        lines.append(",".join(str(row.get(header, "")) for header in headers))
    return "\n".join(lines) + "\n"


def read_rows(text):
    lines = [line for line in text.splitlines() if line]
    headers = lines[0].split(",")
    return [dict(zip(headers, line.split(","))) for line in lines[1:]]
