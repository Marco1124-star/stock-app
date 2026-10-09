"""Gate read-only per la promozione degli artifact ML fondamentali.

Il modulo non confronta challenger, fallback o modelli alternativi e non copia
file. Valuta esclusivamente il modello candidato presente in ciascun orizzonte.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import sys
from typing import Any, Dict, Mapping, Optional, Sequence

from .model_backends import algorithm_available


KNOWN_V4_VALIDATION_VERSIONS = (
    "v4",
    "cross-sectional-block-bootstrap-v4",
    "v5",
    "point-in-time-oof-stacking-v5",
)
INTERVAL_80_MIN_COVERAGE = 0.75
INTERVAL_80_MAX_COVERAGE = 0.90


def _finite_number(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _check(
    gate: str,
    passed: bool,
    *,
    observed: Any,
    required: Any,
    success: str,
    failure: str,
) -> Dict[str, Any]:
    return {
        "gate": gate,
        "passed": bool(passed),
        "observed": observed,
        "required": required,
        "reason": success if passed else failure,
    }


def _validation_statuses(model: Mapping[str, Any]) -> Dict[str, Any]:
    performance = model.get("performance")
    selection = model.get("selection")
    locations = {
        "model": model.get("validationStatus"),
        "performance": (
            performance.get("validationStatus")
            if isinstance(performance, Mapping)
            else None
        ),
        "selection": (
            selection.get("validationStatus")
            if isinstance(selection, Mapping)
            else None
        ),
    }
    return {name: value for name, value in locations.items() if value is not None}


def _objective_mode(model: Mapping[str, Any]) -> str:
    training_audit = model.get("trainingAudit")
    performance = model.get("performance")
    return str(
        model.get("objectiveMode")
        or (
            training_audit.get("objectiveMode")
            if isinstance(training_audit, Mapping)
            else None
        )
        or (
            performance.get("objectiveMode")
            if isinstance(performance, Mapping)
            else None
        )
        or "regression"
    ).strip().lower()


def _runtime_availability(model: Mapping[str, Any]) -> Dict[str, Any]:
    algorithm = str(model.get("modelType") or "").strip().lower()
    if algorithm != "ensemble":
        available = bool(algorithm) and algorithm_available(algorithm)
        return {
            "algorithm": algorithm or None,
            "available": available,
            "components": {},
        }
    members = model.get("members")
    if not isinstance(members, Mapping) or not members:
        return {
            "algorithm": "ensemble",
            "available": False,
            "components": {},
            "reason": "Ensemble privo di membri serializzati.",
        }
    components = {
        str(name): _runtime_availability(member)
        if isinstance(member, Mapping)
        else {"algorithm": None, "available": False}
        for name, member in members.items()
    }
    return {
        "algorithm": "ensemble",
        "available": all(value.get("available") is True for value in components.values()),
        "components": components,
    }


def _ensemble_oof_audit(model: Mapping[str, Any]) -> Optional[Mapping[str, Any]]:
    if str(model.get("modelType") or "").strip().lower() != "ensemble":
        return None
    training_audit = model.get("trainingAudit")
    ensemble = (
        training_audit.get("ensemble")
        if isinstance(training_audit, Mapping)
        else None
    )
    return ensemble if isinstance(ensemble, Mapping) else {}


def _diagnostic(
    value: Any,
    *,
    missing_reason: str,
) -> Dict[str, Any]:
    """Descrive evidenza diagnostica senza attribuirle un esito pass/fail."""

    if not isinstance(value, Mapping):
        return {
            "status": "missing",
            "available": False,
            "reason": missing_reason,
            "decisionImpact": "diagnostic-only",
        }
    if value.get("available") is False:
        return {
            "status": "unavailable",
            "available": False,
            "reason": value.get("reason") or "Diagnostica dichiarata non disponibile.",
            "decisionImpact": "diagnostic-only",
        }
    if value.get("available") is not True:
        return {
            "status": "missing",
            "available": False,
            "reason": (
                "La diagnostica non dichiara esplicitamente available=true; "
                "non viene considerata superata."
            ),
            "decisionImpact": "diagnostic-only",
        }
    summary = {
        key: value.get(key)
        for key in (
            "method",
            "confidenceLevel",
            "iterations",
            "blockLengthMonths",
            "spacingMonths",
            "phaseCount",
            "dateCount",
            "maeEdgeVsZeroMinimum",
            "maeEdgePositivePhaseRate",
            "crossSectionalRankIcMeanMedian",
        )
        if value.get(key) is not None
    }
    if isinstance(value.get("intervals"), Mapping):
        summary["intervals"] = dict(value["intervals"])
    return {
        "status": "available",
        "available": True,
        "evidence": summary,
        "decisionImpact": "diagnostic-only",
    }


def _audit_horizon(
    horizon: str,
    model: Any,
    *,
    validation_version: Any,
    validation_version_valid: bool,
) -> Dict[str, Any]:
    if not isinstance(model, Mapping):
        check = _check(
            "candidate_present",
            False,
            observed="missing",
            required="candidate model object",
            success="Il candidato è presente.",
            failure=f"Il candidato per l'orizzonte {horizon} è mancante.",
        )
        return {
            "decision": "reject",
            "algorithm": None,
            "checks": [check],
            "reasons": [check["reason"]],
            "diagnostics": {
                "bootstrapCi95": _diagnostic(
                    None,
                    missing_reason="Candidato mancante: bootstrap CI non verificabile.",
                ),
                "nonOverlappingRobustness": _diagnostic(
                    None,
                    missing_reason=(
                        "Candidato mancante: robustezza non-overlap non verificabile."
                    ),
                ),
            },
        }

    performance = model.get("performance")
    performance = performance if isinstance(performance, Mapping) else {}
    selection = model.get("selection")
    selection = selection if isinstance(selection, Mapping) else {}
    algorithm = str(model.get("modelType") or "").strip().lower()
    objective_mode = _objective_mode(model)

    checks = [
        _check(
            "validation_version_v4",
            validation_version_valid,
            observed=validation_version,
            required=list(KNOWN_V4_VALIDATION_VERSIONS),
            success="L'artifact usa il protocollo di validazione v4.",
            failure=(
                "Protocollo di validazione v4 mancante o non riconosciuto; "
                "un artifact legacy non può essere promosso."
            ),
        )
    ]

    holdout_value = selection.get("holdoutUsedForSelection")
    checks.append(
        _check(
            "holdout_not_used_for_selection",
            holdout_value is False,
            observed=holdout_value,
            required=False,
            success="L'holdout non è stato usato per selezionare il modello.",
            failure=(
                "holdoutUsedForSelection deve essere esplicitamente false; "
                "manca isolamento tra selezione e valutazione."
            ),
        )
    )

    statuses = _validation_statuses(model)
    status_valid = bool(statuses) and all(
        value == "validated" for value in statuses.values()
    )
    checks.append(
        _check(
            "validation_status",
            status_valid,
            observed=statuses or None,
            required="validated in every declared location",
            success="Lo stato di validazione del candidato è coerente e validato.",
            failure=(
                "validationStatus deve essere 'validated' e coerente in tutte "
                "le posizioni dichiarate."
            ),
        )
    )

    publishable = model.get("publishable")
    checks.append(
        _check(
            "publishable",
            publishable is True,
            observed=publishable,
            required=True,
            success="Il candidato è marcato publishable.",
            failure="Il candidato deve essere esplicitamente publishable=true.",
        )
    )

    mae = _finite_number(performance.get("mae"))
    baseline_mae = _finite_number(performance.get("baselineZeroMae"))
    beats_baseline = objective_mode == "ranking" or (
        mae is not None and baseline_mae is not None and mae < baseline_mae
    )
    checks.append(
        _check(
            "mae_beats_zero_baseline",
            beats_baseline,
            observed={"mae": mae, "baselineZeroMae": baseline_mae},
            required=(
                "not applicable to ranking score"
                if objective_mode == "ranking"
                else "mae < baselineZeroMae"
            ),
            success="Il MAE è inferiore alla baseline a rendimento zero.",
            failure=(
                "MAE e baseline devono essere finiti e il MAE deve essere "
                "strettamente inferiore a baselineZeroMae."
            ),
        )
    )

    rank_ic = _finite_number(performance.get("crossSectionalRankIcMean"))
    checks.append(
        _check(
            "positive_cross_sectional_rank_ic",
            rank_ic is not None and rank_ic > 0.0,
            observed=rank_ic,
            required="> 0",
            success="Il Rank IC cross-sectional medio è positivo.",
            failure=(
                "crossSectionalRankIcMean deve essere finito e strettamente positivo."
            ),
        )
    )

    if objective_mode == "ranking":
        ndcg_lift = _finite_number(
            performance.get("crossSectionalNdcgAt20PctLiftVsRandom")
        )
        checks.append(
            _check(
                "positive_cross_sectional_ndcg_lift",
                ndcg_lift is not None and ndcg_lift > 0.0,
                observed=ndcg_lift,
                required="> 0 vs random ranking",
                success="L'NDCG top-20% supera il ranking casuale sull'holdout.",
                failure=(
                    "Un ranker richiede crossSectionalNdcgAt20PctLiftVsRandom "
                    "finito e strettamente positivo."
                ),
            )
        )

    coverage = _finite_number(performance.get("interval80Coverage"))
    coverage_valid = (
        objective_mode == "ranking"
        or (
            coverage is not None
            and INTERVAL_80_MIN_COVERAGE <= coverage <= INTERVAL_80_MAX_COVERAGE
        )
    )
    checks.append(
        _check(
            "interval_80_coverage",
            coverage_valid,
            observed=coverage,
            required=(
                "not applicable to uncalibrated ranking score"
                if objective_mode == "ranking"
                else {
                    "minimumInclusive": INTERVAL_80_MIN_COVERAGE,
                    "maximumInclusive": INTERVAL_80_MAX_COVERAGE,
                }
            ),
            success="La copertura empirica dell'intervallo 80% è calibrata.",
            failure=(
                "interval80Coverage deve essere finita e compresa tra 0.75 e 0.90."
            ),
        )
    )

    runtime = _runtime_availability(model)
    runtime_available = runtime.get("available") is True
    checks.append(
        _check(
            "runtime_algorithm_available",
            runtime_available,
            observed=runtime,
            required=True,
            success=f"Il runtime può caricare l'algoritmo {algorithm}.",
            failure=(
                "modelType è assente, non supportato o la relativa dipendenza "
                "non è disponibile nel runtime."
            ),
        )
    )

    ensemble_audit = _ensemble_oof_audit(model)
    if ensemble_audit is not None:
        ensemble_oof_valid = bool(
            ensemble_audit
            and ensemble_audit.get("oofOnly") is True
            and ensemble_audit.get("metaLearnerFitPartition")
            == "developmentOOFOnly"
            and ensemble_audit.get("holdoutUsedForFit") is False
            and ensemble_audit.get("holdoutUsedForSelection") is False
            and ensemble_audit.get("developmentHoldoutRowOverlap") == 0
            and ensemble_audit.get("datesStrictlySeparated") is True
            and ensemble_audit.get("allMemberFoldsPurged") is True
        )
        checks.append(
            _check(
                "ensemble_development_oof_only",
                ensemble_oof_valid,
                observed=(
                    {
                        key: ensemble_audit.get(key)
                        for key in (
                            "oofOnly",
                            "metaLearnerFitPartition",
                            "holdoutUsedForFit",
                            "holdoutUsedForSelection",
                            "developmentHoldoutRowOverlap",
                            "datesStrictlySeparated",
                            "allMemberFoldsPurged",
                            "developmentRows",
                            "holdoutRows",
                        )
                    }
                    if ensemble_audit
                    else None
                ),
                required=(
                    "development walk-forward OOF only; zero holdout overlap"
                ),
                success="Lo stacking usa esclusivamente OOF temporale del development.",
                failure=(
                    "Audit ensemble incompleto o indica contaminazione di holdout/in-sample."
                ),
            )
        )

    explicit_promotion = model.get("promotionDecision")
    if explicit_promotion is not None:
        checks.append(
            _check(
                "explicit_horizon_promotion_decision",
                explicit_promotion == "promote",
                observed=explicit_promotion,
                required="promote",
                success="Il piano indipendente promuove questo orizzonte.",
                failure="Il piano indipendente non autorizza questo orizzonte.",
            )
        )

    failures = [check["reason"] for check in checks if not check["passed"]]
    return {
        "decision": "promote" if not failures else "reject",
        "algorithm": algorithm or None,
        "objectiveMode": objective_mode,
        "checks": checks,
        "reasons": failures or ["Tutti i gate obbligatori sono superati."],
        "diagnostics": {
            "bootstrapCi95": _diagnostic(
                performance.get("blockBootstrap95"),
                missing_reason=(
                    "blockBootstrap95 mancante; nessun esito viene inferito."
                ),
            ),
            "nonOverlappingRobustness": _diagnostic(
                performance.get("nonOverlappingRobustness"),
                missing_reason=(
                    "nonOverlappingRobustness mancante; nessun esito viene inferito."
                ),
            ),
        },
    }


def audit_candidate_artifact(
    artifact: Mapping[str, Any],
    required_horizons: Sequence[str] = ("1m", "3m", "1y"),
) -> Dict[str, Any]:
    """Valuta un artifact candidato senza confrontarlo con modelli alternativi."""

    normalized_horizons = tuple(str(value).strip() for value in required_horizons)
    if not normalized_horizons or any(not value for value in normalized_horizons):
        raise ValueError("required_horizons deve contenere almeno un orizzonte valido.")

    candidate = artifact if isinstance(artifact, Mapping) else {}
    validation_version = candidate.get("validationVersion")
    validation_version_valid = validation_version in KNOWN_V4_VALIDATION_VERSIONS
    models = candidate.get("models")
    models = models if isinstance(models, Mapping) else {}
    horizon_results = {
        horizon: _audit_horizon(
            horizon,
            models.get(horizon),
            validation_version=validation_version,
            validation_version_valid=validation_version_valid,
        )
        for horizon in normalized_horizons
    }
    rejected = [
        horizon
        for horizon, result in horizon_results.items()
        if result["decision"] == "reject"
    ]
    decision = "reject" if rejected else "promote"
    return {
        "decision": decision,
        "eligible": decision == "promote",
        "policy": {
            "requiredHorizons": list(normalized_horizons),
            "acceptedValidationVersions": list(KNOWN_V4_VALIDATION_VERSIONS),
            "interval80CoverageRangeInclusive": [
                INTERVAL_80_MIN_COVERAGE,
                INTERVAL_80_MAX_COVERAGE,
            ],
            "candidateOnly": True,
            "mutatesFiles": False,
            "bootstrapCiAndNonOverlap": "diagnostic-only",
        },
        "artifact": {
            "modelVersion": candidate.get("modelVersion"),
            "validationVersion": validation_version,
            "generatedAt": candidate.get("generatedAt"),
        },
        "horizons": horizon_results,
        "reasons": (
            [f"Gate non superati per: {', '.join(rejected)}."]
            if rejected
            else ["Tutti gli orizzonti richiesti superano i gate di promozione."]
        ),
    }


def _cli_rejection(reason: str, path: str) -> Dict[str, Any]:
    return {
        "decision": "reject",
        "eligible": False,
        "artifact": {"path": path},
        "horizons": {},
        "reasons": [reason],
    }


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Audit read-only di un artifact ML candidato.",
    )
    parser.add_argument("artifact", help="Percorso dell'artifact JSON candidato.")
    args = parser.parse_args(argv)
    path = Path(args.artifact)
    try:
        with path.open("r", encoding="utf-8") as handle:
            artifact = json.load(handle)
        result = audit_candidate_artifact(artifact)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        result = _cli_rejection(
            f"Artifact non auditabile: {exc}",
            str(path),
        )
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2, allow_nan=False)
    sys.stdout.write("\n")
    return 0 if result.get("decision") == "promote" else 2


if __name__ == "__main__":  # pragma: no cover - verificato via subprocess.
    raise SystemExit(main())
