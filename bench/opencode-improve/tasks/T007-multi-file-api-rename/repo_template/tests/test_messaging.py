import unittest

import messaging
from messaging.client import MessageClient
from messaging.notifications import notify_admin
from messaging.queue import flush_queue


class MessagingApiTest(unittest.TestCase):
    def test_public_api_uses_correct_spelling(self):
        self.assertEqual(messaging.send_message("user", "hello"), "sent:user:hello")
        self.assertIn("send_message", messaging.__all__)

    def test_client_uses_correct_api(self):
        self.assertEqual(MessageClient().send("user", "hello"), "sent:user:hello")

    def test_other_call_sites_still_work(self):
        self.assertEqual(notify_admin("alert"), "sent:admin:alert")
        self.assertEqual(flush_queue([{"recipient": "a", "body": "one"}]), ["sent:a:one"])


if __name__ == "__main__":
    unittest.main()
