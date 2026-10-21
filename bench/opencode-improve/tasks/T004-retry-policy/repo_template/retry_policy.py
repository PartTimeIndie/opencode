class TransientError(Exception):
    pass


class FatalError(Exception):
    pass


def retry(operation, retries=3):
    last_error = None
    for _ in range(retries):
        try:
            return operation()
        except Exception as error:
            last_error = error
    raise last_error
