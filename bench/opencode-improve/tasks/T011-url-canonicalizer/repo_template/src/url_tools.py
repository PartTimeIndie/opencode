def build_api_url(base_url, path, query=None):
    url = base_url.rstrip("/") + "/" + path.strip("/")
    if query:
        url += "?" + "&".join(f"{key}={value}" for key, value in query.items())
    return url
