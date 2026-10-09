"""Causal price-path features and explicit daily-bar event ambiguity.

Technical inputs reuse the page engine. Returns are not winsorized as labels:
real tail events stay. Missing fundamentals have explicit availability flags.
"""
import numpy as np
import pandas as pd
from .analysis_pages import technical_series, seasonality_page_payload
from .point_in_time import latest_usable_vintage
from .fundamental_model import build_feature_vector

TECHNICAL_NAMES = ["RSI14", "MACD_Hist", "ATR14", "ADX14", "CMF20", "SMA20", "SMA50", "SMA200"]
FUNDAMENTAL_NAMES = ["gross_margin", "operating_margin", "net_margin", "current_ratio", "debt_to_equity", "roa"]
PAGE_FEATURES = [f"technical_{n}" for n in TECHNICAL_NAMES] + [f"missing_technical_{n}" for n in TECHNICAL_NAMES] + ["seasonal_month_median", "seasonal_next_month_median", "seasonal_years"] + [f"fundamental_{n}" for n in FUNDAMENTAL_NAMES] + [f"missing_fundamental_{n}" for n in FUNDAMENTAL_NAMES] + ["filing_age_years"]
MARKET_FEATURES = ["market_return_5", "market_return_21", "relative_return_21", "lagged_beta_60", "lagged_correlation_60", "market_missing"]
PAGE_FEATURES += MARKET_FEATURES


def page_feature_table(history, vintages=None, market=None):
    """Reuse actual page formulas; rolling technicals are causal, filings lag a day."""
    values, _, _ = technical_series(history)
    output = pd.DataFrame(index=history.index)
    for name in TECHNICAL_NAMES:
        series = values[name]
        if name.startswith("SMA"):
            series = history.Close / series - 1
        elif name in ("MACD_Hist", "ATR14"):
            series = series / history.Close
        elif name in ("RSI14", "ADX14"):
            series = series / 100
        output[f"technical_{name}"] = series
        output[f"missing_technical_{name}"] = series.isna().astype(float)
    seasonal_by_year = {}
    fundamental_cache = {}
    rows = []
    for date in history.index:
        if date.year not in seasonal_by_year:
            past = history.loc[history.index.year < date.year]
            seasonal_by_year[date.year] = seasonality_page_payload(past, exclude_outliers=True, as_of=date, prior_years_only=True) if len(past) else None
        seasonal = seasonal_by_year[date.year]
        medians = seasonal["monthlyPercentiles"] if seasonal else []
        row = {"seasonal_month_median": medians[date.month - 1]["median"] / 100 if medians and medians[date.month - 1]["median"] is not None else 0.,
               "seasonal_next_month_median": medians[date.month % 12]["median"] / 100 if medians and medians[date.month % 12]["median"] is not None else 0.,
               "seasonal_years": len(seasonal["years"]) if seasonal else 0.}
        # Midnight cutoff excludes filings accepted during/after this session.
        current, previous = latest_usable_vintage(vintages or [], date.to_pydatetime())
        if current and (date - pd.Timestamp(current["acceptedAt"]).tz_localize(None)).days > 550:
            current = None
        if current:
            identity = current["accessionNumber"]
            if identity not in fundamental_cache:
                fundamental_cache[identity] = build_feature_vector(current["metrics"], previous["metrics"] if previous else None, raw_price=None, filing_age_days=0)
            features = fundamental_cache[identity]
            row["filing_age_years"] = (date - pd.Timestamp(current["acceptedAt"]).tz_localize(None)).days / 365.25
        else:
            features = {}
            row["filing_age_years"] = 0.
        for name in FUNDAMENTAL_NAMES:
            value = features.get(name)
            valid = value is not None and np.isfinite(value)
            row[f"fundamental_{name}"] = float(value) if valid else 0.
            row[f"missing_fundamental_{name}"] = 0. if valid else 1.
        rows.append(row)
    extra = pd.DataFrame(rows, index=history.index)
    context = pd.DataFrame(0., index=history.index, columns=MARKET_FEATURES)
    context["market_missing"] = 1.
    if market is not None and not market.empty:
        close = market["Adj Close"] if "Adj Close" in market else market.Close
        daily = close.pct_change(fill_method=None)
        observed = pd.DataFrame({"market_return_5": close / close.shift(5) - 1,
                                 "market_return_21": close / close.shift(21) - 1, "daily": daily})
        # Prior calendar date only: no same-day foreign close sneaks into an anchor.
        aligned = observed.reindex(history.index - pd.Timedelta(days=1), method="ffill", tolerance=pd.Timedelta(days=4))
        aligned.index = history.index
        stock_returns = history["Adj Close"].pct_change(fill_method=None)
        context["market_return_5"] = aligned.market_return_5
        context["market_return_21"] = aligned.market_return_21
        context["relative_return_21"] = history["Adj Close"].pct_change(21, fill_method=None) - aligned.market_return_21
        variance = aligned.daily.rolling(60, min_periods=40).var()
        context["lagged_beta_60"] = stock_returns.rolling(60, min_periods=40).cov(aligned.daily) / variance.where(variance > 1e-12)
        context["lagged_correlation_60"] = stock_returns.rolling(60, min_periods=40).corr(aligned.daily)
        context["market_missing"] = context.iloc[:, :-1].isna().any(axis=1).astype(float)
    return pd.concat([output, extra, context], axis=1).reindex(columns=PAGE_FEATURES).replace([np.inf, -np.inf], np.nan).fillna(0.)

CONTEXT_FEATURES = ["return_5", "return_21", "volatility_20", "volatility_60",
                    "volatility_ratio", "range_fraction", "relative_volume", "drawdown_60",
                    "downside_volatility", "return_skew", "seasonal_return", "seasonal_count",
                    "support_tests", "resistance_tests", "support_last_test_age", "resistance_last_test_age",
                    "support_rejections", "resistance_rejections", "support_crosses", "resistance_crosses"]


def volatility(prefix):
    returns = prefix["Adj Close"].pct_change(fill_method=None).tail(60).dropna().to_numpy()
    return max(float(np.std(returns[-20:], ddof=1)), .0001) if len(returns) >= 20 else np.nan


def context_features(prefix, zones, horizon):
    price = float(prefix.Close.iloc[-1])
    adjusted = prefix["Adj Close"]
    returns = adjusted.pct_change(fill_method=None).tail(60).dropna()
    vol20 = volatility(prefix)
    vol60 = max(float(returns.std()), .0001)
    recent = prefix.tail(60)
    volume_mean = float(prefix.Volume.iloc[-21:-1].mean())
    negative = returns.clip(upper=0)
    # Only labels that have matured by this anchor contribute to seasonality.
    matured = adjusted.shift(-horizon) / adjusted - 1
    seasonal = matured[(prefix.index.month == prefix.index[-1].month) & (prefix.index.year < prefix.index[-1].year)].dropna()
    seasonal_mean = float(seasonal.mean()) * len(seasonal) / (len(seasonal) + 100) if len(seasonal) else 0.
    result = [float(adjusted.iloc[-1] / adjusted.iloc[-6] - 1), float(adjusted.iloc[-1] / adjusted.iloc[-22] - 1),
              vol20, vol60, vol20 / vol60, float((prefix.High.iloc[-1] - prefix.Low.iloc[-1]) / price),
              float(prefix.Volume.iloc[-1] / volume_mean) if volume_mean > 0 else 0.,
              float(price / recent.Close.max() - 1), float(np.sqrt(np.mean(negative ** 2))),
              float(returns.skew()) if returns.std() > 1e-10 else 0., seasonal_mean, min(len(seasonal), 1000) / 1000]
    supports = [z for z in zones["support"] if z["price"] <= price]
    resistances = [z for z in zones["resistance"] if z["price"] >= price]
    selected = [max(supports, key=lambda z: z["price"], default=None), min(resistances, key=lambda z: z["price"], default=None)]
    stats = []
    for i, zone in enumerate(selected):
        if zone is None:
            stats.append([0., 1., 0., 0.]); continue
        touch = (recent.Low <= zone["max"]) & (recent.High >= zone["min"])
        locations = np.flatnonzero(touch.to_numpy())
        reject = touch & ((recent.Close > zone["max"]) if i == 0 else (recent.Close < zone["min"]))
        side = recent.Close > zone["price"]
        crosses = (side.iloc[1:].to_numpy() != side.iloc[:-1].to_numpy()).sum()
        stats.append([float(touch.mean()), (len(recent) - 1 - locations[-1]) / 60 if len(locations) else 1.,
                      float(reject.mean()), float(crosses / 60)])
    result += [stats[i][j] for j in range(4) for i in range(2)]
    return result


def first_gap_event(gaps, future, price, zones):
    """First 50%-fill target among today's candidates, with competing invalidation.

    A daily candle cannot order two targets, or a target and its stop. Exclude
    that whole anchor from first-target training instead of inventing an order.
    Stops are fixed at the snapshot's nearest opposite zone; absent: no stop.
    """
    stops = {"above": max((z["min"] for z in zones["support"] if z["max"] < price), default=None),
             "below": min((z["max"] for z in zones["resistance"] if z["min"] > price), default=None)}
    active = list(gaps)
    invalidated = set()
    for step, row in enumerate(future.itertuples(), 1):
        hits, survivors = [], []
        for gap in active:
            mid = (gap["start"] + gap["end"]) / 2
            # Fill direction is the gap's formation direction, not today's trend.
            reached = row.Low <= mid if "Up" in gap["type"] else row.High >= mid
            side = "above" if mid >= price else "below"
            stop = stops[side]
            stopped = stop is not None and (row.Low <= stop if side == "above" else row.High >= stop)
            if reached and stopped:
                return {"ambiguous": True, "winner": None, "steps": None, "invalidated": len(invalidated)}
            if reached:
                hits.append(gap["id"])
            elif stopped:
                invalidated.add(gap["id"])
            else:
                survivors.append(gap)
        if len(hits) > 1:
            return {"ambiguous": True, "winner": None, "steps": None, "invalidated": len(invalidated)}
        if hits:
            return {"ambiguous": False, "winner": hits[0], "steps": step, "invalidated": len(invalidated)}
        active = survivors
    return {"ambiguous": False, "winner": None, "steps": None, "invalidated": len(invalidated)}


def path_event(future, price, scale):
    """First +/- one ex-ante horizon volatility barrier; -1 = daily ambiguity."""
    upper, lower = price * (1 + scale), price * (1 - scale)
    for row in future.itertuples():
        up, down = row.High >= upper, row.Low <= lower
        if up and down:
            return -1
        if up or down:
            return 2 if up else 0
    return 1
