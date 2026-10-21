import sys
from pathlib import Path

sys.path.insert(0, str(Path(sys.argv[1])))

from src.mail_summary import summarize_message


encoded = (
    b"From: Ada <ada@example.com>\r\n"
    b"Subject: =?utf-8?q?Hello_=E2=9C=93?=\r\n"
    b"MIME-Version: 1.0\r\n"
    b"Content-Type: multipart/alternative; boundary=abc\r\n\r\n"
    b"--abc\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>HTML</p>\r\n"
    b"--abc\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPlain body\r\n"
    b"--abc--\r\n"
)
summary = summarize_message(encoded)
if summary["subject"] != "Hello ✓":
    raise AssertionError(summary)
if summary["body"].strip() != "Plain body":
    raise AssertionError(summary)

attachment = "From: a@example.com\nSubject: Report\nMIME-Version: 1.0\nContent-Type: multipart/mixed; boundary=x\n\n--x\nContent-Type: text/plain\n\nBody\n--x\nContent-Type: text/plain\nContent-Disposition: attachment; filename=a.txt\n\nAttachment\n--x--\n"
if summarize_message(attachment)["body"].strip() != "Body":
    raise AssertionError("attachment body was selected")

print("hidden email checks passed")
