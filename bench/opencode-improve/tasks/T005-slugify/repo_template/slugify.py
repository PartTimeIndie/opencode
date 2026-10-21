import re
import unicodedata


def slugify(value):
    text = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    text = text.strip().lower()
    text = re.sub(r"\s+", "-", text)
    text = re.sub(r"[^a-z0-9_-]+", "-", text)
    return text
