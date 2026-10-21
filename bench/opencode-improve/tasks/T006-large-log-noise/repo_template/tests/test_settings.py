import unittest

from settings import get_setting


def setUpModule():
    for index in range(3000):
        print(f"noise line {index:04d}: worker heartbeat ok")


class SettingsTest(unittest.TestCase):
    def test_data_path_is_available(self):
        self.assertEqual(get_setting("data_path"), "./data/app.db")

    def test_feature_flag_is_available(self):
        self.assertIs(get_setting("feature_enabled"), True)


if __name__ == "__main__":
    unittest.main()
