import re


UNITS = {"h": 3600, "m": 60, "s": 1}


def parse_duration(text):
    match = re.search(r"(\d+)\s*([hms])", text.strip().lower())
    if not match:
        raise ValueError(f"invalid duration: {text}")
    return int(match.group(1)) * UNITS[match.group(2)]
