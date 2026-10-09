"""Modello auditabile per i rendimenti fondamentali.

Ridge resta il benchmark e il fallback operativo. XGBoost e LightGBM possono
competere come challenger usando gli stessi dati point-in-time, preprocessing
e fold walk-forward. Tutte le trasformazioni vengono apprese sul solo training
set e serializzate nel medesimo artifact JSON del modello.
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta
import hashlib
import inspect
import math
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from .model_backends import (
    ALGORITHM_LABELS,
    DEFAULT_TREE_CONFIGS,
    algorithm_available,
    fit_tree_model,
    predict_tree_model,
    tree_contributions,
)


MODEL_VERSION = "fundamental-champion-challenger-v3"
VALIDATION_VERSION = "cross-sectional-block-bootstrap-v4"
SELECTION_POLICY_VERSION = "development-only-rank-ic-non-inferiority-v2"
SELECTION_POLICY_FROZEN_AT = "2026-08-09"
ENSEMBLE_POLICY_VERSION = "development-walk-forward-oof-stacking-v5"
SCHEMA_VERSION = 2
SUPPORTED_ALGORITHMS = ("ridge", "xgboost", "lightgbm", "catboost")
ENSEMBLE_MODEL_TYPE = "ensemble"
ENSEMBLE_DISPLAY_NAME = "Ensemble OOF temporale"
DEFAULT_PROMOTION_RULES = {
    "minimumRelativeMaeImprovement": 0.0025,
    "minimumFoldWinRate": 0.50,
    "maximumRankIcDeterioration": 0.005,
    "minimumRelativeMaeImprovementForRankTradeoff": 0.02,
    "minimumOosR2ImprovementForRankTradeoff": 0.02,
    "minimumFoldWinRateForRankTradeoff": 2.0 / 3.0,
    "minimumRankIcForRankTradeoff": 0.03,
    "minimumRankIcRetentionForRankTradeoff": 0.85,
    "minimumRankingRankIcImprovement": 0.005,
    "minimumRankingNdcgLiftVsRandom": 0.0,
    "minimumRankingFoldWinRate": 0.50,
}

HORIZONS: Dict[str, Dict[str, Any]] = {
    "1m": {"sessions": 21, "label": "1 mese"},
    "3m": {"sessions": 63, "label": "3 mesi"},
    "1y": {"sessions": 252, "label": "1 anno"},
}

FEATURE_NAMES: List[str] = [
    "revenue_growth_yoy",
    "net_income_growth_yoy",
    "cfo_growth_yoy",
    "assets_growth_yoy",
    "equity_growth_yoy",
    "shares_growth_yoy",
    "gross_margin",
    "operating_margin",
    "net_margin",
    "cfo_margin",
    "fcf_margin",
    "roa",
    "roe",
    "asset_turnover",
    "current_ratio",
    "quick_ratio",
    "cash_ratio",
    "debt_to_assets",
    "debt_to_equity",
    "net_debt_to_ebitda",
    "interest_coverage",
    "cfo_to_net_income",
    "accrual_ratio",
    "capex_to_revenue",
    "rd_to_revenue",
    "book_to_market",
    "earnings_yield",
    "fcf_yield",
    "sales_to_price",
    "log_market_cap",
    "filing_age_years",
]

FEATURE_LABELS: Dict[str, str] = {
    "revenue_growth_yoy": "Crescita ricavi",
    "net_income_growth_yoy": "Crescita utile netto",
    "cfo_growth_yoy": "Crescita flusso operativo",
    "assets_growth_yoy": "Crescita attivo",
    "equity_growth_yoy": "Crescita patrimonio netto",
    "shares_growth_yoy": "Variazione numero azioni",
    "gross_margin": "Margine lordo",
    "operating_margin": "Margine operativo",
    "net_margin": "Margine netto",
    "cfo_margin": "Margine di cassa operativo",
    "fcf_margin": "Margine free cash flow",
    "roa": "ROA",
    "roe": "ROE",
    "asset_turnover": "Rotazione dell'attivo",
    "current_ratio": "Current ratio",
    "quick_ratio": "Quick ratio",
    "cash_ratio": "Indice di liquidità immediata",
    "debt_to_assets": "Debito / Attivo",
    "debt_to_equity": "Debito / Patrimonio netto",
    "net_debt_to_ebitda": "Debito netto / EBITDA",
    "interest_coverage": "Copertura interessi",
    "cfo_to_net_income": "Conversione utile in cassa",
    "accrual_ratio": "Accrual ratio",
    "capex_to_revenue": "Capex / Ricavi",
    "rd_to_revenue": "R&S / Ricavi",
    "book_to_market": "Patrimonio / Capitalizzazione",
    "earnings_yield": "Earnings yield",
    "fcf_yield": "Free cash flow yield",
    "sales_to_price": "Ricavi / Capitalizzazione",
    "log_market_cap": "Dimensione aziendale",
    "filing_age_years": "Età del filing",
}

PERCENT_FEATURES = {
    "revenue_growth_yoy",
    "net_income_growth_yoy",
    "cfo_growth_yoy",
    "assets_growth_yoy",
    "equity_growth_yoy",
    "shares_growth_yoy",
    "gross_margin",
    "operating_margin",
    "net_margin",
    "cfo_margin",
    "fcf_margin",
    "roa",
    "roe",
    "debt_to_assets",
    "accrual_ratio",
    "capex_to_revenue",
    "rd_to_revenue",
    "book_to_market",
    "earnings_yield",
    "fcf_yield",
    "sales_to_price",
}


def _algorithm_display_name(algorithm: str) -> str:
    if str(algorithm).strip().lower() == ENSEMBLE_MODEL_TYPE:
        return ENSEMBLE_DISPLAY_NAME
    return ALGORITHM_LABELS.get(algorithm, algorithm)


def _finite(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _safe_ratio(
    numerator: Any,
    denominator: Any,
    *,
    allow_negative_denominator: bool = False,
) -> Optional[float]:
    num = _finite(numerator)
    den = _finite(denominator)
    if num is None or den is None or abs(den) < 1e-12:
        return None
    if not allow_negative_denominator and den <= 0:
        return None
    return num / den


def _growth(current: Any, previous: Any) -> Optional[float]:
    current_number = _finite(current)
    previous_number = _finite(previous)
    if (
        current_number is None
        or previous_number is None
        or abs(previous_number) < 1e-12
    ):
        return None
    # La crescita percentuale non è interpretabile quando la base cambia segno.
    if current_number * previous_number < 0:
        return None
    return (current_number / previous_number) - 1.0


def _average(current: Any, previous: Any) -> Optional[float]:
    current_number = _finite(current)
    previous_number = _finite(previous)
    if current_number is None:
        return None
    if previous_number is None:
        return current_number
    return (current_number + previous_number) / 2.0


def _metric(values: Mapping[str, Any], name: str) -> Optional[float]:
    return _finite(values.get(name))


def build_feature_vector(
    current: Mapping[str, Any],
    previous: Optional[Mapping[str, Any]],
    *,
    raw_price: Any,
    filing_age_days: Any,
) -> Dict[str, Optional[float]]:
    """Costruisce feature esclusivamente dai due filing point-in-time forniti."""

    previous = previous or {}
    revenue = _metric(current, "revenue")
    cost = _metric(current, "cost_of_revenue")
    gross_profit = _metric(current, "gross_profit")
    if gross_profit is None and revenue is not None and cost is not None:
        gross_profit = revenue - abs(cost)

    operating_income = _metric(current, "operating_income")
    net_income = _metric(current, "net_income")
    cfo = _metric(current, "operating_cash_flow")
    capex = _metric(current, "capital_expenditure")
    free_cash_flow = (
        cfo - abs(capex)
        if cfo is not None and capex is not None
        else None
    )

    assets = _metric(current, "assets")
    equity = _metric(current, "equity")
    current_assets = _metric(current, "current_assets")
    current_liabilities = _metric(current, "current_liabilities")
    cash = _metric(current, "cash")
    receivables = _metric(current, "receivables")
    current_debt = _metric(current, "current_debt")
    long_term_debt = _metric(current, "long_term_debt")
    reported_debt = _metric(current, "total_debt")
    debt_parts = [value for value in (current_debt, long_term_debt) if value is not None]
    total_debt = reported_debt
    if total_debt is None and debt_parts:
        total_debt = sum(debt_parts)

    depreciation = _metric(current, "depreciation")
    ebitda = (
        operating_income + abs(depreciation)
        if operating_income is not None and depreciation is not None
        else operating_income
    )
    net_debt = (
        total_debt - (cash or 0.0)
        if total_debt is not None
        else None
    )
    interest = _metric(current, "interest_expense")
    rd = _metric(current, "research_and_development")
    shares = (
        _metric(current, "shares_outstanding")
        or _metric(current, "diluted_average_shares")
        or _metric(current, "basic_average_shares")
    )
    price = _finite(raw_price)
    market_cap = (
        price * shares
        if price is not None and price > 0 and shares is not None and shares > 0
        else None
    )

    average_assets = _average(assets, previous.get("assets"))
    average_equity = _average(equity, previous.get("equity"))
    accrual_numerator = (
        net_income - cfo
        if net_income is not None and cfo is not None
        else None
    )

    features: Dict[str, Optional[float]] = {
        "revenue_growth_yoy": _growth(revenue, previous.get("revenue")),
        "net_income_growth_yoy": _growth(net_income, previous.get("net_income")),
        "cfo_growth_yoy": _growth(cfo, previous.get("operating_cash_flow")),
        "assets_growth_yoy": _growth(assets, previous.get("assets")),
        "equity_growth_yoy": _growth(equity, previous.get("equity")),
        "shares_growth_yoy": _growth(shares, previous.get("shares_outstanding")),
        "gross_margin": _safe_ratio(gross_profit, revenue),
        "operating_margin": _safe_ratio(operating_income, revenue),
        "net_margin": _safe_ratio(net_income, revenue),
        "cfo_margin": _safe_ratio(cfo, revenue),
        "fcf_margin": _safe_ratio(free_cash_flow, revenue),
        "roa": _safe_ratio(net_income, average_assets),
        "roe": _safe_ratio(
            net_income,
            average_equity,
            allow_negative_denominator=False,
        ),
        "asset_turnover": _safe_ratio(revenue, average_assets),
        "current_ratio": _safe_ratio(current_assets, current_liabilities),
        "quick_ratio": _safe_ratio(
            (
                cash + receivables
                if cash is not None and receivables is not None
                else None
            ),
            current_liabilities,
        ),
        "cash_ratio": _safe_ratio(cash, current_liabilities),
        "debt_to_assets": _safe_ratio(total_debt, assets),
        "debt_to_equity": _safe_ratio(total_debt, equity),
        "net_debt_to_ebitda": _safe_ratio(
            net_debt,
            ebitda,
            allow_negative_denominator=False,
        ),
        "interest_coverage": _safe_ratio(
            operating_income,
            abs(interest) if interest is not None else None,
            allow_negative_denominator=True,
        ),
        "cfo_to_net_income": _safe_ratio(
            cfo,
            net_income,
            allow_negative_denominator=True,
        ),
        "accrual_ratio": _safe_ratio(
            accrual_numerator,
            average_assets,
            allow_negative_denominator=False,
        ),
        "capex_to_revenue": _safe_ratio(
            abs(capex) if capex is not None else None,
            revenue,
        ),
        "rd_to_revenue": _safe_ratio(
            abs(rd) if rd is not None else None,
            revenue,
        ),
        "book_to_market": _safe_ratio(equity, market_cap),
        "earnings_yield": _safe_ratio(
            net_income,
            market_cap,
            allow_negative_denominator=False,
        ),
        "fcf_yield": _safe_ratio(
            free_cash_flow,
            market_cap,
            allow_negative_denominator=False,
        ),
        "sales_to_price": _safe_ratio(revenue, market_cap),
        "log_market_cap": (
            math.log(market_cap)
            if market_cap is not None and market_cap > 0
            else None
        ),
        "filing_age_years": (
            max(0.0, _finite(filing_age_days)) / 365.25
            if _finite(filing_age_days) is not None
            else None
        ),
    }
    return {name: features.get(name) for name in FEATURE_NAMES}


def _percentile(values: np.ndarray, quantile: float) -> float:
    if values.size == 0:
        return 0.0
    return float(np.quantile(values, quantile))


def _fit_preprocessor(
    rows: Sequence[Mapping[str, Any]],
    feature_names: Sequence[str],
    *,
    categorical_feature_names: Sequence[str] = (),
    native_categorical: bool = False,
) -> Dict[str, Any]:
    raw = np.array(
        [
            [
                np.nan if _finite(row.get(name)) is None else float(row.get(name))
                for name in feature_names
            ]
            for row in rows
        ],
        dtype=float,
    )
    medians = []
    lower = []
    upper = []
    for column in raw.T:
        valid = column[np.isfinite(column)]
        if valid.size:
            medians.append(float(np.median(valid)))
            lower.append(_percentile(valid, 0.01))
            upper.append(_percentile(valid, 0.99))
        else:
            medians.append(0.0)
            lower.append(0.0)
            upper.append(0.0)

    filled, _ = _preprocess_raw(
        raw,
        np.asarray(medians),
        np.asarray(lower),
        np.asarray(upper),
    )
    missing = (~np.isfinite(raw)).astype(float)
    expanded = np.concatenate([filled, missing], axis=1)
    means = np.mean(expanded, axis=0)
    scales = np.std(expanded, axis=0)
    scales[~np.isfinite(scales) | (scales < 1e-12)] = 1.0
    preprocessing = {
        "featureNames": list(feature_names),
        "medians": [float(value) for value in medians],
        "lowerBounds": [float(value) for value in lower],
        "upperBounds": [float(value) for value in upper],
        "expandedMeans": [float(value) for value in means],
        "expandedScales": [float(value) for value in scales],
    }
    categorical_names = [
        str(name)
        for name in categorical_feature_names
        if str(name) not in feature_names
    ]
    if not categorical_names:
        return preprocessing

    category_maps: Dict[str, Dict[str, int]] = {}
    for name in categorical_names:
        categories = sorted(
            {
                str(row.get(name)).strip()
                for row in rows
                if row.get(name) is not None and str(row.get(name)).strip()
            }
        )
        category_maps[name] = {
            value: index for index, value in enumerate(categories)
        }
    numeric_count = len(feature_names)
    output_names = [
        *list(feature_names),
        *[f"{name}__missing" for name in feature_names],
        *categorical_names,
    ]
    preprocessing.update(
        {
            "categoricalFeatureNames": categorical_names,
            "nativeCategorical": bool(native_categorical),
            "categoryMaps": category_maps,
            "outputFeatureNames": output_names,
            "outputBaseNames": [
                *list(feature_names),
                *list(feature_names),
                *categorical_names,
            ],
            "categoricalFeatureIndices": list(
                range(numeric_count * 2, numeric_count * 2 + len(categorical_names))
            ),
        }
    )
    return preprocessing


def _preprocess_raw(
    raw: np.ndarray,
    medians: np.ndarray,
    lower: np.ndarray,
    upper: np.ndarray,
) -> Tuple[np.ndarray, np.ndarray]:
    missing = ~np.isfinite(raw)
    filled = np.where(missing, medians[None, :], raw)
    filled = np.minimum(np.maximum(filled, lower[None, :]), upper[None, :])
    return filled, missing.astype(float)


def _transform_rows(
    rows: Sequence[Mapping[str, Any]],
    preprocessing: Mapping[str, Any],
) -> np.ndarray:
    feature_names = preprocessing["featureNames"]
    raw = np.array(
        [
            [
                np.nan if _finite(row.get(name)) is None else float(row.get(name))
                for name in feature_names
            ]
            for row in rows
        ],
        dtype=float,
    )
    filled, missing = _preprocess_raw(
        raw,
        np.asarray(preprocessing["medians"], dtype=float),
        np.asarray(preprocessing["lowerBounds"], dtype=float),
        np.asarray(preprocessing["upperBounds"], dtype=float),
    )
    expanded = np.concatenate([filled, missing], axis=1)
    means = np.asarray(preprocessing["expandedMeans"], dtype=float)
    scales = np.asarray(preprocessing["expandedScales"], dtype=float)
    numeric_matrix = (expanded - means[None, :]) / scales[None, :]
    categorical_names = list(
        preprocessing.get("categoricalFeatureNames") or []
    )
    if not categorical_names:
        return numeric_matrix
    native = bool(preprocessing.get("nativeCategorical"))
    category_maps = preprocessing.get("categoryMaps") or {}
    categorical_columns = []
    for name in categorical_names:
        if native:
            column = np.asarray(
                [
                    str(row.get(name)).strip()
                    if row.get(name) is not None and str(row.get(name)).strip()
                    else "__MISSING__"
                    for row in rows
                ],
                dtype=object,
            )
        else:
            mapping = category_maps.get(name) or {}
            column = np.asarray(
                [
                    float(mapping.get(str(row.get(name)).strip(), -1))
                    if row.get(name) is not None and str(row.get(name)).strip()
                    else -1.0
                    for row in rows
                ],
                dtype=float,
            )
        categorical_columns.append(column)
    categorical_matrix = np.column_stack(categorical_columns)
    if native:
        output = np.empty(
            (numeric_matrix.shape[0], numeric_matrix.shape[1] + len(categorical_names)),
            dtype=object,
        )
        output[:, : numeric_matrix.shape[1]] = numeric_matrix
        output[:, numeric_matrix.shape[1] :] = categorical_matrix
        return output
    return np.concatenate(
        [numeric_matrix, np.asarray(categorical_matrix, dtype=float)],
        axis=1,
    )


def _fit_ridge(
    rows: Sequence[Mapping[str, Any]],
    target: Sequence[float],
    *,
    alpha: float,
    feature_names: Sequence[str],
    categorical_feature_names: Sequence[str] = (),
    sample_weight: Optional[Sequence[float]] = None,
) -> Dict[str, Any]:
    preprocessing = _fit_preprocessor(
        rows,
        feature_names,
        categorical_feature_names=categorical_feature_names,
        native_categorical=False,
    )
    matrix = _transform_rows(rows, preprocessing)
    target_array = np.asarray(target, dtype=float)
    weights = (
        np.asarray(sample_weight, dtype=float)
        if sample_weight is not None
        else np.ones(target_array.size, dtype=float)
    )
    if weights.shape != target_array.shape:
        raise ValueError("I pesi di training non corrispondono ai target.")
    weights[~np.isfinite(weights) | (weights <= 0)] = 1.0
    weights = weights / max(float(np.mean(weights)), 1e-12)
    intercept = float(np.average(target_array, weights=weights))
    centered = target_array - intercept
    square_root_weights = np.sqrt(weights)
    weighted_matrix = matrix * square_root_weights[:, None]
    weighted_target = centered * square_root_weights
    identity = np.eye(matrix.shape[1], dtype=float)
    coefficients = np.linalg.solve(
        weighted_matrix.T @ weighted_matrix + float(alpha) * identity,
        weighted_matrix.T @ weighted_target,
    )
    return {
        "modelType": "ridge",
        "modelDisplayName": ALGORITHM_LABELS["ridge"],
        "alpha": float(alpha),
        "intercept": intercept,
        "coefficients": [float(value) for value in coefficients],
        "preprocessing": preprocessing,
    }


def _predict_ridge(
    model: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
) -> np.ndarray:
    matrix = _transform_rows(rows, model["preprocessing"])
    coefficients = np.asarray(model["coefficients"], dtype=float)
    return float(model["intercept"]) + matrix @ coefficients


def _filing_balanced_weights(
    rows: Sequence[Mapping[str, Any]],
) -> np.ndarray:
    """Evita che un filing replicato per molti mesi domini il fitting."""

    groups = []
    for index, row in enumerate(rows):
        ticker = str(row.get("ticker") or "").upper()
        accession = str(row.get("accession_number") or "").strip()
        groups.append(
            (ticker, accession)
            if ticker and accession
            else ("__row__", str(index))
        )
    counts = Counter(groups)
    weights = np.asarray([1.0 / counts[group] for group in groups], dtype=float)
    return weights / max(float(np.mean(weights)), 1e-12)


def _resolved_model_config(
    algorithm: str,
    *,
    alpha: float,
    model_configs: Optional[Mapping[str, Mapping[str, Any]]],
) -> Dict[str, Any]:
    if algorithm == "ridge":
        config: Dict[str, Any] = {"alpha": float(alpha)}
    else:
        config = dict(DEFAULT_TREE_CONFIGS.get(algorithm, {}))
    if model_configs and isinstance(model_configs.get(algorithm), Mapping):
        config.update(dict(model_configs[algorithm]))
    return config


def _temporal_validation_block(
    items: Sequence[Tuple[Mapping[str, Any], datetime, datetime, float]],
    *,
    minimum_training_rows: int,
    minimum_validation_rows: int,
    embargo_days: int = 7,
) -> Optional[Dict[str, Any]]:
    """Crea una coda OOT e purga i target del train che la oltrepassano."""

    if not items:
        return None
    ordered = sorted(items, key=lambda item: (item[1], str(item[0].get("ticker"))))
    periods = sorted({item[1].strftime("%Y-%m") for item in ordered})
    if len(periods) < 2:
        return None
    desired_periods = max(1, int(math.ceil(len(periods) * 0.15)))
    maximum_periods = min(12, len(periods) - 1)
    candidates = []
    embargo = timedelta(days=max(0, int(embargo_days)))
    for period_count in range(1, maximum_periods + 1):
        validation_periods = set(periods[-period_count:])
        validation = [
            item
            for item in ordered
            if item[1].strftime("%Y-%m") in validation_periods
        ]
        if len(validation) < minimum_validation_rows:
            continue
        validation_start = min(item[1] for item in validation)
        training = [
            item
            for item in ordered
            if item[1] < validation_start
            and item[2] < (validation_start - embargo)
        ]
        if len(training) < minimum_training_rows:
            continue
        candidates.append(
            (
                abs(period_count - desired_periods),
                period_count,
                training,
                validation,
            )
        )
    if not candidates:
        return None

    _, period_count, training, validation = min(
        candidates,
        key=lambda item: (item[0], item[1]),
    )
    validation_start = min(item[1] for item in validation)
    validation_end = max(item[1] for item in validation)
    latest_training_snapshot = max(item[1] for item in training)
    latest_training_label = max(item[2] for item in training)
    strictly_subsequent = bool(
        latest_training_snapshot < validation_start
        and latest_training_label < (validation_start - embargo)
    )
    if not strictly_subsequent:
        raise RuntimeError("Split temporale di validation non purgato.")
    return {
        "training": training,
        "validation": validation,
        "audit": {
            "source": "developmentTail",
            "embargoDays": int(embargo_days),
            "validationPeriods": period_count,
            "trainingRows": len(training),
            "validationRows": len(validation),
            "trainingSnapshotStart": min(item[1] for item in training)
            .date()
            .isoformat(),
            "trainingSnapshotEnd": latest_training_snapshot.date().isoformat(),
            "latestTrainingLabelDate": latest_training_label.date().isoformat(),
            "validationSnapshotStart": validation_start.date().isoformat(),
            "validationSnapshotEnd": validation_end.date().isoformat(),
            "strictlySubsequent": strictly_subsequent,
            "holdoutUsed": False,
        },
    }


def _resolved_objective_mode(
    algorithm: str,
    horizon: str,
    model_configs: Optional[Mapping[str, Mapping[str, Any]]],
) -> str:
    """Risolve l'obiettivo senza imporre la nuova API ai backend legacy."""

    config = (
        dict(model_configs.get(algorithm) or {})
        if model_configs and isinstance(model_configs.get(algorithm), Mapping)
        else {}
    )
    by_horizon = config.get("objective_mode_by_horizon")
    if isinstance(by_horizon, Mapping):
        configured = by_horizon.get(horizon)
    else:
        configured = config.get("objective_mode", config.get("objectiveMode"))
    normalized = str(configured or "regression").strip().lower()
    if normalized not in {"regression", "classification", "ranking"}:
        return "regression"
    # Il ranking v5 e' intenzionalmente limitato al target cross-sectional 3m.
    return normalized if normalized != "ranking" or horizon == "3m" else "regression"


def _objective_mode_for_horizon(
    algorithm: str,
    horizon: str,
    *,
    model_configs: Optional[Mapping[str, Mapping[str, Any]]],
    objective_modes_by_horizon: Optional[Mapping[str, Any]],
) -> str:
    configured = (
        objective_modes_by_horizon.get(horizon)
        if isinstance(objective_modes_by_horizon, Mapping)
        else None
    )
    if isinstance(configured, Mapping):
        value = configured.get(algorithm, configured.get("default"))
    else:
        value = configured
    if value is None:
        return _resolved_objective_mode(algorithm, horizon, model_configs)
    normalized = str(value).strip().lower()
    if algorithm == "ridge":
        return "regression"
    if normalized not in {"regression", "classification", "ranking"}:
        return "regression"
    return normalized if normalized != "ranking" or horizon == "3m" else "regression"


def _query_id(row: Mapping[str, Any]) -> Optional[str]:
    snapshot = _parse_date(row.get("snapshot_date"))
    return snapshot.strftime("%Y-%m") if snapshot is not None else None


def _ranking_relevance(
    target: Sequence[float],
    query_ids: Sequence[str],
    *,
    buckets: int = 5,
) -> np.ndarray:
    """Converte i rendimenti in gradi ordinali point-in-time per query/mese."""

    values = np.asarray(target, dtype=float)
    if values.size != len(query_ids):
        raise ValueError("query_ids e target ranking non sono allineati.")
    relevance = np.zeros(values.size, dtype=float)
    groups: Dict[str, List[int]] = {}
    for index, query in enumerate(query_ids):
        groups.setdefault(str(query), []).append(index)
    if not groups or any(len(indices) < 2 for indices in groups.values()):
        raise ValueError("Ogni query ranking deve contenere almeno due titoli.")
    maximum_grade = max(1, int(buckets) - 1)
    for indices in groups.values():
        group_values = values[np.asarray(indices, dtype=int)]
        group_ranks = _rank(group_values)
        denominator = max(1.0, float(len(indices) - 1))
        grades = np.floor((group_ranks / denominator) * (maximum_grade + 1))
        grades = np.minimum(grades, maximum_grade)
        relevance[np.asarray(indices, dtype=int)] = grades
    return relevance


def _ordered_ranking_inputs(
    rows: Sequence[Mapping[str, Any]],
    target: Sequence[float],
) -> Tuple[List[Mapping[str, Any]], np.ndarray, List[str]]:
    """Ordina le query in blocchi contigui richiesti da LambdaMART."""

    if len(rows) != len(target):
        raise ValueError("Righe e target ranking non sono allineati.")
    indexed = []
    for index, row in enumerate(rows):
        query = _query_id(row)
        if query is None:
            raise ValueError("snapshot_date mancante per una query ranking.")
        indexed.append(
            (
                query,
                str(row.get("ticker") or row.get("security_id") or ""),
                index,
                row,
                float(target[index]),
            )
        )
    indexed.sort(key=lambda item: (item[0], item[1], item[2]))
    ordered_rows = [item[3] for item in indexed]
    raw_target = np.asarray([item[4] for item in indexed], dtype=float)
    query_ids = [item[0] for item in indexed]
    return ordered_rows, _ranking_relevance(raw_target, query_ids), query_ids


def _call_fit_tree_model(*args: Any, **kwargs: Any) -> Dict[str, Any]:
    """Passa capability v5 solo quando il backend installato le dichiara."""

    try:
        signature = inspect.signature(fit_tree_model)
        accepts_kwargs = any(
            parameter.kind == inspect.Parameter.VAR_KEYWORD
            for parameter in signature.parameters.values()
        )
        if not accepts_kwargs:
            kwargs = {
                key: value
                for key, value in kwargs.items()
                if key in signature.parameters
            }
    except (TypeError, ValueError):
        # Alcuni wrapper nativi non espongono una signature introspezionabile.
        optional = {
            "objective_mode",
            "categorical_feature_indices",
            "query_groups",
            "query_ids",
            "validation_query_groups",
            "validation_query_ids",
        }
        kwargs = {key: value for key, value in kwargs.items() if key not in optional}
    return fit_tree_model(*args, **kwargs)


def _fit_estimator(
    algorithm: str,
    rows: Sequence[Mapping[str, Any]],
    target: Sequence[float],
    *,
    alpha: float,
    feature_names: Sequence[str],
    categorical_feature_names: Sequence[str] = (),
    model_configs: Optional[Mapping[str, Mapping[str, Any]]],
    seed: int,
    validation_rows: Optional[Sequence[Mapping[str, Any]]] = None,
    validation_target: Optional[Sequence[float]] = None,
    temporal_audit: Optional[Mapping[str, Any]] = None,
    objective_mode: str = "regression",
) -> Dict[str, Any]:
    normalized = str(algorithm or "").strip().lower()
    config = _resolved_model_config(
        normalized,
        alpha=alpha,
        model_configs=model_configs,
    )
    resolved_objective = str(objective_mode or "regression").strip().lower()
    fitting_rows = list(rows)
    fitting_target = np.asarray(target, dtype=float)
    query_ids: Optional[List[str]] = None
    if resolved_objective == "ranking":
        fitting_rows, fitting_target, query_ids = _ordered_ranking_inputs(
            fitting_rows,
            fitting_target,
        )
    weights = _filing_balanced_weights(fitting_rows)
    if normalized == "ridge":
        return _fit_ridge(
            fitting_rows,
            fitting_target,
            alpha=float(config.get("alpha", alpha)),
            feature_names=feature_names,
            categorical_feature_names=categorical_feature_names,
            sample_weight=weights,
        )
    if normalized not in {"xgboost", "lightgbm", "catboost"}:
        raise ValueError(f"Algoritmo non supportato: {algorithm}")
    preprocessing = _fit_preprocessor(
        fitting_rows,
        feature_names,
        categorical_feature_names=categorical_feature_names,
        native_categorical=(normalized == "catboost"),
    )
    matrix = _transform_rows(fitting_rows, preprocessing)
    validation_matrix = None
    validation_target_array = None
    validation_weights = None
    validation_query_ids: Optional[List[str]] = None
    if validation_rows is not None or validation_target is not None:
        if validation_rows is None or validation_target is None:
            raise ValueError(
                "validation_rows e validation_target devono essere passati insieme."
            )
        if not validation_rows:
            raise ValueError("Il blocco temporale di validation è vuoto.")
        ordered_validation_rows = list(validation_rows)
        validation_target_array = np.asarray(validation_target, dtype=float)
        if resolved_objective == "ranking":
            (
                ordered_validation_rows,
                validation_target_array,
                validation_query_ids,
            ) = _ordered_ranking_inputs(
                ordered_validation_rows,
                validation_target_array,
            )
            if set(query_ids or []).intersection(validation_query_ids):
                raise ValueError("Le query train e validation ranking si sovrappongono.")
        validation_matrix = _transform_rows(ordered_validation_rows, preprocessing)
        validation_weights = _filing_balanced_weights(ordered_validation_rows)
    configured_profile = config.get(
        "robust_profile",
        config.get("loss_profile"),
    )
    normalized_profile = str(configured_profile or "").strip().lower()
    quantile_alpha = (
        config.get("quantile_alpha")
        if normalized_profile == "quantile"
        else None
    )
    categorical_feature_indices = (
        config.get(
            "categorical_feature_indices",
            preprocessing.get("categoricalFeatureIndices"),
        )
        if normalized == "catboost"
        else None
    )
    backend_feature_names = preprocessing.get("outputFeatureNames") or feature_names
    tree_model = _call_fit_tree_model(
        normalized,
        matrix,
        fitting_target,
        feature_names=backend_feature_names,
        sample_weight=weights,
        config=config,
        seed=seed,
        validation_matrix=validation_matrix,
        validation_target=validation_target_array,
        validation_weight=validation_weights,
        robust_profile=configured_profile,
        quantile_alpha=quantile_alpha,
        early_stopping_rounds=config.get("early_stopping_rounds"),
        objective_mode=resolved_objective,
        categorical_feature_indices=categorical_feature_indices,
        query_ids=query_ids,
        validation_query_ids=validation_query_ids,
    )
    training_audit = dict(tree_model.get("trainingAudit") or {})
    if temporal_audit:
        training_audit["temporalSplit"] = dict(temporal_audit)
    training_audit.setdefault("objectiveMode", resolved_objective)
    if query_ids:
        training_audit.setdefault(
            "queryGrouping",
            {
                "source": "snapshotCalendarMonth",
                "queryCount": len(set(query_ids)),
                "rowCount": len(query_ids),
                "validationQueryCount": len(set(validation_query_ids or [])),
                "trainValidationDisjoint": not bool(
                    set(query_ids).intersection(validation_query_ids or [])
                ),
            },
        )
    return {
        **tree_model,
        "preprocessing": preprocessing,
        "trainingAudit": training_audit,
    }


def _fit_final_estimator(
    algorithm: str,
    rows: Sequence[Mapping[str, Any]],
    *,
    horizon: str,
    development_cutoff: Optional[datetime],
    alpha: float,
    feature_names: Sequence[str],
    categorical_feature_names: Sequence[str] = (),
    minimum_training_rows: int,
    minimum_validation_rows: int,
    model_configs: Optional[Mapping[str, Mapping[str, Any]]],
    seed: int,
    objective_mode: str = "regression",
) -> Dict[str, Any]:
    """Seleziona i round sul development e rifitta poi su tutti i dati maturi."""

    target_key = f"target_{horizon}"
    label_key = f"label_date_{horizon}"
    targets = [float(row[target_key]) for row in rows]
    normalized = str(algorithm or "").strip().lower()
    if normalized == "ridge":
        return _fit_estimator(
            normalized,
            rows,
            targets,
            alpha=alpha,
            feature_names=feature_names,
            categorical_feature_names=categorical_feature_names,
            model_configs=model_configs,
            seed=seed,
            objective_mode=objective_mode,
        )

    embargo = timedelta(days=7)
    development_items = []
    for row in rows:
        snapshot = _parse_date(row.get("snapshot_date"))
        label_date = _parse_date(row.get(label_key))
        target = _finite(row.get(target_key))
        if snapshot is None or label_date is None or target is None:
            continue
        if development_cutoff is not None and (
            snapshot >= development_cutoff
            or label_date >= (development_cutoff - embargo)
        ):
            continue
        development_items.append((row, snapshot, label_date, target))

    split = _temporal_validation_block(
        development_items,
        minimum_training_rows=minimum_training_rows,
        minimum_validation_rows=minimum_validation_rows,
        embargo_days=7,
    )
    if split is None:
        raise ValueError(
            "Impossibile ricavare una validation temporale purgata dal solo "
            "development per il refit finale."
        )
    fitting_items = split["training"]
    validation_items = split["validation"]
    tuning_model = _fit_estimator(
        normalized,
        [item[0] for item in fitting_items],
        [item[3] for item in fitting_items],
        alpha=alpha,
        feature_names=feature_names,
        categorical_feature_names=categorical_feature_names,
        model_configs=model_configs,
        seed=seed,
        validation_rows=[item[0] for item in validation_items],
        validation_target=[item[3] for item in validation_items],
        temporal_audit=split["audit"],
        objective_mode=objective_mode,
    )
    tuning_audit = dict(tuning_model.get("trainingAudit") or {})
    best_iterations = int(
        tuning_audit.get("predictionIterations")
        or (
            (tuning_audit.get("earlyStopping") or {}).get("bestIteration")
            if isinstance(tuning_audit.get("earlyStopping"), Mapping)
            else 0
        )
        or _resolved_model_config(
            normalized,
            alpha=alpha,
            model_configs=model_configs,
        ).get("num_boost_round", 240)
    )
    final_config = _resolved_model_config(
        normalized,
        alpha=alpha,
        model_configs=model_configs,
    )
    final_config["num_boost_round"] = max(1, best_iterations)
    final_configs = {normalized: final_config}
    final_model = _fit_estimator(
        normalized,
        rows,
        targets,
        alpha=alpha,
        feature_names=feature_names,
        categorical_feature_names=categorical_feature_names,
        model_configs=final_configs,
        seed=seed,
        objective_mode=objective_mode,
    )
    final_audit = dict(final_model.get("trainingAudit") or {})
    final_audit["roundSelection"] = {
        **dict(split["audit"]),
        "developmentCutoff": (
            development_cutoff.date().isoformat()
            if development_cutoff is not None
            else None
        ),
        "holdoutExcluded": development_cutoff is not None,
        "selectedIterations": max(1, best_iterations),
        "backendAudit": tuning_audit,
    }
    final_audit["finalRefit"] = {
        "rows": len(rows),
        "validationUsed": False,
        "selectedIterations": max(1, best_iterations),
        "roundsSelectedFrom": "developmentTail",
    }
    final_model["trainingAudit"] = final_audit
    return final_model


def _model_type(model: Mapping[str, Any]) -> str:
    """Gli artifact v1 senza modelType sono Ridge per retrocompatibilità."""

    return str(model.get("modelType") or "ridge").strip().lower()


def _predict_estimator(
    model: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
) -> np.ndarray:
    algorithm = _model_type(model)
    if algorithm == "ridge":
        return _predict_ridge(model, rows)
    if algorithm == ENSEMBLE_MODEL_TYPE:
        members = model.get("members")
        meta = model.get("metaLearner")
        if not isinstance(members, Mapping) or not isinstance(meta, Mapping):
            raise ValueError("Artifact ensemble privo di membri o meta-learner.")
        member_names = list(meta.get("members") or members.keys())
        predictions = np.column_stack(
            [_predict_estimator(members[name], rows) for name in member_names]
        )
        return _ensemble_predictions(meta, predictions)
    matrix = _transform_rows(rows, model["preprocessing"])
    return predict_tree_model(model, matrix)


def _local_contributions(
    model: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
) -> np.ndarray:
    model_type = _model_type(model)
    if model_type == ENSEMBLE_MODEL_TYPE:
        members = model.get("members")
        meta = model.get("metaLearner")
        if not isinstance(members, Mapping) or not isinstance(meta, Mapping):
            raise ValueError("Artifact ensemble privo di membri o meta-learner.")
        member_names = list(meta.get("members") or members.keys())
        weights = np.asarray(meta.get("weights") or [], dtype=float)
        if weights.size != len(member_names):
            raise ValueError("Pesi ensemble incompleti.")
        contributions = [
            _local_contributions(members[name], rows)
            for name in member_names
        ]
        shapes = {value.shape for value in contributions}
        if len(shapes) != 1:
            raise ValueError("I membri ensemble usano schemi contributivi diversi.")
        return sum(
            weight * value
            for weight, value in zip(weights, contributions)
        )
    matrix = _transform_rows(rows, model["preprocessing"])
    if model_type == "ridge":
        coefficients = np.asarray(model["coefficients"], dtype=float)
        return matrix * coefficients[None, :]
    return tree_contributions(model, matrix)


def _local_effects(
    model: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
) -> List[Dict[str, float]]:
    """Normalizza contributi anche con schemi e membri ensemble differenti."""

    if _model_type(model) == ENSEMBLE_MODEL_TYPE:
        members = model.get("members")
        meta = model.get("metaLearner")
        if not isinstance(members, Mapping) or not isinstance(meta, Mapping):
            raise ValueError("Artifact ensemble privo di membri o meta-learner.")
        member_names = list(meta.get("members") or members.keys())
        weights = np.asarray(meta.get("weights") or [], dtype=float)
        if weights.size != len(member_names):
            raise ValueError("Pesi ensemble incompleti.")
        output = [dict() for _ in rows]
        for weight, name in zip(weights, member_names):
            for row_index, effects in enumerate(
                _local_effects(members[name], rows)
            ):
                for feature, effect in effects.items():
                    output[row_index][feature] = (
                        output[row_index].get(feature, 0.0)
                        + float(weight) * float(effect)
                    )
        return output

    contributions = _local_contributions(model, rows)
    preprocessing = model.get("preprocessing") or {}
    base_names = list(preprocessing.get("outputBaseNames") or [])
    if not base_names:
        feature_names = list(preprocessing.get("featureNames") or [])
        base_names = [*feature_names, *feature_names]
    if contributions.ndim != 2 or contributions.shape[1] != len(base_names):
        raise ValueError("Contributi locali non coerenti con lo schema feature.")
    effects_by_row = []
    for contribution_row in contributions:
        effects: Dict[str, float] = {}
        for feature, effect in zip(base_names, contribution_row):
            effects[feature] = effects.get(feature, 0.0) + float(effect)
        effects_by_row.append(effects)
    return effects_by_row


def _parse_date(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value
    if value is None:
        return None
    try:
        normalized = str(value).strip()[:10]
        return datetime.strptime(normalized, "%Y-%m-%d")
    except (TypeError, ValueError):
        return None


def _rank(values: np.ndarray) -> np.ndarray:
    order = np.argsort(values, kind="mergesort")
    ranks = np.empty(values.size, dtype=float)
    start = 0
    while start < values.size:
        end = start + 1
        while end < values.size and values[order[end]] == values[order[start]]:
            end += 1
        ranks[order[start:end]] = (start + end - 1) / 2.0
        start = end
    return ranks


def _spearman(actual: np.ndarray, predicted: np.ndarray) -> Optional[float]:
    if actual.size < 3:
        return None
    actual_rank = _rank(actual)
    predicted_rank = _rank(predicted)
    if np.std(actual_rank) < 1e-12 or np.std(predicted_rank) < 1e-12:
        return None
    return float(np.corrcoef(actual_rank, predicted_rank)[0, 1])


def _evaluation_period(row: Mapping[str, Any]) -> Optional[str]:
    snapshot = _parse_date(row.get("snapshot_date"))
    return snapshot.strftime("%Y-%m") if snapshot else None


def _sample_structure(
    rows: Optional[Sequence[Mapping[str, Any]]],
    sample_size: int,
) -> Dict[str, Any]:
    """Descrive il grain senza confondere righe replicate e prove indipendenti."""

    note = (
        "sampleSize conta righe snapshot. Le osservazioni condividono date, "
        "emittenti e filing e, per orizzonti oltre un mese, finestre di "
        "rendimento sovrapposte: non sono campioni indipendenti."
    )
    if rows is None:
        return {
            "sampleSizeUnit": "snapshotRows",
            "sampleSizeIsIndependent": False,
            "effectiveSampleSize": None,
            "sampleSizeNote": note,
            "uniqueSnapshotDates": None,
            "uniqueEvaluationMonths": None,
            "uniqueIssuers": None,
            "uniqueFilings": None,
            "filingIdentifierCoverage": None,
        }

    snapshot_dates = set()
    periods = set()
    issuers = set()
    filings = set()
    filing_rows = 0
    for row in rows:
        snapshot = _parse_date(row.get("snapshot_date"))
        if snapshot:
            snapshot_dates.add(snapshot.date().isoformat())
            periods.add(snapshot.strftime("%Y-%m"))
        ticker = str(row.get("ticker") or "").strip().upper()
        if ticker:
            issuers.add(ticker)
        accession = str(row.get("accession_number") or "").strip()
        if accession:
            filing_rows += 1
            filings.add((ticker, accession))

    return {
        "sampleSizeUnit": "snapshotRows",
        "sampleSizeIsIndependent": False,
        "effectiveSampleSize": None,
        "sampleSizeNote": note,
        "uniqueSnapshotDates": len(snapshot_dates),
        "uniqueEvaluationMonths": len(periods),
        "uniqueIssuers": len(issuers),
        "uniqueFilings": len(filings) if filing_rows else None,
        "filingIdentifierCoverage": (
            filing_rows / max(1, sample_size) if sample_size else None
        ),
    }


def _cross_sectional_rank_ic_values(
    actual: np.ndarray,
    predicted: np.ndarray,
    rows: Optional[Sequence[Mapping[str, Any]]],
) -> List[Tuple[str, float]]:
    """Calcola lo Spearman IC fra emittenti per ciascun mese di valutazione."""

    if rows is None or len(rows) != actual.size:
        return []
    grouped: Dict[str, Dict[str, List[Tuple[float, float]]]] = {}
    for index, row in enumerate(rows):
        period = _evaluation_period(row)
        if period is None:
            continue
        ticker = str(row.get("ticker") or f"__row_{index}").strip().upper()
        grouped.setdefault(period, {}).setdefault(ticker, []).append(
            (float(actual[index]), float(predicted[index]))
        )

    values: List[Tuple[str, float]] = []
    for period in sorted(grouped):
        issuer_values = grouped[period]
        if len(issuer_values) < 3:
            continue
        period_actual = np.asarray(
            [
                np.mean([value[0] for value in observations])
                for observations in issuer_values.values()
            ],
            dtype=float,
        )
        period_predicted = np.asarray(
            [
                np.mean([value[1] for value in observations])
                for observations in issuer_values.values()
            ],
            dtype=float,
        )
        rank_ic = _spearman(period_actual, period_predicted)
        if rank_ic is not None and math.isfinite(rank_ic):
            values.append((period, float(rank_ic)))
    return values


def _ndcg_at_fraction(
    actual: np.ndarray,
    predicted: np.ndarray,
    *,
    fraction: float = 0.20,
) -> Tuple[Optional[float], Optional[float]]:
    """NDCG e baseline casuale sulla sezione trasversale del mese."""

    size = int(actual.size)
    if size < 3:
        return None, None
    ranks = _rank(actual)
    relevance = np.floor((ranks / max(1.0, size - 1.0)) * 5.0)
    relevance = np.minimum(relevance, 4.0)
    cutoff = max(1, int(math.ceil(size * max(0.01, min(1.0, fraction)))))
    discounts = 1.0 / np.log2(np.arange(cutoff, dtype=float) + 2.0)

    def gain(indices: np.ndarray) -> float:
        return float(
            np.sum((np.power(2.0, relevance[indices]) - 1.0) * discounts)
        )

    predicted_order = np.argsort(-predicted, kind="mergesort")[:cutoff]
    ideal_order = np.argsort(-relevance, kind="mergesort")[:cutoff]
    ideal = gain(ideal_order)
    if ideal <= 1e-12:
        return None, None
    observed = gain(predicted_order) / ideal
    expected_random = float(
        np.mean(np.power(2.0, relevance) - 1.0) * np.sum(discounts) / ideal
    )
    return observed, expected_random


def _cross_sectional_ndcg_values(
    actual: np.ndarray,
    predicted: np.ndarray,
    rows: Optional[Sequence[Mapping[str, Any]]],
) -> List[Tuple[str, float, float]]:
    if rows is None or len(rows) != actual.size:
        return []
    grouped: Dict[str, Dict[str, List[Tuple[float, float]]]] = {}
    for index, row in enumerate(rows):
        period = _evaluation_period(row)
        if period is None:
            continue
        issuer = str(
            row.get("security_id")
            or row.get("ticker")
            or f"__row_{index}"
        ).strip().upper()
        grouped.setdefault(period, {}).setdefault(issuer, []).append(
            (float(actual[index]), float(predicted[index]))
        )
    values = []
    for period in sorted(grouped):
        observations = grouped[period]
        period_actual = np.asarray(
            [np.mean([value[0] for value in item]) for item in observations.values()],
            dtype=float,
        )
        period_predicted = np.asarray(
            [np.mean([value[1] for value in item]) for item in observations.values()],
            dtype=float,
        )
        ndcg, random_baseline = _ndcg_at_fraction(
            period_actual,
            period_predicted,
        )
        if ndcg is not None and random_baseline is not None:
            values.append((period, ndcg, random_baseline))
    return values


def _cross_sectional_metrics(
    actual: np.ndarray,
    predicted: np.ndarray,
    rows: Optional[Sequence[Mapping[str, Any]]],
) -> Dict[str, Any]:
    dated_values = _cross_sectional_rank_ic_values(actual, predicted, rows)
    values = np.asarray([value for _, value in dated_values], dtype=float)
    standard_deviation = (
        float(np.std(values, ddof=1)) if values.size >= 2 else None
    )
    mean_rank_ic = float(np.mean(values)) if values.size else None
    ndcg_values = _cross_sectional_ndcg_values(actual, predicted, rows)
    ndcg = np.asarray([value[1] for value in ndcg_values], dtype=float)
    random_ndcg = np.asarray([value[2] for value in ndcg_values], dtype=float)
    return {
        "crossSectionalRankIcMean": mean_rank_ic,
        "crossSectionalRankIcMedian": (
            float(np.median(values)) if values.size else None
        ),
        "crossSectionalRankIcIcir": (
            mean_rank_ic / standard_deviation
            if (
                mean_rank_ic is not None
                and standard_deviation is not None
                and standard_deviation > 1e-12
            )
            else None
        ),
        "crossSectionalRankIcPositiveRate": (
            float(np.mean(values > 0)) if values.size else None
        ),
        "crossSectionalRankIcDateCount": int(values.size),
        "crossSectionalRankIcPeriod": "calendarMonth",
        "crossSectionalNdcgAt20PctMean": (
            float(np.mean(ndcg)) if ndcg.size else None
        ),
        "crossSectionalNdcgAt20PctRandomBaseline": (
            float(np.mean(random_ndcg)) if random_ndcg.size else None
        ),
        "crossSectionalNdcgAt20PctLiftVsRandom": (
            float(np.mean(ndcg - random_ndcg)) if ndcg.size else None
        ),
        "crossSectionalNdcgDateCount": int(ndcg.size),
    }


def _moving_block_bootstrap(
    actual: np.ndarray,
    predicted: np.ndarray,
    rows: Optional[Sequence[Mapping[str, Any]]],
    *,
    horizon: Optional[str],
    seed: int,
    iterations: int,
) -> Dict[str, Any]:
    if rows is None or len(rows) != actual.size:
        return {
            "available": False,
            "reason": "Metadati temporali non disponibili.",
        }

    period_indices: Dict[str, List[int]] = {}
    for index, row in enumerate(rows):
        period = _evaluation_period(row)
        if period is not None:
            period_indices.setdefault(period, []).append(index)
    periods = sorted(period_indices)
    if len(periods) < 4:
        return {
            "available": False,
            "reason": "Servono almeno quattro mesi di valutazione.",
            "dateCount": len(periods),
        }

    sessions = int(HORIZONS.get(horizon or "", {}).get("sessions", 21))
    block_length = max(1, int(math.ceil(sessions / 21.0)))
    block_length = min(block_length, len(periods))
    number_of_blocks = int(math.ceil(len(periods) / block_length))
    rng = np.random.default_rng(int(seed))
    rank_ic_by_period = dict(
        _cross_sectional_rank_ic_values(actual, predicted, rows)
    )
    distributions: Dict[str, List[float]] = {
        "mae": [],
        "maeEdgeVsZero": [],
        "oosR2VsZero": [],
        "crossSectionalRankIcMean": [],
    }

    for _ in range(max(1, int(iterations))):
        starts = rng.integers(0, len(periods), size=number_of_blocks)
        sampled_periods = [
            periods[(int(start) + offset) % len(periods)]
            for start in starts
            for offset in range(block_length)
        ][: len(periods)]
        sampled_indices = np.asarray(
            [
                index
                for period in sampled_periods
                for index in period_indices[period]
            ],
            dtype=int,
        )
        sampled_actual = actual[sampled_indices]
        sampled_predicted = predicted[sampled_indices]
        absolute_errors = np.abs(sampled_actual - sampled_predicted)
        mae = float(np.mean(absolute_errors))
        baseline_mae = float(np.mean(np.abs(sampled_actual)))
        distributions["mae"].append(mae)
        distributions["maeEdgeVsZero"].append(baseline_mae - mae)
        zero_sse = float(np.sum(np.square(sampled_actual)))
        if zero_sse > 1e-12:
            model_sse = float(
                np.sum(np.square(sampled_actual - sampled_predicted))
            )
            distributions["oosR2VsZero"].append(1.0 - model_sse / zero_sse)
        sampled_rank_ics = [
            rank_ic_by_period[period]
            for period in sampled_periods
            if period in rank_ic_by_period
        ]
        if sampled_rank_ics:
            distributions["crossSectionalRankIcMean"].append(
                float(np.mean(sampled_rank_ics))
            )

    intervals: Dict[str, Any] = {}
    for name, values in distributions.items():
        finite_values = np.asarray(values, dtype=float)
        finite_values = finite_values[np.isfinite(finite_values)]
        intervals[name] = (
            {
                "lower": float(np.quantile(finite_values, 0.025)),
                "upper": float(np.quantile(finite_values, 0.975)),
            }
            if finite_values.size
            else None
        )
    return {
        "available": True,
        "method": "circularMovingBlockBootstrapByCalendarMonth",
        "confidenceLevel": 0.95,
        "iterations": max(1, int(iterations)),
        "seed": int(seed),
        "blockLengthMonths": block_length,
        "dateCount": len(periods),
        "intervals": intervals,
    }


def _non_overlapping_robustness(
    actual: np.ndarray,
    predicted: np.ndarray,
    rows: Optional[Sequence[Mapping[str, Any]]],
    *,
    horizon: Optional[str],
) -> Dict[str, Any]:
    if rows is None or len(rows) != actual.size:
        return {
            "available": False,
            "reason": "Metadati temporali non disponibili.",
        }
    period_indices: Dict[str, List[int]] = {}
    for index, row in enumerate(rows):
        period = _evaluation_period(row)
        if period is not None:
            period_indices.setdefault(period, []).append(index)
    periods = sorted(period_indices)
    sessions = int(HORIZONS.get(horizon or "", {}).get("sessions", 21))
    spacing = max(1, int(math.ceil(sessions / 21.0)))
    if len(periods) < spacing * 2:
        return {
            "available": False,
            "reason": "Periodo troppo breve per almeno due osservazioni per fase.",
            "spacingMonths": spacing,
            "dateCount": len(periods),
        }

    phases = []
    for phase in range(spacing):
        selected_periods = periods[phase::spacing]
        if len(selected_periods) < 2:
            continue
        selected_indices = np.asarray(
            [
                index
                for period in selected_periods
                for index in period_indices[period]
            ],
            dtype=int,
        )
        selected_rows = [rows[index] for index in selected_indices]
        phase_actual = actual[selected_indices]
        phase_predicted = predicted[selected_indices]
        mae = float(np.mean(np.abs(phase_actual - phase_predicted)))
        baseline_mae = float(np.mean(np.abs(phase_actual)))
        cross_sectional = _cross_sectional_metrics(
            phase_actual,
            phase_predicted,
            selected_rows,
        )
        phases.append(
            {
                "phase": phase,
                "sampleSize": int(selected_indices.size),
                "dateCount": len(selected_periods),
                "mae": mae,
                "baselineZeroMae": baseline_mae,
                "maeEdgeVsZero": baseline_mae - mae,
                "crossSectionalRankIcMean": cross_sectional[
                    "crossSectionalRankIcMean"
                ],
            }
        )

    if not phases:
        return {
            "available": False,
            "reason": "Nessuna fase non sovrapposta valutabile.",
            "spacingMonths": spacing,
            "dateCount": len(periods),
        }
    edges = np.asarray([phase["maeEdgeVsZero"] for phase in phases], dtype=float)
    rank_ics = np.asarray(
        [
            phase["crossSectionalRankIcMean"]
            for phase in phases
            if phase["crossSectionalRankIcMean"] is not None
        ],
        dtype=float,
    )
    return {
        "available": True,
        "method": "calendarPhaseSubsamples",
        "spacingMonths": spacing,
        "phaseCount": len(phases),
        "dateCount": len(periods),
        "maeEdgeVsZeroMedian": float(np.median(edges)),
        "maeEdgeVsZeroMinimum": float(np.min(edges)),
        "maeEdgePositivePhaseRate": float(np.mean(edges > 0)),
        "crossSectionalRankIcMeanMedian": (
            float(np.median(rank_ics)) if rank_ics.size else None
        ),
        "phases": phases,
        "note": (
            "Ogni fase usa mesi distanziati quanto l'orizzonte; le fasi sono "
            "diagnostiche e non vengono usate per scegliere il modello."
        ),
    }


def _metrics(
    actual: np.ndarray,
    predicted: np.ndarray,
    *,
    rows: Optional[Sequence[Mapping[str, Any]]] = None,
    horizon: Optional[str] = None,
    include_inference: bool = False,
    bootstrap_seed: int = 42,
    bootstrap_iterations: int = 300,
) -> Dict[str, Any]:
    errors = actual - predicted
    squared_error = float(np.sum(np.square(errors)))
    zero_squared_error = float(np.sum(np.square(actual)))
    mae = float(np.mean(np.abs(errors)))
    baseline_mae = float(np.mean(np.abs(actual)))
    performance = {
        "sampleSize": int(actual.size),
        **_sample_structure(rows, int(actual.size)),
        "mae": mae,
        "baselineZeroMae": baseline_mae,
        "maeEdgeVsZero": baseline_mae - mae,
        "maeRelativeImprovementVsZero": (
            (baseline_mae - mae) / baseline_mae
            if baseline_mae > 1e-12
            else None
        ),
        "rmse": float(np.sqrt(np.mean(np.square(errors)))),
        "oosR2VsZero": (
            1.0 - (squared_error / zero_squared_error)
            if zero_squared_error > 1e-12
            else None
        ),
        "rankIc": _spearman(actual, predicted),
        "directionalAccuracy": float(np.mean((actual >= 0) == (predicted >= 0))),
        **_cross_sectional_metrics(actual, predicted, rows),
    }
    if include_inference:
        performance["blockBootstrap95"] = _moving_block_bootstrap(
            actual,
            predicted,
            rows,
            horizon=horizon,
            seed=bootstrap_seed,
            iterations=bootstrap_iterations,
        )
        performance["nonOverlappingRobustness"] = _non_overlapping_robustness(
            actual,
            predicted,
            rows,
            horizon=horizon,
        )
    return performance


def _walk_forward_predictions(
    rows: Sequence[Mapping[str, Any]],
    *,
    horizon: str,
    algorithm: str,
    alpha: float,
    feature_names: Sequence[str],
    categorical_feature_names: Sequence[str] = (),
    minimum_training_rows: int,
    minimum_test_rows: int,
    model_configs: Optional[Mapping[str, Mapping[str, Any]]],
    seed: int,
    objective_mode: str = "regression",
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, List[Dict[str, Any]]]:
    usable = []
    target_key = f"target_{horizon}"
    label_date_key = f"label_date_{horizon}"
    for row in rows:
        snapshot_date = _parse_date(row.get("snapshot_date"))
        label_date = _parse_date(row.get(label_date_key))
        target = _finite(row.get(target_key))
        if snapshot_date and label_date and target is not None:
            usable.append((row, snapshot_date, label_date, target))
    if not usable:
        return np.array([]), np.array([]), np.array([], dtype=int), []

    years = sorted({snapshot.year for _, snapshot, _, _ in usable})
    actual_parts: List[np.ndarray] = []
    predicted_parts: List[np.ndarray] = []
    test_year_parts: List[np.ndarray] = []
    folds: List[Dict[str, Any]] = []
    embargo = timedelta(days=7)

    for test_year in years:
        test_start = datetime(test_year, 1, 1)
        test_end = datetime(test_year + 1, 1, 1)
        training = [
            item
            for item in usable
            if item[2] < (test_start - embargo)
        ]
        testing = [
            item
            for item in usable
            if test_start <= item[1] < test_end
        ]
        if (
            len(training) < minimum_training_rows
            or len(testing) < minimum_test_rows
        ):
            continue

        fitting = training
        validation = []
        temporal_audit = None
        if str(algorithm or "").strip().lower() != "ridge":
            split = _temporal_validation_block(
                training,
                minimum_training_rows=minimum_training_rows,
                minimum_validation_rows=max(5, min(minimum_test_rows, 20)),
                embargo_days=7,
            )
            if split is None:
                continue
            fitting = split["training"]
            validation = split["validation"]
            temporal_audit = split["audit"]
        fold_model = _fit_estimator(
            algorithm,
            [item[0] for item in fitting],
            [item[3] for item in fitting],
            alpha=alpha,
            feature_names=feature_names,
            categorical_feature_names=categorical_feature_names,
            model_configs=model_configs,
            seed=seed + test_year,
            validation_rows=(
                [item[0] for item in validation] if validation else None
            ),
            validation_target=(
                [item[3] for item in validation] if validation else None
            ),
            temporal_audit=temporal_audit,
            objective_mode=objective_mode,
        )
        fold_actual = np.asarray([item[3] for item in testing], dtype=float)
        fold_rows = [item[0] for item in testing]
        fold_predicted = _predict_estimator(
            fold_model,
            fold_rows,
        )
        actual_parts.append(fold_actual)
        predicted_parts.append(fold_predicted)
        test_year_parts.append(
            np.full(fold_actual.size, test_year, dtype=int)
        )
        folds.append(
            {
                "testYear": test_year,
                "trainingRows": len(fitting),
                "preValidationEligibleRows": len(training),
                "validationRows": len(validation),
                "testRows": len(testing),
                "latestTrainingLabelDate": max(
                    item[2] for item in fitting
                ).date().isoformat(),
                "trainingAudit": fold_model.get("trainingAudit"),
                "performance": _metrics(
                    fold_actual,
                    fold_predicted,
                    rows=fold_rows,
                    horizon=horizon,
                ),
            }
        )

    if not actual_parts:
        return np.array([]), np.array([]), np.array([], dtype=int), []
    return (
        np.concatenate(actual_parts),
        np.concatenate(predicted_parts),
        np.concatenate(test_year_parts),
        folds,
    )


def _aligned_oos_rows(
    rows: Sequence[Mapping[str, Any]],
    *,
    horizon: str,
    folds: Sequence[Mapping[str, Any]],
) -> List[Mapping[str, Any]]:
    """Ricostruisce lo stesso ordine usato dalle concatenazioni walk-forward."""

    target_key = f"target_{horizon}"
    label_date_key = f"label_date_{horizon}"
    usable = [
        row
        for row in rows
        if _parse_date(row.get("snapshot_date")) is not None
        and _parse_date(row.get(label_date_key)) is not None
        and _finite(row.get(target_key)) is not None
    ]
    aligned = []
    for fold in folds:
        test_year = fold.get("testYear")
        aligned.extend(
            row
            for row in usable
            if _parse_date(row.get("snapshot_date")).year == test_year
        )
    return aligned


def _oof_identity_keys(
    rows: Sequence[Mapping[str, Any]],
    *,
    horizon: str,
) -> List[Tuple[str, ...]]:
    """Identita' stabili, con contatore, per allineare OOF tra backend."""

    occurrences: Counter = Counter()
    keys = []
    for row in rows:
        base = (
            str(row.get("security_id") or row.get("ticker") or "").upper(),
            str(row.get("snapshot_date") or "")[:10],
            str(row.get("accession_number") or ""),
            str(row.get(f"label_date_{horizon}") or "")[:10],
        )
        occurrence = occurrences[base]
        occurrences[base] += 1
        keys.append((*base, str(occurrence)))
    return keys


def _fit_nonnegative_oof_stacker(
    predictions: np.ndarray,
    actual: np.ndarray,
    *,
    alpha: float = 1e-4,
    maximum_iterations: int = 2000,
) -> Dict[str, Any]:
    """Ridge non-negativa deterministica; nessuna riga in-sample e' ammessa."""

    matrix = np.asarray(predictions, dtype=float)
    target = np.asarray(actual, dtype=float)
    if matrix.ndim != 2 or target.ndim != 1 or matrix.shape[0] != target.size:
        raise ValueError("Matrice OOF e target del meta-learner non allineati.")
    finite_mask = np.isfinite(target) & np.all(np.isfinite(matrix), axis=1)
    matrix = matrix[finite_mask]
    target = target[finite_mask]
    if matrix.shape[0] < max(20, matrix.shape[1] * 5):
        raise ValueError("Righe development OOF insufficienti per lo stacking.")

    means = np.mean(matrix, axis=0)
    target_mean = float(np.mean(target))
    centered_matrix = matrix - means[None, :]
    centered_target = target - target_mean
    member_count = matrix.shape[1]
    weights = np.full(member_count, 1.0 / member_count, dtype=float)
    gram = (centered_matrix.T @ centered_matrix) / matrix.shape[0]
    lipschitz = float(np.linalg.norm(gram, ord=2)) + max(0.0, float(alpha))
    step = 1.0 / max(lipschitz, 1e-8)
    converged = False
    iterations = 0
    for iterations in range(1, max(1, int(maximum_iterations)) + 1):
        gradient = (
            centered_matrix.T @ (centered_matrix @ weights - centered_target)
        ) / matrix.shape[0] + max(0.0, float(alpha)) * weights
        updated = np.maximum(0.0, weights - step * gradient)
        if float(np.max(np.abs(updated - weights))) <= 1e-10:
            weights = updated
            converged = True
            break
        weights = updated

    fallback = None
    if not np.any(weights > 1e-12):
        member_mae = np.mean(np.abs(matrix - target[:, None]), axis=0)
        best = int(np.argmin(member_mae))
        weights = np.zeros(member_count, dtype=float)
        weights[best] = 1.0
        fallback = {
            "used": True,
            "reason": "Soluzione NNLS degenere; scelto il miglior membro su development OOF.",
            "selectedMemberIndex": best,
        }
    intercept = target_mean - float(means @ weights)
    fitted = intercept + matrix @ weights
    return {
        "type": "nonnegativeRidge",
        "alpha": max(0.0, float(alpha)),
        "intercept": float(intercept),
        "weights": [float(value) for value in weights],
        "iterations": iterations,
        "converged": converged,
        "developmentRows": int(matrix.shape[0]),
        "developmentMae": float(np.mean(np.abs(target - fitted))),
        "fallback": fallback or {"used": False, "reason": None},
    }


def _ensemble_predictions(
    meta_learner: Mapping[str, Any],
    member_predictions: np.ndarray,
) -> np.ndarray:
    weights = np.asarray(meta_learner.get("weights") or [], dtype=float)
    matrix = np.asarray(member_predictions, dtype=float)
    if matrix.ndim != 2 or matrix.shape[1] != weights.size:
        raise ValueError("Pesi e predizioni dei membri ensemble non allineati.")
    return float(meta_learner.get("intercept") or 0.0) + matrix @ weights


def _folds_from_aligned_oof(
    actual: np.ndarray,
    predicted: np.ndarray,
    years: np.ndarray,
    rows: Sequence[Mapping[str, Any]],
    *,
    horizon: str,
) -> List[Dict[str, Any]]:
    folds = []
    for year in sorted({int(value) for value in years}):
        mask = years == year
        fold_rows = [row for row, included in zip(rows, mask) if bool(included)]
        folds.append(
            {
                "testYear": year,
                "testRows": int(np.sum(mask)),
                "source": "alignedMemberWalkForwardOOF",
                "performance": _metrics(
                    actual[mask],
                    predicted[mask],
                    rows=fold_rows,
                    horizon=horizon,
                ),
            }
        )
    return folds


def _build_temporal_oof_ensemble(
    candidate_records: Mapping[str, Mapping[str, Any]],
    *,
    horizon: str,
    development_years: Sequence[int],
    holdout_years: Sequence[int],
    usable_rows: Sequence[Mapping[str, Any]],
    target_key: str,
    minimum_test_rows: int,
    seed: int,
) -> Dict[str, Any]:
    """Costruisce stacking soltanto dall'intersezione walk-forward OOF."""

    member_names = [
        name
        for name, record in candidate_records.items()
        if name != ENSEMBLE_MODEL_TYPE
        and isinstance(record.get("finalModel"), Mapping)
    ]
    if len(member_names) < 2:
        raise ValueError("Servono almeno due backend validi per l'ensemble OOF.")

    member_maps: Dict[str, Dict[Tuple[str, ...], Dict[str, Any]]] = {}
    member_row_counts: Dict[str, int] = {}
    all_folds_purged = True
    for name in member_names:
        record = candidate_records[name]
        rows = list(record.get("oosRows") or [])
        actual_source = record.get("oosActual")
        predicted_source = record.get("oosPredicted")
        years_source = record.get("oosYears")
        actual = np.asarray(
            [] if actual_source is None else actual_source,
            dtype=float,
        )
        predicted = np.asarray(
            [] if predicted_source is None else predicted_source,
            dtype=float,
        )
        years = np.asarray(
            [] if years_source is None else years_source,
            dtype=int,
        )
        if not (
            len(rows) == actual.size == predicted.size == years.size
            and actual.size > 0
        ):
            raise ValueError(f"OOF incompleto o disallineato per {name}.")
        keys = _oof_identity_keys(rows, horizon=horizon)
        member_maps[name] = {
            key: {
                "row": row,
                "actual": float(actual[index]),
                "predicted": float(predicted[index]),
                "year": int(years[index]),
            }
            for index, (key, row) in enumerate(zip(keys, rows))
        }
        member_row_counts[name] = len(keys)
        for fold in record.get("folds") or []:
            year = fold.get("testYear")
            latest = _parse_date(fold.get("latestTrainingLabelDate"))
            if year is None or latest is None or latest >= datetime(int(year), 1, 1):
                all_folds_purged = False

    common_keys = set.intersection(
        *(set(values) for values in member_maps.values())
    )
    if not common_keys:
        raise ValueError("Nessuna riga OOF comune tra i membri ensemble.")
    ordered_keys = sorted(common_keys, key=lambda value: (value[1], value[0], value))
    reference_name = member_names[0]
    aligned_rows = [member_maps[reference_name][key]["row"] for key in ordered_keys]
    actual = np.asarray(
        [member_maps[reference_name][key]["actual"] for key in ordered_keys],
        dtype=float,
    )
    years = np.asarray(
        [member_maps[reference_name][key]["year"] for key in ordered_keys],
        dtype=int,
    )
    matrix = np.column_stack(
        [
            np.asarray(
                [member_maps[name][key]["predicted"] for key in ordered_keys],
                dtype=float,
            )
            for name in member_names
        ]
    )
    for name in member_names[1:]:
        member_actual = np.asarray(
            [member_maps[name][key]["actual"] for key in ordered_keys],
            dtype=float,
        )
        member_years = np.asarray(
            [member_maps[name][key]["year"] for key in ordered_keys],
            dtype=int,
        )
        if not np.allclose(member_actual, actual, rtol=0.0, atol=1e-12):
            raise RuntimeError(f"Target OOF non coerenti tra {reference_name} e {name}.")
        if not np.array_equal(member_years, years):
            raise RuntimeError(f"Anni OOF non coerenti tra {reference_name} e {name}.")

    development_mask = np.isin(years, list(development_years))
    holdout_mask = np.isin(years, list(holdout_years))
    overlap = bool(np.any(development_mask & holdout_mask))
    if overlap:
        raise RuntimeError("Development e holdout ensemble si sovrappongono.")
    development_rows = [
        row for row, included in zip(aligned_rows, development_mask) if bool(included)
    ]
    holdout_rows = [
        row for row, included in zip(aligned_rows, holdout_mask) if bool(included)
    ]
    if not development_rows:
        raise ValueError("Nessuna predizione OOF nel development ensemble.")
    meta = _fit_nonnegative_oof_stacker(
        matrix[development_mask],
        actual[development_mask],
    )
    meta["members"] = member_names
    meta["weightsByMember"] = dict(zip(member_names, meta["weights"]))
    predicted = _ensemble_predictions(meta, matrix)

    development_dates = [
        _parse_date(row.get("snapshot_date")) for row in development_rows
    ]
    holdout_dates = [_parse_date(row.get("snapshot_date")) for row in holdout_rows]
    development_dates = [value for value in development_dates if value is not None]
    holdout_dates = [value for value in holdout_dates if value is not None]
    dates_strictly_separated = bool(
        not holdout_dates
        or (
            development_dates
            and max(development_dates) < min(holdout_dates)
        )
    )
    if not dates_strictly_separated:
        raise RuntimeError("Le date meta-fit raggiungono l'holdout ensemble.")

    identity_digest = hashlib.sha256(
        "\n".join("|".join(key) for key in ordered_keys).encode("utf-8")
    ).hexdigest()
    audit = {
        "policyVersion": ENSEMBLE_POLICY_VERSION,
        "oofOnly": True,
        "predictionSource": "purgedWalkForwardFolds",
        "metaLearnerFitPartition": "developmentOOFOnly",
        "holdoutUsedForFit": False,
        "holdoutUsedForSelection": False,
        "memberModels": member_names,
        "memberPredictionRows": member_row_counts,
        "alignedRows": len(aligned_rows),
        "droppedRowsByMember": {
            name: member_row_counts[name] - len(aligned_rows) for name in member_names
        },
        "developmentRows": int(np.sum(development_mask)),
        "holdoutRows": int(np.sum(holdout_mask)),
        "developmentYears": [int(value) for value in development_years],
        "holdoutYears": [int(value) for value in holdout_years],
        "developmentSnapshotStart": (
            min(development_dates).date().isoformat() if development_dates else None
        ),
        "developmentSnapshotEnd": (
            max(development_dates).date().isoformat() if development_dates else None
        ),
        "holdoutSnapshotStart": (
            min(holdout_dates).date().isoformat() if holdout_dates else None
        ),
        "holdoutSnapshotEnd": (
            max(holdout_dates).date().isoformat() if holdout_dates else None
        ),
        "developmentHoldoutRowOverlap": 0,
        "datesStrictlySeparated": dates_strictly_separated,
        "allMemberFoldsPurged": all_folds_purged,
        "alignedIdentitySha256": identity_digest,
        "metaLearner": {
            key: value
            for key, value in meta.items()
            if key not in {"members", "weightsByMember"}
        },
        "fallback": dict(meta.get("fallback") or {}),
    }
    if not all_folds_purged:
        raise RuntimeError("Un membro ensemble non prova la purga dei fold OOF.")

    members = {
        name: dict(candidate_records[name]["finalModel"]) for name in member_names
    }
    reference_preprocessing = dict(
        members[reference_name].get("preprocessing") or {}
    )
    final_model = {
        "modelType": ENSEMBLE_MODEL_TYPE,
        "modelDisplayName": ENSEMBLE_DISPLAY_NAME,
        "objectiveMode": "regression",
        "predictionKind": "expectedReturn",
        "members": members,
        "metaLearner": meta,
        "preprocessing": reference_preprocessing,
        "trainingAudit": {"ensemble": audit},
    }
    folds = _folds_from_aligned_oof(
        actual,
        predicted,
        years,
        aligned_rows,
        horizon=horizon,
    )
    development_actual = actual[development_mask]
    development_predicted = predicted[development_mask]
    holdout_actual = actual[holdout_mask]
    holdout_predicted = predicted[holdout_mask]
    evidence = _residual_evidence(
        development_actual,
        development_predicted,
        holdout_actual,
        holdout_predicted,
        final_model=final_model,
        usable_rows=usable_rows,
        target_key=target_key,
        evaluation_rows=holdout_rows,
        horizon=horizon,
        bootstrap_seed=seed + int(HORIZONS[horizon]["sessions"]) + 701,
    )
    evidence["publishable"] = bool(
        evidence["publishable"]
        and evidence["performance"].get("sampleSize", 0) >= minimum_test_rows * 2
    )
    return {
        "algorithm": ENSEMBLE_MODEL_TYPE,
        "objectiveMode": "regression",
        "folds": folds,
        "oosActual": actual,
        "oosPredicted": predicted,
        "oosYears": years,
        "oosRows": aligned_rows,
        "finalModel": final_model,
        **evidence,
        "fullWalkForwardPerformance": _metrics(
            actual,
            predicted,
            rows=aligned_rows,
            horizon=horizon,
        ),
        "developmentPerformance": _metrics(
            development_actual,
            development_predicted,
            rows=development_rows,
            horizon=horizon,
        ),
        "holdoutPerformance": evidence["performance"],
        "developmentFolds": [
            fold for fold in folds if fold.get("testYear") in development_years
        ],
        "holdoutFolds": [
            fold for fold in folds if fold.get("testYear") in holdout_years
        ],
        "ensembleAudit": audit,
    }


def _empty_performance() -> Dict[str, Any]:
    return {
        "sampleSize": 0,
        **_sample_structure([], 0),
        "mae": None,
        "baselineZeroMae": None,
        "maeEdgeVsZero": None,
        "maeRelativeImprovementVsZero": None,
        "rmse": None,
        "oosR2VsZero": None,
        "rankIc": None,
        "crossSectionalRankIcMean": None,
        "crossSectionalRankIcMedian": None,
        "crossSectionalRankIcIcir": None,
        "crossSectionalRankIcPositiveRate": None,
        "crossSectionalRankIcDateCount": 0,
        "crossSectionalRankIcPeriod": "calendarMonth",
        "directionalAccuracy": None,
        "interval80Coverage": None,
        "interval80CalibrationGap": None,
        "interval80CalibrationStatus": "unavailable",
        "interval80CalibrationSampleSize": 0,
    }


def _residual_evidence(
    calibration_actual: np.ndarray,
    calibration_predicted: np.ndarray,
    evaluation_actual: np.ndarray,
    evaluation_predicted: np.ndarray,
    *,
    final_model: Mapping[str, Any],
    usable_rows: Sequence[Mapping[str, Any]],
    target_key: str,
    evaluation_rows: Optional[Sequence[Mapping[str, Any]]] = None,
    horizon: Optional[str] = None,
    bootstrap_seed: int = 42,
) -> Dict[str, Any]:
    if calibration_actual.size:
        residuals = calibration_actual - calibration_predicted
    else:
        target = np.asarray(
            [float(row[target_key]) for row in usable_rows],
            dtype=float,
        )
        residuals = target - _predict_estimator(final_model, usable_rows)
    residuals = residuals[np.isfinite(residuals)]
    lower_residual = _percentile(residuals, 0.10)
    upper_residual = _percentile(residuals, 0.90)
    performance = (
        _metrics(
            evaluation_actual,
            evaluation_predicted,
            rows=evaluation_rows,
            horizon=horizon,
            include_inference=True,
            bootstrap_seed=bootstrap_seed,
        )
        if evaluation_actual.size
        else _empty_performance()
    )
    performance["interval80CalibrationSampleSize"] = int(
        calibration_actual.size
    )
    if evaluation_actual.size:
        interval_hits = (
            (evaluation_actual >= (evaluation_predicted + lower_residual))
            & (evaluation_actual <= (evaluation_predicted + upper_residual))
        )
        coverage = float(np.mean(interval_hits))
        gap = coverage - 0.80
        performance["interval80Coverage"] = coverage
        performance["interval80CalibrationGap"] = gap
        performance["interval80CalibrationStatus"] = (
            "withinTolerance"
            if abs(gap) <= 0.05
            else "underCoverage"
            if gap < 0
            else "overCoverage"
        )

    if residuals.size > 2000:
        sorted_residuals = np.sort(residuals)
        indices = np.linspace(0, sorted_residuals.size - 1, 2000).astype(int)
        residual_sample = sorted_residuals[indices]
    else:
        residual_sample = np.sort(residuals)

    oos_r2 = _finite(performance.get("oosR2VsZero"))
    mae = _finite(performance.get("mae"))
    baseline_mae = _finite(performance.get("baselineZeroMae"))
    publishable = bool(
        performance.get("sampleSize", 0) > 0
        and oos_r2 is not None
        and oos_r2 > 0
        and mae is not None
        and baseline_mae is not None
        and mae < baseline_mae
    )
    return {
        "performance": performance,
        "residualQuantiles": {
            "p10": lower_residual,
            "p90": upper_residual,
        },
        "residualSample": [float(value) for value in residual_sample],
        "calibrationSampleSize": int(calibration_actual.size),
        "publishable": publishable,
    }


def _fold_win_rate(
    candidate_folds: Sequence[Mapping[str, Any]],
    ridge_folds: Sequence[Mapping[str, Any]],
) -> Optional[float]:
    ridge_by_year = {
        fold.get("testYear"): fold
        for fold in ridge_folds
        if fold.get("testYear") is not None
    }
    comparisons = []
    for fold in candidate_folds:
        ridge_fold = ridge_by_year.get(fold.get("testYear"))
        candidate_mae = _finite((fold.get("performance") or {}).get("mae"))
        ridge_mae = _finite(
            (ridge_fold.get("performance") or {}).get("mae")
            if ridge_fold
            else None
        )
        if candidate_mae is not None and ridge_mae is not None:
            comparisons.append(candidate_mae < ridge_mae)
    return (
        float(np.mean(comparisons))
        if comparisons
        else None
    )


def _ranking_fold_win_rate(
    candidate_folds: Sequence[Mapping[str, Any]],
    ridge_folds: Sequence[Mapping[str, Any]],
) -> Optional[float]:
    ridge_by_year = {
        fold.get("testYear"): fold
        for fold in ridge_folds
        if fold.get("testYear") is not None
    }
    comparisons = []
    for fold in candidate_folds:
        ridge_fold = ridge_by_year.get(fold.get("testYear"))
        candidate_rank = _finite(
            (fold.get("performance") or {}).get("crossSectionalRankIcMean")
        )
        ridge_rank = _finite(
            (ridge_fold.get("performance") or {}).get(
                "crossSectionalRankIcMean"
            )
            if ridge_fold
            else None
        )
        if candidate_rank is not None and ridge_rank is not None:
            comparisons.append(candidate_rank > ridge_rank)
    return float(np.mean(comparisons)) if comparisons else None


def _select_champion(
    candidates: Mapping[str, Mapping[str, Any]],
    *,
    promotion_rules: Mapping[str, Any],
    horizon: Optional[str] = None,
) -> Tuple[str, Dict[str, Any]]:
    if "ridge" not in candidates:
        raise ValueError("Ridge è obbligatorio come benchmark e fallback.")

    ridge = candidates["ridge"]
    ridge_performance = ridge.get("performance") or {}
    ridge_mae = _finite(ridge_performance.get("mae"))
    ridge_r2 = _finite(ridge_performance.get("oosR2VsZero"))
    ridge_rank = _finite(
        ridge_performance.get("crossSectionalRankIcMean")
    )
    rank_metric = "crossSectionalRankIcMean"
    if ridge_rank is None:
        ridge_rank = _finite(ridge_performance.get("rankIc"))
        rank_metric = "rankIc"
    minimum_mae_gain = float(
        promotion_rules.get("minimumRelativeMaeImprovement", 0.0025)
    )
    minimum_fold_win = float(
        promotion_rules.get("minimumFoldWinRate", 0.50)
    )
    maximum_rank_loss = float(
        promotion_rules.get("maximumRankIcDeterioration", 0.005)
    )
    tradeoff_mae_gain = float(
        promotion_rules.get(
            "minimumRelativeMaeImprovementForRankTradeoff",
            0.02,
        )
    )
    tradeoff_r2_gain = float(
        promotion_rules.get(
            "minimumOosR2ImprovementForRankTradeoff",
            0.02,
        )
    )
    tradeoff_fold_win = float(
        promotion_rules.get(
            "minimumFoldWinRateForRankTradeoff",
            2.0 / 3.0,
        )
    )
    tradeoff_minimum_rank = float(
        promotion_rules.get("minimumRankIcForRankTradeoff", 0.03)
    )
    tradeoff_rank_retention = float(
        promotion_rules.get(
            "minimumRankIcRetentionForRankTradeoff",
            0.85,
        )
    )

    audit: Dict[str, Any] = {
        "ridge": {
            "eligible": True,
            "reason": "Benchmark e fallback operativo.",
            "relativeMaeImprovementVsRidge": 0.0,
            "foldWinRateVsRidge": None,
            "rankMetric": rank_metric,
        }
    }
    qualified = []
    ranking_qualified = []
    for algorithm, candidate in candidates.items():
        if algorithm == "ridge":
            continue
        performance = candidate.get("performance") or {}
        candidate_mae = _finite(performance.get("mae"))
        candidate_r2 = _finite(performance.get("oosR2VsZero"))
        candidate_rank = _finite(performance.get(rank_metric))
        if candidate_rank is None:
            candidate_rank = _finite(performance.get("rankIc"))
        baseline_mae = _finite(performance.get("baselineZeroMae"))
        objective_mode = str(
            candidate.get("objectiveMode")
            or performance.get("objectiveMode")
            or "regression"
        ).strip().lower()
        fold_win_rate = _fold_win_rate(
            candidate.get("folds") or [],
            ridge.get("folds") or [],
        )
        if objective_mode == "ranking" and horizon == "3m":
            ndcg_lift = _finite(
                performance.get("crossSectionalNdcgAt20PctLiftVsRandom")
            )
            rank_gain = (
                candidate_rank - ridge_rank
                if candidate_rank is not None and ridge_rank is not None
                else None
            )
            ranking_fold_win = _ranking_fold_win_rate(
                candidate.get("folds") or [],
                ridge.get("folds") or [],
            )
            ranking_checks = {
                "positiveRankIc": (
                    candidate_rank is not None and candidate_rank > 0.0
                ),
                "improvesRidgeRankIc": (
                    rank_gain is not None
                    and rank_gain
                    >= float(
                        promotion_rules.get(
                            "minimumRankingRankIcImprovement",
                            0.005,
                        )
                    )
                ),
                "positiveNdcgLiftVsRandom": (
                    ndcg_lift is not None
                    and ndcg_lift
                    > float(
                        promotion_rules.get(
                            "minimumRankingNdcgLiftVsRandom",
                            0.0,
                        )
                    )
                ),
                "stableRankingAcrossFolds": (
                    ranking_fold_win is not None
                    and ranking_fold_win
                    >= float(
                        promotion_rules.get(
                            "minimumRankingFoldWinRate",
                            0.50,
                        )
                    )
                ),
            }
            eligible = all(ranking_checks.values())
            failed = [
                name for name, passed in ranking_checks.items() if not passed
            ]
            audit[algorithm] = {
                "eligible": eligible,
                "reason": (
                    "Supera le regole di ranking 3m sul development OOF."
                    if eligible
                    else "Non supera: " + ", ".join(failed) + "."
                ),
                "objectiveMode": "ranking",
                "selectionData": "developmentOOFOnly",
                "holdoutUsedForSelection": False,
                "rankMetric": rank_metric,
                "rankIcImprovementVsRidge": rank_gain,
                "ndcgLiftVsRandom": ndcg_lift,
                "rankingFoldWinRateVsRidge": ranking_fold_win,
                "checks": ranking_checks,
            }
            if eligible:
                ranking_qualified.append(
                    (
                        algorithm,
                        candidate_rank if candidate_rank is not None else -math.inf,
                        ndcg_lift if ndcg_lift is not None else -math.inf,
                        -candidate_mae if candidate_mae is not None else -math.inf,
                    )
                )
            continue
        relative_mae_gain = (
            (ridge_mae - candidate_mae) / max(abs(ridge_mae), 1e-12)
            if ridge_mae is not None and candidate_mae is not None
            else None
        )
        r2_gain = (
            candidate_r2 - ridge_r2
            if candidate_r2 is not None and ridge_r2 is not None
            else None
        )
        rank_retention = (
            candidate_rank / ridge_rank
            if (
                candidate_rank is not None
                and ridge_rank is not None
                and ridge_rank >= tradeoff_minimum_rank
            )
            else None
        )
        preserves_rank_absolute = bool(
            candidate_rank is not None
            and (
                ridge_rank is None
                or candidate_rank >= ridge_rank - maximum_rank_loss
            )
        )
        rank_tradeoff_applied = bool(
            not preserves_rank_absolute
            and candidate_rank is not None
            and candidate_rank >= tradeoff_minimum_rank
            and rank_retention is not None
            and rank_retention >= tradeoff_rank_retention
            and relative_mae_gain is not None
            and relative_mae_gain >= tradeoff_mae_gain
            and r2_gain is not None
            and r2_gain >= tradeoff_r2_gain
            and fold_win_rate is not None
            and fold_win_rate >= tradeoff_fold_win
        )
        checks = {
            "beatsZeroMae": (
                candidate_mae is not None
                and baseline_mae is not None
                and candidate_mae < baseline_mae
            ),
            "positiveOosR2": candidate_r2 is not None and candidate_r2 > 0,
            "improvesRidgeMae": (
                relative_mae_gain is not None
                and relative_mae_gain >= minimum_mae_gain
            ),
            "doesNotWorsenRidgeR2": (
                candidate_r2 is not None
                and (ridge_r2 is None or candidate_r2 >= ridge_r2)
            ),
            "stableAcrossFolds": (
                fold_win_rate is not None
                and fold_win_rate >= minimum_fold_win
            ),
            "preservesRankIc": (
                preserves_rank_absolute or rank_tradeoff_applied
            ),
        }
        eligible = all(checks.values())
        failed = [name for name, passed in checks.items() if not passed]
        audit[algorithm] = {
            "eligible": eligible,
            "reason": (
                "Supera tutte le regole di promozione."
                if eligible
                else "Non supera: " + ", ".join(failed) + "."
            ),
            "relativeMaeImprovementVsRidge": relative_mae_gain,
            "oosR2ImprovementVsRidge": r2_gain,
            "foldWinRateVsRidge": fold_win_rate,
            "rankIcRetentionVsRidge": rank_retention,
            "rankIcTradeoffApplied": rank_tradeoff_applied,
            "rankMetric": rank_metric,
            "objectiveMode": objective_mode,
            "checks": checks,
        }
        if eligible:
            qualified.append(
                (
                    algorithm,
                    relative_mae_gain or 0.0,
                    (
                        candidate_r2
                        if candidate_r2 is not None
                        else -math.inf
                    ),
                    (
                        candidate_rank
                        if candidate_rank is not None
                        else -math.inf
                    ),
                )
            )

    champion = (
        max(ranking_qualified, key=lambda item: (item[1], item[2], item[3]))[0]
        if horizon == "3m" and ranking_qualified
        else max(qualified, key=lambda item: (item[1], item[2], item[3]))[0]
        if qualified
        else "ridge"
    )
    return champion, {
        "champion": champion,
        "championDisplayName": _algorithm_display_name(champion),
        "fallback": "ridge",
        "rules": dict(promotion_rules),
        "candidateAudit": audit,
        "rankMetric": rank_metric,
        "selectionBasis": (
            "Configurazioni prefissate sugli stessi fold walk-forward; "
            "Rank IC cross-sectional medio (pooled solo come fallback) protetto "
            "da non inferiorità assoluta o, soltanto con "
            "miglioramenti materiali e stabili di MAE/R², relativa."
        ),
    }


def _normalized_algorithms(algorithms: Sequence[str]) -> List[str]:
    normalized = []
    for value in algorithms:
        algorithm = str(value or "").strip().lower()
        if algorithm in SUPPORTED_ALGORITHMS and algorithm not in normalized:
            normalized.append(algorithm)
    if "ridge" in normalized:
        normalized.remove("ridge")
    return ["ridge", *normalized]


def fit_artifact(
    rows: Sequence[Mapping[str, Any]],
    *,
    alpha: float = 12.0,
    feature_names: Sequence[str] = FEATURE_NAMES,
    feature_names_by_horizon: Optional[Mapping[str, Sequence[str]]] = None,
    categorical_feature_names: Sequence[str] = (),
    objective_modes_by_horizon: Optional[Mapping[str, Any]] = None,
    enable_oof_ensemble: bool = True,
    minimum_training_rows: int = 120,
    minimum_test_rows: int = 20,
    metadata: Optional[Mapping[str, Any]] = None,
    algorithms: Sequence[str] = ("ridge",),
    model_configs: Optional[Mapping[str, Mapping[str, Any]]] = None,
    promotion_rules: Optional[Mapping[str, Any]] = None,
    seed: int = 42,
    evaluation_years: int = 2,
) -> Dict[str, Any]:
    """Addestra i challenger e produce un artifact JSON serializzabile."""

    if not rows:
        raise ValueError("Il dataset di training è vuoto.")

    requested_algorithms = _normalized_algorithms(algorithms)
    resolved_rules = {
        **DEFAULT_PROMOTION_RULES,
        **dict(promotion_rules or {}),
    }
    availability = {
        algorithm: {
            "available": algorithm_available(algorithm),
            "displayName": ALGORITHM_LABELS.get(algorithm, algorithm),
        }
        for algorithm in requested_algorithms
    }
    available_algorithms = [
        algorithm
        for algorithm in requested_algorithms
        if availability[algorithm]["available"]
    ]
    if "ridge" not in available_algorithms:
        raise RuntimeError("Ridge non è disponibile come benchmark.")

    models: Dict[str, Any] = {}
    evaluated_algorithms = set()
    horizon_sample_summary: Dict[str, Any] = {}
    for horizon in HORIZONS:
        horizon_feature_names = list(
            (feature_names_by_horizon or {}).get(horizon) or feature_names
        )
        target_key = f"target_{horizon}"
        label_key = f"label_date_{horizon}"
        usable_rows = [
            row
            for row in rows
            if _finite(row.get(target_key)) is not None
            and _parse_date(row.get(label_key)) is not None
        ]
        if len(usable_rows) < max(30, minimum_test_rows):
            continue
        horizon_sample_summary[horizon] = {
            "sampleSize": len(usable_rows),
            **_sample_structure(usable_rows, len(usable_rows)),
        }

        candidate_records: Dict[str, Dict[str, Any]] = {}
        candidate_errors: Dict[str, str] = {}
        for algorithm in available_algorithms:
            try:
                objective_mode = _objective_mode_for_horizon(
                    algorithm,
                    horizon,
                    model_configs=model_configs,
                    objective_modes_by_horizon=objective_modes_by_horizon,
                )
                (
                    oos_actual,
                    oos_predicted,
                    oos_years,
                    folds,
                ) = _walk_forward_predictions(
                    usable_rows,
                    horizon=horizon,
                    algorithm=algorithm,
                    alpha=alpha,
                    feature_names=horizon_feature_names,
                    categorical_feature_names=categorical_feature_names,
                    minimum_training_rows=minimum_training_rows,
                    minimum_test_rows=minimum_test_rows,
                    model_configs=model_configs,
                    seed=seed,
                    objective_mode=objective_mode,
                )
                oos_rows = _aligned_oos_rows(
                    usable_rows,
                    horizon=horizon,
                    folds=folds,
                )
                if len(oos_rows) != oos_actual.size:
                    raise RuntimeError(
                        "Allineamento dei metadati OOS non coerente con le "
                        "previsioni walk-forward."
                    )
                if not oos_actual.size:
                    raise ValueError(
                        "Nessun fold walk-forward valutabile per l'algoritmo."
                    )
                candidate_records[algorithm] = {
                    "algorithm": algorithm,
                    "folds": folds,
                    "oosActual": oos_actual,
                    "oosPredicted": oos_predicted,
                    "oosYears": oos_years,
                    "oosRows": oos_rows,
                    "objectiveMode": objective_mode,
                }
                evaluated_algorithms.add(algorithm)
            except Exception as exc:
                if algorithm == "ridge":
                    raise
                candidate_errors[algorithm] = (
                    f"{type(exc).__name__}: {str(exc)[:240]}"
                )

        requested_evaluation_years = max(1, int(evaluation_years))

        def evaluation_partition() -> Tuple[
            List[int], List[int], List[int], bool, int
        ]:
            year_sets = [
                {int(value) for value in record["oosYears"]}
                for record in candidate_records.values()
            ]
            common_years = sorted(set.intersection(*year_sets))
            independent = len(common_years) >= 4
            count = (
                min(requested_evaluation_years, len(common_years) - 2)
                if independent
                else 0
            )
            holdout = common_years[-count:] if count else list(common_years)
            development = (
                common_years[:-count] if count else list(common_years)
            )
            return common_years, development, holdout, independent, count

        # Un challenger che non riesce a produrre un refit temporalmente pulito
        # viene escluso; Ridge resta sempre disponibile come percorso legacy.
        for _ in range(2):
            (
                all_test_years,
                development_years,
                holdout_years,
                independent_holdout,
                holdout_count,
            ) = evaluation_partition()
            development_cutoff = (
                datetime(min(holdout_years), 1, 1)
                if independent_holdout and holdout_years
                else None
            )
            failed_algorithms = []
            for algorithm, record in candidate_records.items():
                try:
                    record["finalModel"] = _fit_final_estimator(
                        algorithm,
                        usable_rows,
                        horizon=horizon,
                        development_cutoff=development_cutoff,
                        alpha=alpha,
                        feature_names=horizon_feature_names,
                        categorical_feature_names=categorical_feature_names,
                        minimum_training_rows=minimum_training_rows,
                        minimum_validation_rows=max(
                            5,
                            min(minimum_test_rows, 20),
                        ),
                        model_configs=model_configs,
                        seed=seed,
                        objective_mode=record.get("objectiveMode", "regression"),
                    )
                except Exception as exc:
                    if algorithm == "ridge":
                        raise
                    candidate_errors[algorithm] = (
                        f"{type(exc).__name__}: {str(exc)[:240]}"
                    )
                    failed_algorithms.append(algorithm)
            if not failed_algorithms:
                break
            for algorithm in failed_algorithms:
                candidate_records.pop(algorithm, None)
                evaluated_algorithms.discard(algorithm)
        (
            all_test_years,
            development_years,
            holdout_years,
            independent_holdout,
            holdout_count,
        ) = evaluation_partition()

        for record in candidate_records.values():
            actual = record["oosActual"]
            predicted = record["oosPredicted"]
            years = record["oosYears"]
            holdout_mask = np.isin(years, holdout_years)
            development_mask = np.isin(years, development_years)
            development_actual = actual[development_mask]
            development_predicted = predicted[development_mask]
            holdout_actual = actual[holdout_mask]
            holdout_predicted = predicted[holdout_mask]
            oos_rows = record["oosRows"]
            development_rows = [
                row
                for row, included in zip(oos_rows, development_mask)
                if bool(included)
            ]
            holdout_rows = [
                row
                for row, included in zip(oos_rows, holdout_mask)
                if bool(included)
            ]
            evidence = _residual_evidence(
                development_actual,
                development_predicted,
                holdout_actual,
                holdout_predicted,
                final_model=record["finalModel"],
                usable_rows=usable_rows,
                target_key=target_key,
                evaluation_rows=holdout_rows,
                horizon=horizon,
                bootstrap_seed=seed + int(HORIZONS[horizon]["sessions"]),
            )
            evidence["publishable"] = bool(
                evidence["publishable"]
                and evidence["performance"].get("sampleSize", 0)
                >= minimum_test_rows * 2
            )
            objective_mode = str(record.get("objectiveMode") or "regression")
            evidence["performance"]["objectiveMode"] = objective_mode
            if objective_mode == "ranking":
                rank_ic = _finite(
                    evidence["performance"].get("crossSectionalRankIcMean")
                )
                ndcg_lift = _finite(
                    evidence["performance"].get(
                        "crossSectionalNdcgAt20PctLiftVsRandom"
                    )
                )
                evidence["publishable"] = bool(
                    evidence["performance"].get("sampleSize", 0)
                    >= minimum_test_rows * 2
                    and rank_ic is not None
                    and rank_ic > 0.0
                    and ndcg_lift is not None
                    and ndcg_lift > 0.0
                )
            record.update(
                {
                    **evidence,
                    "fullWalkForwardPerformance": (
                        _metrics(
                            actual,
                            predicted,
                            rows=oos_rows,
                            horizon=horizon,
                        )
                        if actual.size
                        else _empty_performance()
                    ),
                    "developmentPerformance": (
                        _metrics(
                            development_actual,
                            development_predicted,
                            rows=development_rows,
                            horizon=horizon,
                        )
                        if development_actual.size
                        else _empty_performance()
                    ),
                    "holdoutPerformance": evidence["performance"],
                    "developmentFolds": [
                        fold
                        for fold in record["folds"]
                        if fold.get("testYear") in development_years
                    ],
                    "holdoutFolds": [
                        fold
                        for fold in record["folds"]
                        if fold.get("testYear") in holdout_years
                    ],
                }
            )

        if enable_oof_ensemble and independent_holdout:
            try:
                ensemble_record = _build_temporal_oof_ensemble(
                    candidate_records,
                    horizon=horizon,
                    development_years=development_years,
                    holdout_years=holdout_years,
                    usable_rows=usable_rows,
                    target_key=target_key,
                    minimum_test_rows=minimum_test_rows,
                    seed=seed,
                )
                candidate_records[ENSEMBLE_MODEL_TYPE] = ensemble_record
                evaluated_algorithms.add(ENSEMBLE_MODEL_TYPE)
            except (RuntimeError, ValueError, KeyError) as exc:
                candidate_errors[ENSEMBLE_MODEL_TYPE] = (
                    f"{type(exc).__name__}: {str(exc)[:240]}"
                )

        development_candidates = {
            algorithm: {
                "performance": record["developmentPerformance"],
                "folds": record["developmentFolds"],
                "objectiveMode": record.get("objectiveMode", "regression"),
            }
            for algorithm, record in candidate_records.items()
        }
        development_champion, development_selection = _select_champion(
            development_candidates,
            promotion_rules=resolved_rules,
            horizon=horizon,
        )
        development_audit = development_selection.get("candidateAudit", {})
        rank_tradeoff_applied = bool(
            (
                development_audit.get(development_champion)
                if isinstance(development_audit, Mapping)
                else {}
            ).get("rankIcTradeoffApplied")
        )
        champion = development_champion
        holdout_selection = None
        holdout_confirmed = None
        if independent_holdout and development_champion != "ridge":
            confirmation_candidates = {
                algorithm: {
                    "performance": candidate_records[algorithm][
                        "holdoutPerformance"
                    ],
                    "folds": candidate_records[algorithm]["holdoutFolds"],
                    "objectiveMode": candidate_records[algorithm].get(
                        "objectiveMode",
                        "regression",
                    ),
                }
                for algorithm in ("ridge", development_champion)
            }
            confirmed_champion, holdout_selection = _select_champion(
                confirmation_candidates,
                promotion_rules=resolved_rules,
                horizon=horizon,
            )
            holdout_confirmed = confirmed_champion == development_champion

        selection = {
            "champion": champion,
            "championDisplayName": _algorithm_display_name(champion),
            "developmentChampion": development_champion,
            "developmentChampionDisplayName": _algorithm_display_name(
                development_champion
            ),
            "fallback": "ridge",
            "rules": dict(resolved_rules),
            "policyVersion": SELECTION_POLICY_VERSION,
            "policyFrozenAt": SELECTION_POLICY_FROZEN_AT,
            "rankIcTradeoffApplied": rank_tradeoff_applied,
            "policyValidationStatus": (
                "prospective-confirmation-required"
                if rank_tradeoff_applied
                else "standard"
            ),
            "independentHoldout": independent_holdout,
            "holdoutUsedForSelection": False,
            "developmentYears": development_years,
            "holdoutYears": holdout_years,
            "holdoutConfirmed": holdout_confirmed,
            "candidateAudit": development_selection.get(
                "candidateAudit",
                {},
            ),
            "holdoutCandidateAudit": (
                holdout_selection.get("candidateAudit", {})
                if holdout_selection
                else {}
            ),
            "selectionBasis": (
                "Gli anni di sviluppo scelgono definitivamente l'algoritmo. "
                f"Gli ultimi {holdout_count or 0} anni restano separati e "
                "vengono usati soltanto per audit, metriche pubblicate e "
                "copertura degli intervalli, mai per cambiare il vincitore."
            ),
        }
        selected = candidate_records[champion]
        if not independent_holdout:
            validation_status = "limitedNoIndependentHoldout"
        elif not selected["publishable"]:
            validation_status = "notValidated"
        elif rank_tradeoff_applied:
            validation_status = "prospectiveConfirmationRequired"
        elif holdout_confirmed is False:
            validation_status = "holdoutNotConfirmed"
        else:
            validation_status = "validated"
        selected["performance"]["validationStatus"] = validation_status
        for record in candidate_records.values():
            record["performance"].setdefault(
                "validationStatus",
                (
                    "validated"
                    if independent_holdout and record["publishable"]
                    else "notValidated"
                    if independent_holdout
                    else "limitedNoIndependentHoldout"
                ),
            )
        selection["validationStatus"] = validation_status
        promotion_decision = (
            "promote" if validation_status == "validated" else "reject"
        )
        selection["promotionDecision"] = promotion_decision
        selection["promotionScope"] = "horizonIndependent"
        selection["holdoutAuditStatus"] = (
            "notIndependent"
            if not independent_holdout
            else "benchmarkSelected"
            if development_champion == "ridge"
            else "challengerConfirmed"
            if holdout_confirmed
            else "challengerNotConfirmed"
        )
        training_start = min(
            str(row.get("snapshot_date"))[:10] for row in usable_rows
        )
        training_end = max(
            str(row.get("snapshot_date"))[:10] for row in usable_rows
        )
        candidate_performance = {
            algorithm: {
                "displayName": _algorithm_display_name(algorithm),
                "objectiveMode": record.get("objectiveMode", "regression"),
                "performance": record["performance"],
                "folds": record["folds"],
                "developmentPerformance": record[
                    "developmentPerformance"
                ],
                "holdoutPerformance": record["holdoutPerformance"],
                "fullWalkForwardPerformance": record[
                    "fullWalkForwardPerformance"
                ],
                "developmentFolds": record["developmentFolds"],
                "holdoutFolds": record["holdoutFolds"],
                "publishable": record["publishable"],
                "trainingAudit": record["finalModel"].get("trainingAudit"),
                "hyperparameters": (
                    record["finalModel"].get("hyperparameters")
                    or {
                        "alpha": record["finalModel"].get("alpha")
                    }
                ),
            }
            for algorithm, record in candidate_records.items()
        }
        selected_model = {
            **selected["finalModel"],
            "trainingRows": len(usable_rows),
            "trainingStart": training_start,
            "trainingEnd": training_end,
            "performance": selected["performance"],
            "folds": selected["folds"],
            "residualQuantiles": selected["residualQuantiles"],
            "residualSample": selected["residualSample"],
            "calibrationSampleSize": selected["calibrationSampleSize"],
            "publishable": selected["publishable"],
            "validationStatus": validation_status,
            "promotionDecision": promotion_decision,
            "promotionScope": "horizonIndependent",
            "objectiveMode": selected.get("objectiveMode", "regression"),
            "featureNames": list(horizon_feature_names),
            "categoricalFeatureNames": list(categorical_feature_names),
            "candidatePerformance": candidate_performance,
            "candidateErrors": candidate_errors,
            "selection": selection,
        }
        if champion != "ridge":
            ridge = candidate_records["ridge"]
            selected_model["fallbackModel"] = {
                **ridge["finalModel"],
                "trainingRows": len(usable_rows),
                "trainingStart": training_start,
                "trainingEnd": training_end,
                "performance": ridge["performance"],
                "folds": ridge["folds"],
                "residualQuantiles": ridge["residualQuantiles"],
                "residualSample": ridge["residualSample"],
                "calibrationSampleSize": ridge["calibrationSampleSize"],
                "publishable": ridge["publishable"],
                "promotionDecision": (
                    "promote"
                    if ridge["performance"].get("validationStatus") == "validated"
                    else "reject"
                ),
                "validationStatus": ridge["performance"].get(
                    "validationStatus"
                ),
            }
        models[horizon] = selected_model

    if not models:
        raise ValueError("Nessun orizzonte contiene abbastanza target maturi.")

    tickers = sorted(
        {
            str(row.get("ticker") or "").upper()
            for row in rows
            if row.get("ticker")
        }
    )
    generated_at = datetime.utcnow().replace(microsecond=0).isoformat() + "Z"
    horizon_champions = {
        horizon: {
            "modelType": _model_type(model),
            "modelDisplayName": model.get("modelDisplayName")
            or _algorithm_display_name(_model_type(model)),
        }
        for horizon, model in models.items()
    }
    unique_champions = list(
        dict.fromkeys(
            item["modelDisplayName"]
            for item in horizon_champions.values()
        )
    )
    evaluated_labels = [
        _algorithm_display_name(algorithm)
        for algorithm in sorted(evaluated_algorithms)
        if algorithm in evaluated_algorithms
    ]
    feature_schema_by_horizon = {
        horizon: list(model.get("featureNames") or feature_names)
        for horizon, model in models.items()
    }
    union_feature_names = list(
        dict.fromkeys(
            name
            for horizon_names in feature_schema_by_horizon.values()
            for name in horizon_names
        )
    )
    promotion_plan = {
        horizon: {
            "decision": model.get("promotionDecision", "reject"),
            "modelType": _model_type(model),
            "validationStatus": model.get("validationStatus"),
        }
        for horizon, model in models.items()
    }
    return {
        "schemaVersion": SCHEMA_VERSION,
        "modelVersion": MODEL_VERSION,
        "validationVersion": VALIDATION_VERSION,
        "generatedAt": generated_at,
        "featureNames": union_feature_names,
        "featureNamesByHorizon": feature_schema_by_horizon,
        "categoricalFeatureNames": list(categorical_feature_names),
        "ensemblePolicyVersion": ENSEMBLE_POLICY_VERSION,
        "horizons": HORIZONS,
        "models": models,
        "modelSummary": {
            "strategy": "champion-challenger",
            "displayName": " / ".join(unique_champions),
            "championsByHorizon": horizon_champions,
            "fallback": "Ridge",
            "promotionScope": "horizonIndependent",
            "promotionPlan": promotion_plan,
        },
        "dataset": {
            **dict(metadata or {}),
            "rows": len(rows),
            "issuers": len(tickers),
            **_sample_structure(rows, len(rows)),
            "horizonSamples": horizon_sample_summary,
            "tickers": tickers,
            "algorithmsRequested": requested_algorithms,
            "algorithmsEvaluated": sorted(evaluated_algorithms),
            "algorithmAvailability": availability,
            "independentEvaluationYears": int(evaluation_years),
        },
        "methodology": {
            "model": (
                "Champion per orizzonte tra "
                f"{', '.join(evaluated_labels)}; "
                f"vincitori attuali: {', '.join(unique_champions)}"
            ),
            "selection": (
                "Configurazioni conservative prefissate; non inferiorità "
                "Rank IC assoluta oppure relativa solo con miglioramenti "
                "materiali di MAE/R² e stabilità nei fold."
            ),
            "selectionPolicy": (
                f"{SELECTION_POLICY_VERSION}, congelata il "
                f"{SELECTION_POLICY_FROZEN_AT}"
            ),
            "ensemble": (
                "Stacking Ridge non-negativo addestrato esclusivamente su "
                "predizioni walk-forward OOF del development; holdout escluso "
                "da pesi, selezione e fallback."
            ),
            "ensemblePolicyVersion": ENSEMBLE_POLICY_VERSION,
            "promotion": "Promozione e astensione indipendenti per orizzonte.",
            "prospectiveValidation": (
                "Le promozioni attivate dalla nuova regola relativa sono "
                "esplorative finché non vengono confermate su dati maturati "
                "dopo il congelamento della policy."
            ),
            "validation": (
                "Walk-forward annuale con target maturi, embargo di 7 giorni "
                "e holdout temporale finale usato soltanto per audit; la "
                "selezione dell'algoritmo usa esclusivamente gli anni di sviluppo"
            ),
            "validationVersion": VALIDATION_VERSION,
            "crossSectionalMetrics": (
                "Spearman Rank IC calcolato tra emittenti per mese: media, "
                "mediana, ICIR non annualizzato e quota di mesi positivi"
            ),
            "uncertaintyOfMetrics": (
                "Intervalli al 95% con circular moving-block bootstrap mensile; "
                "lunghezza del blocco coerente con l'orizzonte"
            ),
            "nonOverlappingRobustness": (
                "Sottocampioni per fase con mesi distanziati di 1, 3 o 12 mesi"
            ),
            "sampleSize": (
                "Numero di righe snapshot, non numero di osservazioni "
                "statisticamente indipendenti"
            ),
            "target": "Rendimento totale rettificato per split e dividendi",
            "interval": (
                "Quantili 10/90 dei residui degli anni di sviluppo; copertura "
                "misurata soltanto sull'holdout finale"
            ),
            "baseline": "Rendimento previsto pari a zero",
            "preprocessing": (
                "Imputazione mediana, winsorization 1/99, indicatori di "
                "missingness e scaling appresi dentro ogni training fold"
            ),
            "weighting": (
                "Peso inverso al numero di snapshot mensili per ticker e filing"
            ),
            "treeEarlyStopping": (
                "Per XGBoost e LightGBM una coda temporale purgata, successiva "
                "al train e ricavata solo dal development, seleziona i round; "
                "l'holdout finale non viene mai usato per early stopping"
            ),
            "finalRefit": (
                "Dopo la selezione dei round i booster vengono rifittati su "
                "tutti i target maturi senza blocco di validation; date, righe "
                "e provenienza della coda restano in trainingAudit"
            ),
            "driverMethod": (
                "Contributi lineari per Ridge; contributi TreeSHAP nativi "
                "per XGBoost e LightGBM"
            ),
        },
    }


def _format_feature_value(name: str, value: Any) -> Optional[str]:
    if value is None:
        return None
    numeric = _finite(value)
    if numeric is None:
        text = str(value).strip()
        return text or None
    if name in PERCENT_FEATURES:
        return f"{numeric * 100:.1f}%"
    if name == "log_market_cap":
        return None
    if name == "filing_age_years":
        return f"{numeric * 365.25:.0f} giorni"
    return f"{numeric:.2f}x"


def _model_quality(performance: Mapping[str, Any]) -> Dict[str, str]:
    sample_size = int(performance.get("sampleSize") or 0)
    evaluation_dates = int(
        performance.get("crossSectionalRankIcDateCount") or 0
    )
    oos_r2 = _finite(performance.get("oosR2VsZero"))
    mae_edge = _finite(performance.get("maeEdgeVsZero"))
    rank_ic = _finite(performance.get("crossSectionalRankIcMean"))
    if rank_ic is None:
        rank_ic = _finite(performance.get("rankIc"))
    if (
        (evaluation_dates and evaluation_dates < 12)
        or (not evaluation_dates and sample_size < 100)
        or oos_r2 is None
    ):
        return {
            "key": "insufficient",
            "label": "Non verificata",
            "detail": "Backtest temporale insufficiente per valutarne l'affidabilità.",
        }
    if oos_r2 <= 0 or (mae_edge is not None and mae_edge <= 0):
        return {
            "key": "insufficient",
            "label": "Evidenza insufficiente",
            "detail": "Nel backtest il modello non supera la previsione nulla.",
        }
    if (
        (evaluation_dates >= 24 or (not evaluation_dates and sample_size >= 1000))
        and rank_ic is not None
        and rank_ic >= 0.05
    ):
        return {
            "key": "moderate",
            "label": "Moderata",
            "detail": "Il segnale ha superato la baseline su un campione temporale ampio.",
        }
    return {
        "key": "limited",
        "label": "Limitata",
        "detail": "Il segnale supera la baseline, ma resta debole o poco esteso.",
    }


def _drivers_for_effects(
    features: Mapping[str, Any],
    effects: Mapping[str, float],
) -> Dict[str, List[Dict[str, Any]]]:
    usable = []
    for name, effect in effects.items():
        raw_value = features.get(name)
        has_value = raw_value is not None and bool(str(raw_value).strip())
        if name == "log_market_cap" or not has_value or not math.isfinite(effect):
            continue
        usable.append(
            {
                "feature": name,
                "label": FEATURE_LABELS.get(name, name),
                "value": (
                    _finite(raw_value)
                    if _finite(raw_value) is not None
                    else str(raw_value)
                ),
                "formattedValue": _format_feature_value(name, raw_value),
                "effectPctPoints": effect * 100.0,
            }
        )
    return {
        "strengths": sorted(
            (driver for driver in usable if driver["effectPctPoints"] > 0),
            key=lambda item: item["effectPctPoints"],
            reverse=True,
        )[:4],
        "attentionSignals": sorted(
            (driver for driver in usable if driver["effectPctPoints"] < 0),
            key=lambda item: item["effectPctPoints"],
        )[:4],
    }


def predict_from_artifact(
    artifact: Mapping[str, Any],
    features: Mapping[str, Any],
) -> Dict[str, Any]:
    """Esegue inferenza e restituisce previsioni, qualità e contributi locali."""

    output_predictions = []
    all_contributions: Dict[str, float] = {}
    drivers_by_horizon: Dict[str, Dict[str, List[Dict[str, Any]]]] = {}
    runtime_fallbacks = []
    coverage_feature_names = list(
        dict.fromkeys(
            [
                *list(artifact.get("featureNames", FEATURE_NAMES)),
                *list(artifact.get("categoricalFeatureNames") or []),
            ]
        )
    )
    coverage_values = [
        (
            _finite(features.get(name)) is not None
            or (
                features.get(name) is not None
                and bool(str(features.get(name)).strip())
            )
        )
        for name in coverage_feature_names
    ]
    coverage = sum(coverage_values) / max(1, len(coverage_values))

    for horizon, model in (artifact.get("models") or {}).items():
        selected_type = _model_type(model)
        runtime_model = model
        fallback_used = False
        try:
            prediction = float(_predict_estimator(runtime_model, [features])[0])
            horizon_contributions = _local_effects(
                runtime_model,
                [features],
            )[0]
        except (ImportError, RuntimeError, ValueError, KeyError) as exc:
            fallback = model.get("fallbackModel")
            if not isinstance(fallback, Mapping):
                raise
            runtime_model = fallback
            fallback_used = True
            prediction = float(_predict_estimator(runtime_model, [features])[0])
            horizon_contributions = _local_effects(
                runtime_model,
                [features],
            )[0]
            runtime_fallbacks.append(
                {
                    "horizon": horizon,
                    "selectedModelType": selected_type,
                    "runtimeModelType": _model_type(runtime_model),
                    "reason": str(exc)[:180],
                }
            )
        if not math.isfinite(prediction):
            raise ValueError(f"Previsione non finita per l'orizzonte {horizon}.")

        residual_quantiles = runtime_model.get("residualQuantiles") or {}
        lower = prediction + float(residual_quantiles.get("p10") or 0.0)
        upper = prediction + float(residual_quantiles.get("p90") or 0.0)
        residuals = np.asarray(
            runtime_model.get("residualSample") or [],
            dtype=float,
        )
        probability_positive = (
            float(np.mean((prediction + residuals) > 0))
            if residuals.size
            else None
        )

        for name, contribution in horizon_contributions.items():
            all_contributions[name] = all_contributions.get(name, 0.0) + contribution
        drivers_by_horizon[horizon] = _drivers_for_effects(
            features,
            horizon_contributions,
        )

        performance = dict(runtime_model.get("performance") or {})
        bootstrap_intervals = (
            (performance.get("blockBootstrap95") or {}).get("intervals") or {}
        )
        mae_edge_interval = bootstrap_intervals.get("maeEdgeVsZero") or {}
        rank_ic_interval = bootstrap_intervals.get(
            "crossSectionalRankIcMean"
        ) or {}
        coverage_value = _finite(performance.get("interval80Coverage"))
        calibration_gap = _finite(performance.get("interval80CalibrationGap"))
        if calibration_gap is None and coverage_value is not None:
            calibration_gap = coverage_value - 0.80
        calibration_status = performance.get("interval80CalibrationStatus")
        if not calibration_status:
            calibration_status = (
                "unavailable"
                if calibration_gap is None
                else "withinTolerance"
                if abs(calibration_gap) <= 0.05
                else "underCoverage"
                if calibration_gap < 0
                else "overCoverage"
            )
        validation_status = (
            runtime_model.get("validationStatus")
            or performance.get("validationStatus")
            or "legacyArtifact"
        )
        explicit_promotion = runtime_model.get("promotionDecision")
        if explicit_promotion in {"promote", "reject"}:
            promotion_decision = str(explicit_promotion)
        elif validation_status == "legacyArtifact":
            promotion_decision = "promote"
        else:
            promotion_decision = (
                "promote"
                if runtime_model.get("publishable") is True
                and validation_status == "validated"
                else "reject"
            )
        objective_mode = str(
            runtime_model.get("objectiveMode")
            or (runtime_model.get("trainingAudit") or {}).get("objectiveMode")
            or performance.get("objectiveMode")
            or "regression"
        ).strip().lower()
        ranking_score_only = objective_mode == "ranking" and not isinstance(
            runtime_model.get("returnCalibrator"),
            Mapping,
        )
        abstained = promotion_decision == "reject" or ranking_score_only
        abstention_reason = (
            "Score LambdaMART non calibrato come rendimento; disponibile solo per ordinare una sezione trasversale."
            if ranking_score_only
            else "L'orizzonte non ha superato i gate indipendenti di promozione."
            if promotion_decision == "reject"
            else None
        )
        members = runtime_model.get("members")
        meta_learner = runtime_model.get("metaLearner") or {}
        component_models = (
            [_model_type(member) for member in members.values()]
            if isinstance(members, Mapping)
            else []
        )
        ensemble_weights = (
            dict(meta_learner.get("weightsByMember") or {})
            if _model_type(runtime_model) == ENSEMBLE_MODEL_TYPE
            else {}
        )
        output_predictions.append(
            {
                "horizon": horizon,
                "label": HORIZONS.get(horizon, {}).get("label", horizon),
                "modelType": _model_type(runtime_model),
                "modelDisplayName": (
                    runtime_model.get("modelDisplayName")
                    or _algorithm_display_name(_model_type(runtime_model))
                ),
                "selectedModelType": selected_type,
                "runtimeFallbackUsed": fallback_used,
                "promotionDecision": promotion_decision,
                "promoted": promotion_decision == "promote",
                "abstained": abstained,
                "abstentionReason": abstention_reason,
                "objectiveMode": objective_mode,
                "componentModels": component_models,
                "ensembleWeights": ensemble_weights,
                "expectedReturnPct": None if abstained else prediction * 100.0,
                "diagnosticExpectedReturnPct": prediction * 100.0,
                "rankingScore": prediction if ranking_score_only else None,
                "interval80Pct": (
                    None if abstained else [lower * 100.0, upper * 100.0]
                ),
                "diagnosticInterval80Pct": [lower * 100.0, upper * 100.0],
                "probabilityPositivePct": (
                    probability_positive * 100.0
                    if probability_positive is not None and not abstained
                    else None
                ),
                "uncertainty": {
                    "available": not abstained and bool(residuals.size),
                    "intervalLevel": 0.80,
                    "intervalPct": (
                        None
                        if abstained
                        else [lower * 100.0, upper * 100.0]
                    ),
                    "calibrationSource": "developmentOOFResiduals",
                    "holdoutUsedForCalibrationFit": False,
                    "holdoutCoverage": coverage_value,
                    "calibrationStatus": calibration_status,
                },
                "quality": _model_quality(performance),
                "publishable": bool(runtime_model.get("publishable")),
                "validationStatus": validation_status,
                "performance": {
                    "sampleSize": performance.get("sampleSize"),
                    "sampleSizeIsIndependent": performance.get(
                        "sampleSizeIsIndependent"
                    ),
                    "sampleSizeNote": performance.get("sampleSizeNote"),
                    "uniqueSnapshotDates": performance.get(
                        "uniqueSnapshotDates"
                    ),
                    "uniqueEvaluationMonths": performance.get(
                        "uniqueEvaluationMonths"
                    ),
                    "uniqueIssuers": performance.get("uniqueIssuers"),
                    "uniqueFilings": performance.get("uniqueFilings"),
                    "oosMaePct": (
                        float(performance["mae"]) * 100.0
                        if _finite(performance.get("mae")) is not None
                        else None
                    ),
                    "baselineZeroMaePct": (
                        float(performance["baselineZeroMae"]) * 100.0
                        if _finite(performance.get("baselineZeroMae")) is not None
                        else None
                    ),
                    "maeEdgeVsZeroPct": (
                        float(performance["maeEdgeVsZero"]) * 100.0
                        if _finite(performance.get("maeEdgeVsZero")) is not None
                        else None
                    ),
                    "maeRelativeImprovementVsZeroPct": (
                        float(performance["maeRelativeImprovementVsZero"])
                        * 100.0
                        if _finite(
                            performance.get("maeRelativeImprovementVsZero")
                        )
                        is not None
                        else None
                    ),
                    "maeEdgeVsZeroCi95Pct": (
                        [
                            float(mae_edge_interval["lower"]) * 100.0,
                            float(mae_edge_interval["upper"]) * 100.0,
                        ]
                        if _finite(mae_edge_interval.get("lower")) is not None
                        and _finite(mae_edge_interval.get("upper")) is not None
                        else None
                    ),
                    "oosR2VsZero": performance.get("oosR2VsZero"),
                    "rankIc": performance.get("rankIc"),
                    "crossSectionalRankIcMean": performance.get(
                        "crossSectionalRankIcMean"
                    ),
                    "crossSectionalRankIcMedian": performance.get(
                        "crossSectionalRankIcMedian"
                    ),
                    "crossSectionalRankIcIcir": performance.get(
                        "crossSectionalRankIcIcir"
                    ),
                    "crossSectionalRankIcPositiveRatePct": (
                        float(
                            performance["crossSectionalRankIcPositiveRate"]
                        )
                        * 100.0
                        if _finite(
                            performance.get(
                                "crossSectionalRankIcPositiveRate"
                            )
                        )
                        is not None
                        else None
                    ),
                    "crossSectionalRankIcDateCount": performance.get(
                        "crossSectionalRankIcDateCount"
                    ),
                    "crossSectionalNdcgAt20PctMean": performance.get(
                        "crossSectionalNdcgAt20PctMean"
                    ),
                    "crossSectionalNdcgAt20PctLiftVsRandom": performance.get(
                        "crossSectionalNdcgAt20PctLiftVsRandom"
                    ),
                    "crossSectionalRankIcMeanCi95": (
                        [
                            float(rank_ic_interval["lower"]),
                            float(rank_ic_interval["upper"]),
                        ]
                        if _finite(rank_ic_interval.get("lower")) is not None
                        and _finite(rank_ic_interval.get("upper")) is not None
                        else None
                    ),
                    "directionalAccuracyPct": (
                        float(performance["directionalAccuracy"]) * 100.0
                        if _finite(performance.get("directionalAccuracy")) is not None
                        else None
                    ),
                    "interval80CoveragePct": (
                        float(performance["interval80Coverage"]) * 100.0
                        if _finite(performance.get("interval80Coverage")) is not None
                        else None
                    ),
                    "interval80CalibrationGapPct": (
                        calibration_gap * 100.0
                        if calibration_gap is not None
                        else None
                    ),
                    "interval80CalibrationStatus": calibration_status,
                    "interval80CalibrationSampleSize": performance.get(
                        "interval80CalibrationSampleSize"
                    ),
                    "validationStatus": validation_status,
                    "nonOverlappingRobustness": performance.get(
                        "nonOverlappingRobustness"
                    ),
                },
            }
        )

    horizon_count = max(1, len(output_predictions))
    averaged = {
        name: value / horizon_count for name, value in all_contributions.items()
    }
    aggregate_drivers = _drivers_for_effects(features, averaged)

    missing = [
        FEATURE_LABELS.get(name, name)
        for name, available in zip(coverage_feature_names, coverage_values)
        if not available
    ]
    promoted_count = sum(
        1
        for prediction in output_predictions
        if prediction["promoted"] and not prediction["abstained"]
    )
    return {
        "predictions": output_predictions,
        "drivers": aggregate_drivers,
        "driversByHorizon": drivers_by_horizon,
        "dataQuality": {
            "featureCoveragePct": coverage * 100.0,
            "availableFeatures": sum(coverage_values),
            "totalFeatures": len(coverage_values),
            "missingFeatures": missing,
            "runtimeFallbacks": runtime_fallbacks,
        },
        "status": (
            "ready"
            if promoted_count == len(output_predictions) and output_predictions
            else "limited"
        ),
    }
