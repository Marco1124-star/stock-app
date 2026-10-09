"""Costruzione di filing vintage e campioni mensili senza look-ahead.

Il percorso storico resta annuale per default.  La modalita trimestrale e
esplicita e ricostruisce i flussi TTM soltanto da accession gia pubblicati:
ultimo 10-K + YTD corrente - YTD comparabile dell'anno precedente.
"""

from __future__ import annotations

from datetime import datetime, timezone
import math
import re
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

from .fundamental_model import HORIZONS, build_feature_vector


ANNUAL_FORMS = {"10-K"}
QUARTERLY_FORMS = {"10-Q"}
SUPPORTED_ORIGINAL_FORMS = ANNUAL_FORMS | QUARTERLY_FORMS
ACCESSION_PATTERN = re.compile(r"^\d{10}-\d{2}-\d{6}$")

CONCEPTS: Dict[str, Tuple[str, ...]] = {
    "revenue": (
        "RevenueFromContractWithCustomerExcludingAssessedTax",
        "Revenues",
        "SalesRevenueNet",
    ),
    "cost_of_revenue": (
        "CostOfRevenue",
        "CostOfGoodsAndServicesSold",
        "CostOfGoodsSold",
    ),
    "gross_profit": ("GrossProfit",),
    "operating_income": ("OperatingIncomeLoss",),
    "net_income": (
        "NetIncomeLossAvailableToCommonStockholdersBasic",
        "NetIncomeLoss",
        "ProfitLoss",
    ),
    "interest_expense": (
        "InterestExpenseNonOperating",
        "InterestExpense",
    ),
    "research_and_development": (
        "ResearchAndDevelopmentExpense",
        "ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost",
    ),
    "assets": ("Assets",),
    "current_assets": ("AssetsCurrent",),
    "cash": (
        "CashCashEquivalentsAndShortTermInvestments",
        "CashAndCashEquivalentsAtCarryingValue",
        "Cash",
    ),
    "receivables": (
        "AccountsReceivableNetCurrent",
        "AccountsNotesAndLoansReceivableNetCurrent",
    ),
    "inventory": ("InventoryNet",),
    "liabilities": ("Liabilities",),
    "current_liabilities": ("LiabilitiesCurrent",),
    "accounts_payable": (
        "AccountsPayableCurrent",
        "AccountsPayableAndAccruedLiabilitiesCurrent",
    ),
    "current_debt": (
        "LongTermDebtCurrent",
        "ShortTermBorrowings",
        "ShortTermDebtCurrent",
        "LongTermDebtAndFinanceLeaseObligationsCurrent",
    ),
    "long_term_debt": (
        "LongTermDebtNoncurrent",
        "LongTermDebtAndFinanceLeaseObligationsNoncurrent",
    ),
    "total_debt": (
        "LongTermDebtAndFinanceLeaseObligations",
        "LongTermDebtAndCapitalLeaseObligations",
    ),
    "equity": (
        "StockholdersEquity",
        "CommonStockholdersEquity",
    ),
    "shares_outstanding": ("CommonStockSharesOutstanding",),
    "basic_average_shares": ("WeightedAverageNumberOfSharesOutstandingBasic",),
    "diluted_average_shares": (
        "WeightedAverageNumberOfDilutedSharesOutstanding",
    ),
    "operating_cash_flow": ("NetCashProvidedByUsedInOperatingActivities",),
    "capital_expenditure": (
        "PaymentsToAcquirePropertyPlantAndEquipment",
        "PaymentsToAcquireProductiveAssets",
    ),
    "dividends": (
        "PaymentsOfDividends",
        "PaymentsOfDividendsCommonStock",
    ),
    "buybacks": (
        "PaymentsForRepurchaseOfCommonStock",
        "PaymentsForRepurchaseOfEquity",
    ),
    "depreciation": (
        "DepreciationDepletionAndAmortization",
        "DepreciationDepletionAndAmortizationPropertyPlantAndEquipment",
    ),
}

INSTANT_METRICS = {
    "assets",
    "current_assets",
    "cash",
    "receivables",
    "inventory",
    "liabilities",
    "current_liabilities",
    "accounts_payable",
    "current_debt",
    "long_term_debt",
    "total_debt",
    "equity",
    "shares_outstanding",
}
SHARE_METRICS = {
    "shares_outstanding",
    "basic_average_shares",
    "diluted_average_shares",
}
NEGATIVE_OUTFLOW_METRICS = {
    "capital_expenditure",
    "dividends",
    "buybacks",
}
DURATION_METRICS = set(CONCEPTS) - INSTANT_METRICS
TARGET_KINDS = {
    "raw",
    "excess",
    "market-relative",
    "sector-relative",
    "market-sector-neutral",
}
TARGET_BENCHMARKS = {
    "excess": "excess",
    "market-relative": "market",
    "sector-relative": "sector",
}

# Queste feature sono separate da FEATURE_NAMES per non cambiare il contratto
# degli artifact v4. Il trainer v5 puo abilitarle esplicitamente e scegliere
# per quali orizzonti usarle. Tutte sono calcolate esclusivamente con dati il
# cui timestamp e minore o uguale allo snapshot.
V5_MARKET_FEATURE_NAMES: Tuple[str, ...] = (
    "momentum_1d",
    "momentum_5d",
    "momentum_20d",
    "momentum_60d",
    "realized_volatility_20d",
    "realized_volatility_60d",
    "log_average_dollar_volume_20d",
    "turnover_20d",
    "amihud_illiquidity_20d",
    "volume_ratio_20d_60d",
    "market_beta_60d",
    "market_correlation_60d",
    "days_since_earnings",
    "days_to_earnings",
    "earnings_surprise_pct",
    "earnings_revision_30d_pct",
)
V5_MARKET_MISSING_FLAG_NAMES: Tuple[str, ...] = tuple(
    f"is_missing_{name}" for name in V5_MARKET_FEATURE_NAMES
)
V5_CATEGORICAL_FEATURE_NAMES: Tuple[str, ...] = (
    "security_sector",
    "security_sic",
    "security_industry",
    "security_exchange",
    "security_type",
)


def _as_date(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        text = str(value).strip()
        if not text:
            return None
        normalized = text.replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(normalized)
        except ValueError:
            try:
                parsed = datetime.strptime(text[:10], "%Y-%m-%d")
            except ValueError:
                return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def _finite(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _normal_accession(value: Any) -> str:
    text = str(value or "").strip()
    return text if ACCESSION_PATTERN.fullmatch(text) else ""


def _rows_from_columnar(payload: Mapping[str, Any]) -> Iterable[Dict[str, Any]]:
    recent = payload.get("recent") if isinstance(payload.get("recent"), dict) else payload
    accessions = recent.get("accessionNumber") if isinstance(recent, dict) else None
    if not isinstance(accessions, list):
        return []
    keys = (
        "accessionNumber",
        "filingDate",
        "reportDate",
        "acceptanceDateTime",
        "form",
        "primaryDocument",
    )
    output = []
    for index in range(len(accessions)):
        row = {}
        for key in keys:
            values = recent.get(key)
            row[key] = values[index] if isinstance(values, list) and index < len(values) else None
        output.append(row)
    return output


def build_filing_index(
    submissions_payload: Mapping[str, Any],
    historical_payloads: Optional[Sequence[Mapping[str, Any]]] = None,
    *,
    include_quarterly: bool = False,
) -> Dict[str, Dict[str, Any]]:
    """Indicizza filing originali con data di accettazione nota.

    ``include_quarterly=False`` conserva esattamente il contratto storico:
    vengono inclusi soltanto i 10-K e sono sempre escluse le amendment.
    """

    sources: List[Mapping[str, Any]] = []
    filings = submissions_payload.get("filings")
    if isinstance(filings, dict) and isinstance(filings.get("recent"), dict):
        sources.append({"recent": filings["recent"]})
    elif isinstance(submissions_payload.get("recent"), dict):
        sources.append(submissions_payload)
    sources.extend(
        payload
        for payload in (historical_payloads or [])
        if isinstance(payload, dict)
    )

    allowed_forms = ANNUAL_FORMS | (QUARTERLY_FORMS if include_quarterly else set())
    index: Dict[str, Dict[str, Any]] = {}
    for source in sources:
        for row in _rows_from_columnar(source):
            accession = _normal_accession(row.get("accessionNumber"))
            form = str(row.get("form") or "").strip().upper()
            accepted_at = _as_date(row.get("acceptanceDateTime"))
            filing_date = _as_date(row.get("filingDate"))
            report_date = _as_date(row.get("reportDate"))
            if (
                not accession
                or form not in allowed_forms
                or report_date is None
            ):
                continue
            # I file storici SEC non sempre includono acceptanceDateTime.
            # La filingDate, a mezzanotte successiva, è un fallback conservativo.
            accepted_fallback = False
            if accepted_at is None and filing_date is not None:
                accepted_at = filing_date.replace(hour=23, minute=59, second=59)
                accepted_fallback = True
            if accepted_at is None:
                continue
            index[accession] = {
                "accessionNumber": accession,
                "form": form,
                "filingFrequency": "quarterly" if form in QUARTERLY_FORMS else "annual",
                "acceptedAt": accepted_at,
                "acceptedAtIso": accepted_at.isoformat() + "Z",
                "acceptanceFallback": accepted_fallback,
                "filingDate": (
                    filing_date.date().isoformat() if filing_date else None
                ),
                "reportDate": report_date.date().isoformat(),
                "primaryDocument": row.get("primaryDocument") or None,
            }
    return index


def _preferred_entries(
    fact: Mapping[str, Any],
    metric: str,
) -> List[Mapping[str, Any]]:
    units = fact.get("units") if isinstance(fact, dict) else None
    if not isinstance(units, dict):
        return []
    if metric in SHARE_METRICS:
        unit_names = [
            key for key in units if str(key).lower().replace(" ", "") in {"shares", "share"}
        ]
    else:
        unit_names = ["USD"] if "USD" in units else [
            key for key in units if re.fullmatch(r"[A-Z]{3}", str(key))
        ]
    output = []
    for unit_name in unit_names:
        entries = units.get(unit_name)
        if isinstance(entries, list):
            for entry in entries:
                if isinstance(entry, dict):
                    output.append({**entry, "_unit": str(unit_name)})
    return output


def _select_entry(
    fact: Mapping[str, Any],
    metric: str,
    filing: Mapping[str, Any],
) -> Optional[Dict[str, Any]]:
    report_date = _as_date(filing.get("reportDate"))
    accession = filing.get("accessionNumber")
    if report_date is None or not accession:
        return None

    candidates = []
    for entry in _preferred_entries(fact, metric):
        if _normal_accession(entry.get("accn")) != accession:
            continue
        filing_form = str(filing.get("form") or "").strip().upper()
        if str(entry.get("form") or "").strip().upper() != filing_form:
            continue
        end_date = _as_date(entry.get("end"))
        if end_date is None or abs((end_date - report_date).days) > 45:
            continue
        start_date = _as_date(entry.get("start"))
        if metric not in INSTANT_METRICS:
            if start_date is None:
                continue
            span = (end_date - start_date).days
            if filing_form in ANNUAL_FORMS:
                if not 250 <= span <= 430:
                    continue
            elif filing_form in QUARTERLY_FORMS:
                # Per il TTM serve la misura YTD disponibile nel 10-Q.  Il
                # range ammette Q1, semestre e nove mesi, ma esclude annuali.
                if not 55 <= span <= 320:
                    continue
            else:
                continue
        value = _finite(entry.get("val"))
        if value is None:
            continue
        if metric in NEGATIVE_OUTFLOW_METRICS:
            value = -abs(value)
        candidates.append(
            {
                "value": value,
                "end": end_date,
                "distance": abs((end_date - report_date).days),
                "framePenalty": 0 if entry.get("frame") else 1,
                "unit": entry.get("_unit"),
                "start": start_date,
                "spanDays": (
                    (end_date - start_date).days if start_date is not None else None
                ),
                "fiscalYear": entry.get("fy"),
                "fiscalPeriod": entry.get("fp"),
            }
        )
    if not candidates:
        return None
    candidates.sort(
        key=lambda item: (
            item["distance"],
            # Nei 10-Q preferiamo il contesto YTD piu lungo rispetto al solo
            # trimestre, a parita di end date e accession.
            -(item.get("spanDays") or 0) if filing.get("form") == "10-Q" else 0,
            item["framePenalty"],
        )
    )
    return candidates[0]


def _unit_audit(metric_units: Mapping[str, str]) -> Dict[str, Any]:
    currencies = sorted(
        {
            str(unit).upper()
            for metric, unit in metric_units.items()
            if metric not in SHARE_METRICS
            and re.fullmatch(r"[A-Z]{3}", str(unit).upper())
        }
    )
    unexpected = sorted(
        metric
        for metric, unit in metric_units.items()
        if (
            metric in SHARE_METRICS
            and str(unit).lower().replace(" ", "") not in {"share", "shares"}
        )
        or (
            metric not in SHARE_METRICS
            and not re.fullmatch(r"[A-Z]{3}", str(unit).upper())
        )
    )
    if unexpected:
        status = "unexpected-unit"
    elif len(currencies) > 1:
        status = "mixed-currency"
    elif not currencies:
        status = "currency-missing"
    else:
        status = "ok"
    return {
        "status": status,
        "currency": currencies[0] if len(currencies) == 1 else None,
        "currencies": currencies,
        "mixedCurrency": len(currencies) > 1,
        "unexpectedUnitMetrics": unexpected,
        "currencyConversionApplied": False,
        "metricUnits": dict(metric_units),
    }


def _raw_filing_record(
    accession: str,
    filing: Mapping[str, Any],
    us_gaap: Mapping[str, Any],
) -> Dict[str, Any]:
    values: Dict[str, float] = {}
    concepts_used: Dict[str, str] = {}
    units_used: Dict[str, str] = {}
    periods: Dict[str, Dict[str, Any]] = {}
    for metric, concept_names in CONCEPTS.items():
        for concept_name in concept_names:
            fact = us_gaap.get(concept_name)
            selected = (
                _select_entry(fact, metric, filing) if isinstance(fact, dict) else None
            )
            if selected is None:
                continue
            values[metric] = selected["value"]
            concepts_used[metric] = concept_name
            units_used[metric] = str(selected.get("unit") or "")
            periods[metric] = {
                "start": (
                    selected["start"].date().isoformat()
                    if isinstance(selected.get("start"), datetime)
                    else None
                ),
                "end": selected["end"].date().isoformat(),
                "spanDays": selected.get("spanDays"),
                "fiscalYear": selected.get("fiscalYear"),
                "fiscalPeriod": selected.get("fiscalPeriod"),
            }
            break
    return {
        **dict(filing),
        "accessionNumber": accession,
        "reportedMetrics": values,
        "reportedMetricPeriods": periods,
        "conceptsUsed": concepts_used,
        "unitAudit": _unit_audit(units_used),
    }


def _report_datetime(vintage: Mapping[str, Any]) -> Optional[datetime]:
    return _as_date(vintage.get("reportDate"))


def _latest_prior_annual(
    records: Sequence[Mapping[str, Any]],
    current: Mapping[str, Any],
) -> Optional[Mapping[str, Any]]:
    current_report = _report_datetime(current)
    eligible = [
        item
        for item in records
        if item.get("form") in ANNUAL_FORMS
        and isinstance(item.get("acceptedAt"), datetime)
        and item["acceptedAt"] < current["acceptedAt"]
        and _report_datetime(item) is not None
        and (current_report is None or _report_datetime(item) < current_report)
        and (
            current_report is None
            or 45 <= (current_report - _report_datetime(item)).days <= 400
        )
    ]
    return max(eligible, key=lambda item: item["acceptedAt"]) if eligible else None


def _prior_comparable_quarter(
    records: Sequence[Mapping[str, Any]],
    current: Mapping[str, Any],
) -> Optional[Mapping[str, Any]]:
    current_report = _report_datetime(current)
    if current_report is None:
        return None
    candidates = []
    for item in records:
        report = _report_datetime(item)
        if (
            item.get("form") not in QUARTERLY_FORMS
            or report is None
            or item.get("acceptedAt") >= current.get("acceptedAt")
        ):
            continue
        annual_distance = abs((current_report - report).days - 365)
        if annual_distance <= 50:
            candidates.append((annual_distance, item))
    if not candidates:
        return None
    candidates.sort(key=lambda pair: (pair[0], -pair[1]["acceptedAt"].timestamp()))
    return candidates[0][1]


def _ttm_value(
    metric: str,
    annual: Mapping[str, Any],
    current: Mapping[str, Any],
    comparable: Mapping[str, Any],
) -> Optional[float]:
    annual_value = _finite((annual.get("reportedMetrics") or {}).get(metric))
    current_value = _finite((current.get("reportedMetrics") or {}).get(metric))
    comparable_value = _finite((comparable.get("reportedMetrics") or {}).get(metric))
    if annual_value is None or current_value is None or comparable_value is None:
        return None

    periods = [
        (record.get("reportedMetricPeriods") or {}).get(metric) or {}
        for record in (annual, current, comparable)
    ]
    annual_span, current_span, comparable_span = [
        _finite(period.get("spanDays")) for period in periods
    ]
    if current_span is None or comparable_span is None:
        return None
    if abs(current_span - comparable_span) > 50:
        return None

    units = [
        (record.get("unitAudit") or {}).get("metricUnits", {}).get(metric)
        for record in (annual, current, comparable)
    ]
    if not units[0] or len(set(units)) != 1:
        return None

    if metric in {"basic_average_shares", "diluted_average_shares"}:
        if annual_span is None:
            return None
        denominator = annual_span + current_span - comparable_span
        if denominator <= 0:
            return None
        return (
            annual_value * annual_span
            + current_value * current_span
            - comparable_value * comparable_span
        ) / denominator
    return annual_value + current_value - comparable_value


def extract_filing_vintages(
    companyfacts_payload: Mapping[str, Any],
    filing_index: Mapping[str, Mapping[str, Any]],
    *,
    include_quarterly: bool = False,
) -> List[Dict[str, Any]]:
    """Estrae vintage annuali e, opzionalmente, trimestrali point-in-time.

    Tutti i valori riportati provengono dall'accession del filing corrente.
    Per un 10-Q i flussi esposti in ``metrics`` sono TTM; se i tre componenti
    point-in-time non sono disponibili il singolo flusso resta mancante.
    """

    facts_root = companyfacts_payload.get("facts")
    us_gaap = facts_root.get("us-gaap") if isinstance(facts_root, dict) else None
    if not isinstance(us_gaap, dict):
        return []

    allowed = ANNUAL_FORMS | (QUARTERLY_FORMS if include_quarterly else set())
    raw_records = [
        _raw_filing_record(accession, filing, us_gaap)
        for accession, filing in filing_index.items()
        if filing.get("form") in allowed
    ]
    raw_records.sort(key=lambda item: item["acceptedAt"])

    output: List[Dict[str, Any]] = []
    for record in raw_records:
        reported = dict(record.get("reportedMetrics") or {})
        metrics: Dict[str, float] = {
            metric: value
            for metric, value in reported.items()
            if metric in INSTANT_METRICS
        }
        ttm_methods: Dict[str, str] = {}
        annual_base = None
        comparable = None
        if record.get("form") in ANNUAL_FORMS:
            metrics.update(reported)
            for metric in DURATION_METRICS & reported.keys():
                ttm_methods[metric] = "reported-annual"
        else:
            annual_base = _latest_prior_annual(raw_records, record)
            comparable = _prior_comparable_quarter(raw_records, record)
            if annual_base is not None and comparable is not None:
                for metric in DURATION_METRICS:
                    value = _ttm_value(metric, annual_base, record, comparable)
                    if value is not None:
                        metrics[metric] = value
                        ttm_methods[metric] = "annual-plus-current-ytd-minus-prior-ytd"

        if not metrics.get("revenue") or not metrics.get("assets"):
            continue
        missing_metrics = sorted(set(CONCEPTS) - set(metrics))
        ttm_available = len(DURATION_METRICS & metrics.keys())
        output.append(
            {
                **record,
                "metrics": metrics,
                "metricCoverage": len(metrics) / max(1, len(CONCEPTS)),
                "missingMetrics": missing_metrics,
                "missingMetricCount": len(missing_metrics),
                "ttm": {
                    "required": record.get("form") in QUARTERLY_FORMS,
                    "method": (
                        "reported-annual"
                        if record.get("form") in ANNUAL_FORMS
                        else "annual-plus-current-ytd-minus-prior-ytd"
                    ),
                    "availableMetrics": ttm_available,
                    "totalDurationMetrics": len(DURATION_METRICS),
                    "coverage": ttm_available / max(1, len(DURATION_METRICS)),
                    "methods": ttm_methods,
                    "annualBaseAccession": (
                        annual_base.get("accessionNumber") if annual_base else None
                    ),
                    "comparableQuarterAccession": (
                        comparable.get("accessionNumber") if comparable else None
                    ),
                    "usesFutureFiling": False,
                    "restatementPolicy": "exact-original-accession-only",
                },
            }
        )
    output.sort(key=lambda item: item["acceptedAt"])
    return output


def extract_annual_vintages(
    companyfacts_payload: Mapping[str, Any],
    filing_index: Mapping[str, Mapping[str, Any]],
) -> List[Dict[str, Any]]:
    """Compatibilita: estrae soltanto 10-K originali point-in-time."""

    return extract_filing_vintages(
        companyfacts_payload,
        filing_index,
        include_quarterly=False,
    )


def latest_usable_vintage(
    vintages: Sequence[Mapping[str, Any]],
    as_of: Optional[datetime] = None,
) -> Tuple[Optional[Mapping[str, Any]], Optional[Mapping[str, Any]]]:
    as_of = as_of or datetime.utcnow()
    eligible = [
        vintage
        for vintage in vintages
        if isinstance(vintage.get("acceptedAt"), datetime)
        and vintage["acceptedAt"] <= as_of
    ]
    if not eligible:
        return None, None
    eligible.sort(key=lambda item: item["acceptedAt"])
    current = eligible[-1]
    previous = _previous_comparable_vintage(eligible, current)
    return current, previous


def _normalized_price_frame(prices: pd.DataFrame) -> pd.DataFrame:
    if not isinstance(prices, pd.DataFrame) or prices.empty:
        return pd.DataFrame(columns=["raw", "adjusted", "stock_splits", "volume"])
    raw_source = prices.get("Close")
    if raw_source is None:
        return pd.DataFrame(columns=["raw", "adjusted", "stock_splits", "volume"])
    raw = pd.to_numeric(raw_source, errors="coerce")
    adjusted_source = prices.get("Adj Close")
    if adjusted_source is None:
        adjusted_source = prices.get("Close")
    adjusted = pd.to_numeric(adjusted_source, errors="coerce")
    valid_index = raw.index.intersection(adjusted.index)
    raw = raw.reindex(valid_index)
    adjusted = adjusted.reindex(valid_index)
    valid = raw.notna() & adjusted.notna() & (raw > 0) & (adjusted > 0)
    splits_source = prices.get("Stock Splits")
    if splits_source is None:
        splits = pd.Series(0.0, index=valid_index, dtype=float)
    else:
        splits = pd.to_numeric(splits_source, errors="coerce").fillna(0.0)
        splits = splits.reindex(valid_index).fillna(0.0)
    volume_source = prices.get("Volume")
    if volume_source is None:
        volume = pd.Series(np.nan, index=valid_index, dtype=float)
    else:
        volume = pd.to_numeric(volume_source, errors="coerce")
        volume = volume.reindex(valid_index)
        volume = volume.where(volume >= 0)
    frame = pd.DataFrame(
        {
            "raw": raw[valid],
            "adjusted": adjusted[valid],
            "stock_splits": splits[valid],
            "volume": volume[valid],
        }
    ).sort_index()
    frame.index = pd.to_datetime(frame.index)
    if getattr(frame.index, "tz", None) is not None:
        frame.index = frame.index.tz_convert(None)
    return frame


def _price_columns(prices: pd.DataFrame) -> Tuple[pd.Series, pd.Series]:
    frame = _normalized_price_frame(prices)
    if frame.empty:
        return pd.Series(dtype=float), pd.Series(dtype=float)
    return frame["raw"], frame["adjusted"]


def _benchmark_return(
    adjusted: pd.Series,
    start: pd.Timestamp,
    end: pd.Timestamp,
) -> Tuple[Optional[float], Optional[str], Optional[str]]:
    if adjusted.empty:
        return None, None, None
    eligible_start = adjusted.loc[:start]
    eligible_end = adjusted.loc[:end]
    if eligible_start.empty or eligible_end.empty:
        return None, None, None
    start_date = eligible_start.index[-1]
    end_date = eligible_end.index[-1]
    if (
        (pd.Timestamp(start) - pd.Timestamp(start_date)).days > 7
        or (pd.Timestamp(end) - pd.Timestamp(end_date)).days > 7
    ):
        return None, None, None
    start_value = _finite(eligible_start.iloc[-1])
    end_value = _finite(eligible_end.iloc[-1])
    if start_value is None or end_value is None or start_value <= 0 or end_value <= 0:
        return None, None, None
    return (
        (end_value / start_value) - 1.0,
        pd.Timestamp(start_date).date().isoformat(),
        pd.Timestamp(end_date).date().isoformat(),
    )


def _previous_comparable_vintage(
    eligible: Sequence[Mapping[str, Any]],
    current: Mapping[str, Any],
) -> Optional[Mapping[str, Any]]:
    if len(eligible) < 2:
        return None
    has_quarterly = any(
        vintage.get("form") in QUARTERLY_FORMS for vintage in eligible
    )
    if not has_quarterly:
        return eligible[-2]
    current_report = _report_datetime(current)
    if current_report is None:
        return eligible[-2]
    candidates = []
    for vintage in eligible[:-1]:
        report = _report_datetime(vintage)
        if report is None:
            continue
        lag = (current_report - report).days
        if 315 <= lag <= 415:
            candidates.append((abs(lag - 365), vintage))
    if not candidates:
        return eligible[-2]
    candidates.sort(key=lambda pair: pair[0])
    return candidates[0][1]


def resolve_security_point_in_time(
    security_timeline: Sequence[Mapping[str, Any]],
    as_of: Any,
) -> Optional[Dict[str, Any]]:
    """Restituisce la sola riga del security master valida a ``as_of``.

    Gli intervalli sono inclusivi. In caso di dati non validati con piu righe
    eleggibili viene scelta quella con ``valid_from`` piu recente; il loader del
    trainer v5 rifiuta comunque gli overlap prima di arrivare qui.
    """

    timestamp = _as_date(as_of)
    if timestamp is None:
        return None
    eligible: List[Tuple[datetime, Dict[str, Any]]] = []
    for raw in security_timeline or []:
        if not isinstance(raw, Mapping):
            continue
        valid_from = _as_date(raw.get("valid_from"))
        valid_to = _as_date(raw.get("valid_to") or raw.get("delist_date"))
        if valid_from is not None and timestamp.date() < valid_from.date():
            continue
        if valid_to is not None and timestamp.date() > valid_to.date():
            continue
        eligible.append((valid_from or datetime.min, dict(raw)))
    if not eligible:
        return None
    eligible.sort(key=lambda pair: pair[0])
    return eligible[-1][1]


def _record_datetime(
    record: Mapping[str, Any],
    names: Sequence[str],
) -> Optional[datetime]:
    for name in names:
        parsed = _as_date(record.get(name))
        if parsed is not None:
            return parsed
    return None


def _record_number(
    record: Mapping[str, Any],
    names: Sequence[str],
) -> Optional[float]:
    for name in names:
        value = _finite(record.get(name))
        if value is not None:
            return value
    return None


def build_market_event_features(
    price_frame: pd.DataFrame,
    snapshot_date: Any,
    market_frame: Optional[pd.DataFrame] = None,
    shares_outstanding: Optional[float] = None,
    earnings_events: Optional[Sequence[Mapping[str, Any]]] = None,
    estimate_revisions: Optional[Sequence[Mapping[str, Any]]] = None,
) -> Dict[str, Any]:
    """Costruisce feature market/event rigorosamente point-in-time.

    ``days_to_earnings`` richiede sempre ``announced_at``/``as_of`` non
    successivo allo snapshot. Surprise e revisioni richiedono analogamente un
    timestamp di pubblicazione. I record privi di timestamp non vengono
    retrodatati: la relativa feature resta mancante.
    """

    snapshot = _as_date(snapshot_date)
    values: Dict[str, Optional[float]] = {
        name: None for name in V5_MARKET_FEATURE_NAMES
    }
    if snapshot is None:
        return {
            **values,
            **{f"is_missing_{name}": 1.0 for name in V5_MARKET_FEATURE_NAMES},
            "market_feature_cutoff_date": None,
            "earnings_feature_cutoff_at": None,
            "feature_source_max_timestamp": None,
            "feature_lookahead_detected": False,
            "future_source_records_rejected": 0,
        }

    frame = _normalized_price_frame(price_frame)
    history = frame.loc[frame.index <= pd.Timestamp(snapshot)].copy()
    source_cutoffs: List[datetime] = []
    market_cutoff: Optional[datetime] = None
    if not history.empty:
        market_cutoff = pd.Timestamp(history.index[-1]).to_pydatetime()
        source_cutoffs.append(market_cutoff)
        adjusted = history["adjusted"].astype(float)
        simple_returns = adjusted.pct_change()
        log_returns = np.log(adjusted).diff()

        for sessions in (1, 5, 20, 60):
            if len(adjusted) > sessions:
                start = _finite(adjusted.iloc[-sessions - 1])
                end = _finite(adjusted.iloc[-1])
                if start is not None and end is not None and start > 0:
                    values[f"momentum_{sessions}d"] = (end / start) - 1.0

        for sessions in (20, 60):
            window = log_returns.dropna().tail(sessions)
            minimum = max(10, int(math.ceil(sessions * 0.75)))
            if len(window) >= minimum:
                volatility = float(window.std(ddof=1) * math.sqrt(252.0))
                values[f"realized_volatility_{sessions}d"] = (
                    volatility if math.isfinite(volatility) else None
                )

        recent_20 = history.tail(20)
        recent_60 = history.tail(60)
        dollar_volume_20 = (
            recent_20["raw"].astype(float)
            * pd.to_numeric(recent_20["volume"], errors="coerce")
        ).replace([np.inf, -np.inf], np.nan).dropna()
        volume_20 = pd.to_numeric(recent_20["volume"], errors="coerce").dropna()
        volume_60 = pd.to_numeric(recent_60["volume"], errors="coerce").dropna()
        if len(dollar_volume_20) >= 10 and float(dollar_volume_20.mean()) > 0:
            values["log_average_dollar_volume_20d"] = math.log1p(
                float(dollar_volume_20.mean())
            )
            aligned_returns = simple_returns.reindex(dollar_volume_20.index).abs()
            ratios = (aligned_returns / dollar_volume_20).replace(
                [np.inf, -np.inf], np.nan
            ).dropna()
            if len(ratios) >= 10:
                # Il fattore 1e6 rende il numero leggibile senza alterare
                # ordinamento o informazione della misura di Amihud.
                values["amihud_illiquidity_20d"] = float(ratios.mean() * 1e6)
        shares = _finite(shares_outstanding)
        if len(volume_20) >= 10 and shares is not None and shares > 0:
            values["turnover_20d"] = float(volume_20.mean() / shares)
        if len(volume_20) >= 10 and len(volume_60) >= 30:
            denominator = float(volume_60.mean())
            if denominator > 0:
                values["volume_ratio_20d_60d"] = float(volume_20.mean()) / denominator

        market_source = market_frame if isinstance(market_frame, pd.DataFrame) else pd.DataFrame()
        market = _normalized_price_frame(market_source)
        market_history = market.loc[market.index <= pd.Timestamp(snapshot)]
        if not market_history.empty:
            market_source_cutoff = pd.Timestamp(market_history.index[-1]).to_pydatetime()
            source_cutoffs.append(market_source_cutoff)
            stock_returns = history["adjusted"].astype(float).pct_change().rename("stock")
            market_returns = (
                market_history["adjusted"].astype(float).pct_change().rename("market")
            )
            aligned = pd.concat([stock_returns, market_returns], axis=1).dropna().tail(60)
            if len(aligned) >= 40:
                market_variance = float(aligned["market"].var(ddof=1))
                if math.isfinite(market_variance) and market_variance > 1e-16:
                    covariance = float(aligned["stock"].cov(aligned["market"]))
                    beta = covariance / market_variance
                    if math.isfinite(beta):
                        values["market_beta_60d"] = beta
                correlation = float(aligned["stock"].corr(aligned["market"]))
                if math.isfinite(correlation):
                    values["market_correlation_60d"] = correlation

    earnings_cutoffs: List[datetime] = []
    rejected_future = 0
    completed: List[Tuple[datetime, datetime, Mapping[str, Any]]] = []
    announced_upcoming: List[Tuple[datetime, datetime, Mapping[str, Any]]] = []
    for record in earnings_events or []:
        if not isinstance(record, Mapping):
            continue
        event_at = _record_datetime(
            record, ("event_date", "earnings_date", "date")
        )
        announced_at = _record_datetime(
            record, ("announced_at", "scheduled_at", "as_of")
        )
        published_at = _record_datetime(
            record, ("published_at", "available_at", "reported_at")
        )
        if event_at is None:
            continue
        if event_at <= snapshot:
            availability = published_at or event_at
            if availability <= snapshot:
                completed.append((event_at, availability, record))
            else:
                rejected_future += 1
        elif announced_at is not None:
            if announced_at <= snapshot:
                announced_upcoming.append((event_at, announced_at, record))
            else:
                rejected_future += 1

    if completed:
        completed.sort(key=lambda item: (item[0], item[1]))
        event_at, availability, record = completed[-1]
        values["days_since_earnings"] = float((snapshot.date() - event_at.date()).days)
        earnings_cutoffs.append(availability)
        # Una surprise e disponibile solo se il record dichiara quando e stata
        # pubblicata; event_date da solo non basta per questo valore.
        surprise_published = _record_datetime(
            record, ("published_at", "available_at", "reported_at")
        )
        if surprise_published is not None and surprise_published <= snapshot:
            surprise = _record_number(
                record, ("earnings_surprise_pct", "surprise_pct")
            )
            if surprise is None:
                actual = _record_number(record, ("actual_eps", "reported_eps"))
                estimate = _record_number(record, ("estimate_eps", "consensus_eps"))
                if actual is not None and estimate not in (None, 0.0):
                    surprise = (actual - estimate) / abs(estimate)
            values["earnings_surprise_pct"] = surprise
            earnings_cutoffs.append(surprise_published)
    if announced_upcoming:
        announced_upcoming.sort(key=lambda item: (item[0], item[1]))
        event_at, announced_at, _ = announced_upcoming[0]
        values["days_to_earnings"] = float((event_at.date() - snapshot.date()).days)
        earnings_cutoffs.append(announced_at)

    eligible_revisions: List[Tuple[datetime, Mapping[str, Any]]] = []
    for record in estimate_revisions or []:
        if not isinstance(record, Mapping):
            continue
        published_at = _record_datetime(
            record, ("published_at", "available_at", "as_of")
        )
        if published_at is None:
            # Fail closed: una revisione senza data di pubblicazione non puo
            # essere resa point-in-time in modo dimostrabile.
            continue
        if published_at <= snapshot:
            eligible_revisions.append((published_at, record))
        else:
            rejected_future += 1
    if eligible_revisions:
        eligible_revisions.sort(key=lambda item: item[0])
        revision_at, revision = eligible_revisions[-1]
        values["earnings_revision_30d_pct"] = _record_number(
            revision,
            (
                "earnings_revision_30d_pct",
                "revision_30d_pct",
                "revision_pct",
            ),
        )
        earnings_cutoffs.append(revision_at)

    for name in V5_MARKET_FEATURE_NAMES:
        value = _finite(values.get(name))
        values[name] = value
    max_earnings_cutoff = max(earnings_cutoffs) if earnings_cutoffs else None
    source_cutoffs.extend(earnings_cutoffs)
    source_max = max(source_cutoffs) if source_cutoffs else None
    lookahead = bool(source_max is not None and source_max > snapshot)
    return {
        **values,
        **{
            f"is_missing_{name}": 1.0 if values.get(name) is None else 0.0
            for name in V5_MARKET_FEATURE_NAMES
        },
        "market_feature_cutoff_date": (
            market_cutoff.date().isoformat() if market_cutoff is not None else None
        ),
        "earnings_feature_cutoff_at": (
            max_earnings_cutoff.isoformat() + "Z"
            if max_earnings_cutoff is not None
            else None
        ),
        "feature_source_max_timestamp": (
            source_max.isoformat() + "Z" if source_max is not None else None
        ),
        "feature_lookahead_detected": lookahead,
        "future_source_records_rejected": int(rejected_future),
    }


def audit_market_feature_leakage(
    rows: Sequence[Mapping[str, Any]],
) -> Dict[str, Any]:
    """Audit deterministico dei cutoff delle feature v5."""

    violations: List[Dict[str, Any]] = []
    explicitly_flagged = 0
    for position, row in enumerate(rows):
        snapshot = _as_date(row.get("snapshot_date"))
        cutoff = _as_date(row.get("feature_source_max_timestamp"))
        flagged = bool(row.get("feature_lookahead_detected"))
        explicitly_flagged += int(flagged)
        if snapshot is not None and cutoff is not None and cutoff > snapshot:
            violations.append(
                {
                    "row": position,
                    "ticker": row.get("ticker"),
                    "snapshotDate": snapshot.date().isoformat(),
                    "sourceMaxTimestamp": cutoff.isoformat() + "Z",
                }
            )
    return {
        "rows": len(rows),
        "lookaheadViolations": len(violations),
        "explicitLookaheadFlags": explicitly_flagged,
        "passed": len(violations) == 0 and explicitly_flagged == 0,
        "examples": violations[:10],
        "policy": "all feature source timestamps must be <= snapshot_date",
    }


def build_monthly_samples(
    ticker: str,
    vintages: Sequence[Mapping[str, Any]],
    prices: pd.DataFrame,
    *,
    minimum_feature_coverage: float = 0.35,
    benchmark_prices: Optional[Mapping[str, pd.DataFrame]] = None,
    benchmark_symbols: Optional[Mapping[str, str]] = None,
    target_kind: str = "raw",
    max_filing_age_days: Optional[int] = None,
    security_timeline: Optional[Sequence[Mapping[str, Any]]] = None,
    sector_benchmark_prices: Optional[Mapping[str, pd.DataFrame]] = None,
    earnings_events: Optional[Sequence[Mapping[str, Any]]] = None,
    estimate_revisions: Optional[Sequence[Mapping[str, Any]]] = None,
    enable_market_features: bool = False,
) -> List[Dict[str, Any]]:
    """Crea uno snapshot per fine mese usando l'ultimo filing già pubblico."""

    normalized_target = str(target_kind or "raw").strip().lower()
    if normalized_target not in TARGET_KINDS:
        raise ValueError(
            f"target_kind non valido: {target_kind!r}; attesi {sorted(TARGET_KINDS)}"
        )
    normalized_benchmarks = {
        str(key).strip().lower(): _normalized_price_frame(value)
        for key, value in (benchmark_prices or {}).items()
        if isinstance(value, pd.DataFrame)
    }
    normalized_sector_benchmarks = {
        str(key).strip().upper(): _normalized_price_frame(value)
        for key, value in (sector_benchmark_prices or {}).items()
        if key and isinstance(value, pd.DataFrame)
    }
    required_benchmark = TARGET_BENCHMARKS.get(normalized_target)
    if required_benchmark and (
        required_benchmark not in normalized_benchmarks
        or normalized_benchmarks[required_benchmark].empty
    ):
        raise ValueError(
            f"Il target {normalized_target!r} richiede "
            f"benchmark_prices[{required_benchmark!r}]."
        )
    if normalized_target == "market-sector-neutral":
        if (
            "market" not in normalized_benchmarks
            or normalized_benchmarks["market"].empty
        ):
            raise ValueError(
                "Il target 'market-sector-neutral' richiede "
                "benchmark_prices['market']."
            )
        if (
            not normalized_sector_benchmarks
            and (
                "sector" not in normalized_benchmarks
                or normalized_benchmarks["sector"].empty
            )
        ):
            raise ValueError(
                "Il target 'market-sector-neutral' richiede benchmark di settore "
                "point-in-time in sector_benchmark_prices o benchmark_prices['sector']."
            )
    symbol_lookup = {
        str(key).strip().lower(): str(value).strip().upper()
        for key, value in (benchmark_symbols or {}).items()
        if value
    }

    split_field_available = "Stock Splits" in prices.columns
    frame = _normalized_price_frame(prices)
    if frame.empty or not vintages:
        return []

    month_positions: Dict[Tuple[int, int], int] = {}
    for position, timestamp in enumerate(frame.index):
        month_positions[(timestamp.year, timestamp.month)] = position
    positions = sorted(month_positions.values())
    ordered_vintages = sorted(vintages, key=lambda item: item["acceptedAt"])
    samples: List[Dict[str, Any]] = []

    for position in positions:
        snapshot = frame.index[position].to_pydatetime()
        security = resolve_security_point_in_time(
            security_timeline or [], snapshot
        )
        if security_timeline and security is None:
            # Un security master fornito e vincolante: non inventiamo
            # appartenenza, ticker o settore per uno snapshot non coperto.
            continue
        eligible = [
            vintage
            for vintage in ordered_vintages
            # Regola conservativa: il filing entra nelle feature dalla prima
            # chiusura successiva. Così un 10-K pubblicato dopo la chiusura non
            # viene associato retroattivamente al prezzo dello stesso giorno.
            if vintage["acceptedAt"] < snapshot
        ]
        if not eligible:
            continue
        current = eligible[-1]
        previous = _previous_comparable_vintage(eligible, current)
        age_days = (snapshot - current["acceptedAt"]).days
        age_limit = (
            int(max_filing_age_days)
            if max_filing_age_days is not None
            else (190 if current.get("form") in QUARTERLY_FORMS else 550)
        )
        if age_days < 0 or age_days > age_limit:
            continue
        features = build_feature_vector(
            current["metrics"],
            previous["metrics"] if previous else None,
            raw_price=float(frame.iloc[position]["raw"]),
            filing_age_days=age_days,
        )
        market_features: Dict[str, Any] = {}
        if enable_market_features or normalized_target == "market-sector-neutral":
            market_features = build_market_event_features(
                prices,
                snapshot,
                market_frame=(
                    benchmark_prices.get("market")
                    if isinstance(benchmark_prices, Mapping)
                    else None
                ),
                shares_outstanding=(current.get("metrics") or {}).get(
                    "shares_outstanding"
                ),
                earnings_events=earnings_events,
                estimate_revisions=estimate_revisions,
            )
        missing_features = sorted(
            key
            for key, value in features.items()
            if value is None or not math.isfinite(float(value))
        )
        feature_coverage = (
            (len(features) - len(missing_features)) / max(1, len(features))
        )
        if feature_coverage < minimum_feature_coverage:
            continue

        row: Dict[str, Any] = {
            "ticker": str(ticker).upper(),
            "snapshot_date": snapshot.date().isoformat(),
            "accession_number": current["accessionNumber"],
            "accepted_at": current.get("acceptedAtIso"),
            "report_date": current.get("reportDate"),
            "filing_form": current.get("form"),
            "filing_frequency": current.get("filingFrequency") or (
                "quarterly" if current.get("form") in QUARTERLY_FORMS else "annual"
            ),
            "acceptance_fallback": bool(current.get("acceptanceFallback")),
            "filing_age_days": age_days,
            "filing_age_limit_days": age_limit,
            "comparison_accession_number": (
                previous.get("accessionNumber") if previous else None
            ),
            "feature_coverage": feature_coverage,
            "feature_missing_count": len(missing_features),
            "feature_total_count": len(features),
            "feature_missing_fields": "|".join(missing_features),
            "source_metric_coverage": current.get("metricCoverage"),
            "source_metric_missing_count": current.get("missingMetricCount"),
            "source_metric_missing_fields": "|".join(
                current.get("missingMetrics") or []
            ),
            "ttm_coverage": (current.get("ttm") or {}).get("coverage"),
            "ttm_annual_base_accession": (
                (current.get("ttm") or {}).get("annualBaseAccession")
            ),
            "ttm_comparable_quarter_accession": (
                (current.get("ttm") or {}).get("comparableQuarterAccession")
            ),
            "currency": (current.get("unitAudit") or {}).get("currency"),
            "unit_audit_status": (current.get("unitAudit") or {}).get("status"),
            "mixed_currency": bool(
                (current.get("unitAudit") or {}).get("mixedCurrency")
            ),
            "unexpected_unit_metrics": "|".join(
                (current.get("unitAudit") or {}).get("unexpectedUnitMetrics") or []
            ),
            "target_kind": normalized_target,
            "target_benchmark": symbol_lookup.get(required_benchmark or ""),
            "target_uses_adjusted_close": True,
            "stock_split_field_available": split_field_available,
            "raw_close": float(frame.iloc[position]["raw"]),
            "adjusted_close": float(frame.iloc[position]["adjusted"]),
            "price_adjustment_factor": (
                float(frame.iloc[position]["adjusted"])
                / float(frame.iloc[position]["raw"])
            ),
            **features,
            **market_features,
        }
        if market_features:
            row["market_feature_horizons"] = "1m|3m"
        if security is not None:
            row.update(
                {
                    "security_id": security.get("security_id"),
                    "security_ticker_asof": security.get("ticker"),
                    "security_canonical_ticker": security.get(
                        "canonical_ticker"
                    ),
                    "security_valid_from": security.get("valid_from"),
                    "security_valid_to": security.get("valid_to"),
                    "security_delist_date": security.get("delist_date"),
                    "security_delisting_return": security.get(
                        "delisting_return"
                    ),
                    "security_sector": security.get("sector"),
                    "security_sic": security.get("sic"),
                    "security_industry": security.get("industry"),
                    "security_exchange": security.get("exchange"),
                    "security_type": security.get("security_type"),
                    "security_sector_benchmark": security.get(
                        "sector_benchmark"
                    ),
                    "security_master_verified": True,
                }
            )
        start_adjusted = float(frame.iloc[position]["adjusted"])
        for horizon, config in HORIZONS.items():
            end_position = position + int(config["sessions"])
            expected_label = (
                pd.Timestamp(frame.index[position])
                + pd.offsets.BDay(int(config["sessions"]))
            )
            target_includes_delisting = False
            raw_target: Optional[float] = None
            label_timestamp: Optional[pd.Timestamp] = None
            split_window = pd.Series(dtype=float)
            if end_position < len(frame):
                label_timestamp = pd.Timestamp(frame.index[end_position])
                end_adjusted = float(frame.iloc[end_position]["adjusted"])
                raw_target = (end_adjusted / start_adjusted) - 1.0
                split_window = frame.iloc[
                    position + 1 : end_position + 1
                ]["stock_splits"]
            elif security is not None:
                delist_at = _as_date(security.get("delist_date"))
                delisting_return = _finite(security.get("delisting_return"))
                if (
                    delist_at is not None
                    and delisting_return is not None
                    and delisting_return >= -1.0
                    and snapshot < delist_at <= expected_label.to_pydatetime()
                ):
                    terminal = frame.loc[frame.index <= pd.Timestamp(delist_at)]
                    if not terminal.empty:
                        terminal_adjusted = _finite(terminal.iloc[-1]["adjusted"])
                        if terminal_adjusted is not None and terminal_adjusted > 0:
                            raw_target = (
                                (terminal_adjusted / start_adjusted)
                                * (1.0 + delisting_return)
                                - 1.0
                            )
                            label_timestamp = expected_label
                            target_includes_delisting = True
                            split_window = terminal.loc[
                                terminal.index > frame.index[position], "stock_splits"
                            ]

            if raw_target is None or label_timestamp is None:
                row[f"target_{horizon}"] = None
                row[f"target_raw_{horizon}"] = None
                row[f"label_date_{horizon}"] = None
                row[f"target_definition_{horizon}"] = normalized_target
                row[f"stock_split_in_horizon_{horizon}"] = None
                row[f"target_includes_delisting_return_{horizon}"] = False
                row[f"target_market_sector_neutral_{horizon}"] = None
                for benchmark_name in ("excess", "market", "sector"):
                    row[f"benchmark_return_{benchmark_name}_{horizon}"] = None
                    row[f"target_{benchmark_name}_relative_{horizon}"] = None
                    row[f"benchmark_label_date_{benchmark_name}_{horizon}"] = None
                row[f"target_excess_{horizon}"] = None
                continue
            row[f"target_raw_{horizon}"] = raw_target
            row[f"label_date_{horizon}"] = label_timestamp.date().isoformat()
            row[f"target_definition_{horizon}"] = normalized_target
            row[f"stock_split_in_horizon_{horizon}"] = bool(
                (split_window.fillna(0.0) != 0.0).any()
            )
            row[f"target_includes_delisting_return_{horizon}"] = (
                target_includes_delisting
            )

            relative_targets: Dict[str, Optional[float]] = {}
            sector_symbol = str(
                (security or {}).get("sector_benchmark")
                or symbol_lookup.get("sector")
                or ""
            ).strip().upper()
            for benchmark_name in ("excess", "market", "sector"):
                if benchmark_name == "sector" and sector_symbol:
                    benchmark_frame = normalized_sector_benchmarks.get(sector_symbol)
                    if benchmark_frame is None or benchmark_frame.empty:
                        benchmark_frame = normalized_benchmarks.get("sector")
                    benchmark_symbol = sector_symbol
                else:
                    benchmark_frame = normalized_benchmarks.get(benchmark_name)
                    benchmark_symbol = symbol_lookup.get(benchmark_name)
                benchmark_return = None
                benchmark_start = None
                benchmark_end = None
                if benchmark_frame is not None and not benchmark_frame.empty:
                    benchmark_return, benchmark_start, benchmark_end = _benchmark_return(
                        benchmark_frame["adjusted"],
                        frame.index[position],
                        label_timestamp,
                    )
                relative = (
                    raw_target - benchmark_return
                    if benchmark_return is not None
                    else None
                )
                relative_targets[benchmark_name] = relative
                row[f"benchmark_symbol_{benchmark_name}"] = benchmark_symbol
                row[f"benchmark_return_{benchmark_name}_{horizon}"] = benchmark_return
                row[f"benchmark_start_date_{benchmark_name}_{horizon}"] = benchmark_start
                row[f"benchmark_label_date_{benchmark_name}_{horizon}"] = benchmark_end
                row[f"target_{benchmark_name}_relative_{horizon}"] = relative
                if benchmark_name == "excess":
                    row[f"target_excess_{horizon}"] = relative

            if normalized_target == "raw":
                row[f"target_{horizon}"] = raw_target
                row[f"target_market_sector_neutral_{horizon}"] = None
            elif normalized_target == "market-sector-neutral":
                market_return = row.get(f"benchmark_return_market_{horizon}")
                sector_return = row.get(f"benchmark_return_sector_{horizon}")
                beta = _finite(row.get("market_beta_60d"))
                neutral = (
                    raw_target
                    - beta * market_return
                    - (sector_return - market_return)
                    if beta is not None
                    and market_return is not None
                    and sector_return is not None
                    else None
                )
                row[f"target_market_sector_neutral_{horizon}"] = neutral
                row[f"target_beta_asof_{horizon}"] = beta
                row[f"target_{horizon}"] = neutral
                row["target_benchmark"] = (
                    f"market={symbol_lookup.get('market') or ''};"
                    f"sector={sector_symbol}"
                )
            else:
                row[f"target_market_sector_neutral_{horizon}"] = None
                row[f"target_{horizon}"] = relative_targets.get(
                    required_benchmark or ""
                )
        samples.append(row)
    return samples
