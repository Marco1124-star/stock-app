"""Original Previsione zone engine, shared with chronological neural training."""
import numpy as np
import pandas as pd

def calculate_supply_demand_zones(hist, bins=50, window=2, strength_percentile=75, pivot_source="close"):
    hist = hist.copy().ffill()
    price_min = hist['Low'].min()
    price_max = hist['High'].max()
    bin_edges = np.linspace(price_min, price_max, bins + 1)
    
    support_counts = np.zeros(bins)
    resistance_counts = np.zeros(bins)
    
    # ADL cumulativo
    price_range = hist['High'] - hist['Low']
    price_range[price_range == 0] = 1e-9
    adl = ((hist['Close'] - hist['Low']) - (hist['High'] - hist['Close'])) / price_range * hist['Volume']
    adl = adl.cumsum()
    
    # Equivalent centered pivots, vectorized. Last `window` bars cannot yet
    # confirm a pivot; calling on a historical prefix never sees future bars.
    lows = hist['Low'] if pivot_source == "hilo" else hist['Close']
    highs = hist['High'] if pivot_source == "hilo" else hist['Close']
    support = lows.eq(lows.rolling(2 * window + 1, center=True, min_periods=1).min()).to_numpy()
    resistance = highs.eq(highs.rolling(2 * window + 1, center=True, min_periods=1).max()).to_numpy()
    if pivot_source != "hilo":
        resistance &= ~support  # Preserve the original if / elif on flat bars.
    valid = np.zeros(len(hist), dtype=bool)
    valid[window:len(hist) - window] = True
    indices = np.clip(np.digitize(hist['Close'].to_numpy(), bin_edges) - 1, 0, bins - 1)
    np.add.at(support_counts, indices[support & valid], adl.to_numpy()[support & valid])
    np.add.at(resistance_counts, indices[resistance & valid], adl.to_numpy()[resistance & valid])
    
    support_threshold = np.percentile(support_counts, strength_percentile)
    resistance_threshold = np.percentile(resistance_counts, strength_percentile)
    
    support_zones = []
    resistance_zones = []
    
    for i in range(bins):
        price_lower = bin_edges[i]
        price_upper = bin_edges[i + 1]
        price_mid = round(float((price_lower + price_upper) / 2), 2)
        
        if support_counts[i] >= support_threshold:
            support_zones.append({
                "price": price_mid,
                "min": round(price_lower, 2),
                "max": round(price_upper, 2),
            })
        if resistance_counts[i] >= resistance_threshold:
            resistance_zones.append({
                "price": price_mid,
                "min": round(price_lower, 2),
                "max": round(price_upper, 2),
            })
    
    return {"support": support_zones, "resistance": resistance_zones}

def determine_market_state(price, supports, resistances, proximity=1.5):
    nearest_support = max([s["price"] for s in supports if s["price"] <= price], default=None)
    nearest_resistance = min([r["price"] for r in resistances if r["price"] >= price], default=None)

    if nearest_support is None or nearest_resistance is None:
        return {"state": "IN_NONE", "strength": 0}

    dist_support = ((price - nearest_support) / nearest_support) * 100
    dist_resistance = ((nearest_resistance - price) / nearest_resistance) * 100

    strength = round(100 - min(dist_support, dist_resistance), 2)

    if dist_support < dist_resistance and dist_support < proximity:
        return {"state": "IN_DEMAND", "strength": strength}
    elif dist_resistance < dist_support and dist_resistance < proximity:
        return {"state": "IN_SUPPLY", "strength": strength}
    else:
        return {"state": "IN_NONE", "strength": strength}

def filter_zones_by_distance(zones, price, min_pct):
    if price <= 0 or min_pct <= 0:
        return zones

    min_abs = price * (min_pct / 100.0)
    supports = [s for s in zones["support"] if (price - s["price"]) >= min_abs]
    resistances = [r for r in zones["resistance"] if (r["price"] - price) >= min_abs]

    # Fallback: se filtriamo tutto, mantieni le zone originali
    if not supports:
        supports = zones["support"]
    if not resistances:
        resistances = zones["resistance"]

    return {"support": supports, "resistance": resistances}

def merge_close_zones(zones, min_gap_pct):
    if min_gap_pct <= 0:
        return zones

    def merge_list(items):
        if not items:
            return items
        items = sorted(items, key=lambda x: x["price"])
        merged = [items[0]]
        for item in items[1:]:
            last = merged[-1]
            gap = abs(item["price"] - last["price"])
            min_gap = last["price"] * (min_gap_pct / 100.0)
            if gap <= min_gap:
                # Unisci media dei prezzi e aggiorna range
                new_price = round((last["price"] + item["price"]) / 2, 2)
                merged[-1] = {
                    "price": new_price,
                    "min": round(min(last["min"], item["min"]), 2),
                    "max": round(max(last["max"], item["max"]), 2),
                }
            else:
                merged.append(item)
        return merged

    return {
        "support": merge_list(zones["support"]),
        "resistance": merge_list(zones["resistance"]),
    }
