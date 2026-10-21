import json
import os


def load_config(path="defaults.json"):
    with open(path, encoding="utf-8") as file:
        defaults = json.load(file)

    config = {
        "port": os.environ.get("APP_PORT", defaults["port"]),
        "debug": os.environ.get("APP_DEBUG", defaults["debug"]),
        "name": os.environ.get("APP_NAME", defaults["name"]),
    }
    return config
