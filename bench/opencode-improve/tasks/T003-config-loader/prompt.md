Fix the config loader in this repository.

Requirements:
- Load defaults from defaults.json.
- APP_PORT overrides port and becomes an int.
- APP_DEBUG overrides debug and becomes a bool.
- APP_NAME overrides name and stays a string.
- Environment overrides must win over defaults.

Run the unit tests and keep the patch minimal.
