def summarize_message(raw):
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    headers, _, body = raw.partition("\n\n")
    result = {"from": "", "subject": "", "body": body.strip()}
    for line in headers.splitlines():
        if line.lower().startswith("from:"):
            result["from"] = line.split(":", 1)[1].strip()
        if line.lower().startswith("subject:"):
            result["subject"] = line.split(":", 1)[1].strip()
    return result
