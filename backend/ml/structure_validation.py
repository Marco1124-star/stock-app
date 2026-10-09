"""Purged temporal selection and OOF calibration for the price-structure MLPs.

Only development predictions choose a pipeline. The final holdout is a report
and publication gate, never a source of hyperparameters or calibration targets.
"""
import numpy as np
import os
from pathlib import Path
from scipy.optimize import minimize_scalar
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from threadpoolctl import threadpool_limits


NAMES = {"legacy": "MLP di riferimento 16/8", "compact": "MLP regolarizzata 8/4",
         "ensemble": "Ensemble di due reti", "linear": "Regressione logistica", "lightgbm": "LightGBM regolarizzato"}


def fit_challengers(x, y, times):
    weights = date_weights(times)
    lower, upper = np.quantile(x, [.01, .99], axis=0)
    scaler = fit_scaler(np.clip(x, lower, upper), weights)
    transformed = scaler.transform(np.clip(x, lower, upper))
    models = {"linear": LogisticRegression(C=.1, max_iter=1000).fit(transformed, y, sample_weight=weights)}
    try:
        from lightgbm import LGBMClassifier
        models["lightgbm"] = LGBMClassifier(n_estimators=100, num_leaves=7, max_depth=3,
            learning_rate=.04, min_child_samples=40, reg_lambda=10., verbosity=-1,
            n_jobs=1, random_state=42, deterministic=True, force_col_wise=True).fit(transformed, y, sample_weight=weights)
    except ImportError:
        pass
    return {name: (model, scaler, lower, upper, True) for name, model in models.items()}


def fit_scaler(x, sample_weight=None):
    if sample_weight is None:
        return StandardScaler().fit(x)
    # Direct centered second moment stays non-negative for nearly-constant
    # features; sklearn's incremental weighted variance can round below zero.
    scaler = StandardScaler()
    scaler.n_features_in_ = x.shape[1]
    scaler.n_samples_seen_ = float(np.sum(sample_weight))
    scaler.mean_ = np.average(x, axis=0, weights=sample_weight)
    scaler.var_ = np.average((x - scaler.mean_) ** 2, axis=0, weights=sample_weight)
    scaler.scale_ = np.sqrt(scaler.var_)
    scaler.scale_[scaler.scale_ <= 1e-12] = 1.
    return scaler


def date_weights(times):
    """Equal total weight for each observation date, mean row weight one."""
    _, inverse, counts = np.unique(times, return_inverse=True, return_counts=True)
    weights = 1. / counts[inverse]
    return weights / weights.mean()


def by_date(values, times):
    return np.array([np.asarray(values)[times == t].mean() for t in np.unique(times)])


def spaced_dates(times, horizon):
    # Index stepping is not enough when missing observations make dates uneven.
    result = []
    for t in np.unique(times):
        if not result or t > result[-1] + horizon:
            result.append(int(t))
    return np.asarray(result, dtype=int)


def purged_folds(times, horizon):
    unique = np.unique(times)
    if len(unique) < 390:
        return []
    start = max(300 + horizon, len(unique) // 2)
    if len(unique) - start < 60:
        return []
    splits, previous = [], None
    for block in np.array_split(unique[start:], 3):
        train = times + horizon < block[0]
        eligible = block if previous is None else block[block > previous + horizon]
        validation_dates = spaced_dates(eligible, horizon)
        if not len(validation_dates):
            continue
        previous = validation_dates[-1]
        test = np.isin(times, validation_dates)
        if len(np.unique(times[train])) >= 300:
            splits.append((train, test))
    return splits


def temperature_scale(probabilities, temperature):
    logits = np.log(np.clip(probabilities, 1e-9, 1)) / temperature
    logits -= logits.max(axis=1, keepdims=True)
    exponent = np.exp(logits)
    return exponent / exponent.sum(axis=1, keepdims=True)


def calibrate(probabilities, labels, times):
    windows = len(np.unique(times))
    identity = {"method": "identity", "temperature": 1., "windows": windows}
    if windows < 20 or len(np.unique(labels)) < probabilities.shape[1]:
        return identity
    weights = date_weights(times)
    def objective(log_temperature):
        p = temperature_scale(probabilities, np.exp(log_temperature))
        nll = np.average(-np.log(np.clip(p[np.arange(len(labels)), labels], 1e-9, 1)), weights=weights)
        # One low-flexibility parameter, with shrinkage toward no calibration.
        return nll + .02 * log_temperature ** 2
    solution = minimize_scalar(objective, bounds=(np.log(.75), np.log(3)), method="bounded")
    if not solution.success or objective(solution.x) >= objective(0.) - .001:
        return identity
    return {"method": "temperature", "temperature": float(np.exp(solution.x)), "windows": windows}


def losses(probabilities, labels):
    targets = np.eye(probabilities.shape[1])[labels]
    brier = ((probabilities - targets) ** 2).sum(axis=1)
    log_loss = -np.log(np.clip(probabilities[np.arange(len(labels)), labels], 1e-9, 1))
    return brier, log_loss


def balanced_accuracy(probabilities, labels, times):
    weights = date_weights(times)
    correct = probabilities.argmax(axis=1) == labels
    return float(np.mean([np.average(correct[labels == c], weights=weights[labels == c])
                          for c in np.unique(labels)]))


def block_draws(size):
    rng = np.random.default_rng(42)
    block = max(2, int(round(size ** (1 / 3))))
    starts = rng.integers(0, size, (1000, int(np.ceil(size / block))))
    return ((starts[:, :, None] + np.arange(block)) % size).reshape(1000, -1)[:, :size]


def current_quality(probabilities, members, fitted_x, current_x):
    if not len(current_x):
        return []
    lower, upper = np.quantile(fitted_x, [.01, .99], axis=0)
    span = np.maximum(upper - lower, 1e-6)
    constant = np.ptp(fitted_x, axis=0) <= 1e-10
    outside = ((current_x < lower - .5 * span) | (current_x > upper + .5 * span))
    # In an almost-constant feature, a new state is an important warning.
    outside[:, constant] = np.abs(current_x[:, constant] - fitted_x[0, constant]) > 1e-6
    ood = outside.sum(axis=1) >= 2
    if constant.any():
        ood |= outside[:, constant].any(axis=1)
    spread = np.ptp(np.stack(members), axis=0).max(axis=1) * 100 if len(members) > 1 else np.zeros(len(current_x))
    ordered = np.sort(probabilities, axis=1)
    confident = (ordered[:, -1] >= .6) & (ordered[:, -1] - ordered[:, -2] >= .15)
    result = []
    for i in range(len(current_x)):
        reason = ("Struttura fuori dal dominio storico: non estrapolare il segnale." if ood[i] else
                  "Le reti sono in disaccordo: segnale sospeso." if spread[i] > 20 else
                  "Probabilità o separazione fra esiti insufficienti: segnale incerto." if not confident[i] else
                  "Confidenza e coerenza interne sufficienti; verificare anche il test fuori campione.")
        result.append({"abstain": bool(ood[i] or spread[i] > 20 or not confident[i]), "reason": reason,
                       "confidencePct": float(ordered[i, -1] * 100), "disagreementPct": float(spread[i]),
                       "outOfDistribution": bool(ood[i])})
    return result


def evaluate_pipeline(data, latest, horizon, boundary, classes, dates, fit_network, predict_network, artifact_name=None):
    # Small networks run more predictably without oversubscribed BLAS threads.
    with threadpool_limits(limits=1):
        result = _evaluate(data, latest, horizon, boundary, classes, dates, fit_network, predict_network, artifact_name)
        return result


def _evaluate(data, latest, horizon, boundary, classes, dates, fit_network, predict_network, artifact_name=None):
    x, y, times = data
    unavailable = lambda reason: ({"status": "unavailable", "reason": reason}, None)
    train = times + horizon < boundary
    test_dates = spaced_dates(times[times >= boundary], horizon)
    test = np.isin(times, test_dates)
    if len(x) == 0 or train.sum() < 300 or len(np.unique(times[train])) < 252 or len(test_dates) < 20:
        return unavailable("Storico insufficiente per training e almeno 20 finestre finali separate.")
    if np.bincount(y[train], minlength=classes).min() < 15:
        return unavailable("Troppi pochi esempi di uno degli esiti nel training.")
    incumbent_train = train & (times >= max(119, len(dates) - 1512))
    if (incumbent_train.sum() < 300 or len(np.unique(times[incumbent_train])) < 252 or
            np.bincount(y[incumbent_train], minlength=classes).min() < 15):
        return unavailable("Confronto con la rete precedente non disponibile: campione recente o esiti insufficienti.")

    def fit_pair(fx, fy, ft):
        legacy = fit_network(fx, fy)  # Exact original specification, benchmark retained.
        compact = fit_network(fx, fy, hidden=(8, 4), alpha=10., seed=17, sample_weight=date_weights(ft))
        models = {name: model for name, model in (("legacy", legacy), ("compact", compact)) if model[-1]}
        # Keep failure explicit when both neural comparators fail.
        if models:
            models.update(fit_challengers(fx, fy, ft))
        return models

    def predict_pair(models, fx):
        output = {}
        for name, fitted in models.items():
            if name not in ("linear", "lightgbm"):
                output[name] = predict_network(fitted, fx, classes)
                continue
            model, scaler, lower, upper, _ = fitted
            transformed = scaler.transform(np.clip(fx, lower, upper))
            if name == "lightgbm":
                raw = model.booster_.predict(transformed)
                raw = np.column_stack([1 - raw, raw]) if raw.ndim == 1 else raw
            else:
                raw = model.predict_proba(transformed)
            probabilities = np.zeros((len(fx), classes))
            probabilities[:, model.classes_.astype(int)] = raw
            output[name] = probabilities
        if "legacy" in output and "compact" in output:
            output["ensemble"] = (output["legacy"] + output["compact"]) / 2
        return output

    def oof(fx, fy, ft):
        # Whole dates stay together; no feature scaling or labels cross a fold boundary.
        folds = purged_folds(ft, horizon)
        predictions, labels, anchors, audits = [], [], [], []
        for fit_mask, val_mask in folds:
            if np.bincount(fy[fit_mask], minlength=classes).min() < 15:
                continue
            models = fit_pair(fx[fit_mask], fy[fit_mask], ft[fit_mask])
            if not models:
                continue
            predictions.append(predict_pair(models, fx[val_mask]))
            labels.append(fy[val_mask]); anchors.append(ft[val_mask])
            audits.append({"trainLabelEnd": dates[int((ft[fit_mask] + horizon).max())].date().isoformat(),
                           "start": dates[int(ft[val_mask].min())].date().isoformat(),
                           "end": dates[int((ft[val_mask] + horizon).max())].date().isoformat()})
        if not predictions:
            return {}, np.array([], dtype=int), np.array([], dtype=int), []
        common = set.intersection(*(set(p) for p in predictions))
        return ({key: np.concatenate([p[key] for p in predictions]) for key in sorted(common)},
                np.concatenate(labels), np.concatenate(anchors), audits)

    # All configuration choices below use development only, never the final test.
    dev_predictions, dev_y, dev_t, fold_audit = oof(x[train], y[train], times[train])
    calibration = {name: calibrate(p, dev_y, dev_t) for name, p in dev_predictions.items()}
    # Choose on uncalibrated OOF loss: calibration cannot win by fitting its own labels.
    scores = {name: float(by_date(losses(p, dev_y)[0], dev_t).mean()) for name, p in dev_predictions.items()}
    selected = min(scores, key=scores.get) if scores else "legacy"
    # Prefer original when the estimated reduction is less than 1% (avoid tuning noise).
    if "legacy" in scores and scores[selected] >= .99 * scores["legacy"]:
        selected = "legacy"
    selected_calibration = calibration.get(selected, {"method": "identity", "temperature": 1., "windows": 0})
    frozen = fit_pair(x[train], y[train], times[train])
    predicted = predict_pair(frozen, x[test])
    if selected not in predicted or "legacy" not in predicted:
        return unavailable("Una rete richiesta non converge: nessuna sostituzione scelta sul test finale.")
    probs = temperature_scale(predicted[selected], selected_calibration["temperature"])
    if np.array_equal(incumbent_train, train):
        original = predicted["legacy"]
    else:
        incumbent = fit_network(x[incumbent_train], y[incumbent_train])
        if not incumbent[-1]:
            return unavailable("La rete precedente non converge: confronto di precisione non disponibile.")
        original = predict_network(incumbent, x[test], classes)
    weights = date_weights(times[train])
    prior = np.bincount(y[train], weights=weights, minlength=classes) / weights.sum()
    baseline = np.tile(prior, (test.sum(), 1))
    # Independent low-complexity comparator with preprocessing fitted on development.
    lower, upper = np.quantile(x[train], [.01, .99], axis=0)
    scaler = fit_scaler(np.clip(x[train], lower, upper), weights)
    linear = LogisticRegression(C=.1, max_iter=1000).fit(
        scaler.transform(np.clip(x[train], lower, upper)), y[train], sample_weight=weights)
    linear_probs = linear.predict_proba(scaler.transform(np.clip(x[test], lower, upper)))
    t = times[test]; target = y[test]
    brier, log_loss = losses(probs, target)
    group_loss = by_date(brier, t)
    group_base = by_date(losses(baseline, target)[0], t)
    group_original = by_date(losses(original, target)[0], t)
    group_linear = by_date(losses(linear_probs, target)[0], t)
    accuracy = float(by_date(probs.argmax(axis=1) == target, t).mean())
    baseline_accuracy = float(by_date(baseline.argmax(axis=1) == target, t).mean())
    draws = block_draws(len(group_loss))
    upper_ci = float(np.quantile((group_loss - group_base)[draws].mean(axis=1), .95))
    old_upper_ci = float(np.quantile((group_loss - group_original)[draws].mean(axis=1), .95))
    brier_ci = np.quantile(group_loss[draws].mean(axis=1), [.025, .975])
    recent = slice(len(group_loss) // 2, None)
    validated = bool(len(fold_audit) >= 2 and group_loss.mean() < .98 * group_base.mean() and
                     group_loss.mean() <= group_original.mean() + 1e-9 and
                     group_loss.mean() <= group_linear.mean() and upper_ci < 0 and
                     accuracy >= baseline_accuracy and group_loss[recent].mean() < group_base[recent].mean())
    target_metrics = {}
    if artifact_name == "gaps":
        # A high binary accuracy on many unhit gaps is not target-picking skill.
        rankings, nearest, selections, hits = [], [], [], []
        for date in np.unique(t):
            indices = np.flatnonzero(t == date)
            labels = target[indices]
            winner = np.flatnonzero(labels == 1)
            predicted_index = int(probs[indices, 1].argmax())
            if len(winner) == 1:
                rankings.append(float(predicted_index == winner[0]))
                distances = np.abs(x[test][indices, -6])
                nearest.append(float(distances.argmin() == winner[0]))
            accepted_target = probs[indices[predicted_index], 1] >= .6
            if accepted_target:
                selections.append(float(labels[predicted_index] == 1))
            hits.append(bool(len(winner)))
        target_metrics = {"targetWindows": len(rankings),
                          "firstTargetRankingAccuracyPct": float(np.mean(rankings) * 100) if rankings else None,
                          "nearestGapRankingAccuracyPct": float(np.mean(nearest) * 100) if nearest else None,
                          "highProbabilityTargetWindows": len(selections),
                          "highProbabilityTargetPrecisionPct": float(np.mean(selections) * 100) if selections else None,
                          "noTargetBaselineAccuracyPct": float((1 - np.mean(hits)) * 100)}
        validated = validated and len(rankings) >= 20 and np.mean(rankings) > np.mean(nearest)
    holdout_members = [predicted[name] for name in ("legacy", "compact", "linear", "lightgbm") if name in predicted]
    quality = current_quality(probs, holdout_members, x[train], x[test])
    accepted = np.array([not q["abstain"] for q in quality])
    test_weights = date_weights(t)
    coverage = float(np.average(accepted, weights=test_weights))
    selective_accuracy = (float(np.average((probs.argmax(axis=1) == target)[accepted], weights=test_weights[accepted]))
                          if accepted.any() else None)
    calibration_bins = []
    confidence = probs.max(axis=1)
    correct = probs.argmax(axis=1) == target
    for lo, hi in ((0., .4), (.4, .6), (.6, .8), (.8, 1.000001)):
        mask = (confidence >= lo) & (confidence < hi)
        if mask.any():
            calibration_bins.append({"fromPct": lo * 100, "toPct": min(hi, 1) * 100,
                                     "observations": int(mask.sum()), "windows": len(np.unique(t[mask])),
                                     "meanConfidencePct": float(np.average(confidence[mask], weights=test_weights[mask]) * 100),
                                     "accuracyPct": float(np.average(correct[mask], weights=test_weights[mask]) * 100)})

    # Same selected architecture, updated OOF calibration and final fit on mature labels.
    # These production weights are not falsely described as themselves holdout-tested.
    final_oof, final_y, final_t, _ = oof(x, y, times)
    final_cal = calibrate(final_oof[selected], final_y, final_t) if selected in final_oof else {"method": "identity", "temperature": 1., "windows": 0}
    final = fit_pair(x, y, times)
    if artifact_name and os.environ.get("STRUCTURE_ARTIFACT_DIR"):
        import joblib
        directory = Path(os.environ["STRUCTURE_ARTIFACT_DIR"])
        directory.mkdir(parents=True, exist_ok=True)
        joblib.dump({"models": final, "selected": selected, "calibration": final_cal,
                     "horizon": horizon, "classes": classes, "trainingEnd": str(dates[int(times.max())]),
                     "featureCount": int(x.shape[1])}, directory / f"{artifact_name}.joblib")
    final_predicted = predict_pair(final, latest) if len(latest) else {}
    if len(latest) and selected not in final_predicted:
        return unavailable("Il riaddestramento della rete selezionata non converge.")
    estimate = temperature_scale(final_predicted[selected], final_cal["temperature"]) if len(latest) else np.empty((0, classes))
    members = [final_predicted[name] for name in ("legacy", "compact", "linear", "lightgbm") if name in final_predicted]
    latest_quality = current_quality(estimate, members, x, latest)
    report = {"status": "validated" if validated else "experimental", "trainingRows": len(x),
              "modelSelection": {"name": NAMES[selected], "candidate": selected, "folds": len(fold_audit),
                                 "developmentBrier": scores, "foldAudit": fold_audit,
                                 "calibration": final_cal, "validationCalibration": selected_calibration},
              "predictionQuality": latest_quality,
              "reliability": latest_quality[0] if latest_quality else None,
              "validation": {"windows": len(test_dates), "observations": int(test.sum()),
                             **target_metrics,
                             "calibrationBins": calibration_bins,
                             "accuracyPct": accuracy * 100, "errorPct": (1 - accuracy) * 100,
                             "baselineAccuracyPct": baseline_accuracy * 100,
                             "balancedAccuracyPct": balanced_accuracy(probs, target, t) * 100,
                             "brier": float(group_loss.mean()), "baselineBrier": float(group_base.mean()),
                             "incumbentBrier": float(group_original.mean()), "linearBrier": float(group_linear.mean()),
                             "logLoss": float(by_date(log_loss, t).mean()),
                             "skillPct": float((1 - group_loss.mean() / group_base.mean()) * 100) if group_base.mean() > 0 else None,
                             "brierInterval95": {"low": float(brier_ci[0]), "high": float(brier_ci[1])},
                             "improvementUpper95": upper_ci, "improvementVsIncumbentUpper95": old_upper_ci,
                             "coveragePct": coverage * 100,
                             "selectiveAccuracyPct": selective_accuracy * 100 if selective_accuracy is not None else None,
                             "recentBrier": float(group_loss[recent].mean()), "recentBaselineBrier": float(group_base[recent].mean()),
                             "trainLabelEnd": dates[int((times[train] + horizon).max())].date().isoformat(),
                             "start": dates[int(test_dates[0])].date().isoformat(), "end": dates[int(test_dates[-1] + horizon)].date().isoformat()},
              "reason": ("Test temporale favorevole rispetto a frequenze, rete precedente e modello lineare; non garanzia futura." if validated else
                         "Il vantaggio non supera tutti i controlli fuori campione: stima sperimentale, non segnale confermato.")}
    return report, estimate
