"""Prospective heat-map signals with purged, expanding-window validation.

Prices are daily adjusted closes on the target's calendar. At close t the
information set ends at t; entry is close t+1 and the label ends at t+1+h.
Same-period correlation/intercepts are deliberately not forecasting inputs.
"""
import numpy as np
import pandas as pd


VERSION = "forward-ridge-v1"
HORIZONS = {"daily": 1, "monthly": 21, "annual": 252}
MIN_TRAIN = 252
MIN_VALIDATION = {"daily": 60, "monthly": 12, "annual": 8}


def _number(value):
    try:
        result = float(value)
        return result if np.isfinite(result) else None
    except (ValueError, TypeError):
        return None


def _date(value):
    return pd.Timestamp(value).tz_localize(None).normalize()


def _clean_prices(series, as_of):
    if not isinstance(series, pd.Series) or series.empty:
        return pd.Series(dtype=float, index=pd.DatetimeIndex([]))
    prices = pd.to_numeric(series.copy(), errors="coerce")
    prices.index = pd.to_datetime(prices.index, errors="coerce", utc=True).tz_localize(None).normalize()
    prices = prices.loc[~prices.index.isna()]
    prices = prices.loc[~prices.index.duplicated(keep="last")].sort_index()
    prices = prices.loc[prices.index <= as_of]
    # Keep invalid-price barriers: dropping them would bridge missing sessions.
    return prices.where(np.isfinite(prices) & (prices > 0))


def _returns(prices, sessions):
    result = prices.div(prices.shift(sessions)).sub(1)
    continuous = prices.notna().rolling(sessions + 1, min_periods=sessions + 1).sum().eq(sessions + 1)
    return result.where(continuous).replace([np.inf, -np.inf], np.nan)


def prepare_signal_dataset(target_prices, factor_prices, horizon, sector_factor="Settore", as_of=None):
    h = HORIZONS[horizon]
    cutoff = _date(as_of if as_of is not None else pd.Timestamp.now(tz="UTC"))
    target = _clean_prices(target_prices, cutoff)
    # Reindex on the union so missing target sessions present in a factor remain
    # explicit, while calendar weekends are not fabricated as trading sessions.
    factors = {name: _clean_prices(series, cutoff) for name, series in factor_prices.items()}
    calendar = target.index
    if len(calendar):
        for prices in factors.values():
            calendar = calendar.union(prices.loc[(prices.index >= target.index[0]) & (prices.index <= target.index[-1])].index)
    target = target.reindex(calendar)
    # Long provider gaps must not look like one trading day on a sparse calendar.
    calendar_gaps = calendar.to_series().diff().dt.days.gt(5)
    target = target.mask(calendar_gaps)
    factors = {name: prices.reindex(calendar).mask(calendar_gaps) for name, prices in factors.items()}
    features = {}
    for lag in (1, 5, 21, 63):
        features[f"Titolo · rendimento {lag} sedute"] = _returns(target, lag)
    daily = _returns(target, 1)
    for lag in (21, 63):
        features[f"Titolo · volatilità {lag} sedute"] = daily.rolling(lag, min_periods=lag).std()
    for name, prices in factors.items():
        for lag in ((1, 5, 21, 63) if name == sector_factor or name == "Mercato · SPY" else (21,)):
            features[f"{name} · rendimento {lag} sedute"] = _returns(prices, lag)
    sector = factors.get(sector_factor, pd.Series(np.nan, index=calendar))
    for lag in (21, 63):
        features[f"Forza relativa · {lag} sedute"] = _returns(target, lag) - _returns(sector, lag)
    feature_frame = pd.DataFrame(features, index=calendar)
    dates = pd.Series(calendar, index=calendar)
    entry = target.shift(-1)
    end = target.shift(-(h + 1))
    # All closes from t+1 through t+1+h must exist, including intervening ones.
    continuous = target.notna().rolling(h + 1, min_periods=h + 1).sum().shift(-(h + 1)).eq(h + 1)
    labels = end.div(entry).sub(1).where(continuous).replace([np.inf, -np.inf], np.nan)
    return {
        "features": feature_frame, "labels": labels, "labelEnd": dates.shift(-(h + 1)),
        "entryDate": dates.shift(-1), "horizonSessions": h,
        "asOf": calendar[-1].date().isoformat() if len(calendar) else None,
        "cutoff": cutoff, "target": target, "sector": sector,
    }


def _fit(train_x, train_y):
    """Median imputation, clipping and scaling learned ONLY inside this fold."""
    columns = train_x.columns[train_x.notna().mean().ge(0.8)]
    if not len(columns):
        return None
    x = train_x[columns]
    medians = x.median()
    lower, upper = x.quantile(0.01), x.quantile(0.99)
    clipped = x.fillna(medians).clip(lower=lower, upper=upper, axis=1)
    means, scales = clipped.mean(), clipped.std(ddof=0)
    columns = scales.index[scales.gt(1e-10) & scales.notna()]
    if not len(columns):
        return None
    z = ((clipped[columns] - means[columns]) / scales[columns]).to_numpy()
    y = train_y.to_numpy(dtype=float)
    # Fixed regularisation on mean squared loss; no optimisation on holdout.
    penalty = 1.0
    beta = np.linalg.solve(z.T @ z / len(z) + penalty * np.eye(z.shape[1]), z.T @ (y - y.mean()) / len(z))
    return {"columns": columns, "medians": medians[columns], "lower": lower[columns],
            "upper": upper[columns], "means": means[columns], "scales": scales[columns],
            "beta": beta, "intercept": float(y.mean())}


def _predict(model, frame):
    x = frame[model["columns"]].fillna(model["medians"])
    x = x.clip(lower=model["lower"], upper=model["upper"], axis=1)
    z = (x - model["means"]) / model["scales"]
    return model["intercept"] + z.to_numpy() @ model["beta"]


def _non_overlapping(frame):
    selected, last_end = [], None
    for origin, row in frame.iterrows():
        if last_end is None or row["entry"] >= last_end:
            selected.append(origin)
            last_end = row["end"]
    return frame.loc[selected]


def _methodology(horizon):
    return {
        "label": "Ridge prospettica · verifica walk-forward con separazione delle etichette",
        "executionDelaySessions": 1, "minValidationObservations": MIN_VALIDATION[horizon],
        "sources": [
            {"label": "Validazione temporale", "url": "https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html"},
            {"label": "Prevenzione del data leakage", "url": "https://scikit-learn.org/stable/common_pitfalls.html"},
        ],
        "caveats": [
            "Classificazione e peer correnti: universo non point-in-time, possibile survivorship bias.",
            "Intervallo empirico all'80% dagli errori fuori campione; copertura futura non garantita.",
            "Le finestre non sovrapposte possono comunque essere correlate nel tempo; affidabilità indicativa, non certificazione statistica.",
            "Soglia = costo ipotizzato + 10% dell'errore RMSE. Politica prudenziale, non soglia universale ottimizzata.",
            "Acquista/Vendi richiedono vantaggio su media storica e rendimento zero, stabilità e supporto empirico del 55%.",
            "Vendi indica riduzione/uscita da una posizione; il modello non simula vendite allo scoperto.",
        ],
    }


def unavailable_signal(horizon, status, reason, cost_bps=20.0):
    return {
        "version": VERSION, "action": "unavailable", "label": "Non disponibile", "status": status,
        "bias": "Non stimabile", "asOf": None, "horizonSessions": HORIZONS[horizon],
        "forecastReturnPct": None, "interval80": None, "upsideProbability": None,
        "confidence": "Non stimabile", "costBps": cost_bps, "decisionThresholdPct": None,
        "reasons": [reason], "drivers": [], "validation": {"status": status},
        "methodology": _methodology(horizon),
        "caveat": "Stima sperimentale: accuratezza e rendimento futuro non garantiti.",
    }


def build_heatmap_signal(target_prices, factor_prices, horizon, *, sector_factor="Settore", cost_bps=20.0, as_of=None):
    if horizon not in HORIZONS:
        raise ValueError("Orizzonte non valido")
    cost_bps = _number(cost_bps)
    if cost_bps is None or not 0 <= cost_bps <= 500:
        raise ValueError("Il costo deve essere compreso tra 0 e 500 punti base")
    data = prepare_signal_dataset(target_prices, factor_prices, horizon, sector_factor, as_of)
    result = unavailable_signal(horizon, "insufficient_data", "Storico o fattore settore insufficienti.", cost_bps)
    result["asOf"] = data["asOf"]
    target, sector, features = data["target"], data["sector"], data["features"]
    if not len(target):
        return result
    if (data["cutoff"] - target.index[-1]).days > 7:
        result.update(status="stale_data", reasons=["L'ultima quotazione risale a oltre 7 giorni fa: aggiornare lo storico."])
        return result
    if pd.isna(target.iloc[-1]) or pd.isna(sector.iloc[-1]):
        result.update(status="stale_data", reasons=["Titolo e settore non hanno una chiusura valida sulla stessa ultima data."])
        return result
    core = ["Titolo · rendimento 21 sedute", "Titolo · volatilità 21 sedute", "Forza relativa · 21 sedute"]
    eligible = features[core].notna().all(axis=1)
    if not bool(eligible.iloc[-1]):
        result["reasons"] = ["Mancano chiusure consecutive recenti per titolo e settore; il segnale è sospeso."]
        return result
    train_mask = eligible & data["labels"].notna()
    positions = np.flatnonzero(train_mask.to_numpy())
    if len(positions) < MIN_TRAIN + 40:
        result["reasons"] = [f"Solo {len(positions)} esempi con rendimento futuro già osservato; ne servono almeno {MIN_TRAIN + 40}."]
        return result
    h = data["horizonSessions"]
    first_origin = positions[MIN_TRAIN - 1] + h + 2
    validation_positions = positions[positions >= first_origin]
    if not len(validation_positions):
        result["reasons"] = ["Storico insufficiente dopo la separazione tra addestramento e verifica."]
        return result
    records, folds, prior_forecasts = [], [], []
    for fold_number, block in enumerate(np.array_split(validation_positions, 4), 1):
        if not len(block):
            continue
        start = features.index[block[0]]
        fold_mask = train_mask & data["labelEnd"].lt(start)
        if int(fold_mask.sum()) < MIN_TRAIN:
            continue
        fitted = _fit(features.loc[fold_mask], data["labels"].loc[fold_mask])
        if fitted is None:
            continue
        yhat = _predict(fitted, features.iloc[block])
        baseline = float(data["labels"].loc[fold_mask].mean())
        for pos, prediction in zip(block, yhat):
            records.append({"origin": features.index[pos], "actual": float(data["labels"].iloc[pos]),
                            "prediction": float(prediction), "baseline": baseline,
                            "entry": data["entryDate"].iloc[pos], "end": data["labelEnd"].iloc[pos]})
        prior_forecasts.append(float(_predict(fitted, features.iloc[[-1]])[0]))
        folds.append({"fold": fold_number, "trainObservations": int(fold_mask.sum()),
                      "trainLabelEnd": data["labelEnd"].loc[fold_mask].max().date().isoformat(),
                      "validationStart": start.date().isoformat(),
                      "validationEnd": features.index[block[-1]].date().isoformat()})
    if not records:
        result["reasons"] = ["Il modello non produce previsioni temporali verificabili sul campione disponibile."]
        return result
    model = _fit(features.loc[train_mask], data["labels"].loc[train_mask])
    if model is None:
        result["reasons"] = ["I fattori non presentano variazione sufficiente per stimare il modello."]
        return result
    forecast = float(_predict(model, features.iloc[[-1]])[0])
    if not np.isfinite(forecast) or forecast <= -1:
        result["reasons"] = ["Stima fuori dal dominio dei rendimenti: modello non applicabile a questa osservazione."]
        return result
    oos = pd.DataFrame(records).set_index("origin")
    independent = _non_overlapping(oos)
    errors = independent.actual.to_numpy() - independent.prediction.to_numpy()
    rmse = float(np.sqrt(np.mean(errors ** 2)))
    base_rmse = float(np.sqrt(np.mean((independent.actual - independent.baseline) ** 2)))
    zero_rmse = float(np.sqrt(np.mean(independent.actual ** 2)))
    skill_base = 1 - rmse / base_rmse if base_rmse > 1e-12 else None
    skill_zero = 1 - rmse / zero_rmse if zero_rmse > 1e-12 else None
    accuracy = float(np.mean(np.sign(independent.actual) == np.sign(independent.prediction)))
    baseline_accuracy = float(np.mean(np.sign(independent.actual) == np.sign(independent.baseline)))
    stability = float(np.mean(np.sign(prior_forecasts) == np.sign(forecast)))
    n = len(independent)
    adequate = n >= MIN_VALIDATION[horizon] and len(folds) >= 3
    cost = cost_bps / 10000
    threshold = cost + 0.10 * rmse
    probability = float((1 + np.sum(forecast + errors > cost)) / (n + 2)) if adequate else None
    downside = float((1 + np.sum(forecast + errors < -cost)) / (n + 2)) if adequate else None
    edge = (skill_base is not None and skill_base > 0 and skill_zero is not None and skill_zero > 0
            and accuracy >= max(0.5, baseline_accuracy) and stability >= 0.75)
    action, status, label = "hold", "no_edge", "Attendi"
    if not adequate:
        action, status, label = "unavailable", "insufficient_validation", "Da validare"
    elif edge and forecast > threshold and probability >= 0.55:
        action, status, label = "buy", "ready", "Acquista"
    elif edge and forecast < -threshold and downside >= 0.55:
        action, status, label = "sell", "ready", "Vendi"
    confidence = "Limitata" if adequate else "Non stimabile"
    if adequate and edge and n >= 40:
        confidence = "Moderata"
        # Wilson lower bound prevents a few correct calls from implying certainty.
        z = 1.96
        lower = (accuracy + z*z/(2*n) - z*np.sqrt(accuracy*(1-accuracy)/n + z*z/(4*n*n))) / (1+z*z/n)
        if n >= 100 and lower > 0.5 and min(skill_base, skill_zero) >= 0.05 and stability == 1:
            confidence = "Alta"
    reasons = [f"Stima {forecast * 100:+.2f}% sulle prossime {h} sedute, con ingresso ipotizzato alla chiusura della seduta successiva."]
    if not adequate:
        reasons.append(f"Solo {n} osservazioni di verifica non sovrapposte: ne servono {MIN_VALIDATION[horizon]}. Nessuna indicazione operativa validata per questo orizzonte.")
    else:
        reasons.append(f"Errore fuori campione {rmse * 100:.2f} punti percentuali; media storica {base_rmse * 100:.2f}, previsione zero {zero_rmse * 100:.2f}.")
        if not edge:
            if skill_base is None or skill_base <= 0 or skill_zero is None or skill_zero <= 0:
                reasons.append("Il modello non migliora entrambi i riferimenti fuori campione: manca un vantaggio predittivo misurato.")
            if accuracy < max(0.5, baseline_accuracy):
                reasons.append("La frequenza delle direzioni corrette non supera il riferimento storico.")
            if stability < 0.75:
                reasons.append("La direzione della stima cambia troppo tra i modelli delle diverse finestre.")
        elif action == "hold":
            reasons.append("Il movimento stimato non supera costo e margine d'errore con sufficiente supporto empirico.")
        else:
            reasons.append("Vantaggio fuori campione, direzione stabile e movimento stimato superiore alla soglia dopo i costi.")
    reasons.append(f"Costo ipotizzato {cost_bps:g} punti base; soglia dinamica {threshold * 100:.2f}% (costo + 10% del RMSE).")
    current = features.iloc[-1][model["columns"]].fillna(model["medians"])
    contribution = (current.clip(lower=model["lower"], upper=model["upper"]) - model["medians"]) / model["scales"] * model["beta"]
    drivers = [{"feature": str(name), "contributionPct": float(value * 100)}
               for name, value in contribution.loc[contribution.abs().sort_values(ascending=False).index].head(5).items()]
    result.update({
        "action": action, "label": label, "status": status,
        "bias": "Rialzista" if forecast > 1e-9 else "Ribassista" if forecast < -1e-9 else "Bilanciata",
        "forecastReturnPct": float(forecast * 100), "decisionThresholdPct": float(threshold * 100),
        "interval80": {"lowerPct": float(max(-1, forecast + np.quantile(errors, 0.1)) * 100),
                       "upperPct": float(max(-1, forecast + np.quantile(errors, 0.9)) * 100)} if adequate else None,
        "upsideProbability": probability, "confidence": confidence, "drivers": drivers,
        "validation": {"status": "ready" if adequate else "insufficient_validation", "observations": len(oos),
                       "nonOverlappingObservations": n, "folds": len(folds), "foldAudit": folds,
                       "rmsePct": rmse * 100, "baselineRmsePct": base_rmse * 100,
                       "zeroRmsePct": zero_rmse * 100, "skillVsBaseline": skill_base, "skillVsZero": skill_zero,
                       "directionAccuracy": accuracy, "baselineDirectionAccuracy": baseline_accuracy,
                       "stability": stability, "start": str(oos.index[0].date()), "end": str(oos["end"].iloc[-1].date())},
        "reasons": reasons,
    })
    return result
