"""Chronological multi-source models driven by the actual analysis-page engines.

Technical/seasonal features and dated filings; no broker orders or old adaptive model.
See STRUCTURE_NEURAL.md for targets, validation and limitations.
"""
import warnings
import numpy as np
import pandas as pd
from .analysis_pages import completed_daily_history
from .page_structure import calculate_supply_demand_zones, filter_zones_by_distance, merge_close_zones
from .structure_validation import evaluate_pipeline, fit_scaler
from .structure_features import (CONTEXT_FEATURES, PAGE_FEATURES, context_features, page_feature_table,
                                 volatility, first_gap_event, path_event)

VERSION = "structure-neural-v4.2"
TIMEFRAMES = {"1d": (1, 120, 70, 1, .6), "1w": (5, 100, 80, 2, 1.2), "1mo": (21, 60, 90, 4, 2.5)}
GAP_TYPES = ("Gap Up", "Gap Down", "Gap Up 3 candele", "Gap Down 3 candele")
MAX_CANDIDATES = 8
BASE_FEATURES = ["support_present", "support_distance", "support_width", "resistance_present",
                 "resistance_distance", "resistance_width", "range_position", "support_count", "resistance_count"]
GAP_FEATURES = ["gap_mid_distance", "gap_width", "gap_fill", "gap_age_days", "gap_up", "gap_three_candles"]
GAP_STATE_FEATURES = ["open_gap_count", "nearest_gap_above", "nearest_gap_below", "gap_above_present", "gap_below_present"]
TREND_FEATURES = BASE_FEATURES + CONTEXT_FEATURES + PAGE_FEATURES + GAP_STATE_FEATURES


def gap_state(gaps, price):
    distances = [(g["start"] + g["end"]) / (2 * price) - 1 for g in gaps]
    above, below = [d for d in distances if d >= 0], [d for d in distances if d < 0]
    return [len(gaps) / 8, min(above, default=0.), max(below, default=0.), float(bool(above)), float(bool(below))]


def finite(value):
    if isinstance(value, bool):
        raise ValueError("Valore numerico non valido.")
    number = float(value)
    if not np.isfinite(number):
        raise ValueError("Valore numerico non finito.")
    return number


def validate_request(payload):
    if not isinstance(payload, dict):
        raise ValueError("Richiesta non valida.")
    timeframe = payload.get("timeframe", "1d")
    timeframe = "1mo" if timeframe == "1m" else timeframe
    if not isinstance(timeframe, str) or timeframe not in TIMEFRAMES:
        raise ValueError("Seleziona 1D, 1W o 1M.")
    target, _, strength, distance, gap = TIMEFRAMES[timeframe]
    horizon = finite(payload.get("horizon", target))
    if horizon != target:
        raise ValueError("Orizzonte incoerente: 1D = 1, 1W = 5, 1M = 21 sedute.")
    options = {key: finite(payload.get(key, default)) for key, default in (("strength", strength), ("min_pct", distance), ("gap_pct", gap))}
    options["timeframe"] = timeframe
    if not 0 <= options["strength"] <= 100 or any(not 0 <= options[k] <= 50 for k in ("min_pct", "gap_pct")):
        raise ValueError("Filtri dei livelli fuori intervallo.")
    snapshot = payload.get("snapshot")
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("zones"), dict):
        raise ValueError("Mancano i livelli della pagina.")
    price = finite(snapshot.get("price"))
    if price <= 0:
        raise ValueError("Prezzo della pagina non disponibile.")
    gap_window = finite(snapshot.get("gapWindowBars", 260))
    if not 1 <= gap_window <= 2000 or not gap_window.is_integer():
        raise ValueError("Copertura dei gap della pagina non valida.")
    as_of = pd.Timestamp(snapshot.get("asOf"))
    if pd.isna(as_of):
        raise ValueError("Data della pagina non disponibile.")
    as_of = as_of.tz_localize(None).normalize()
    if as_of > pd.Timestamp.now(tz="UTC").tz_localize(None).normalize():
        raise ValueError("Data della pagina nel futuro.")
    zones = {}
    for kind in ("support", "resistance"):
        items = snapshot["zones"].get(kind)
        if not isinstance(items, list) or len(items) > 100:
            raise ValueError("Livelli della pagina non validi.")
        zones[kind] = []
        for item in items:
            row = {key: finite(item.get(key)) for key in ("price", "min", "max")}
            if not 0 < row["min"] <= row["price"] <= row["max"]:
                raise ValueError("Intervallo del livello non valido.")
            zones[kind].append(row)
    gaps = snapshot.get("gaps", [])
    if not isinstance(gaps, list) or len(gaps) > 1000:
        raise ValueError("Elenco gap non valido.")
    clean, seen = [], set()
    for item in gaps:
        start, end, fill = (finite(item.get(k, 0)) for k in ("start", "end", "fillPct"))
        date = pd.Timestamp(item.get("date")).tz_localize(None).normalize()
        kind = item.get("type")
        if pd.isna(date) or date > as_of or date < as_of - pd.DateOffset(years=5) or kind not in GAP_TYPES or not 0 < start <= end or not 0 <= fill < 50:
            raise ValueError("Gap aperto della pagina non valido.")
        if start == end:
            continue  # Legacy chart permits zero-width gaps; they cannot be filled.
        identity = str(item.get("id") or f"{date.date()}|{kind}|{start}|{end}")[:180]
        if identity in seen:
            continue
        seen.add(identity)
        clean.append({"id": identity, "date": date.date().isoformat(), "type": kind,
                      "start": start, "end": end, "fillPct": fill})
    return int(horizon), options, {"price": price, "asOf": as_of.date().isoformat(), "zones": zones,
                                   "gaps": clean, "gapWindowBars": int(gap_window)}


def level_history(history, timeframe):
    """Aggregate an already truncated daily prefix, including its partial last period."""
    if timeframe == "1d":
        return history
    rule = "W-MON" if timeframe == "1w" else "MS"
    return history.resample(rule, closed="left", label="left").agg(
        {"Open": "first", "High": "max", "Low": "min", "Close": "last", "Volume": "sum"}
    ).dropna(subset=["Open", "High", "Low", "Close"])


def page_zones(history, options):
    timeframe = options.get("timeframe", "1d")
    hist = level_history(history, timeframe).tail(TIMEFRAMES[timeframe][1])
    zones = calculate_supply_demand_zones(hist, strength_percentile=options["strength"], pivot_source="close" if timeframe == "1d" else "hilo")
    price = round(float(hist.Close.iloc[-1]), 2)
    return merge_close_zones(filter_zones_by_distance(zones, price, options["min_pct"]), options["gap_pct"])


def detect_gaps(history):
    """Exactly the page's >1% range and same-colour three-candle rules."""
    values = history[["Open", "High", "Low", "Close"]].to_numpy(float)
    gaps = []
    def append(index, start, end, kind, origin):
        if end <= start:
            return
        gaps.append({"index": index, "origin": origin, "date": history.index[index].date().isoformat(),
                     "start": float(start), "end": float(end), "type": kind,
                     "id": f"{history.index[index].date()}|{kind}|{start}|{end}"})
    for i in range(1, len(values)):
        if not np.isfinite(values[i-1:i+1]).all():
            continue
        if values[i, 2] > values[i-1, 1] * 1.01:
            append(i, values[i-1, 1], values[i, 2], "Gap Up", i-1)
        elif values[i, 1] < values[i-1, 2] * .99:
            append(i, values[i, 1], values[i-1, 2], "Gap Down", i-1)
        if i >= 2 and np.isfinite(values[i-2:i+1]).all():
            bars = values[i-2:i+1]
            if (bars[:, 3] > bars[:, 0]).all() and bars[-1, 2] >= bars[0, 1]:
                append(i, bars[0, 1], bars[-1, 2], "Gap Up 3 candele", i-2)
            elif (bars[:, 3] < bars[:, 0]).all() and bars[-1, 1] <= bars[0, 2]:
                append(i, bars[-1, 1], bars[0, 2], "Gap Down 3 candele", i-2)
    return gaps


def fill_pct(gap, history):
    if history.empty:
        return 0.
    width = gap["end"] - gap["start"]
    if "Up" in gap["type"]:
        return float(np.clip((gap["end"] - history.Low.min()) / width, 0, 1) * 100)
    return float(np.clip((history.High.max() - gap["start"]) / width, 0, 1) * 100)


def open_gaps_at(history, events, position):
    date = history.index[position]
    cutoff = date - pd.DateOffset(years=5)
    result = []
    for gap in events:
        if gap["index"] > position or history.index[gap["origin"]] < cutoff:
            continue
        fill = fill_pct(gap, history.iloc[gap["index"]+1:position+1])
        if fill < 50:
            result.append({**gap, "fillPct": fill})
    return result


def zone_features(price, zones):
    supports = [z for z in zones["support"] if z["price"] <= price]
    resistances = [z for z in zones["resistance"] if z["price"] >= price]
    support = max(supports, key=lambda z: z["price"], default=None)
    resistance = min(resistances, key=lambda z: z["price"], default=None)
    values = []
    for zone in (support, resistance):
        values.extend([float(zone is not None), (zone["price"] / price - 1) if zone else 0.,
                       ((zone["max"] - zone["min"]) / price) if zone else 0.])
    width = resistance["price"] - support["price"] if support and resistance else 0
    values.extend([(price - support["price"]) / width if width > 0 else .5,
                   len(supports) / 50, len(resistances) / 50])
    return values


def gap_features(gap, price, date):
    return [((gap["start"] + gap["end"]) / 2) / price - 1, (gap["end"] - gap["start"]) / price,
            gap["fillPct"] / 100, max(0, (pd.Timestamp(date) - pd.Timestamp(gap["date"])).days) / 1826,
            float("Up" in gap["type"]), float("3 candele" in gap["type"])]


def candidates(gaps, price):
    return sorted(gaps, key=lambda g: (abs((g["start"] + g["end"]) / 2 / price - 1), g["id"]))[:MAX_CANDIDATES]


def gap_snapshots(history, events, first, stop, max_bars=None):
    """Update each open gap once per observed bar, never scan its future."""
    by_date = {}
    for gap in events:
        by_date.setdefault(gap["index"], []).append(gap)
    active = []
    values = history[["High", "Low", "Close"]].to_numpy(float)
    for t in range(stop):
        high, low, price = values[t]
        cutoff = history.index[t] - pd.DateOffset(years=5)
        updated = []
        for gap in active:
            if history.index[gap["origin"]] < cutoff or (max_bars is not None and gap["origin"] < t - max_bars + 1):
                continue
            width = gap["end"] - gap["start"]
            amount = (gap["end"] - low) / width if "Up" in gap["type"] else (high - gap["start"]) / width
            fill = max(gap["fillPct"], float(np.clip(amount, 0, 1) * 100)) if np.isfinite(amount) else gap["fillPct"]
            if fill < 50:
                updated.append({**gap, "fillPct": fill})
        active = updated + [{**gap, "fillPct": 0.} for gap in by_date.get(t, [])
                            if max_bars is None or gap["origin"] >= t - max_bars + 1]
        if t >= first:
            yield t, candidates(active, price) if np.isfinite(price) and price > 0 else []


def dataset(history, horizon, options, gap_window_bars=260, page_table=None):
    # The old page's raw OHLC/ADL basis is intentionally retained for geometry.
    history = history.copy()
    events = detect_gaps(history)
    trend_x, trend_y, trend_t, gap_x, gap_y, gap_t = [], [], [], [], [], []
    first = max(219, len(history) - 2016)
    page_table = page_feature_table(history) if page_table is None else page_table
    path_x, path_y, path_t, none_x, none_y, none_t, returns = [], [], [], [], [], [], []
    audit = {"gapAnchors": 0, "ambiguousGapAnchors": 0, "ambiguousPathAnchors": 0, "firstHitSteps": [], "invalidatedCandidates": 0}
    for t, open_gaps in gap_snapshots(history, events, first, len(history) - horizon, gap_window_bars):
        prefix = history.iloc[:t+1]
        timeframe = options.get("timeframe", "1d")
        if timeframe != "1d" and len(level_history(prefix, timeframe)) < TIMEFRAMES[timeframe][1]:
            continue
        recent = history.iloc[t-119:t+horizon+1]
        if not np.isfinite(recent[["Open", "High", "Low", "Close", "Volume"]].to_numpy()).all() or (recent.Close <= 0).any():
            continue
        if recent.index.to_series().diff().dt.days.gt(7).any():
            continue
        # Return labels use Adj Close, never raw split/dividend discontinuities.
        adjusted = history["Adj Close"].iloc[t:t+horizon+1]
        if not np.isfinite(adjusted).all() or (adjusted <= 0).any():
            continue
        price = float(history.Close.iloc[t])
        zones = page_zones(prefix, options)
        features = zone_features(price, zones) + context_features(prefix, zones, horizon) + page_table.iloc[t].tolist() + gap_state(open_gaps, price)
        if not np.isfinite(features).all():
            continue
        scale = volatility(prefix) * np.sqrt(horizon)
        threshold = max(.001, .25 * scale)
        ret = float(adjusted.iloc[-1] / adjusted.iloc[0] - 1)
        trend_x.append(features); trend_y.append(2 if ret > threshold else 0 if ret < -threshold else 1); trend_t.append(t)
        returns.append(ret)
        future = history.iloc[t+1:t+horizon+1]
        path = path_event(future, price, scale)
        if path >= 0:
            path_x.append(features); path_y.append(path); path_t.append(t)
        else:
            audit["ambiguousPathAnchors"] += 1
        if open_gaps:
            event = first_gap_event(open_gaps, future, price, zones)
            audit["gapAnchors"] += 1
            audit["invalidatedCandidates"] += event["invalidated"]
            if event["ambiguous"]:
                audit["ambiguousGapAnchors"] += 1
                continue
            none_x.append(features); none_y.append(int(event["winner"] is None)); none_t.append(t)
            if event["steps"] is not None:
                audit["firstHitSteps"].append(event["steps"])
            for gap in open_gaps:
                gap_x.append(features + gap_features(gap, price, history.index[t]))
                gap_y.append(int(event["winner"] == gap["id"]))
                gap_t.append(t)
    return {"trend": (np.asarray(trend_x), np.asarray(trend_y), np.asarray(trend_t)),
            "path": (np.asarray(path_x), np.asarray(path_y), np.asarray(path_t)),
            "noGap": (np.asarray(none_x), np.asarray(none_y), np.asarray(none_t)),
            "returns": np.asarray(returns), "audit": audit,
            "gaps": (np.asarray(gap_x), np.asarray(gap_y), np.asarray(gap_t))}


def fit_network(x, y, hidden=(16, 8), alpha=5., seed=42, sample_weight=None):
    from sklearn.neural_network import MLPClassifier
    from sklearn.exceptions import ConvergenceWarning
    lower, upper = np.quantile(x, [.01, .99], axis=0)
    discrete = np.all(np.isin(x, [-1., 0., 1.]), axis=0)
    lower[discrete], upper[discrete] = x[:, discrete].min(axis=0), x[:, discrete].max(axis=0)
    scaler = fit_scaler(np.clip(x, lower, upper), sample_weight)
    model = MLPClassifier(hidden_layer_sizes=hidden, activation="tanh", alpha=alpha, max_iter=400,
                          learning_rate_init=.001, early_stopping=False, shuffle=False, random_state=seed, tol=.001)
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always", ConvergenceWarning)
        model.fit(scaler.transform(np.clip(x, lower, upper)), y, sample_weight=sample_weight)
    converged = not any(issubclass(w.category, ConvergenceWarning) for w in caught)
    return model, scaler, lower, upper, converged


def predict_network(fitted, x, classes):
    model, scaler, lower, upper, _ = fitted
    probabilities = np.zeros((len(x), classes))
    probabilities[:, model.classes_.astype(int)] = model.predict_proba(scaler.transform(np.clip(x, lower, upper)))
    return probabilities


def train_task(data, latest, horizon, boundary, classes, dates, task_name="trend"):
    report, estimate = evaluate_pipeline(data, latest, horizon, boundary, classes, dates, fit_network, predict_network, task_name)
    report["features"] = TREND_FEATURES + (GAP_FEATURES if latest.ndim == 2 and latest.shape[1] == len(TREND_FEATURES) + len(GAP_FEATURES) else [])
    return report, estimate


def build_structure_neural(history, payload, now=None, vintages=None, market=None, market_symbol=None):
    horizon, options, snapshot = validate_request(payload)
    result = {"version": VERSION, "status": "unavailable", "horizon": horizon,
              "timeframe": options["timeframe"], "gapTimeframe": "1d", "asOf": snapshot["asOf"],
              "inputSummary": {"supports": len(snapshot["zones"]["support"]), "resistances": len(snapshot["zones"]["resistance"]),
                               "openGaps": len(snapshot["gaps"]), "price": snapshot["price"]}, "pageSnapshot": snapshot}
    # Training excludes today's incomplete bar; inference uses the actual page
    # date, including an observed intraday bar when supplied by the provider.
    current_history = completed_daily_history(history, pd.Timestamp(snapshot["asOf"]) + pd.Timedelta(days=1))
    history = completed_daily_history(history, now)
    for column in ("Open", "High", "Low", "Close", "Volume", "Adj Close"):
        history[column] = pd.to_numeric(history.get(column, np.nan), errors="coerce")
        current_history[column] = pd.to_numeric(current_history.get(column, np.nan), errors="coerce")
    history = history.replace([np.inf, -np.inf], np.nan)
    current_history = current_history.replace([np.inf, -np.inf], np.nan)
    boundary = len(history) - horizon - max(252, 21 * (horizon + 1))
    if len(history) < 850 or boundary < 504 or history.Volume.tail(120).fillna(0).sum() <= 0:
        result["reason"] = "Servono almeno circa quattro anni di OHLC, volumi e chiusure rettificate validi."
        return result
    today = pd.Timestamp(now or pd.Timestamp.now(tz="UTC")).tz_localize(None).normalize()
    snapshot_date = pd.Timestamp(snapshot["asOf"])
    if (today - history.index[-1]).days > 7 or snapshot_date < history.index[-1] or (snapshot_date - history.index[-1]).days > 4:
        result["reason"] = "Storico o dati della pagina non aggiornati: ricarica Previsioni."
        return result
    latest_price = float(current_history.Close.iloc[-1]) if len(current_history) else np.nan
    if not len(current_history) or current_history.index[-1] != snapshot_date or not np.isfinite(latest_price) or latest_price <= 0 or abs(snapshot["price"] / latest_price - 1) > .01:
        result["reason"] = "Il prezzo della pagina e lo storico non sono allineati: ricarica i dati."
        return result
    page_table = page_feature_table(current_history, vintages, market)
    data = dataset(history, horizon, options, snapshot["gapWindowBars"], page_table.reindex(history.index))
    selected = candidates(snapshot["gaps"], snapshot["price"])
    current = zone_features(snapshot["price"], snapshot["zones"]) + context_features(current_history, snapshot["zones"], horizon) + page_table.iloc[-1].tolist() + gap_state(selected, snapshot["price"])
    if not np.isfinite(current).all():
        result["reason"] = "Indicatori recenti incompleti: impossibile produrre una stima affidabile."
        return result
    trend, trend_probs = train_task(data["trend"], np.asarray([current]), horizon, boundary, 3, history.index)
    if trend_probs is not None:
        trend.update(label=["Ribassista", "Laterale", "Rialzista"][int(trend_probs[0].argmax())],
                     probabilities={key: float(trend_probs[0, index] * 100) for key, index in (("down", 0), ("flat", 1), ("up", 2))})
    else:
        trend["label"] = "Non disponibile"
    path, path_probs = train_task(data["path"], np.asarray([current]), horizon, boundary, 3, history.index, "path")
    if path_probs is not None:
        path["probabilities"] = dict(zip(("down", "neither", "up"), (path_probs[0] * 100).tolist()))
    path["barrierPct"] = volatility(current_history) * np.sqrt(horizon) * 100
    none, none_probs = train_task(data["noGap"], np.asarray([current]), horizon, boundary, 2, history.index, "noGap") if selected else ({"status": "unavailable"}, None)
    none["probabilityPct"] = float(none_probs[0, 1] * 100) if none_probs is not None else None
    current_gaps = np.asarray([current + gap_features(g, snapshot["price"], snapshot["asOf"]) for g in selected])
    gaps, gap_probs = train_task(data["gaps"], current_gaps, horizon, boundary, 2, history.index, "gaps") if selected else (
        {"status": "unavailable", "reason": "Nessun gap aperto non degenere nella pagina."}, None)
    qualities = gaps.pop("predictionQuality", [])
    rows = [{**gap, "probabilityPct": float(gap_probs[i, 1] * 100) if gap_probs is not None else None,
             "usable": not qualities[i]["abstain"] if i < len(qualities) else False,
             "disagreementPct": qualities[i]["disagreementPct"] if i < len(qualities) else None,
             "outOfDistribution": qualities[i]["outOfDistribution"] if i < len(qualities) else None,
             "distancePct": ((gap["start"] + gap["end"]) / 2 / snapshot["price"] - 1) * 100,
             "side": "sopra" if (gap["start"] + gap["end"]) / 2 >= snapshot["price"] else "sotto"}
            for i, gap in enumerate(selected)]
    rows.sort(key=lambda g: -(g["probabilityPct"] if g["probabilityPct"] is not None else -1))
    eligible = [g for g in rows if g["usable"] and (g["probabilityPct"] or 0) >= 60]
    # The first gap can be opposite to the final closing direction.
    selected_id = eligible[0]["id"] if eligible and gaps["status"] == "validated" and len(eligible) == 1 else None
    gaps.update(candidates=rows, selectedId=selected_id, totalOpenGaps=len(snapshot["gaps"]), compared=len(rows))
    from .structure_returns import return_interval
    interval = return_interval(data["trend"][0], data["returns"], data["trend"][2], np.asarray([current]), horizon, boundary)
    gap_audit = dict(data["audit"])
    steps = gap_audit.pop("firstHitSteps")
    gap_audit["historicalMedianFirstHitSessions"] = float(np.median(steps)) if steps else None
    result.update(status="ready", trend=trend, gaps=gaps, path=path, noGap=none, returnInterval=interval,
                  eventAudit=gap_audit, neutralBandPct=max(.001, .25 * volatility(current_history) * np.sqrt(horizon)) * 100,
                  featureAsOf=str(current_history.index[-1].date()), trainingAsOf=str(history.index[-1].date()),
                  sourceCoverage=[{"page": "Cerca / Previsioni", "status": "included", "detail": "OHLCV, supporti/resistenze, gap e percorso del prezzo."},
                                  {"page": "Tecnici", "status": "included", "detail": "Stesse formule della pagina: RSI, MACD, ATR, ADX, CMF e medie mobili."},
                                  {"page": "Stagionalità", "status": "included", "detail": "Mediane mensili della pagina, solo anni precedenti e winsorization p05/p95."},
                                  {"page": "Quantitativi", "status": "included", "detail": "Volatilità, downside risk, asimmetria, drawdown e volumi relativi; non previsioni Monte Carlo usate come dati reali."},
                                  {"page": "Bilancio", "status": "included" if any(page_table.iloc[-1][name] == 0 for name in PAGE_FEATURES if name.startswith("missing_fundamental_")) else "unavailable", "detail": "Filing SEC originali con data di accettazione; esclusi valori odierni retrodatati. Disponibilità variabile per titolo."},
                                  {"page": "Mercato di riferimento", "status": "included" if page_table.market_missing.iloc[-1] == 0 else "unavailable", "detail": f"Proxy {market_symbol or 'non disponibile'}, dati antecedenti alla seduta del titolo. Beta/correlazione ritardati, non correlazione sincrona."},
                                  {"page": "Heatmap / settore", "status": "unavailable", "detail": "Non collegato: manca un universo settoriale storico verificato per questo modello. Nessuna classificazione odierna retrodatata."}], parameters=options,
                  caveats=["Trend finale, percorso e primo gap sono problemi distinti: selezione temporale fra MLP, ensemble di reti, regressione logistica e LightGBM quando installato. Nessun ordine automatico.",
                           f"Livelli {options['timeframe']}; gap del grafico giornaliero. Input storici ricostruiti solo con dati disponibili alla data osservata, incluso il periodo corrente parziale. Campioni giornalieri correlati, non periodi indipendenti.",
                           "Trend finale: rendimento rettificato, fascia laterale pari a 0,25 volte la volatilità a 20 sedute per radice dell'orizzonte, minimo 0,1%. Soglia di progetto.",
                           "Gap: primo riempimento al 50% fra gli 8 candidati prima dell'invalidazione sul livello opposto. Ambiguità intraday escluse; probabilità condizionate ai casi ordinabili, stimate separatamente e non una distribuzione congiunta.",
                           f"Confrontati al massimo gli 8 gap aperti più vicini della pagina, sulla sua copertura effettiva di {snapshot['gapWindowBars']} barre (massimo 5 anni). Stessa finestra nel training; nessun gap inventato o senza ampiezza.",
                           "Calibrazione a un parametro su predizioni temporali fuori campione quando ci sono almeno 20 finestre; altrimenti probabilità non calibrate. Non garantisce un errore piccolo.",
                           "Scelta del modello su tre finestre walk-forward precedenti al test finale; il test non sceglie reti o parametri. Il confronto riguarda la procedura storica, non i pesi finali riaddestrati.",
                           "Errore mostrato: classificazioni sbagliate su dati non usati per scegliere il modello, non errore percentuale sul prezzo. Brier e log loss valutano le probabilità; nessuna certificazione di accuratezza futura.",
                           "Segnale sospeso con confidenza sotto 60%, esiti troppo vicini, disaccordo fra reti o struttura fuori dal dominio storico. Le soglie sono scelte di prudenza, non garanzie.",
                           "Zone: formula ADL della pagina, incluse soglie su conteggi nulli/negativi e fallback originali. Nessuna certificazione delle sue ipotesi finanziarie.",
                           "Geometria su OHLC del provider; rendimento trend su Adj Close. Revisioni e corporate action possono alterare lo storico; gap non filtrati per notizie/dividendi.",
                           "Dati intraday della pagina possono differire dall'ultima chiusura usata nel training. Non è un backtest eseguibile né una prova di rendimento."])
    return result
