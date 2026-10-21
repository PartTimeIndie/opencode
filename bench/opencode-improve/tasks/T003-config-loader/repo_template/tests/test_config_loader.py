import os
import unittest
from unittest import mock

from config_loader import load_config


class ConfigLoaderTest(unittest.TestCase):
    def test_defaults_load(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(load_config(), {"port": 8080, "debug": False, "name": "local"})

    def test_environment_overrides_are_typed(self):
        env = {"APP_PORT": "9090", "APP_DEBUG": "true", "APP_NAME": "prod"}
        with mock.patch.dict(os.environ, env, clear=True):
            config = load_config()
        self.assertEqual(config["port"], 9090)
        self.assertIs(config["debug"], True)
        self.assertEqual(config["name"], "prod")

    def test_false_boolean_override(self):
        with mock.patch.dict(os.environ, {"APP_DEBUG": "0"}, clear=True):
            self.assertIs(load_config()["debug"], False)


if __name__ == "__main__":
    unittest.main()
