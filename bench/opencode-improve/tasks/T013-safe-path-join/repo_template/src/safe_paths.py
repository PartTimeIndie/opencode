from pathlib import Path


def safe_join(root, user_path):
    if str(user_path).startswith("../"):
        raise ValueError("path escapes root")
    return str(Path(root) / user_path)
