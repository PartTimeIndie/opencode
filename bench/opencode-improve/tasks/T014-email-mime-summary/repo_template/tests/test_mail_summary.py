import unittest

from src.mail_summary import summarize_message


class MailSummaryTest(unittest.TestCase):
    def test_simple_message(self):
        raw = "From: ada@example.com\nSubject: Hello\n\nBody text\n"
        self.assertEqual(summarize_message(raw), {"from": "ada@example.com", "subject": "Hello", "body": "Body text"})

    def test_folded_subject(self):
        raw = "From: ada@example.com\nSubject: Hello\n world\n\nBody text\n"
        self.assertEqual(summarize_message(raw)["subject"], "Hello world")


if __name__ == "__main__":
    unittest.main()
