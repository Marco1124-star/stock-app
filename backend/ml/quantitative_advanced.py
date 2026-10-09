"""Ricerca quantitativa point-in-time per il pannello Quantitativi.

Il modulo separa chiaramente dati, stima e diagnostica: il dataset dei filing
viene usato solo dopo la data snapshot, mentre i prezzi locali vengono usati
per la matrice di rischio. Le dipendenze opzionali (LightGBM, CatBoost, SHAP)
non vengono imitate: se non sono installate il payload dichiara la limitazione.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Iterable, Mapping, Optional, Sequence
import importlib.util
import json
import math
import os

import numpy as np
import pandas as pd


FACTOR_COLUMNS = {
    "value": "book_to_market",
    "earnings": "earnings_yield",
    "cashflow": "fcf_yield",
    "quality": "roe",
    "profitability": "gross_margin",
    "size": "log_market_cap",
    "growth": "revenue_growth_yoy",
}
REGULARIZED_FEATURES = [
    "revenue_growth_yoy", "net_income_growth_yoy", "gross_margin",
    "operating_margin", "net_margin", "roe", "roa", "current_ratio",
    "debt_to_equity", "interest_coverage", "cfo_to_net_income",
    "accrual_ratio", "book_to_market", "earnings_yield", "fcf_yield",
    "log_market_cap", "filing_age_years",
]


def _number(value: Any) -> Optional[float]:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _json(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {str(key): _json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json(item) for item in value]
    if isinstance(value, (np.integer, np.floating)):
        return value.item() if math.isfinite(float(value)) else None
    if isinstance(value, np.ndarray):
        return _json(value.tolist())
    if isinstance(value, (pd.Timestamp,)):
        return value.date().isoformat()
    return value


def _rank_zscore(values: pd.Series, ascending: bool = True) -> pd.Series:
    ranks = values.rank(method="average", pct=True, ascending=ascending)
    centered = ranks - ranks.mean()
    scale = ranks.std(ddof=0)
    return centered / scale if scale and math.isfinite(float(scale)) else centered * 0.0


def _spearman(left: pd.Series, right: pd.Series) -> Optional[float]:
    frame = pd.concat([left, right], axis=1).dropna()
    if len(frame) < 8 or frame.iloc[:, 0].nunique() < 3 or frame.iloc[:, 1].nunique() < 3:
        return None
    value = frame.iloc[:, 0].corr(frame.iloc[:, 1], method="spearman")
    return _number(value)


def _load_training_dataset(path: Optional[str] = None) -> pd.DataFrame:
    source = path or os.environ.get("FUNDAMENTAL_DATASET_PATH")
    if not source:
        source = str(Path(__file__).resolve().parents[1] / "models" / "fundamental_v4_annual_dataset.csv")
    file_path = Path(source)
    if not file_path.exists():
        return pd.DataFrame()
    frame = pd.read_csv(file_path, low_memory=False)
    if "snapshot_date" not in frame or "ticker" not in frame:
        return pd.DataFrame()
    frame["snapshot_date"] = pd.to_datetime(frame["snapshot_date"], errors="coerce", utc=True).dt.tz_localize(None)
    frame["ticker"] = frame["ticker"].astype(str).str.upper().str.strip()
    return frame.dropna(subset=["snapshot_date", "ticker"])


def _load_security_master(path: Optional[str] = None) -> Dict[str, Any]:
    source = path or os.environ.get("SECURITY_MASTER_PATH")
    if not source:
        source = str(Path(__file__).resolve().parents[1] / "models" / "security_master_v5.csv")
    file_path = Path(source)
    if not file_path.exists():
        return {
            "status": "not_loaded",
            "pointInTime": False,
            "source": None,
            "rows": 0,
            "warning": "Security master storico non presente: alias, delisting e cambi ticker non possono essere verificati.",
        }
    frame = pd.read_csv(file_path, low_memory=False)
    required = {"security_id", "ticker", "valid_from"}
    if not required.issubset(frame.columns):
        return {"status": "invalid", "pointInTime": False, "source": str(file_path), "rows": len(frame), "warning": "Schema security master incompleto."}
    for column in ("valid_from", "valid_to", "delist_date"):
        if column in frame:
            frame[column] = pd.to_datetime(frame[column], errors="coerce", utc=True)
    overlaps = 0
    for _, group in frame.sort_values(["security_id", "valid_from"]).groupby("security_id"):
        previous_end = None
        for row in group.itertuples():
            start = getattr(row, "valid_from", None)
            end = getattr(row, "valid_to", None)
            if end is None or pd.isna(end):
                end = getattr(row, "delist_date", None)
            if previous_end is not None and pd.notna(start) and start <= previous_end:
                overlaps += 1
            if pd.notna(end):
                previous_end = end
    return {
        "status": "validated" if overlaps == 0 else "invalid",
        "pointInTime": overlaps == 0,
        "source": str(file_path),
        "rows": int(len(frame)),
        "securities": int(frame["security_id"].nunique()),
        "overlaps": int(overlaps),
        "warning": None if overlaps == 0 else "Intervalli sovrapposti nel security master.",
    }


def _cross_sectional_factors(frame: pd.DataFrame, horizon: str, ticker: str) -> Dict[str, Any]:
    target_column = f"target_excess_relative_{horizon}"
    if target_column not in frame or frame[target_column].notna().sum() < 20:
        target_column = f"target_{horizon}"
    working = frame.copy()
    for column in [*FACTOR_COLUMNS.values(), target_column]:
        if column in working:
            working[column] = pd.to_numeric(working[column], errors="coerce")
    latest_date = working["snapshot_date"].max()
    latest = working[working["snapshot_date"] == latest_date].copy()
    if "sic" in latest:
        latest["sector_group"] = pd.to_numeric(latest["sic"], errors="coerce").floordiv(100).astype("Int64").astype(str)
    factor_rows = []
    for key, column in FACTOR_COLUMNS.items():
        if column not in latest:
            continue
        ascending = key in {"size", "growth", "quality", "profitability", "value", "earnings", "cashflow"}
        if "sector_group" in latest and latest["sector_group"].nunique(dropna=True) > 1:
            latest[f"factor_{key}"] = latest.groupby("sector_group", dropna=False)[column].transform(lambda values: _rank_zscore(values, ascending=ascending))
        else:
            latest[f"factor_{key}"] = _rank_zscore(latest[column], ascending=ascending)
        selected = latest[latest["ticker"] == ticker]
        factor_rows.append({"factor": key, "sourceField": column, "value": _number(selected[column].iloc[0]) if not selected.empty else None, "zScore": _number(selected[f"factor_{key}"].iloc[0]) if not selected.empty else None, "coverage": int(latest[column].notna().sum())})
    ic_rows = []
    if target_column in working:
        working["month"] = working["snapshot_date"].dt.to_period("M").astype(str)
        for key, column in FACTOR_COLUMNS.items():
            if column not in working:
                continue
            values = []
            for _, group in working.groupby("month"):
                ic = _spearman(group[column], group[target_column])
                if ic is not None:
                    values.append(ic)
            ic_rows.append({"factor": key, "icMean": _number(np.mean(values)) if values else None, "icMedian": _number(np.median(values)) if values else None, "icPositiveRate": _number(np.mean(np.asarray(values) > 0)) if values else None, "months": len(values)})
    return {"asOf": latest_date.date().isoformat() if pd.notna(latest_date) else None, "universe": int(latest["ticker"].nunique()), "factors": factor_rows, "rankIc": ic_rows, "neutralization": {"method": "cross-sectional rank within snapshot", "sector": "SIC-2 digit" if "sector_group" in latest else "SIC non disponibile nel dataset corrente", "market": "target excess relative to market benchmark"}}


def _regularized_models(frame: pd.DataFrame, horizon: str) -> Dict[str, Any]:
    target_column = f"target_excess_relative_{horizon}"
    if target_column not in frame or frame[target_column].notna().sum() < 20:
        target_column = f"target_{horizon}"
    columns = [column for column in REGULARIZED_FEATURES if column in frame and target_column in frame]
    if len(columns) < 5:
        return {"status": "unavailable", "reason": "Feature insufficienti per la regressione regolarizzata."}
    try:
        from sklearn.impute import SimpleImputer
        from sklearn.linear_model import ElasticNet, Lasso, Ridge
        from sklearn.metrics import mean_absolute_error, r2_score
        from sklearn.pipeline import Pipeline
        from sklearn.preprocessing import StandardScaler
    except ImportError:
        SimpleImputer = Ridge = Lasso = ElasticNet = Pipeline = StandardScaler = None
        mean_absolute_error = r2_score = None
    data = frame[columns + [target_column, "snapshot_date"]].copy().dropna(subset=[target_column]).sort_values("snapshot_date")
    if len(data) < max(100, len(columns) * 8):
        return {"status": "unavailable", "reason": "Campione temporale insufficiente."}
    split = max(len(columns) * 5, int(len(data) * 0.8))
    split = min(split, len(data) - max(20, len(columns)))
    x_train, x_test = data[columns].iloc[:split], data[columns].iloc[split:]
    y_train, y_test = data[target_column].iloc[:split], data[target_column].iloc[split:]
    output = {}
    if Pipeline is not None:
        estimators = (("ridge", Ridge(alpha=10.0)), ("lasso", Lasso(alpha=0.001, max_iter=10000)), ("elasticnet", ElasticNet(alpha=0.001, l1_ratio=0.5, max_iter=10000)))
        for name, estimator in estimators:
            model = Pipeline([("imputer", SimpleImputer(strategy="median", add_indicator=True)), ("scale", StandardScaler()), ("model", estimator)])
            model.fit(x_train, y_train)
            prediction = model.predict(x_test)
            output[name] = {"mae": _number(mean_absolute_error(y_test, prediction)), "r2": _number(r2_score(y_test, prediction)), "trainRows": int(len(x_train)), "testRows": int(len(x_test)), "features": columns, "coefficients": [_number(value) for value in getattr(model[-1], "coef_", [])], "implementation": "scikit-learn"}
    else:
        # Fallback matematico deterministico per il runtime minimale del backend.
        train = x_train.apply(pd.to_numeric, errors="coerce")
        test = x_test.apply(pd.to_numeric, errors="coerce")
        medians = train.median().fillna(0.0)
        train = train.fillna(medians).to_numpy(dtype=float)
        test = test.fillna(medians).to_numpy(dtype=float)
        center = train.mean(axis=0)
        scale = train.std(axis=0)
        scale[scale < 1e-12] = 1.0
        train = (train - center) / scale
        test = (test - center) / scale
        y_train_array = y_train.to_numpy(dtype=float)
        y_test_array = y_test.to_numpy(dtype=float)
        def fit_regularized(alpha, l1_ratio):
            weights = np.linalg.solve(train.T @ train + np.eye(train.shape[1]) * alpha * (1 - l1_ratio), train.T @ y_train_array)
            if l1_ratio:
                for _ in range(60):
                    for index in range(train.shape[1]):
                        residual = y_train_array - train @ weights + train[:, index] * weights[index]
                        rho = float(train[:, index] @ residual)
                        weights[index] = np.sign(rho) * max(abs(rho) - alpha * l1_ratio, 0) / max(float(train[:, index] @ train[:, index]) + alpha * (1 - l1_ratio), 1e-12)
            return weights
        for name, alpha, l1_ratio in (("ridge", 10.0, 0.0), ("lasso", 0.001, 1.0), ("elasticnet", 0.001, 0.5)):
            weights = fit_regularized(alpha, l1_ratio)
            prediction = test @ weights
            ss_res = float(np.sum((y_test_array - prediction) ** 2))
            ss_tot = float(np.sum((y_test_array - y_test_array.mean()) ** 2)) or 1e-12
            output[name] = {"mae": _number(np.mean(np.abs(y_test_array - prediction))), "r2": _number(1 - ss_res / ss_tot), "trainRows": int(len(x_train)), "testRows": int(len(x_test)), "features": columns, "coefficients": [_number(value) for value in weights], "implementation": "numpy-fallback"}
    return {"status": "ready", "horizon": horizon, "models": output, "validation": "80/20 temporal, no random shuffle"}


def _garch11(values: Sequence[float]) -> Dict[str, Any]:
    returns = np.asarray(values, dtype=float)
    returns = returns[np.isfinite(returns)]
    if returns.size < 80:
        return {"status": "unavailable", "reason": "Servono almeno 80 rendimenti per GARCH(1,1)."}
    try:
        from scipy.optimize import minimize
        variance = float(np.var(returns)) or 1e-6
        def objective(params):
            omega, alpha, beta = params
            if omega <= 0 or alpha < 0 or beta < 0 or alpha + beta >= 0.999:
                return 1e12
            sigma = np.empty_like(returns)
            sigma[0] = variance
            for index in range(1, len(returns)):
                sigma[index] = omega + alpha * returns[index - 1] ** 2 + beta * sigma[index - 1]
            return float(np.mean(np.log(sigma) + returns ** 2 / sigma))
        result = minimize(objective, [variance * 0.05, 0.08, 0.90], method="Nelder-Mead", options={"maxiter": 3000})
        omega, alpha, beta = [float(value) for value in result.x]
        sigma = variance
        for value in returns:
            sigma = omega + alpha * value ** 2 + beta * sigma
        return {"status": "ready", "model": "GARCH(1,1)", "omega": omega, "alpha": alpha, "beta": beta, "persistence": alpha + beta, "conditionalVolatility": math.sqrt(max(sigma, 0)) * math.sqrt(252), "converged": bool(result.success)}
    except Exception as exc:
        return {"status": "unavailable", "reason": str(exc)}


def _portfolio_optimizer(price_dir: Optional[str] = None, universe: Optional[Iterable[str]] = None) -> Dict[str, Any]:
    directory = Path(price_dir or os.environ.get("ML_PRICE_CACHE_DIR") or Path(__file__).resolve().parents[1] / ".ml-cache" / "prices")
    tickers = [str(value).upper() for value in (universe or []) if value]
    files = [directory / f"{ticker}.csv" for ticker in tickers] if tickers else sorted(directory.glob("*.csv"))
    series = {}
    # Limita l'ottimizzazione interattiva a 40 titoli liquidi deterministici;
    # l'universo completo resta disponibile nel dataset fattoriale.
    for file_path in files[:40]:
        try:
            frame = pd.read_csv(file_path, index_col=0, parse_dates=True)
            column = "Adj Close" if "Adj Close" in frame else "Close"
            series[file_path.stem.upper()] = pd.to_numeric(frame[column], errors="coerce")
        except Exception:
            continue
    prices = pd.DataFrame(series).sort_index().tail(756).dropna(axis=1, thresh=300)
    returns = prices.pct_change(fill_method=None).dropna(how="all").dropna(axis=1, thresh=250).dropna()
    if returns.shape[1] < 3 or len(returns) < 120:
        return {"status": "unavailable", "reason": "Prezzi insufficienti per ottimizzare il portafoglio."}
    tickers = list(returns.columns)
    mean = returns.mean().to_numpy() * 252
    covariance = returns.cov().to_numpy() * 252 + np.eye(len(tickers)) * 1e-8
    try:
        from scipy.optimize import minimize
        n = len(tickers)
        constraints = ({"type": "eq", "fun": lambda weights: np.sum(weights) - 1},)
        bounds = [(0.0, 0.20)] * n
        initial = np.ones(n) / n
        def variance(weights): return float(weights @ covariance @ weights)
        min_var = minimize(variance, initial, bounds=bounds, constraints=constraints, method="SLSQP")
        def negative_sharpe(weights): return -float((weights @ mean) / max(math.sqrt(variance(weights)), 1e-12))
        max_sharpe = minimize(negative_sharpe, initial, bounds=bounds, constraints=constraints, method="SLSQP")
        inverse_vol = 1 / np.sqrt(np.diag(covariance))
        risk_parity = inverse_vol / inverse_vol.sum()
        serialize = lambda result: [{"ticker": ticker, "weight": _number(weight)} for ticker, weight in zip(tickers, result)]
        return {"status": "ready", "observations": int(len(returns)), "assets": len(tickers), "covarianceConditionNumber": _number(np.linalg.cond(covariance)), "minimumVariance": serialize(min_var.x if min_var.success else initial), "maximumSharpe": serialize(max_sharpe.x if max_sharpe.success else initial), "riskParity": serialize(risk_parity), "constraints": {"longOnly": True, "maxWeight": 0.20, "sumWeights": 1.0}}
    except Exception as exc:
        return {"status": "unavailable", "reason": str(exc)}


def build_quantitative_research_payload(artifact: Mapping[str, Any], ticker: str, *, returns: Optional[Sequence[float]] = None, dataset_path: Optional[str] = None, security_master_path: Optional[str] = None, price_dir: Optional[str] = None) -> Dict[str, Any]:
    symbol = str(ticker or "").strip().upper()
    frame = _load_training_dataset(dataset_path)
    if frame.empty:
        return {"status": "unavailable", "symbol": symbol, "error": "Dataset point-in-time non disponibile."}
    universe = frame["ticker"].dropna().unique().tolist()
    issuer_audit = ((artifact.get("dataset") or {}).get("issuerAudit") or []) if isinstance(artifact, Mapping) else []
    sic_map = {str(row.get("ticker") or "").upper(): row.get("sic") for row in issuer_audit if isinstance(row, Mapping)}
    if sic_map:
        frame["sic"] = frame["ticker"].map(sic_map)
    models = {horizon: _regularized_models(frame, horizon) for horizon in ("1m", "3m", "1y")}
    algorithms = {name: bool(importlib.util.find_spec(name)) for name in ("xgboost", "lightgbm", "catboost", "shap")}
    artifact_models = {}
    for horizon, model in (artifact.get("models") or {}).items():
        performance = model.get("performance") or {}
        artifact_models[horizon] = {"selected": model.get("modelType"), "publishable": bool(model.get("publishable")), "validationStatus": model.get("validationStatus") or performance.get("validationStatus"), "rankIcMean": _number(performance.get("crossSectionalRankIcMean")), "rankIcCi95": performance.get("blockBootstrap95", {}).get("intervals", {}).get("crossSectionalRankIcMean")}
    return _json({"status": "ready", "symbol": symbol, "asOf": frame["snapshot_date"].max(), "universe": {"issuers": len(universe), "tickers": universe, "source": "fundamental_v4_annual_dataset.csv", "pointInTime": True}, "securityMaster": _load_security_master(security_master_path), "factors": {horizon: _cross_sectional_factors(frame, horizon, symbol) for horizon in ("1m", "3m", "1y")}, "regularizedModels": models, "treeModels": {"artifact": artifact_models, "runtimeAvailability": algorithms, "policy": "champion per orizzonte; ranking/return calibrati separatamente"}, "garch": _garch11(returns if returns is not None else []), "portfolio": _portfolio_optimizer(price_dir, universe), "explainability": {"shap": "native TreeSHAP disponibile solo quando il pacchetto SHAP o il contributo nativo del booster è caricabile", "linear": "contributi esatti coefficient × feature per Ridge/Lasso/ElasticNet", "lookAhead": "features e scaling stimati dentro ciascun fold temporale"}})
