"""Fixed quantile challenger: untouched temporal holdout, no coverage guarantee."""
import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor
from threadpoolctl import threadpool_limits
from .structure_validation import spaced_dates


def return_interval(x, returns, times, latest, horizon, boundary):
    train = times + horizon < boundary
    test = np.isin(times, spaced_dates(times[times >= boundary], horizon))
    if len(x) == 0 or train.sum() < 300 or test.sum() < 20:
        return {"status": "unavailable", "reason": "Campione insufficiente per verificare l'intervallo."}
    with threadpool_limits(limits=1):
        def fit_predict(fx, fy, target):
            lower, upper = np.quantile(fx, [.01, .99], axis=0)
            predictions = []
            for q in (.1, .5, .9):
                model = HistGradientBoostingRegressor(loss="quantile", quantile=q, max_iter=100,
                    max_leaf_nodes=7, min_samples_leaf=40, l2_regularization=10., early_stopping=False, random_state=42)
                model.fit(np.clip(fx, lower, upper), fy)
                predictions.append(model.predict(np.clip(target, lower, upper)))
            return np.sort(np.asarray(predictions).T, axis=1)
        holdout = fit_predict(x[train], returns[train], x[test])
        current = fit_predict(x, returns, latest)[0]
    y = returns[test]
    coverage = ((y >= holdout[:, 0]) & (y <= holdout[:, 2])).mean()
    return {"status": "experimental", "lowerPct": float(current[0] * 100), "medianPct": float(current[1] * 100),
            "upperPct": float(current[2] * 100), "nominalCoveragePct": 80,
            "observedCoveragePct": float(coverage * 100), "testWindows": int(test.sum()),
            "medianAbsoluteErrorPct": float(np.mean(np.abs(y - holdout[:, 1])) * 100),
            "reason": "Quantili 10/50/90 del rendimento rettificato: intervallo previsionale sperimentale, non certezza sul prezzo."}
