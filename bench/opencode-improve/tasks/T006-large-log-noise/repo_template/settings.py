SETTINGS = {
    "data_path": "./data/app.db",
    "feature_enabled": True,
}


def get_setting(name):
    return SETTINGS.get(f"settings.{name}")
