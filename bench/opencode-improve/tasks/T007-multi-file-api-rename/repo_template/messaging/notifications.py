from .api import send_mesage


def notify_admin(body):
    return send_mesage("admin", body)
