"""Shared calculation engine for Technicals and Seasonality.

The established page formulas are retained (including their legacy variants),
not silently replaced by different textbook indicators.
"""
import numpy as np
import pandas as pd

PAGE_ENGINE_VERSION = "analysis-pages-v1"
MA_PERIODS = (10, 20, 50, 100, 200)


def completed_daily_history(history, as_of=None):
    cutoff = pd.Timestamp(as_of or pd.Timestamp.now(tz="UTC")).tz_localize(None).normalize()
    frame = history.copy()
    dates = pd.to_datetime(frame.index)
    if dates.tz is None and frame.attrs.get("timestampTimezone") == "UTC" and frame.attrs.get("exchangeTimezoneName"):
        dates = dates.tz_localize("UTC").tz_convert(frame.attrs["exchangeTimezoneName"])
    frame.index = dates.tz_localize(None).normalize()
    frame = frame.loc[~frame.index.duplicated(keep="last")].sort_index()
    # Idempotent: the learner may receive the already-normalized shared source.
    # Do not interpret New York session midnights as UTC a second time.
    frame.attrs["timestampTimezone"] = "exchange-date"
    return frame.loc[frame.index < cutoff]


def _numeric(history):
    hist = history.copy()
    for col in ("Open", "High", "Low", "Close", "Volume"):
        hist[col] = pd.to_numeric(hist.get(col, np.nan), errors="coerce")
    hist = hist.replace([np.inf, -np.inf], np.nan)
    hist["Close"] = hist.Close.where(hist.Close > 0)
    hist["High"] = hist.High.fillna(hist.Close)
    hist["Low"] = hist.Low.fillna(hist.Close)
    # Unknown volume stays unknown (CMF cannot treat it as genuine zero).
    hist["Volume"] = hist.Volume.where(hist.Volume >= 0)
    return hist


def _wma(series, period):
    weights = np.arange(1, period + 1)
    return series.rolling(period).apply(lambda window: np.dot(window, weights) / weights.sum(), raw=True)


def technical_series(history):
    hist = _numeric(history)
    close, high, low, volume = (hist[c] for c in ("Close", "High", "Low", "Volume"))
    values, actions, groups = {}, {}, {"ma": [], "osc": []}
    def add(name, series, action, group="osc"):
        values[name] = series.replace([np.inf, -np.inf], np.nan)
        actions[name] = action.where(values[name].notna())
        groups[group].append(name)
    def reversal(series, lower, upper):
        return ((series < lower).astype(float) - (series > upper).astype(float)).where(series.notna())
    for period in MA_PERIODS:
        sma = close.rolling(period).mean()
        ema = close.ewm(span=period, adjust=False).mean().where(close.notna())
        # The page has always admitted each MA family after `period` bars.
        ema = ema.where(pd.Series(np.arange(len(close)) >= period - 1, index=close.index))
        add(f"SMA{period}", sma, np.sign(close - sma), "ma")
        add(f"EMA{period}", ema, np.sign(close - ema), "ma")
    for period in MA_PERIODS:
        wma = _wma(close, period)
        # Preserve the page's legacy HMA variant: final SMA, not a new WMA.
        hma = (2 * _wma(close, period // 2) - wma).rolling(int(np.sqrt(period))).mean()
        ema1 = close.ewm(span=period, adjust=False).mean()
        ema2 = ema1.ewm(span=period, adjust=False).mean()
        tema = 3 * ema1 - 3 * ema2 + ema2.ewm(span=period, adjust=False).mean()
        tema = tema.where(pd.Series(np.arange(len(close)) >= period - 1, index=close.index) & close.notna())
        for name, value in ((f"WMA{period}", wma), (f"HMA{period}", hma), (f"TEMA{period}", tema)):
            add(name, value, np.sign(close - value), "ma")
    delta = close.diff()
    def rsi(n):
        up, down = delta.clip(lower=0).rolling(n).mean(), (-delta.clip(upper=0)).rolling(n).mean()
        return (100 * up / (up + down)).mask((up + down).eq(0), 50)
    rsi14 = rsi(14)
    add("RSI14", rsi14, reversal(rsi14, 30, 70))
    macd = close.ewm(span=12, adjust=False).mean() - close.ewm(span=26, adjust=False).mean()
    signal = macd.ewm(span=9, adjust=False).mean()
    macd = macd.where(close.notna())
    add("MACD", macd, np.sign(macd - signal))
    low14, high14 = low.rolling(14).min(), high.rolling(14).max()
    stochastic = (100 * (close - low14) / (high14 - low14)).mask(high14.eq(low14), 50)
    add("Stochastic14", stochastic, reversal(stochastic, 20, 80))
    tr = pd.concat([high - low, (high - close.shift()).abs(), (low - close.shift()).abs()], axis=1).max(axis=1).where(close.notna())
    atr = tr.rolling(14).mean()
    add("ATR14", atr, pd.Series(0., index=hist.index))
    tp = (high + low + close) / 3
    def cci(n):
        deviation = tp.rolling(n).apply(lambda w: np.mean(np.abs(w - np.mean(w))), raw=True)
        return ((tp - tp.rolling(n).mean()) / (.015 * deviation)).mask(deviation.eq(0), 0)
    cci20 = cci(20)
    add("CCI20", cci20, reversal(cci20, -100, 100))
    plus_di = 100 * high.diff().clip(lower=0).rolling(14).sum() / tr.rolling(14).sum()
    minus_di = 100 * (-low.diff()).clip(lower=0).rolling(14).sum() / tr.rolling(14).sum()
    dx = (100 * (plus_di - minus_di).abs() / (plus_di + minus_di)).mask((plus_di + minus_di).eq(0), 0)
    # Keep page ADX variant and its non-directional action; excluded from votes.
    add("ADX14", dx.rolling(14).mean(), pd.Series(np.nan, index=hist.index))
    willr = (-100 * (high14 - close) / (high14 - low14)).mask(high14.eq(low14), -50)
    add("WilliamsR14", willr, reversal(willr, -80, -20))
    for name, lag, percentage in (("ROC12", 12, True), ("Momentum10", 10, False), ("Momentum3M", 63, False)):
        value = (close / close.shift(lag) - 1) * 100 if percentage else close - close.shift(lag)
        add(name, value, np.sign(value))
    e1 = close.ewm(span=15, adjust=False).mean()
    e2 = e1.ewm(span=15, adjust=False).mean()
    trix = e2.ewm(span=15, adjust=False).mean().pct_change(fill_method=None) * 100
    add("TRIX15", trix.where(close.notna()), np.sign(trix))
    bp, range_ = close - low, high - low
    uo = sum(w * bp.rolling(n).sum() / range_.rolling(n).sum() for w, n in ((4, 7), (2, 14), (1, 28))) * 100 / 7
    add("UltimateOsc", uo, reversal(uo, 30, 70))
    cci50 = cci(50)
    add("CCI50", cci50, reversal(cci50, -100, 100))
    for n in (7, 21):
        value = rsi(n)
        add(f"RSI{n}", value, reversal(value, 30, 70))
    add("StochSlow", stochastic, reversal(stochastic, 20, 80))
    high50, low50 = high.rolling(50).max(), low.rolling(50).min()
    willr50 = (-100 * (high50 - close) / (high50 - low50)).mask(high50.eq(low50), -50)
    add("WilliamsR50", willr50, reversal(willr50, -80, -20))
    add("MACD_Hist", macd - signal, np.sign(macd - signal))
    roc6, mom20 = (close / close.shift(6) - 1) * 100, close - close.shift(20)
    add("ROC6", roc6, np.sign(roc6))
    add("Momentum20", mom20, np.sign(mom20))
    mf = (((close - low) - (high - close)) / (high - low)).mask(high.eq(low), 0) * volume
    cmf = mf.rolling(20).sum() / volume.rolling(20).sum()
    # Symmetric high/low candles can leave machine-epsilon CMF around zero;
    # do not change a Buy/Sell vote merely by expressing prices in cents.
    cmf = cmf.mask(cmf.abs() < 1e-12, 0.)
    add("CMF20", cmf, np.sign(cmf))
    return pd.DataFrame(values, index=hist.index), pd.DataFrame(actions, index=hist.index), groups


def technical_page_payload(history, computed=None):
    values, actions, groups = computed if computed is not None else technical_series(history)
    def rows(group):
        result = []
        for name in groups[group]:
            value, action = values[name].iloc[-1], actions[name].iloc[-1]
            if group == "ma" and len(history) < int(''.join(c for c in name if c.isdigit())):
                continue
            label = "Unavailable" if not np.isfinite(action) else {1.: "Buy", -1.: "Sell", 0.: "Neutral"}[action]
            if name == "ADX14" and np.isfinite(value):
                label = "Tendenza Forte" if value > 25 else "Neutro"
            result.append({"name": name, "value": round(float(value), 2) if np.isfinite(value) else None, "action": label})
        return result
    ma, osc = rows("ma"), rows("osc")
    def counts(items):
        return {key: sum(x["action"] == key for x in items) for key in ("Buy", "Sell", "Neutral")}
    ma_count, osc_count = counts(ma), counts(osc)
    total = {key: ma_count[key] + osc_count[key] for key in ma_count}
    direction = lambda c: "Buy" if c["Buy"] > c["Sell"] else "Sell" if c["Sell"] > c["Buy"] else "Neutral"
    general = "Buy" if total["Buy"] > max(total["Sell"], total["Neutral"]) else "Sell" if total["Sell"] > max(total["Buy"], total["Neutral"]) else "Neutral"
    strength = max(total["Buy"], total["Sell"]) / sum(total.values()) if sum(total.values()) else 0.
    return {"overall": general, "movingAveragesSummary": ma, "oscillatorsSummary": osc,
            "maSignal": direction(ma_count), "oscSignal": direction(osc_count),
            "summary": {"general": general, "totalCounts": total, "maCounts": ma_count, "oscCounts": osc_count,
                        "oscillators": direction(osc_count), "movingAverages": direction(ma_count),
                        "strength": strength, "strengthLabel": "Strong" if strength > .7 else "Moderate" if strength > .55 else "Weak"},
            "calculationVersion": PAGE_ENGINE_VERSION,
            "asOf": history.index[-1].isoformat() if len(history) else None}


def monthly_returns(history):
    hist = _numeric(history)
    # Close of calendar month / previous calendar month's close. Keep missing
    # months as barriers; never turn a multi-month move into one monthly return.
    close = hist.Close.resample("ME").last()
    return (close.pct_change(fill_method=None) * 100).round(2)


def seasonal_curves(returns, as_of, prior_years_only=False):
    year_now = pd.Timestamp(as_of).year
    curves = {}
    for year, group in returns.groupby(returns.index.year):
        if year > year_now or (prior_years_only and year >= year_now):
            continue
        if year != year_now and group.notna().sum() < 6:
            continue
        curve = [None] * 12
        for date, value in group.items():
            if np.isfinite(value):
                curve[date.month - 1] = float(value)
        if any(v is not None for v in curve):
            curves[int(year)] = curve
    return curves


def winsorize_curves(curves):
    # Same order-statistic p05/p95 as the page's existing "Riduci outlier".
    values = sorted(v for curve in curves.values() for v in curve if v is not None and np.isfinite(v))
    if not values:
        return curves, {"method": "page-p05-p95-floor", "lowerPct": None, "upperPct": None, "limited": 0, "observations": 0}
    lower, upper = values[int(.05 * (len(values) - 1))], values[int(.95 * (len(values) - 1))]
    filtered = {year: [min(max(v, lower), upper) if v is not None else None for v in curve] for year, curve in curves.items()}
    return filtered, {"method": "page-p05-p95-floor", "lowerPct": lower, "upperPct": upper,
                      "limited": sum(v < lower or v > upper for v in values), "observations": len(values)}


def _percentiles(curves):
    result = []
    for month in range(12):
        values = sorted(curve[month] for curve in curves.values() if curve[month] is not None)
        result.append({key: values[int(p * (len(values) - 1))] if values else None
                       for key, p in (("p10", .1), ("median", .5), ("p90", .9))})
    return result


def seasonality_page_payload(history, exclude_outliers=False, as_of=None, prior_years_only=False):
    date = pd.Timestamp(as_of or pd.Timestamp.now(tz="UTC")).tz_localize(None)
    raw = seasonal_curves(monthly_returns(history), date, prior_years_only)
    curves, audit = winsorize_curves(raw) if exclude_outliers else (raw, None)
    cumulative = {}
    for year, curve in curves.items():
        total, cumul = 1., []
        for value in curve:
            if value is None:
                cumul.append(None)
            else:
                total *= 1 + value / 100
                cumul.append(round((total - 1) * 100, 2))
        cumulative[year] = cumul
    return {"months": ["Gen", "Feb", "Mar", "Apr", "Mag", "Giu", "Lug", "Ago", "Set", "Ott", "Nov", "Dic"],
            "seasonalCurveByYear": curves, "cumulativeCurveByYear": cumulative,
            "monthlyPercentiles": _percentiles(curves), "cumulativePercentiles": _percentiles(cumulative),
            "years": sorted(curves), "excludeOutliers": exclude_outliers, "priorYearsOnly": prior_years_only,
            "outlierAudit": audit, "calculationVersion": PAGE_ENGINE_VERSION,
            "asOf": history.index[-1].date().isoformat() if len(history) else None}
