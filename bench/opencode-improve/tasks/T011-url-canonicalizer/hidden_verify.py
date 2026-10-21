import sys
from pathlib import Path

sys.path.insert(0, str(Path(sys.argv[1])))

from src.url_tools import build_api_url


def check(actual, expected):
    if actual != expected:
        raise AssertionError(f"{actual!r} != {expected!r}")


check(build_api_url("https://api.example.com/v1", "/users", {"page": 2}), "https://api.example.com/v1/users?page=2")
check(
    build_api_url("https://api.example.com/v1/", "search/items", {"q": "a+b / c", "tag": ["x", "y"]}),
    "https://api.example.com/v1/search/items?q=a%2Bb+%2F+c&tag=x&tag=y",
)
check(build_api_url("https://api.example.com/v1", "users/%7Buser%7D", None), "https://api.example.com/v1/users/%7Buser%7D")

try:
    build_api_url("https://api.example.com/v1", "https://evil.example/x", None)
except ValueError:
    pass
else:
    raise AssertionError("absolute target URL was not rejected")

print("hidden url checks passed")
