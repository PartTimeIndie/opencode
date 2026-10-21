from .api import send_mesage


class MessageClient:
    def send(self, recipient, body):
        return send_mesage(recipient, body)
