from .api import send_mesage


def flush_queue(messages):
    return [send_mesage(message["recipient"], message["body"]) for message in messages]
