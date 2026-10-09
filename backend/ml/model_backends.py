"""Backend opzionali per i modelli ad alberi del forecast fondamentale.

I booster vengono serializzati nei formati nativi delle rispettive librerie.
Non viene usato pickle: l'artifact rimane un JSON ispezionabile e può essere
validato prima del caricamento.
"""

from __future__ import annotations

import base64
from copy import deepcopy
from datetime import date, datetime
from functools import lru_cache
import importlib.util
import math
import os
import tempfile
from typing import Any, Dict, Mapping, Optional, Sequence

import numpy as np


ALGORITHM_LABELS = {
    "ridge": "Ridge",
    "xgboost": "XGBoost",
    "lightgbm": "LightGBM",
    "catboost": "CatBoost",
}

DEFAULT_TREE_CONFIGS: Dict[str, Dict[str, Any]] = {
    "xgboost": {
        "num_boost_round": 240,
        "learning_rate": 0.03,
        "max_depth": 2,
        "min_child_weight": 50.0,
        "subsample": 0.80,
        "colsample_bytree": 0.80,
        "reg_alpha": 0.10,
        "reg_lambda": 12.0,
        "gamma": 0.0001,
        "max_bin": 128,
    },
    "lightgbm": {
        "num_boost_round": 240,
        "learning_rate": 0.03,
        "num_leaves": 7,
        "max_depth": 3,
        "min_data_in_leaf": 100,
        "feature_fraction": 0.80,
        "bagging_fraction": 0.80,
        "bagging_freq": 1,
        "lambda_l1": 0.10,
        "lambda_l2": 12.0,
        "min_gain_to_split": 0.0001,
        "max_bin": 127,
    },
    "catboost": {
        "num_boost_round": 240,
        "learning_rate": 0.03,
        "depth": 5,
        "l2_leaf_reg": 12.0,
        "random_strength": 0.25,
        "bagging_temperature": 0.25,
        "border_count": 128,
        # Ordered boosting evita il prediction shift ed e' il default v5.
        # CPU rende determinismo, categorie native e group_id disponibili.
        "boosting_type": "Ordered",
        "task_type": "CPU",
    },
}

DEFAULT_EARLY_STOPPING_ROUNDS = 40
_MAX_LIBRARY_SEED = 2_147_483_647
_ENSEMBLE_SEED_STRIDE = 104_729

# I nomi dei profili restano indipendenti dalla libreria. In questo modo il
# chiamante può confrontare booster diversi con la stessa intenzione statistica
# senza dover conoscere i nomi dei rispettivi objective.
ROBUST_TRAINING_PROFILES: Dict[str, Dict[str, Dict[str, Any]]] = {
    "xgboost": {
        "squared_error": {
            "objective": "reg:squarederror",
            "eval_metric": "mae",
        },
        "huber": {
            "objective": "reg:pseudohubererror",
            "eval_metric": "mae",
            "huber_slope": 1.0,
        },
        "quantile": {
            "objective": "reg:quantileerror",
            "eval_metric": "quantile",
            "quantile_alpha": 0.5,
        },
    },
    "lightgbm": {
        "squared_error": {
            "objective": "regression",
            "metric": "l1",
        },
        "huber": {
            "objective": "huber",
            "metric": "huber",
            "alpha": 0.9,
        },
        "quantile": {
            "objective": "quantile",
            "metric": "quantile",
            "alpha": 0.5,
        },
    },
    "catboost": {
        "squared_error": {
            "loss_function": "RMSE",
            "eval_metric": "MAE",
        },
        "huber": {
            "loss_function": "Huber:delta=1.0",
            "eval_metric": "MAE",
        },
        "quantile": {
            "loss_function": "Quantile:alpha=0.5",
            "eval_metric": "Quantile:alpha=0.5",
        },
    },
}

OBJECTIVE_MODES = ("regression", "classification", "ranking")

_OBJECTIVE_MODE_ALIASES = {
    "regressor": "regression",
    "binary": "classification",
    "binary_classification": "classification",
    "classifier": "classification",
    "lambdamart": "ranking",
    "rank": "ranking",
    "ranker": "ranking",
}

_TASK_PARAMETERS: Dict[str, Dict[str, Dict[str, Any]]] = {
    "xgboost": {
        "classification": {
            "objective": "binary:logistic",
            "eval_metric": "logloss",
        },
        "ranking": {
            "objective": "rank:ndcg",
            "eval_metric": "ndcg",
            "lambdarank_pair_method": "mean",
        },
    },
    "lightgbm": {
        "classification": {
            "objective": "binary",
            "metric": "binary_logloss",
        },
        "ranking": {
            "objective": "lambdarank",
            "metric": "ndcg",
        },
    },
    "catboost": {
        "classification": {
            "loss_function": "Logloss",
            "eval_metric": "Logloss",
        },
        "ranking": {
            "loss_function": "YetiRank",
            "eval_metric": "NDCG",
        },
    },
}

_PROFILE_ALIASES = {
    "default": "squared_error",
    "l2": "squared_error",
    "mse": "squared_error",
    "pseudohuber": "huber",
    "pseudo_huber": "huber",
}


def ensemble_seed(base_seed: int, member_index: int = 0) -> int:
    """Deriva un seed stabile e distinto per un membro dell'ensemble.

    Il membro zero conserva esattamente il seed storico, così il training v3
    non cambia. Gli altri membri usano una progressione deterministica.
    """

    index = int(member_index)
    if index < 0:
        raise ValueError("ensemble_member deve essere maggiore o uguale a zero.")
    normalized = int(base_seed) % _MAX_LIBRARY_SEED
    return int((normalized + index * _ENSEMBLE_SEED_STRIDE) % _MAX_LIBRARY_SEED)


def resolve_training_profile(
    algorithm: str,
    profile: str = "squared_error",
    *,
    quantile_alpha: Optional[float] = None,
) -> Dict[str, Any]:
    """Risolve un profilo robusto nei parametri nativi della libreria."""

    normalized = str(algorithm or "").strip().lower()
    normalized_profile = str(profile or "squared_error").strip().lower()
    normalized_profile = _PROFILE_ALIASES.get(
        normalized_profile,
        normalized_profile,
    )
    available = ROBUST_TRAINING_PROFILES.get(normalized)
    if available is None:
        raise ValueError(f"Algoritmo ad alberi non supportato: {algorithm}")
    if normalized_profile not in available:
        choices = ", ".join(sorted(available))
        raise ValueError(
            f"Profilo robusto non supportato per {normalized}: {profile}. "
            f"Valori ammessi: {choices}."
        )

    resolved = deepcopy(available[normalized_profile])
    if normalized_profile == "quantile" and quantile_alpha is not None:
        alpha = float(quantile_alpha)
        if not 0.0 < alpha < 1.0:
            raise ValueError("quantile_alpha deve essere compreso tra 0 e 1.")
        if normalized == "xgboost":
            resolved["quantile_alpha"] = alpha
        elif normalized == "lightgbm":
            resolved["alpha"] = alpha
        else:
            resolved["loss_function"] = f"Quantile:alpha={alpha:g}"
            resolved["eval_metric"] = f"Quantile:alpha={alpha:g}"
    return resolved


def backend_runtime_availability(algorithm: str) -> Dict[str, Any]:
    """Descrive disponibilita' e fallback senza importare librerie native."""

    normalized = str(algorithm or "").strip().lower()
    if normalized == "ridge":
        return {
            "available": True,
            "library": "numpy",
            "reason": "Backend Ridge sempre disponibile tramite NumPy.",
            "installHint": None,
            "fallbackAlgorithm": None,
        }
    if normalized not in {"xgboost", "lightgbm", "catboost"}:
        return {
            "available": False,
            "library": normalized or None,
            "reason": f"Algoritmo non supportato: {normalized or algorithm}",
            "installHint": None,
            "fallbackAlgorithm": "ridge",
        }
    available = importlib.util.find_spec(normalized) is not None
    label = ALGORITHM_LABELS[normalized]
    return {
        "available": bool(available),
        "library": normalized,
        "reason": (
            f"Runtime {label} disponibile."
            if available
            else f"Libreria opzionale {label} non installata nel runtime."
        ),
        "installHint": None if available else f"pip install {normalized}",
        "fallbackAlgorithm": None if available else "ridge",
    }


def backend_capabilities(algorithm: Optional[str] = None) -> Dict[str, Any]:
    """Restituisce capability ispezionabili senza importare i booster.

    Il ranking è deliberatamente dichiarato come non esposto: XGBoost e
    LightGBM lo supportano, ma richiedono gruppi cross-sectional e label di
    rilevanza. Riutilizzare silenziosamente l'attuale target di rendimento
    romperebbe il contratto statistico del training v3.
    """

    names = (
        [str(algorithm or "").strip().lower()]
        if algorithm is not None
        else ["ridge", "xgboost", "lightgbm", "catboost"]
    )
    result: Dict[str, Any] = {}
    for name in names:
        if name not in ALGORITHM_LABELS:
            raise ValueError(f"Algoritmo non supportato: {name}")
        is_tree = name in ROBUST_TRAINING_PROFILES
        availability = backend_runtime_availability(name)
        supports_native_categories = name == "catboost"
        result[name] = {
            "displayName": ALGORITHM_LABELS[name],
            "available": availability["available"],
            "runtimeAvailability": availability,
            "treeBackend": is_tree,
            "robustProfiles": (
                sorted(ROBUST_TRAINING_PROFILES[name]) if is_tree else []
            ),
            "temporalValidation": is_tree,
            "earlyStopping": is_tree,
            "deterministicSeed": is_tree,
            "ensembleSeedDerivation": is_tree,
            "objectiveModes": (
                {
                    "regression": {
                        "supported": True,
                        "robustProfiles": sorted(ROBUST_TRAINING_PROFILES[name]),
                        "predictionKind": "value",
                    },
                    "classification": {
                        "supported": True,
                        "binaryOnly": True,
                        "predictionKind": "positiveClassProbability",
                    },
                    "ranking": {
                        "supported": True,
                        "queryGroupsRequired": True,
                        "queryIdsSupported": True,
                        "relevanceLabels": "nonNegativeIntegers",
                        "predictionKind": "rankingScore",
                        "lambdaMART": name in {"xgboost", "lightgbm"},
                    },
                }
                if is_tree
                else {
                    "regression": {
                        "supported": True,
                        "robustProfiles": [],
                        "predictionKind": "value",
                    },
                    "classification": {"supported": False},
                    "ranking": {"supported": False},
                }
            ),
            "nativeCategoricalFeatures": {
                "supported": supports_native_categories,
                "orderedBoosting": supports_native_categories,
                "missingToken": "__MISSING__" if supports_native_categories else None,
            },
            "ranking": {
                "librarySupported": is_tree,
                # Flag v4 conservato; il supporto corrente e' nel flag v5.
                "fitInterfaceSupported": False,
                "v5FitInterfaceSupported": is_tree,
                "interfaceVersion": 2 if is_tree else 1,
                "queryGroupsRequired": is_tree,
                "queryIdsSupported": is_tree,
                "lambdaMART": name in {"xgboost", "lightgbm"},
                "reason": (
                    "Richiede gruppi per data e label di rilevanza; il "
                    "contratto v5 e' esposto da v5FitInterfaceSupported."
                    if is_tree
                    else "Non disponibile nel backend Ridge corrente."
                ),
            },
        }
    if algorithm is not None:
        return result[names[0]]
    return result


def algorithm_available(algorithm: str) -> bool:
    """Indica se il runtime può addestrare e caricare l'algoritmo richiesto."""

    normalized = str(algorithm or "").strip().lower()
    return bool(backend_runtime_availability(normalized)["available"])


def _expanded_feature_names(feature_names: Sequence[str]) -> list[str]:
    base = [str(name) for name in feature_names]
    return base + [f"{name}__missing" for name in base]


def _resolved_feature_names(
    matrix: np.ndarray,
    feature_names: Sequence[str],
) -> list[str]:
    """Accetta nomi finali v5 o nomi base del preprocessing legacy v3/v4."""

    values = np.asarray(matrix)
    if values.ndim != 2:
        raise ValueError("matrix deve essere una matrice bidimensionale.")
    base = [str(name) for name in feature_names]
    if not base or len(set(base)) != len(base):
        raise ValueError("feature_names deve contenere nomi univoci e non vuoti.")
    if len(base) == values.shape[1]:
        return base
    if len(base) * 2 == values.shape[1]:
        return _expanded_feature_names(base)
    raise ValueError(
        "feature_names deve descrivere tutte le colonne finali oppure le "
        "colonne base del preprocessing legacy con indicatori missing."
    )


def _normalize_objective_mode(value: Optional[str]) -> str:
    normalized = str(value or "regression").strip().lower()
    normalized = _OBJECTIVE_MODE_ALIASES.get(normalized, normalized)
    if normalized not in OBJECTIVE_MODES:
        choices = ", ".join(OBJECTIVE_MODES)
        raise ValueError(
            f"objective_mode non supportato: {value}. Valori ammessi: {choices}."
        )
    return normalized


def _validate_training_arrays(
    matrix: np.ndarray,
    target: np.ndarray,
    sample_weight: Optional[np.ndarray],
) -> tuple[np.ndarray, np.ndarray, Optional[np.ndarray]]:
    values = np.asarray(matrix)
    labels = np.asarray(target, dtype=float).reshape(-1)
    if values.ndim != 2 or not values.shape[0]:
        raise ValueError("matrix deve essere una matrice bidimensionale non vuota.")
    if labels.shape[0] != values.shape[0]:
        raise ValueError("target deve contenere una label per ogni riga.")
    if not np.isfinite(labels).all():
        raise ValueError("target contiene valori non finiti.")
    weights = None
    if sample_weight is not None:
        weights = np.asarray(sample_weight, dtype=float).reshape(-1)
        if weights.shape[0] != values.shape[0]:
            raise ValueError("sample_weight deve contenere un peso per ogni riga.")
        if not np.isfinite(weights).all() or np.any(weights < 0.0):
            raise ValueError("sample_weight deve contenere pesi finiti non negativi.")
        if not np.any(weights > 0.0):
            raise ValueError("sample_weight deve contenere almeno un peso positivo.")
    return values, labels, weights


def _validate_categorical_indices(
    algorithm: str,
    column_count: int,
    categorical_feature_indices: Optional[Sequence[int]],
) -> list[int]:
    if categorical_feature_indices is None:
        return []
    indices = [int(value) for value in categorical_feature_indices]
    if len(set(indices)) != len(indices):
        raise ValueError("categorical_feature_indices contiene duplicati.")
    if any(index < 0 or index >= column_count for index in indices):
        raise ValueError("categorical_feature_indices contiene un indice fuori range.")
    if indices and algorithm != "catboost":
        raise ValueError(
            "Le categoriche native sono supportate da questa interfaccia solo "
            "per CatBoost; XGBoost e LightGBM richiedono una matrice numerica."
        )
    return sorted(indices)


def _query_id_key(value: Any) -> str:
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if value is None:
        raise ValueError("query_ids non puo' contenere valori nulli.")
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("query_ids non puo' contenere valori non finiti.")
    return str(value)


def _query_layout(
    row_count: int,
    query_groups: Optional[Sequence[int]],
    query_ids: Optional[Sequence[Any]],
    *,
    label: str,
) -> Optional[Dict[str, Any]]:
    if query_groups is not None and query_ids is not None:
        raise ValueError(f"{label}_query_groups e {label}_query_ids sono mutuamente esclusivi.")
    if query_groups is None and query_ids is None:
        return None

    if query_groups is not None:
        raw = np.asarray(query_groups)
        try:
            numeric = np.asarray(query_groups, dtype=float).reshape(-1)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{label}_query_groups deve contenere interi positivi.") from exc
        if raw.ndim != 1 or not numeric.size:
            raise ValueError(f"{label}_query_groups deve essere un vettore non vuoto.")
        if (
            not np.isfinite(numeric).all()
            or np.any(numeric <= 0)
            or np.any(numeric != np.floor(numeric))
        ):
            raise ValueError(f"{label}_query_groups deve contenere interi positivi.")
        sizes = numeric.astype(int).tolist()
        if sum(sizes) != row_count:
            raise ValueError(f"La somma di {label}_query_groups deve uguagliare le righe.")
        ids = [f"group-{index}" for index in range(len(sizes))]
        source = "groupSizes"
        temporal_keys = None
    else:
        raw_ids = list(query_ids) if query_ids is not None else []
        if len(raw_ids) != row_count:
            raise ValueError(f"{label}_query_ids deve contenere un id per ogni riga.")
        normalized_ids = [_query_id_key(value) for value in raw_ids]
        sizes = []
        ids = []
        seen: set[str] = set()
        current = normalized_ids[0]
        count = 0
        for item in normalized_ids:
            if item != current:
                sizes.append(count)
                ids.append(current)
                seen.add(current)
                if item in seen:
                    raise ValueError(
                        f"{label}_query_ids deve essere contiguo: un gruppo non puo' ricomparire."
                    )
                current = item
                count = 0
            count += 1
        sizes.append(count)
        ids.append(current)
        if len(set(ids)) != len(ids):
            raise ValueError(
                f"{label}_query_ids deve essere contiguo: un gruppo non puo' ricomparire."
            )
        source = "queryIds"
        temporal_keys = ids

    if any(size < 2 for size in sizes):
        raise ValueError("Ogni query di ranking deve contenere almeno due righe.")
    expanded_ids = [item for item, size in zip(ids, sizes) for _ in range(size)]
    return {
        "sizes": sizes,
        "ids": ids,
        "expandedIds": expanded_ids,
        "source": source,
        "temporalKeys": temporal_keys,
    }


def _temporal_key(value: str) -> Optional[tuple[int, Any]]:
    text = str(value).strip()
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is not None:
            parsed = parsed.astimezone().replace(tzinfo=None)
        return 0, parsed
    except ValueError:
        pass
    try:
        number = float(text)
        return (1, number) if math.isfinite(number) else None
    except ValueError:
        return None


def _validate_query_contract(
    objective_mode: str,
    train_rows: int,
    validation_rows: Optional[int],
    *,
    query_groups: Optional[Sequence[int]],
    query_ids: Optional[Sequence[Any]],
    validation_query_groups: Optional[Sequence[int]],
    validation_query_ids: Optional[Sequence[Any]],
) -> tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]], bool]:
    any_grouping = any(
        value is not None
        for value in (
            query_groups,
            query_ids,
            validation_query_groups,
            validation_query_ids,
        )
    )
    if objective_mode != "ranking":
        if any_grouping:
            raise ValueError("I gruppi query sono ammessi solo con objective_mode='ranking'.")
        return None, None, False

    training = _query_layout(
        train_rows,
        query_groups,
        query_ids,
        label="training",
    )
    if training is None:
        raise ValueError("Il ranking richiede query_groups oppure query_ids.")
    validation = None
    if validation_rows is not None:
        validation = _query_layout(
            validation_rows,
            validation_query_groups,
            validation_query_ids,
            label="validation",
        )
        if validation is None:
            raise ValueError(
                "Il ranking con validation richiede validation_query_groups "
                "oppure validation_query_ids."
            )
    elif validation_query_groups is not None or validation_query_ids is not None:
        raise ValueError("I gruppi validation richiedono la matrice di validation.")

    temporal_verified = False
    if validation is not None:
        train_keys = training.get("temporalKeys")
        validation_keys = validation.get("temporalKeys")
        if train_keys is not None and validation_keys is not None:
            if set(train_keys) & set(validation_keys):
                raise ValueError("Le query di training e validation devono essere disgiunte.")
            parsed_train = [_temporal_key(value) for value in train_keys]
            parsed_validation = [_temporal_key(value) for value in validation_keys]
            parsed = [*parsed_train, *parsed_validation]
            if all(value is not None for value in parsed):
                kind = parsed[0][0]
                if all(value[0] == kind for value in parsed):
                    if max(value[1] for value in parsed_train) >= min(
                        value[1] for value in parsed_validation
                    ):
                        raise ValueError(
                            "Le query di validation devono essere successive a quelle di training."
                        )
                    temporal_verified = True
    return training, validation, temporal_verified


def _group_mean_weights(
    weights: Optional[np.ndarray],
    sizes: Sequence[int],
) -> Optional[np.ndarray]:
    if weights is None:
        return None
    result = []
    start = 0
    for size in sizes:
        stop = start + int(size)
        result.append(float(np.mean(weights[start:stop])))
        start = stop
    return np.asarray(result, dtype=float)


def _expanded_group_weights(
    weights: Optional[np.ndarray],
    sizes: Sequence[int],
) -> Optional[np.ndarray]:
    group_weights = _group_mean_weights(weights, sizes)
    if group_weights is None:
        return None
    return np.repeat(group_weights, np.asarray(sizes, dtype=int))


def _prepare_catboost_matrix(
    matrix: np.ndarray,
    categorical_feature_indices: Sequence[int],
) -> np.ndarray:
    values = np.asarray(matrix, dtype=object).copy()
    for index in categorical_feature_indices:
        normalized = []
        for value in values[:, index]:
            if value is None or (
                isinstance(value, (float, np.floating)) and not math.isfinite(float(value))
            ):
                normalized.append("__MISSING__")
            else:
                normalized.append(str(value))
        values[:, index] = normalized
    return values


def _resolved_config(
    algorithm: str,
    override: Optional[Mapping[str, Any]],
) -> Dict[str, Any]:
    config = dict(DEFAULT_TREE_CONFIGS.get(algorithm, {}))
    if override:
        config.update(dict(override))
    return config


def _temporal_validation(
    matrix: np.ndarray,
    validation_matrix: Optional[np.ndarray],
    validation_target: Optional[np.ndarray],
    validation_weight: Optional[np.ndarray],
) -> tuple[Optional[np.ndarray], Optional[np.ndarray], Optional[np.ndarray]]:
    """Valida il blocco out-of-time usato esclusivamente per early stopping."""

    provided = validation_matrix is not None or validation_target is not None
    if not provided:
        if validation_weight is not None:
            raise ValueError(
                "validation_weight richiede validation_matrix e validation_target."
            )
        return None, None, None
    if validation_matrix is None or validation_target is None:
        raise ValueError(
            "validation_matrix e validation_target devono essere passati insieme."
        )
    values = np.asarray(validation_matrix)
    labels = np.asarray(validation_target, dtype=float).reshape(-1)
    if values.ndim != 2:
        raise ValueError("validation_matrix deve essere una matrice bidimensionale.")
    if np.asarray(matrix).ndim != 2 or values.shape[1] != np.asarray(matrix).shape[1]:
        raise ValueError(
            "Training e validation devono avere lo stesso numero di colonne."
        )
    if values.shape[0] != labels.shape[0] or not values.shape[0]:
        raise ValueError(
            "validation_target deve contenere una label per ogni riga."
        )
    weights = None
    if validation_weight is not None:
        weights = np.asarray(validation_weight, dtype=float).reshape(-1)
        if weights.shape[0] != labels.shape[0]:
            raise ValueError(
                "validation_weight deve contenere un peso per ogni riga."
            )
    return values, labels, weights


def _early_stopping_rounds(
    configured: Optional[Any],
    explicit: Optional[int],
    *,
    has_validation: bool,
) -> Optional[int]:
    if not has_validation:
        return None
    raw = explicit if explicit is not None else configured
    rounds = DEFAULT_EARLY_STOPPING_ROUNDS if raw is None else int(raw)
    return rounds if rounds > 0 else None


def _require_xgboost():
    try:
        import xgboost as xgb
    except ImportError as exc:  # pragma: no cover - dipende dal runtime.
        raise RuntimeError(
            "XGBoost non è installato nel runtime del backend."
        ) from exc
    return xgb


def _require_lightgbm():
    try:
        import lightgbm as lgb
    except ImportError as exc:  # pragma: no cover - dipende dal runtime.
        raise RuntimeError(
            "LightGBM non è installato nel runtime del backend."
        ) from exc
    return lgb


def _require_catboost():
    try:
        import catboost
    except ImportError as exc:  # pragma: no cover - dipende dal runtime.
        raise RuntimeError(
            "CatBoost non e' installato nel runtime del backend. "
            "Il fallback operativo e' Ridge."
        ) from exc
    return catboost


def _serialize_catboost_model(model: Any) -> str:
    """Serializza il formato nativo CBM senza pickle."""

    handle, path = tempfile.mkstemp(suffix=".cbm")
    os.close(handle)
    try:
        model.save_model(path, format="cbm")
        with open(path, "rb") as stream:
            raw = stream.read()
    finally:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
    if not raw:
        raise RuntimeError("CatBoost ha prodotto un payload vuoto.")
    return base64.b64encode(raw).decode("ascii")


def _catboost_pool(
    catboost: Any,
    matrix: np.ndarray,
    *,
    feature_names: Sequence[str],
    categorical_feature_indices: Sequence[int],
    label: Optional[np.ndarray] = None,
    sample_weight: Optional[np.ndarray] = None,
    group_ids: Optional[Sequence[Any]] = None,
    group_weight: Optional[np.ndarray] = None,
) -> Any:
    values = _prepare_catboost_matrix(matrix, categorical_feature_indices)
    kwargs: Dict[str, Any] = {
        "feature_names": list(feature_names),
        "cat_features": list(categorical_feature_indices),
    }
    if label is not None:
        kwargs["label"] = label
    if sample_weight is not None:
        kwargs["weight"] = sample_weight
    if group_ids is not None:
        kwargs["group_id"] = list(group_ids)
    if group_weight is not None:
        kwargs["group_weight"] = group_weight
    return catboost.Pool(values, **kwargs)


def fit_tree_model(
    algorithm: str,
    matrix: np.ndarray,
    target: np.ndarray,
    *,
    feature_names: Sequence[str],
    sample_weight: Optional[np.ndarray] = None,
    config: Optional[Mapping[str, Any]] = None,
    seed: int = 42,
    validation_matrix: Optional[np.ndarray] = None,
    validation_target: Optional[np.ndarray] = None,
    validation_weight: Optional[np.ndarray] = None,
    robust_profile: Optional[str] = None,
    quantile_alpha: Optional[float] = None,
    early_stopping_rounds: Optional[int] = None,
    ensemble_member: int = 0,
    objective_mode: Optional[str] = None,
    categorical_feature_indices: Optional[Sequence[int]] = None,
    query_groups: Optional[Sequence[int]] = None,
    query_ids: Optional[Sequence[Any]] = None,
    validation_query_groups: Optional[Sequence[int]] = None,
    validation_query_ids: Optional[Sequence[Any]] = None,
) -> Dict[str, Any]:
    """Addestra un booster e restituisce un payload JSON serializzabile.

    ``validation_*`` deve rappresentare un periodo successivo al training: il
    backend non effettua split casuali. Se il blocco è presente, l'early
    stopping è attivo per default e non modifica il percorso legacy quando il
    blocco è assente.
    """

    normalized = str(algorithm or "").strip().lower()
    if normalized not in ROBUST_TRAINING_PROFILES:
        raise ValueError(f"Algoritmo ad alberi non supportato: {algorithm}")
    training_values, training_labels, weights = _validate_training_arrays(
        matrix,
        target,
        sample_weight,
    )
    expanded_names = _resolved_feature_names(training_values, feature_names)
    resolved = _resolved_config(normalized, config)
    configured_objective_mode = resolved.pop("objective_mode", None)
    mode = _normalize_objective_mode(
        objective_mode if objective_mode is not None else configured_objective_mode
    )
    categorical_indices = _validate_categorical_indices(
        normalized,
        training_values.shape[1],
        categorical_feature_indices,
    )
    configured_profile = resolved.pop(
        "robust_profile",
        resolved.pop("loss_profile", None),
    )
    selected_profile = str(
        robust_profile or configured_profile or "squared_error"
    ).strip().lower()
    selected_profile = _PROFILE_ALIASES.get(selected_profile, selected_profile)
    # ``quantile_alpha`` era già un parametro nativo XGBoost valido: lo
    # consumiamo come controllo del profilo soltanto quando il profilo quantile
    # è stato richiesto. Negli altri casi rimane nell'override, preservando le
    # configurazioni avanzate preesistenti che impostano direttamente objective.
    configured_alpha = (
        resolved.pop("quantile_alpha", None)
        if selected_profile == "quantile"
        else None
    )
    selected_alpha = (
        quantile_alpha if quantile_alpha is not None else configured_alpha
    )
    if mode == "regression":
        profile_params = resolve_training_profile(
            normalized,
            selected_profile,
            quantile_alpha=selected_alpha,
        )
    else:
        if robust_profile is not None and selected_profile != "squared_error":
            raise ValueError(
                "robust_profile e' applicabile soltanto alla regressione."
            )
        selected_profile = (
            "binary_logloss" if mode == "classification" else "lambdamart"
        )
        profile_params = deepcopy(_TASK_PARAMETERS[normalized][mode])
        resolved.pop("quantile_alpha", None)

    ranking_objective = resolved.pop("ranking_objective", None)
    if mode == "ranking" and ranking_objective:
        native_key = "loss_function" if normalized == "catboost" else "objective"
        profile_params[native_key] = str(ranking_objective)
    configured_early_stopping = resolved.pop("early_stopping_rounds", None)
    effective_seed = ensemble_seed(seed, ensemble_member)
    validation_values, validation_labels, validation_weights = _temporal_validation(
        training_values,
        validation_matrix,
        validation_target,
        validation_weight,
    )
    if validation_weights is not None:
        if (
            not np.isfinite(validation_weights).all()
            or np.any(validation_weights < 0.0)
            or not np.any(validation_weights > 0.0)
        ):
            raise ValueError(
                "validation_weight deve contenere pesi finiti non negativi "
                "e almeno un peso positivo."
            )

    training_query, validation_query, temporal_query_verified = (
        _validate_query_contract(
            mode,
            training_values.shape[0],
            validation_values.shape[0] if validation_values is not None else None,
            query_groups=query_groups,
            query_ids=query_ids,
            validation_query_groups=validation_query_groups,
            validation_query_ids=validation_query_ids,
        )
    )
    if mode == "classification":
        unique = set(np.unique(training_labels).tolist())
        if unique != {0.0, 1.0}:
            raise ValueError("La classificazione richiede label binarie 0 e 1.")
        if validation_labels is not None and not set(
            np.unique(validation_labels).tolist()
        ).issubset({0.0, 1.0}):
            raise ValueError("Le label di validation devono essere binarie 0 e 1.")
    if mode == "ranking":
        for labels, label in (
            (training_labels, "target"),
            (validation_labels, "validation_target"),
        ):
            if labels is None:
                continue
            if np.any(labels < 0.0) or np.any(labels != np.floor(labels)):
                raise ValueError(
                    f"{label} di ranking deve contenere rilevanze intere non negative."
                )
    stopping_rounds = _early_stopping_rounds(
        configured_early_stopping,
        early_stopping_rounds,
        has_validation=validation_values is not None,
    )

    def training_audit(
        params: Mapping[str, Any],
        *,
        best_iteration_count: int,
    ) -> Dict[str, Any]:
        metric = params.get("eval_metric", params.get("metric"))
        objective = params.get("objective", params.get("loss_function"))
        query_audit = {
            "enabled": mode == "ranking",
            "trainingGroups": len(training_query["sizes"]) if training_query else 0,
            "validationGroups": len(validation_query["sizes"]) if validation_query else 0,
            "trainingSource": training_query.get("source") if training_query else None,
            "validationSource": validation_query.get("source") if validation_query else None,
            "temporalOrderVerified": bool(temporal_query_verified),
            "rowsReordered": False,
            "minimumRowsPerQuery": 2 if mode == "ranking" else None,
        }
        return {
            "robustProfile": selected_profile,
            "objectiveMode": mode,
            "objective": objective,
            "evaluationMetric": metric,
            "baseSeed": int(seed),
            "ensembleMember": int(ensemble_member),
            "effectiveSeed": int(effective_seed),
            "deterministic": True,
            "temporalValidation": validation_values is not None,
            "earlyStopping": {
                "enabled": stopping_rounds is not None,
                "rounds": stopping_rounds,
                "bestIteration": int(best_iteration_count),
            },
            "predictionIterations": int(best_iteration_count),
            "ranking": backend_capabilities(normalized)["ranking"],
            "queryGrouping": query_audit,
            "categoricalFeatures": {
                "native": normalized == "catboost" and bool(categorical_indices),
                "indices": list(categorical_indices),
                "missingToken": "__MISSING__" if categorical_indices else None,
                "orderedBoosting": (
                    str(params.get("boosting_type") or "").lower() == "ordered"
                    if normalized == "catboost"
                    else False
                ),
            },
            "sampleWeights": {
                "provided": weights is not None,
                "rankingAggregation": (
                    "groupMean"
                    if mode == "ranking" and normalized in {"xgboost", "catboost"}
                    else "perRow"
                ),
            },
        }

    prediction_kind = {
        "regression": "value",
        "classification": "positiveClassProbability",
        "ranking": "rankingScore",
    }[mode]

    def artifact(
        params: Mapping[str, Any],
        *,
        best_count: int,
        estimator: Mapping[str, Any],
        rounds: int,
    ) -> Dict[str, Any]:
        return {
            "modelType": normalized,
            "modelDisplayName": ALGORITHM_LABELS[normalized],
            "objectiveMode": mode,
            "predictionKind": prediction_kind,
            "expandedFeatureNames": expanded_names,
            "categoricalFeatureIndices": list(categorical_indices),
            "hyperparameters": {
                **params,
                "num_boost_round": rounds,
            },
            "trainingAudit": training_audit(
                params,
                best_iteration_count=best_count,
            ),
            "estimator": dict(estimator),
        }

    if normalized == "xgboost":
        xgb = _require_xgboost()
        rounds = int(resolved.pop("num_boost_round", 240))
        params = {
            "tree_method": "hist",
            "eta": float(resolved.pop("learning_rate", 0.03)),
            "seed": int(effective_seed),
            "nthread": 1,
            "verbosity": 0,
            **profile_params,
            **resolved,
        }
        training_weight = weights
        validation_weight_for_backend = validation_weights
        if training_query is not None:
            training_weight = _group_mean_weights(weights, training_query["sizes"])
        if validation_query is not None:
            validation_weight_for_backend = _group_mean_weights(
                validation_weights,
                validation_query["sizes"],
            )
        training = xgb.DMatrix(
            training_values,
            label=training_labels,
            weight=training_weight,
            feature_names=expanded_names,
        )
        if training_query is not None:
            training.set_group(training_query["sizes"])
        validation = None
        if validation_values is not None:
            validation = xgb.DMatrix(
                validation_values,
                label=validation_labels,
                weight=validation_weight_for_backend,
                feature_names=expanded_names,
            )
            if validation_query is not None:
                validation.set_group(validation_query["sizes"])
        evals_result: Dict[str, Any] = {}
        booster = xgb.train(
            params,
            training,
            num_boost_round=rounds,
            evals=[(validation, "validation")] if validation is not None else (),
            evals_result=evals_result,
            early_stopping_rounds=stopping_rounds,
            verbose_eval=False,
        )
        best_count = rounds
        if stopping_rounds is not None:
            try:
                best_count = int(booster.best_iteration) + 1
            except (AttributeError, TypeError, ValueError):
                best_count = rounds
        raw = booster.save_raw(raw_format="json")
        return artifact(
            params,
            best_count=best_count,
            rounds=rounds,
            estimator={
                "format": "xgboost-json-base64",
                "payload": base64.b64encode(bytes(raw)).decode("ascii"),
                "library": "xgboost",
                "libraryVersion": str(xgb.__version__),
            },
        )

    if normalized == "lightgbm":
        lgb = _require_lightgbm()
        rounds = int(resolved.pop("num_boost_round", 240))
        params = {
            "learning_rate": float(resolved.pop("learning_rate", 0.03)),
            "seed": int(effective_seed),
            "feature_fraction_seed": int(effective_seed),
            "bagging_seed": int(effective_seed),
            "data_random_seed": int(effective_seed),
            "drop_seed": int(effective_seed),
            "extra_seed": int(effective_seed),
            "deterministic": True,
            "force_col_wise": True,
            "num_threads": 1,
            "verbosity": -1,
            "feature_pre_filter": False,
            **profile_params,
            **resolved,
        }
        training = lgb.Dataset(
            training_values,
            label=training_labels,
            weight=weights,
            group=training_query["sizes"] if training_query is not None else None,
            feature_name=expanded_names,
            free_raw_data=False,
        )
        validation = None
        if validation_values is not None:
            validation = lgb.Dataset(
                validation_values,
                label=validation_labels,
                weight=validation_weights,
                group=(
                    validation_query["sizes"]
                    if validation_query is not None
                    else None
                ),
                feature_name=expanded_names,
                reference=training,
                free_raw_data=False,
            )
        callbacks = []
        if stopping_rounds is not None:
            callbacks.append(lgb.early_stopping(stopping_rounds, verbose=False))
            callbacks.append(lgb.log_evaluation(period=0))
        booster = lgb.train(
            params,
            training,
            num_boost_round=rounds,
            valid_sets=[validation] if validation is not None else None,
            valid_names=["validation"] if validation is not None else None,
            callbacks=callbacks or None,
        )
        best_count = int(getattr(booster, "best_iteration", 0) or rounds)
        return artifact(
            params,
            best_count=best_count,
            rounds=rounds,
            estimator={
                "format": "lightgbm-text",
                "payload": booster.model_to_string(),
                "library": "lightgbm",
                "libraryVersion": str(lgb.__version__),
            },
        )

    if normalized == "catboost":
        catboost = _require_catboost()
        rounds = int(resolved.pop("num_boost_round", 240))
        params = {
            "iterations": rounds,
            "learning_rate": float(resolved.pop("learning_rate", 0.03)),
            "random_seed": int(effective_seed),
            "thread_count": 1,
            "allow_writing_files": False,
            "verbose": False,
            **profile_params,
            **resolved,
        }
        ranking_group_weight = (
            _expanded_group_weights(weights, training_query["sizes"])
            if training_query is not None
            else None
        )
        training = _catboost_pool(
            catboost,
            training_values,
            feature_names=expanded_names,
            categorical_feature_indices=categorical_indices,
            label=training_labels,
            sample_weight=weights if training_query is None else None,
            group_ids=(
                training_query["expandedIds"] if training_query is not None else None
            ),
            group_weight=ranking_group_weight,
        )
        validation = None
        if validation_values is not None:
            validation_group_weight = (
                _expanded_group_weights(
                    validation_weights,
                    validation_query["sizes"],
                )
                if validation_query is not None
                else None
            )
            validation = _catboost_pool(
                catboost,
                validation_values,
                feature_names=expanded_names,
                categorical_feature_indices=categorical_indices,
                label=validation_labels,
                sample_weight=(
                    validation_weights if validation_query is None else None
                ),
                group_ids=(
                    validation_query["expandedIds"]
                    if validation_query is not None
                    else None
                ),
                group_weight=validation_group_weight,
            )
        estimator_class = {
            "regression": catboost.CatBoostRegressor,
            "classification": catboost.CatBoostClassifier,
            "ranking": catboost.CatBoostRanker,
        }[mode]
        booster = estimator_class(**params)
        fit_kwargs: Dict[str, Any] = {"verbose": False}
        if validation is not None:
            fit_kwargs["eval_set"] = validation
            fit_kwargs["use_best_model"] = True
        if stopping_rounds is not None:
            fit_kwargs["early_stopping_rounds"] = stopping_rounds
        booster.fit(training, **fit_kwargs)
        best_count = int(getattr(booster, "tree_count_", 0) or rounds)
        if stopping_rounds is not None:
            try:
                best_iteration = int(booster.get_best_iteration())
                if best_iteration >= 0:
                    best_count = best_iteration + 1
            except (AttributeError, TypeError, ValueError):
                pass
        return artifact(
            params,
            best_count=best_count,
            rounds=rounds,
            estimator={
                "format": "catboost-cbm-base64",
                "payload": _serialize_catboost_model(booster),
                "library": "catboost",
                "libraryVersion": str(catboost.__version__),
            },
        )

    raise ValueError(f"Algoritmo ad alberi non supportato: {algorithm}")


@lru_cache(maxsize=12)
def _load_xgboost(payload: str):
    xgb = _require_xgboost()
    try:
        booster = xgb.Booster()
        booster.load_model(bytearray(base64.b64decode(payload.encode("ascii"))))
        return booster
    except Exception as exc:
        raise RuntimeError(
            "Il payload XGBoost non è compatibile o è corrotto."
        ) from exc


@lru_cache(maxsize=12)
def _load_lightgbm(payload: str):
    lgb = _require_lightgbm()
    try:
        return lgb.Booster(model_str=payload)
    except Exception as exc:
        raise RuntimeError(
            "Il payload LightGBM non è compatibile o è corrotto."
        ) from exc


@lru_cache(maxsize=12)
def _load_catboost(payload: str):
    catboost = _require_catboost()
    handle, path = tempfile.mkstemp(suffix=".cbm")
    os.close(handle)
    try:
        try:
            raw = base64.b64decode(payload.encode("ascii"), validate=True)
            if not raw:
                raise ValueError("payload vuoto")
            with open(path, "wb") as stream:
                stream.write(raw)
            booster = catboost.CatBoost()
            booster.load_model(path, format="cbm")
            return booster
        except Exception as exc:
            raise RuntimeError(
                "Il payload CatBoost non e' compatibile o e' corrotto."
            ) from exc
    finally:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass


def _tree_runtime(model: Mapping[str, Any]):
    algorithm = str(model.get("modelType") or "").lower()
    estimator = model.get("estimator")
    if not isinstance(estimator, Mapping):
        raise ValueError("Payload del booster mancante nell'artifact.")
    payload = estimator.get("payload")
    if not isinstance(payload, str) or not payload:
        raise ValueError("Payload del booster vuoto nell'artifact.")
    if algorithm == "xgboost":
        if estimator.get("format") != "xgboost-json-base64":
            raise ValueError("Formato XGBoost non riconosciuto.")
        return algorithm, _load_xgboost(payload)
    if algorithm == "lightgbm":
        if estimator.get("format") != "lightgbm-text":
            raise ValueError("Formato LightGBM non riconosciuto.")
        return algorithm, _load_lightgbm(payload)
    if algorithm == "catboost":
        if estimator.get("format") != "catboost-cbm-base64":
            raise ValueError("Formato CatBoost non riconosciuto.")
        return algorithm, _load_catboost(payload)
    raise ValueError(f"Modello ad alberi non supportato: {algorithm}")


def predict_tree_model(
    model: Mapping[str, Any],
    matrix: np.ndarray,
) -> np.ndarray:
    algorithm, booster = _tree_runtime(model)
    feature_names = list(model.get("expandedFeatureNames") or [])
    training_audit = model.get("trainingAudit")
    prediction_iterations = (
        training_audit.get("predictionIterations")
        if isinstance(training_audit, Mapping)
        else None
    )
    try:
        if algorithm == "xgboost":
            xgb = _require_xgboost()
            data = xgb.DMatrix(matrix, feature_names=feature_names or None)
            kwargs = (
                {"iteration_range": (0, int(prediction_iterations))}
                if prediction_iterations
                else {}
            )
            return np.asarray(booster.predict(data, **kwargs), dtype=float)
        if algorithm == "catboost":
            catboost = _require_catboost()
            categorical_indices = list(
                model.get("categoricalFeatureIndices") or []
            )
            data = _catboost_pool(
                catboost,
                matrix,
                feature_names=(
                    feature_names
                    or [f"feature_{index}" for index in range(matrix.shape[1])]
                ),
                categorical_feature_indices=categorical_indices,
            )
            kwargs: Dict[str, Any] = {"thread_count": 1}
            if prediction_iterations:
                kwargs["ntree_end"] = int(prediction_iterations)
            if (
                model.get("predictionKind") == "positiveClassProbability"
                or model.get("objectiveMode") == "classification"
            ):
                probabilities = np.asarray(
                    booster.predict(
                        data,
                        prediction_type="Probability",
                        **kwargs,
                    ),
                    dtype=float,
                )
                if probabilities.ndim == 2 and probabilities.shape[1] == 2:
                    return probabilities[:, 1]
                return probabilities.reshape(-1)
            return np.asarray(booster.predict(data, **kwargs), dtype=float).reshape(-1)
        kwargs = (
            {"num_iteration": int(prediction_iterations)}
            if prediction_iterations
            else {}
        )
        return np.asarray(booster.predict(matrix, **kwargs), dtype=float)
    except Exception as exc:
        raise RuntimeError(
            f"Inferenza {ALGORITHM_LABELS.get(algorithm, algorithm)} non riuscita."
        ) from exc


def tree_contributions(
    model: Mapping[str, Any],
    matrix: np.ndarray,
) -> np.ndarray:
    """Restituisce i contributi locali, escluso il termine base/bias."""

    algorithm, booster = _tree_runtime(model)
    feature_names = list(model.get("expandedFeatureNames") or [])
    training_audit = model.get("trainingAudit")
    prediction_iterations = (
        training_audit.get("predictionIterations")
        if isinstance(training_audit, Mapping)
        else None
    )
    try:
        if algorithm == "xgboost":
            xgb = _require_xgboost()
            data = xgb.DMatrix(matrix, feature_names=feature_names or None)
            kwargs = (
                {"iteration_range": (0, int(prediction_iterations))}
                if prediction_iterations
                else {}
            )
            contributions = booster.predict(
                data,
                pred_contribs=True,
                **kwargs,
            )
        elif algorithm == "lightgbm":
            kwargs = (
                {"num_iteration": int(prediction_iterations)}
                if prediction_iterations
                else {}
            )
            contributions = booster.predict(
                matrix,
                pred_contrib=True,
                **kwargs,
            )
        else:
            catboost = _require_catboost()
            categorical_indices = list(
                model.get("categoricalFeatureIndices") or []
            )
            data = _catboost_pool(
                catboost,
                matrix,
                feature_names=(
                    feature_names
                    or [f"feature_{index}" for index in range(matrix.shape[1])]
                ),
                categorical_feature_indices=categorical_indices,
            )
            contributions = booster.get_feature_importance(
                data=data,
                type="ShapValues",
                thread_count=1,
            )
    except Exception as exc:
        raise RuntimeError(
            "Calcolo dei contributi locali "
            f"{ALGORITHM_LABELS.get(algorithm, algorithm)} non riuscito."
        ) from exc
    values = np.asarray(contributions, dtype=float)
    if values.ndim != 2 or values.shape[1] != matrix.shape[1] + 1:
        raise ValueError("Contributi locali del booster con forma inattesa.")
    return values[:, :-1]
