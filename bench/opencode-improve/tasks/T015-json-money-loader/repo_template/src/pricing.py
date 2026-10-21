import json
import os


def load_pricing(text):
    data = json.loads(text)
    data["currency"] = os.environ.get("APP_CURRENCY", data.get("currency", "EUR"))
    data["prices"] = {key: float(value) for key, value in data.get("prices", {}).items()}
    return data
