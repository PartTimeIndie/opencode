import unittest

from retry_policy import FatalError, TransientError, retry


class RetryPolicyTest(unittest.TestCase):
    def test_success_without_retry(self):
        calls = []

        def operation():
            calls.append("call")
            return "ok"

        self.assertEqual(retry(operation, retries=3), "ok")
        self.assertEqual(len(calls), 1)

    def test_transient_retries_include_initial_call(self):
        calls = []

        def operation():
            calls.append("call")
            if len(calls) < 3:
                raise TransientError("temporary")
            return "ok"

        self.assertEqual(retry(operation, retries=2), "ok")
        self.assertEqual(len(calls), 3)

    def test_fatal_error_is_not_retried(self):
        calls = []

        def operation():
            calls.append("call")
            raise FatalError("fatal")

        with self.assertRaises(FatalError):
            retry(operation, retries=3)
        self.assertEqual(len(calls), 1)

    def test_final_transient_error_is_raised(self):
        calls = []

        def operation():
            calls.append("call")
            raise TransientError("temporary")

        with self.assertRaises(TransientError):
            retry(operation, retries=2)
        self.assertEqual(len(calls), 3)


if __name__ == "__main__":
    unittest.main()
