RATES = {
    "CA": 0.07,
    "NY": 0.085,
    "TX": 0.0,
}


def calculate_total(subtotal, state):
    return round(subtotal * (1 + RATES.get(state, 0.05)), 2)
