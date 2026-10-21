from generated.generated_table import TABLE


def expand_tokens(tokens):
    return [TABLE.get(token.upper(), token) for token in tokens]
