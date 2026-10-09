import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Line } from "react-chartjs-2";
import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
} from "chart.js";
import {
  FiActivity,
  FiAlertTriangle,
  FiBarChart2,
  FiCheckCircle,
  FiChevronDown,
  FiChevronRight,
  FiExternalLink,
  FiFileText,
  FiInfo,
  FiSearch,
  FiCalendar,
  FiClock,
  FiRefreshCw,
  FiTrendingDown,
  FiTrendingUp,
} from "react-icons/fi";
import { apiUrl } from "../services/apiBase";
import "./FundamentalAnalysis.css";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  Filler
);

const STATEMENT_TABS = [
  { key: "income", label: "Conto economico" },
  { key: "balance", label: "Stato patrimoniale" },
  { key: "cash", label: "Flussi di cassa" },
];

const CALCULATION_TITLES = {
  income: "Indicatori del conto economico",
  balance: "Indicatori patrimoniali",
  cash: "Indicatori dei flussi di cassa",
};

const COMMON_SIZE_CONFIG = {
  income: {
    statement: "income",
    keys: ["TotalRevenue", "OperatingRevenue"],
    label: "% dei ricavi",
  },
  balance: {
    statement: "balance",
    keys: ["TotalAssets"],
    label: "% delle attività",
  },
  cash: {
    statement: "income",
    keys: ["TotalRevenue", "OperatingRevenue"],
    label: "% dei ricavi",
  },
};

const TREND_METRICS = {
  income: [
    {
      key: "revenue",
      label: "Ricavi",
      keys: ["TotalRevenue", "OperatingRevenue"],
      color: "#2bd3b1",
    },
    {
      key: "operating-income",
      label: "Utile operativo",
      keys: ["OperatingIncome", "TotalOperatingIncomeAsReported"],
      color: "#3b82f6",
    },
    {
      key: "net-income",
      label: "Utile netto",
      keys: [
        "NetIncomeCommonStockholders",
        "NetIncome",
        "NetIncomeFromContinuingOperationNetMinorityInterest",
      ],
      color: "#f59e0b",
    },
  ],
  balance: [
    {
      key: "total-assets",
      label: "Attività totali",
      keys: ["TotalAssets"],
      color: "#2bd3b1",
    },
    {
      key: "total-debt",
      label: "Debito totale",
      keys: ["TotalDebt"],
      color: "#ef5b67",
    },
    {
      key: "equity",
      label: "Patrimonio netto",
      keys: ["StockholdersEquity", "TotalEquityGrossMinorityInterest"],
      color: "#3b82f6",
    },
  ],
  cash: [
    {
      key: "operating-cash-flow",
      label: "Cassa operativa",
      keys: ["OperatingCashFlow", "TotalCashFromOperatingActivities"],
      color: "#2bd3b1",
    },
    {
      key: "free-cash-flow",
      label: "Free cash flow",
      keys: ["FreeCashFlow"],
      color: "#3b82f6",
    },
    {
      key: "capital-expenditure",
      label: "Capex",
      keys: ["CapitalExpenditure", "PurchaseOfPPE"],
      color: "#f59e0b",
    },
  ],
};

const ADVANCED_ANALYSIS_SECTIONS = [
  {
    key: "earnings-debt",
    eyebrow: "Affidabilità e solvibilità",
    title: "Qualità utili e debito",
    description:
      "Confronta gli utili con la cassa generata e misura la capacità di sostenere il debito.",
    highlightKeys: [
      "cash-conversion",
      "interest-coverage",
      "net-debt-ebitda",
    ],
  },
  {
    key: "efficiency",
    eyebrow: "Capitale circolante",
    title: "Efficienza",
    description:
      "Misura i giorni di incasso, magazzino e pagamento e l’utilizzo degli asset operativi.",
    highlightKeys: [
      "cash-conversion-cycle",
      "days-sales-outstanding",
      "fixed-asset-turnover",
    ],
  },
  {
    key: "dupont",
    eyebrow: "Redditività del capitale",
    title: "DuPont",
    description:
      "Scompone il ROE tra margine, rotazione delle attività e leva finanziaria.",
    highlightKeys: ["dupont-roe", "dupont-asset-turnover", "equity-multiplier"],
  },
  {
    key: "capital-allocation",
    eyebrow: "Impiego della cassa",
    title: "Allocazione capitale",
    description:
      "Ricostruisce reinvestimenti, acquisizioni, distribuzioni e finanziamento della crescita.",
    highlightKeys: [
      "reinvestment-rate",
      "cash-returned-fcfe",
      "implied-operating-growth",
    ],
  },
];

const normalizeTicker = value =>
  (value || "").trim().toUpperCase().replace(/\s+/g, "");

const formatPrice = (value, currency) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";

  try {
    if (/^[A-Z]{3}$/.test(currency || "")) {
      return new Intl.NumberFormat("it-IT", {
        style: "currency",
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(number);
    }
  } catch {
    // Alcuni mercati utilizzano codici non ISO.
  }

  const formatted = new Intl.NumberFormat("it-IT", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(number);
  return currency ? `${formatted} ${currency}` : formatted;
};

const formatPeriod = period => {
  if (!period || period === "TTM") return period || "—";
  const date = new Date(`${period}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return period;
  return new Intl.DateTimeFormat("it-IT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
};

const formatStatementValue = (value, format) => {
  if (value == null || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";

  if (format === "perShare") {
    return new Intl.NumberFormat("it-IT", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(number);
  }

  return new Intl.NumberFormat("it-IT", {
    maximumFractionDigits: 0,
  }).format(number / 1000);
};

const formatCommonSizeValue = value => {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return `${new Intl.NumberFormat("it-IT", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(number)}%`;
};

const toFinancialNumber = value => {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const findStatementRow = (statements, statementKey, keys) => {
  const rows = statements?.[statementKey]?.rows || [];
  return keys.map(key => rows.find(row => row.key === key)).find(Boolean) || null;
};

const isCommonSizeEligibleRow = row => {
  if (!row || row.format === "perShare") return false;
  return !/(EPS|PerShare|AverageShares|SharesNumber|ShareIssued|ShareCount)/i.test(
    row.key || ""
  );
};

export const getCommonSizeValue = (
  statements,
  statementKey,
  row,
  periodKey
) => {
  if (!isCommonSizeEligibleRow(row)) return null;
  const value = toFinancialNumber(row.values?.[periodKey]);
  const config = COMMON_SIZE_CONFIG[statementKey];
  if (value == null || !config) return null;

  const baseRows = statements?.[config.statement]?.rows || [];
  const baseValue = config.keys
    .map(key =>
      toFinancialNumber(
        baseRows.find(baseRow => baseRow.key === key)?.values?.[periodKey]
      )
    )
    .find(candidate => candidate != null);
  if (baseValue == null || baseValue <= 0) return null;
  return (value / baseValue) * 100;
};

export const buildTrendCards = (statements, statementKey, periods) => {
  const datedPeriods = (Array.isArray(periods) ? periods : [])
    .filter(period => period?.key && period.key !== "TTM")
    .slice()
    .sort((a, b) => a.key.localeCompare(b.key));

  return (TREND_METRICS[statementKey] || [])
    .map(metric => {
      const row = findStatementRow(statements, statementKey, metric.keys);
      if (!row) return null;
      const statementRows = statements?.[statementKey]?.rows || [];
      const points = datedPeriods
        .map(period => ({
          period: period.key,
          label: formatPeriod(period.label),
          value: metric.keys
            .map(key =>
              toFinancialNumber(
                statementRows.find(candidate => candidate.key === key)?.values?.[
                  period.key
                ]
              )
            )
            .find(candidate => candidate != null),
        }))
        .filter(point => point.value != null);
      return points.length >= 2 ? { ...metric, points } : null;
    })
    .filter(Boolean);
};

const formatCompactValue = (value, currency = "") => {
  const number = toFinancialNumber(value);
  if (number == null) return "—";
  const validCurrency = /^[A-Z]{3}$/.test(currency || "");
  try {
    return new Intl.NumberFormat("it-IT", {
      ...(validCurrency ? { style: "currency", currency } : {}),
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(number);
  } catch {
    return new Intl.NumberFormat("it-IT", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(number);
  }
};

const TrendChartCard = ({ chart, currency, darkMode }) => {
  const latestPoint = chart.points[chart.points.length - 1];
  const priorPoint = chart.points[chart.points.length - 2];
  const latestValue = latestPoint?.value;
  const change =
    priorPoint?.value != null && priorPoint.value > 0 && latestValue != null
      ? ((latestValue / priorPoint.value) - 1) * 100
      : null;
  const textColor = darkMode ? "#94a3b8" : "#667085";
  const gridColor = darkMode
    ? "rgba(158, 177, 203, 0.10)"
    : "rgba(102, 112, 133, 0.12)";

  const data = {
    labels: chart.points.map(point => point.label),
    datasets: [
      {
        data: chart.points.map(point => point.value),
        borderColor: chart.color,
        backgroundColor: `${chart.color}1f`,
        borderWidth: 2.2,
        pointBackgroundColor: chart.color,
        pointBorderColor: darkMode ? "#142234" : "#ffffff",
        pointBorderWidth: 1.5,
        pointRadius: chart.points.length > 12 ? 1.5 : 2.5,
        pointHoverRadius: 4,
        fill: true,
        tension: 0.32,
      },
    ],
  };
  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: context =>
            `${chart.label}: ${formatCompactValue(context.parsed.y, currency)}`,
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: {
          color: textColor,
          font: { size: 10, weight: "600" },
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit: 6,
        },
        border: { display: false },
      },
      y: {
        grid: { color: gridColor },
        ticks: {
          color: textColor,
          font: { size: 10 },
          callback: value => formatCompactValue(value),
          maxTicksLimit: 5,
        },
        border: { display: false },
      },
    },
  };

  return (
    <article className="financial-trend-card">
      <div className="financial-trend-card-heading">
        <div>
          <span>{chart.label}</span>
          <strong>{formatCompactValue(latestValue, currency)}</strong>
        </div>
        {change != null && (
          <span
            className={`financial-trend-change ${
              change >= 0 ? "positive" : "negative"
            }`}
          >
            {change >= 0 ? "+" : ""}
            {change.toFixed(1)}%
          </span>
        )}
      </div>
      <div className="financial-trend-canvas">
        <Line
          data={data}
          options={options}
          role="img"
          aria-label={`Andamento storico: ${chart.label}`}
        />
      </div>
    </article>
  );
};

const formatCalculatedValue = (value, format) => {
  const number = toFinancialNumber(value);
  if (number == null) return "—";

  if (format === "statement") {
    return formatStatementValue(number, "number");
  }

  const formatted = new Intl.NumberFormat("it-IT", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(number);

  if (format === "multiple") return `${formatted}x`;
  if (format === "days") return `${formatted} gg`;
  return `${formatted}%`;
};

const assessmentFromThresholds = (value, excellent, good, acceptable) => {
  if (value >= excellent) return { key: "excellent", label: "Ottimo" };
  if (value >= good) return { key: "good", label: "Buono" };
  if (value >= acceptable) return { key: "weak", label: "Neutro" };
  return { key: "poor", label: "Pessimo" };
};

const assessmentFromUpperBounds = (
  value,
  excellentUpperBound,
  goodUpperBound,
  neutralUpperBound
) => {
  if (value < excellentUpperBound) return { key: "excellent", label: "Ottimo" };
  if (value < goodUpperBound) return { key: "good", label: "Buono" };
  if (value < neutralUpperBound) return { key: "weak", label: "Neutro" };
  return { key: "poor", label: "Pessimo" };
};

const neutralAssessment = detail => ({
  key: "neutral",
  label: "N/D",
  detail,
});

const withAssessmentDetail = (assessment, detail) => ({
  ...assessment,
  detail,
});

const evaluateIncomeIndicator = (
  row,
  value,
  periodKey,
  periodKeys,
  frequency
) => {
  const number = toFinancialNumber(value);
  if (number == null) return null;

  if (row.key === "operating-income") {
    if (number <= 0) {
      return withAssessmentDetail(
        { key: "poor", label: "Pessimo" },
        "Operating income nullo o negativo."
      );
    }
    const periodIndex = periodKeys.indexOf(periodKey);
    const comparisonOffset = frequency === "quarterly" ? 4 : 1;
    const comparisonPeriod = periodKeys[periodIndex + comparisonOffset];
    const previousValue = toFinancialNumber(row.values?.[comparisonPeriod]);
    if (previousValue == null) {
      return neutralAssessment(
        frequency === "quarterly"
          ? "Serve lo stesso trimestre dell’anno precedente."
          : "Serve l’esercizio precedente per valutare la crescita."
      );
    }
    if (previousValue <= 0) {
      return withAssessmentDetail(
        { key: "excellent", label: "Ottimo" },
        "Passaggio da operating income non positivo a positivo."
      );
    }
    const growthRate = ((number / previousValue) - 1) * 100;
    return withAssessmentDetail(
      assessmentFromThresholds(growthRate, 10, 0, -10),
      `Crescita ${frequency === "quarterly" ? "YoY" : "annuale"}: ${growthRate.toFixed(2)}%.`
    );
  }

  if (row.key === "gross-profit-margin") {
    return withAssessmentDetail(
      assessmentFromThresholds(number, 50, 30, 10),
      "Soglie assolute: Ottimo ≥ 50%, Buono ≥ 30%, Neutro ≥ 10%."
    );
  }

  if (row.key === "operating-profit-margin") {
    return withAssessmentDetail(
      assessmentFromThresholds(number, 20, 10, 5),
      "Soglie assolute: Ottimo ≥ 20%, Buono ≥ 10%, Neutro ≥ 5%."
    );
  }

  if (row.key === "net-profit-margin") {
    return withAssessmentDetail(
      assessmentFromThresholds(number, 20, 10, 5),
      "Soglie assolute: Ottimo ≥ 20%, Buono ≥ 10%, Neutro ≥ 5%."
    );
  }

  if (row.key === "return-on-investment") {
    if (frequency === "quarterly") {
      return neutralAssessment(
        "Il ROIC trimestrale non viene confrontato con soglie annuali."
      );
    }
    return withAssessmentDetail(
      assessmentFromThresholds(number, 15, 10, 5),
      "Soglie assolute: Ottimo ≥ 15%, Buono ≥ 10%, Neutro ≥ 5%."
    );
  }

  return null;
};

const getMetricValue = (statements, statementKey, metricKeys, periodKey) => {
  const rows = statements?.[statementKey]?.rows || [];
  for (const metricKey of metricKeys) {
    const row = rows.find(candidate => candidate.key === metricKey);
    const value = toFinancialNumber(row?.values?.[periodKey]);
    if (value != null) return value;
  }
  return null;
};

export const evaluateBalanceIndicator = (
  row,
  value,
  assessmentValue,
  assessmentContext
) => {
  const number = toFinancialNumber(value);
  const ratingNumber = toFinancialNumber(assessmentValue);

  if (row.key === "current-liabilities") {
    if (ratingNumber == null) {
      return neutralAssessment("Copertura delle passività correnti non disponibile.");
    }
    return withAssessmentDetail(
      assessmentFromThresholds(ratingNumber, 2, 1.5, 1),
      `Giudizio basato sulla copertura delle passività correnti: ${ratingNumber.toFixed(2)}x. Ottimo ≥ 2x, Buono ≥ 1,5x, Neutro ≥ 1x.`
    );
  }

  if (row.key === "net-working-capital") {
    if (ratingNumber == null) {
      return neutralAssessment(
        "Capitale circolante normalizzato sulle passività correnti non disponibile."
      );
    }
    return withAssessmentDetail(
      assessmentFromThresholds(ratingNumber, 1, 0.5, 0),
      `Capitale circolante / Passività correnti: ${ratingNumber.toFixed(2)}x. Ottimo ≥ 1x, Buono ≥ 0,5x, Neutro ≥ 0x.`
    );
  }

  if (row.key === "current-ratio") {
    if (number == null) return neutralAssessment("Indice di liquidità non disponibile.");
    return withAssessmentDetail(
      assessmentFromThresholds(number, 2, 1.5, 1),
      "Soglie assolute indicative: Ottimo ≥ 2x, Buono ≥ 1,5x, Neutro ≥ 1x."
    );
  }

  if (row.key === "quick-ratio") {
    if (number == null) return neutralAssessment("Quick ratio non disponibile.");
    return withAssessmentDetail(
      assessmentFromThresholds(number, 1.5, 1, 0.5),
      "Soglie assolute indicative: Ottimo ≥ 1,5x, Buono ≥ 1x, Neutro ≥ 0,5x."
    );
  }

  if (row.key === "immediate-liquidity-ratio") {
    if (number == null) {
      return neutralAssessment("Indice di liquidità immediata non disponibile.");
    }
    return withAssessmentDetail(
      assessmentFromThresholds(number, 1, 0.5, 0.2),
      "Soglie assolute indicative: Ottimo ≥ 1x, Buono ≥ 0,5x, Neutro ≥ 0,2x."
    );
  }

  const leverageKeys = [
    "debt-equity",
    "long-term-debt-equity",
    "long-term-debt-capital",
    "total-debt-capital",
  ];
  if (leverageKeys.includes(row.key)) {
    const debt = toFinancialNumber(assessmentContext?.debt);
    const shareholderEquity = toFinancialNumber(assessmentContext?.equity);
    if (debt == null || shareholderEquity == null) {
      return neutralAssessment("Dati su debito o patrimonio netto non disponibili.");
    }
    if (debt < 0) {
      return neutralAssessment("Il debito negativo non consente una valutazione affidabile.");
    }
    if (shareholderEquity <= 0) {
      return withAssessmentDetail(
        { key: "poor", label: "Pessimo" },
        "Patrimonio netto nullo o negativo: il rapporto di leva non è significativo."
      );
    }
    if (number == null) {
      return neutralAssessment("Rapporto di leva non disponibile.");
    }

    if (["debt-equity", "long-term-debt-equity"].includes(row.key)) {
      return withAssessmentDetail(
        assessmentFromUpperBounds(number, 0.43, 1, 2.33),
        "Soglie assolute indicative: Ottimo < 0,43x, Buono < 1x, Neutro < 2,33x; valori inferiori indicano meno leva."
      );
    }

    return withAssessmentDetail(
      assessmentFromUpperBounds(number, 30, 50, 70),
      "Soglie assolute indicative: Ottimo < 30%, Buono < 50%, Neutro < 70%; valori inferiori indicano meno leva."
    );
  }

  return number == null ? neutralAssessment("Indicatore non disponibile.") : null;
};

const ratio = (numerator, denominator, multiplier = 1) => {
  const safeNumerator = toFinancialNumber(numerator);
  const safeDenominator = toFinancialNumber(denominator);
  if (safeNumerator == null || safeDenominator == null || safeDenominator === 0) {
    return null;
  }
  return (safeNumerator / safeDenominator) * multiplier;
};

export const buildCalculatedRows = (
  statements,
  activeStatement,
  periods,
  frequency
) => {
  if (!statements || !periods.length) return [];

  const periodKeys = periods.map(period => period.key);
  const datedPeriodKeys = periodKeys.filter(periodKey => periodKey !== "TTM");
  const comparisonPeriod = periodKey => {
    if (periodKey === "TTM") return null;
    const periodIndex = datedPeriodKeys.indexOf(periodKey);
    const comparisonOffset = frequency === "quarterly" ? 4 : 1;
    return periodIndex >= 0
      ? datedPeriodKeys[periodIndex + comparisonOffset] || null
      : null;
  };
  const metric = (statementKey, keys, periodKey) =>
    getMetricValue(statements, statementKey, keys, periodKey);
  const growth = (statementKey, keys, periodKey, derivedValue) => {
    const priorPeriodKey = comparisonPeriod(periodKey);
    if (!priorPeriodKey) return null;
    const currentValue = derivedValue
      ? derivedValue(periodKey)
      : metric(statementKey, keys, periodKey);
    const priorValue = derivedValue
      ? derivedValue(priorPeriodKey)
      : metric(statementKey, keys, priorPeriodKey);
    if (currentValue == null || priorValue == null || priorValue <= 0) return null;
    return ((currentValue / priorValue) - 1) * 100;
  };

  const revenue = periodKey =>
    metric("income", ["TotalRevenue", "OperatingRevenue"], periodKey);
  const grossProfit = periodKey =>
    metric("income", ["GrossProfit"], periodKey);
  const operatingIncome = periodKey => {
    const reportedOperatingIncome = metric(
      "income",
      ["OperatingIncome", "TotalOperatingIncomeAsReported"],
      periodKey
    );
    if (reportedOperatingIncome != null) return reportedOperatingIncome;

    const gross = grossProfit(periodKey);
    const operatingExpenses = metric("income", ["OperatingExpense"], periodKey);
    return gross != null && operatingExpenses != null
      ? gross - operatingExpenses
      : null;
  };
  const netIncome = periodKey =>
    metric(
      "income",
      [
        "NetIncomeCommonStockholders",
        "NetIncome",
        "NetIncomeFromContinuingOperationNetMinorityInterest",
      ],
      periodKey
    )
    ?? metric("cash", ["NetIncomeFromContinuingOperations"], periodKey);
  const operatingCashFlow = periodKey =>
    metric(
      "cash",
      ["OperatingCashFlow", "TotalCashFromOperatingActivities"],
      periodKey
    );
  const capitalExpenditure = periodKey =>
    metric("cash", ["CapitalExpenditure", "PurchaseOfPPE"], periodKey);
  const freeCashFlow = periodKey => {
    const reportedFreeCashFlow = metric("cash", ["FreeCashFlow"], periodKey);
    if (reportedFreeCashFlow != null) return reportedFreeCashFlow;
    const operatingCash = operatingCashFlow(periodKey);
    const capex = capitalExpenditure(periodKey);
    return operatingCash != null && capex != null
      ? operatingCash - Math.abs(capex)
      : null;
  };
  const currentAssets = periodKey =>
    metric("balance", ["CurrentAssets"], periodKey);
  const currentLiabilities = periodKey =>
    metric("balance", ["CurrentLiabilities"], periodKey);
  const longTermDebt = periodKey =>
    metric("balance", ["LongTermDebt"], periodKey);
  const accountsReceivable = periodKey =>
    metric("balance", ["AccountsReceivable", "Receivables"], periodKey);
  const immediateCash = periodKey =>
    metric(
      "balance",
      ["CashAndCashEquivalents", "CashCashEquivalentsAndShortTermInvestments"],
      periodKey
    );
  const cash = periodKey =>
    metric(
      "balance",
      ["CashCashEquivalentsAndShortTermInvestments", "CashAndCashEquivalents"],
      periodKey
    );
  const totalDebt = periodKey => {
    const reportedDebt = metric("balance", ["TotalDebt"], periodKey);
    if (reportedDebt != null) return reportedDebt;

    const currentDebt = metric("balance", ["CurrentDebt"], periodKey);
    const nonCurrentDebt = longTermDebt(periodKey);
    return currentDebt != null && nonCurrentDebt != null
      ? currentDebt + nonCurrentDebt
      : null;
  };
  const equity = periodKey =>
    metric(
      "balance",
      ["StockholdersEquity", "TotalEquityGrossMinorityInterest"],
      periodKey
    );
  const workingCapital = periodKey => {
    const reportedWorkingCapital = metric("balance", ["WorkingCapital"], periodKey);
    if (reportedWorkingCapital != null) return reportedWorkingCapital;
    const assets = currentAssets(periodKey);
    const liabilities = currentLiabilities(periodKey);
    return assets != null && liabilities != null ? assets - liabilities : null;
  };
  const quickAssets = periodKey => {
    const availableCash = cash(periodKey);
    const receivables = accountsReceivable(periodKey);
    return availableCash != null && receivables != null
      ? availableCash + receivables
      : null;
  };
  const currentLiabilityCoverage = (numerator, periodKey) => {
    const liabilities = currentLiabilities(periodKey);
    return liabilities != null && liabilities > 0
      ? ratio(numerator, liabilities)
      : null;
  };
  const leverageContext = (debtGetter, periodKey) => ({
    debt: debtGetter(periodKey),
    equity: equity(periodKey),
  });
  const debtToEquity = (debtGetter, periodKey) => {
    const { debt, equity: shareholderEquity } = leverageContext(
      debtGetter,
      periodKey
    );
    return debt != null && debt >= 0 && shareholderEquity > 0
      ? ratio(debt, shareholderEquity)
      : null;
  };
  const debtToCapital = (debtGetter, periodKey) => {
    const { debt, equity: shareholderEquity } = leverageContext(
      debtGetter,
      periodKey
    );
    return debt != null && debt >= 0 && shareholderEquity > 0
      ? ratio(debt, debt + shareholderEquity, 100)
      : null;
  };
  const investedCapital = periodKey => {
    const reportedInvestedCapital = metric(
      "balance",
      ["InvestedCapital"],
      periodKey
    );
    if (reportedInvestedCapital != null) return reportedInvestedCapital;
    const debt = totalDebt(periodKey);
    const shareholderEquity = equity(periodKey);
    const availableCash = immediateCash(periodKey);
    return debt != null && shareholderEquity != null && availableCash != null
      ? debt + shareholderEquity - availableCash
      : null;
  };
  const effectiveTaxRate = periodKey => {
    const reportedRate = metric("income", ["TaxRateForCalcs"], periodKey);
    if (reportedRate != null) {
      const normalizedRate = reportedRate > 1 ? reportedRate / 100 : reportedRate;
      if (normalizedRate >= 0 && normalizedRate <= 1) return normalizedRate;
    }
    const pretaxIncome = metric("income", ["PretaxIncome"], periodKey);
    const taxProvision = metric("income", ["TaxProvision"], periodKey);
    if (
      pretaxIncome == null
      || pretaxIncome <= 0
      || taxProvision == null
      || taxProvision < 0
    ) {
      return null;
    }
    const calculatedRate = ratio(taxProvision, pretaxIncome);
    return calculatedRate != null && calculatedRate >= 0 && calculatedRate <= 1
      ? calculatedRate
      : null;
  };
  const returnOnInvestment = periodKey => {
    if (frequency === "quarterly") return null;
    const periodOperatingIncome = operatingIncome(periodKey);
    const taxRate = effectiveTaxRate(periodKey);
    const balancePeriods = statements?.balance?.periods
      ?.map(period => period.key)
      .filter(periodKeyValue => periodKeyValue !== "TTM") || [];
    const matchingPeriodIndex = balancePeriods.indexOf(periodKey);
    const currentCapital = investedCapital(periodKey);
    const previousCapital =
      matchingPeriodIndex >= 0
        ? investedCapital(balancePeriods[matchingPeriodIndex + 1])
        : null;
    if (
      periodOperatingIncome == null
      || taxRate == null
      || currentCapital == null
      || previousCapital == null
      || currentCapital <= 0
      || previousCapital <= 0
    ) {
      return null;
    }
    const averageCapital = (currentCapital + previousCapital) / 2;
    return ratio(periodOperatingIncome * (1 - taxRate), averageCapital, 100);
  };

  const changeLabel = "YoY";
  const comparisonLabel =
    frequency === "quarterly"
      ? "stesso trimestre dell’anno precedente"
      : "esercizio precedente";
  const definitions = {
    income: [
      {
        key: "operating-income",
        label: "Operating income",
        formula: "Utile operativo riportato; fallback: Utile lordo − Spese operative",
        format: "statement",
        signed: true,
        calculate: operatingIncome,
      },
      {
        key: "gross-profit-margin",
        label: "Margine lordo (Gross profit margin)",
        formula: "Utile lordo / Ricavi",
        format: "percent",
        signed: true,
        calculate: periodKey =>
          ratio(grossProfit(periodKey), revenue(periodKey), 100),
      },
      {
        key: "operating-profit-margin",
        label: "Margine operativo (Operating profit margin)",
        formula: "Operating income / Ricavi",
        format: "percent",
        signed: true,
        calculate: periodKey =>
          ratio(operatingIncome(periodKey), revenue(periodKey), 100),
      },
      {
        key: "net-profit-margin",
        label: "Margine di utile netto",
        formula: "Utile netto / Ricavi",
        format: "percent",
        signed: true,
        calculate: periodKey =>
          ratio(netIncome(periodKey), revenue(periodKey), 100),
      },
      {
        key: "return-on-investment",
        label: "ROIC · Ritorno sul capitale investito",
        formula: "NOPAT / Capitale investito medio",
        format: "percent",
        signed: true,
        calculate: returnOnInvestment,
      },
    ],
    balance: [
      {
        key: "current-ratio",
        label: "Indice di liquidità corrente (Current ratio)",
        formula: "Attività correnti / Passività correnti",
        format: "multiple",
        calculate: periodKey =>
          currentLiabilityCoverage(currentAssets(periodKey), periodKey),
      },
      {
        key: "current-liabilities",
        label: "Current liabilities",
        formula: "Passività correnti",
        format: "statement",
        calculate: currentLiabilities,
        assessmentCalculate: periodKey =>
          currentLiabilityCoverage(currentAssets(periodKey), periodKey),
      },
      {
        key: "net-working-capital",
        label: "Net working capital",
        formula: "Attività correnti − Passività correnti",
        format: "statement",
        signed: true,
        calculate: workingCapital,
        assessmentCalculate: periodKey =>
          currentLiabilityCoverage(workingCapital(periodKey), periodKey),
      },
      {
        key: "quick-ratio",
        label: "Quick ratio",
        formula: "(Liquidità e investimenti a breve + Crediti) / Passività correnti",
        format: "multiple",
        calculate: periodKey =>
          currentLiabilityCoverage(quickAssets(periodKey), periodKey),
      },
      {
        key: "immediate-liquidity-ratio",
        label: "Indice di liquidità immediata",
        formula: "Disponibilità liquide / Passività correnti",
        format: "multiple",
        calculate: periodKey =>
          currentLiabilityCoverage(immediateCash(periodKey), periodKey),
      },
      {
        key: "debt-equity",
        label: "D/E",
        formula: "Debito totale / Patrimonio netto",
        format: "multiple",
        calculate: periodKey => debtToEquity(totalDebt, periodKey),
        assessmentContext: periodKey => leverageContext(totalDebt, periodKey),
      },
      {
        key: "long-term-debt-equity",
        label: "LT D/E",
        formula: "Debito a lungo termine / Patrimonio netto",
        format: "multiple",
        calculate: periodKey => debtToEquity(longTermDebt, periodKey),
        assessmentContext: periodKey => leverageContext(longTermDebt, periodKey),
      },
      {
        key: "long-term-debt-capital",
        label: "Debito a lungo termine / Capitale",
        formula: "Debito a lungo termine / (Debito a lungo termine + Patrimonio netto)",
        format: "percent",
        calculate: periodKey => debtToCapital(longTermDebt, periodKey),
        assessmentContext: periodKey => leverageContext(longTermDebt, periodKey),
      },
      {
        key: "total-debt-capital",
        label: "Debito totale / Capitale",
        formula: "Debito totale / (Debito totale + Patrimonio netto)",
        format: "percent",
        calculate: periodKey => debtToCapital(totalDebt, periodKey),
        assessmentContext: periodKey => leverageContext(totalDebt, periodKey),
      },
    ],
    cash: [
      {
        key: "operating-cash-growth",
        label: `Crescita cassa operativa ${changeLabel}`,
        formula: `(CFO / CFO ${comparisonLabel} − 1) × 100`,
        format: "percent",
        signed: true,
        calculate: periodKey =>
          growth("cash", [], periodKey, operatingCashFlow),
      },
      {
        key: "free-cash-growth",
        label: `Crescita free cash flow ${changeLabel}`,
        formula: `(FCF / FCF ${comparisonLabel} − 1) × 100`,
        format: "percent",
        signed: true,
        calculate: periodKey =>
          growth("cash", [], periodKey, freeCashFlow),
      },
      {
        key: "operating-cash-margin",
        label: "Margine di cassa operativo",
        formula: "Flusso di cassa operativo / Ricavi",
        format: "percent",
        signed: true,
        calculate: periodKey =>
          ratio(operatingCashFlow(periodKey), revenue(periodKey), 100),
      },
      {
        key: "free-cash-margin",
        label: "Margine free cash flow",
        formula: "Free cash flow / Ricavi",
        format: "percent",
        signed: true,
        calculate: periodKey =>
          ratio(freeCashFlow(periodKey), revenue(periodKey), 100),
      },
      {
        key: "capex-revenue",
        label: "Capex su ricavi",
        formula: "|Spese in conto capitale| / Ricavi",
        format: "percent",
        calculate: periodKey => {
          const capex = capitalExpenditure(periodKey);
          return capex != null
            ? ratio(Math.abs(capex), revenue(periodKey), 100)
            : null;
        },
      },
    ],
  };

  return (definitions[activeStatement] || [])
    .map(definition => {
      const values = Object.fromEntries(
        periodKeys.map(periodKey => [periodKey, definition.calculate(periodKey)])
      );
      const assessmentValues = definition.assessmentCalculate
        ? Object.fromEntries(
            periodKeys.map(periodKey => [
              periodKey,
              definition.assessmentCalculate(periodKey),
            ])
          )
        : null;
      const assessmentContexts = definition.assessmentContext
        ? Object.fromEntries(
            periodKeys.map(periodKey => [
              periodKey,
              definition.assessmentContext(periodKey),
            ])
          )
        : null;
      return {
        ...definition,
        values,
        ...(assessmentValues ? { assessmentValues } : {}),
        ...(assessmentContexts ? { assessmentContexts } : {}),
      };
    })
    .filter(row =>
      periodKeys.some(periodKey => {
        if (toFinancialNumber(row.values[periodKey]) != null) return true;
        const context = row.assessmentContexts?.[periodKey];
        return (
          toFinancialNumber(context?.debt) != null
          || toFinancialNumber(context?.equity) != null
        );
      })
    );
};

export const buildAdvancedAnalysis = (
  statements,
  periods,
  frequency = "annual"
) => {
  const datedPeriods = (Array.isArray(periods) ? periods : [])
    .filter(period => period?.key && period.key !== "TTM")
    .slice()
    .sort((a, b) => b.key.localeCompare(a.key))
    .slice(0, 10);

  if (!statements || frequency !== "annual" || !datedPeriods.length) {
    return { periods: datedPeriods, groups: [] };
  }

  const periodKeys = datedPeriods.map(period => period.key);
  const previousPeriod = periodKey => {
    const index = periodKeys.indexOf(periodKey);
    return index >= 0 ? periodKeys[index + 1] || null : null;
  };
  const metric = (statementKey, keys, periodKey) =>
    getMetricValue(statements, statementKey, keys, periodKey);
  const absoluteMetric = (statementKey, keys, periodKey) => {
    const value = metric(statementKey, keys, periodKey);
    return value == null ? null : Math.abs(value);
  };
  const averageValue = (getter, periodKey) => {
    const priorPeriodKey = previousPeriod(periodKey);
    if (!priorPeriodKey) return null;
    const current = toFinancialNumber(getter(periodKey));
    const prior = toFinancialNumber(getter(priorPeriodKey));
    return current != null && prior != null ? (current + prior) / 2 : null;
  };
  const periodDays = periodKey => {
    const priorPeriodKey = previousPeriod(periodKey);
    if (!priorPeriodKey) return null;
    const currentDate = new Date(`${periodKey}T00:00:00Z`);
    const priorDate = new Date(`${priorPeriodKey}T00:00:00Z`);
    const difference =
      Math.abs(currentDate.getTime() - priorDate.getTime()) / 86_400_000;
    return Number.isFinite(difference) && difference >= 250 && difference <= 430
      ? difference
      : 365;
  };

  const revenue = periodKey =>
    metric("income", ["TotalRevenue", "OperatingRevenue"], periodKey);
  const costOfRevenue = periodKey =>
    absoluteMetric(
      "income",
      ["CostOfRevenue", "ReconciledCostOfRevenue"],
      periodKey
    );
  const operatingIncome = periodKey =>
    metric(
      "income",
      ["OperatingIncome", "TotalOperatingIncomeAsReported"],
      periodKey
    );
  const ebit = periodKey =>
    metric("income", ["EBIT"], periodKey) ?? operatingIncome(periodKey);
  const pretaxIncome = periodKey =>
    metric("income", ["PretaxIncome"], periodKey);
  const netIncome = periodKey =>
    metric(
      "income",
      [
        "NetIncomeCommonStockholders",
        "NetIncome",
        "NetIncomeFromContinuingOperationNetMinorityInterest",
      ],
      periodKey
    )
    ?? metric("cash", ["NetIncomeFromContinuingOperations"], periodKey);
  const operatingCashFlow = periodKey =>
    metric(
      "cash",
      ["OperatingCashFlow", "TotalCashFromOperatingActivities"],
      periodKey
    );
  const capitalExpenditure = periodKey =>
    absoluteMetric(
      "cash",
      ["CapitalExpenditure", "PurchaseOfPPE"],
      periodKey
    );
  const freeCashFlow = periodKey => {
    const reported = metric("cash", ["FreeCashFlow"], periodKey);
    if (reported != null) return reported;
    const operatingCash = operatingCashFlow(periodKey);
    const capex = capitalExpenditure(periodKey);
    return operatingCash != null && capex != null
      ? operatingCash - capex
      : null;
  };
  const depreciationAndAmortization = periodKey =>
    absoluteMetric(
      "cash",
      ["DepreciationAndAmortization", "Depreciation"],
      periodKey
    );
  const ebitda = periodKey => {
    const reported = metric("income", ["EBITDA", "NormalizedEBITDA"], periodKey);
    if (reported != null) return reported;
    const periodEbit = ebit(periodKey);
    const depreciation = depreciationAndAmortization(periodKey);
    return periodEbit != null && depreciation != null
      ? periodEbit + depreciation
      : null;
  };
  const totalAssets = periodKey =>
    metric("balance", ["TotalAssets"], periodKey);
  const currentAssets = periodKey =>
    metric("balance", ["CurrentAssets"], periodKey);
  const currentLiabilities = periodKey =>
    metric("balance", ["CurrentLiabilities"], periodKey);
  const currentDebt = periodKey =>
    metric("balance", ["CurrentDebt"], periodKey);
  const longTermDebt = periodKey =>
    metric("balance", ["LongTermDebt"], periodKey);
  const totalDebt = periodKey => {
    const reported = metric("balance", ["TotalDebt"], periodKey);
    if (reported != null) return reported;
    const current = currentDebt(periodKey);
    const nonCurrent = longTermDebt(periodKey);
    return current != null && nonCurrent != null ? current + nonCurrent : null;
  };
  const cashAndInvestments = periodKey => {
    const combined = metric(
      "balance",
      ["CashCashEquivalentsAndShortTermInvestments"],
      periodKey
    );
    if (combined != null) return combined;
    const cash = metric("balance", ["CashAndCashEquivalents"], periodKey);
    const investments = metric(
      "balance",
      ["OtherShortTermInvestments"],
      periodKey
    );
    if (cash == null) return investments;
    return cash + (investments || 0);
  };
  const accountsReceivable = periodKey =>
    metric("balance", ["AccountsReceivable", "Receivables"], periodKey);
  const inventory = periodKey =>
    metric("balance", ["Inventory"], periodKey);
  const accountsPayable = periodKey =>
    metric("balance", ["AccountsPayable"], periodKey);
  const netPpe = periodKey =>
    metric("balance", ["NetPPE"], periodKey);
  const equity = periodKey =>
    metric(
      "balance",
      ["StockholdersEquity", "TotalEquityGrossMinorityInterest"],
      periodKey
    );
  const investedCapital = periodKey => {
    const reported = metric("balance", ["InvestedCapital"], periodKey);
    if (reported != null) return reported;
    const debt = totalDebt(periodKey);
    const shareholderEquity = equity(periodKey);
    const cash = cashAndInvestments(periodKey);
    return debt != null && shareholderEquity != null && cash != null
      ? debt + shareholderEquity - cash
      : null;
  };
  const nonCashWorkingCapital = periodKey => {
    const assets = currentAssets(periodKey);
    const cash = cashAndInvestments(periodKey);
    const liabilities = currentLiabilities(periodKey);
    const debt = currentDebt(periodKey);
    return assets != null && cash != null && liabilities != null && debt != null
      ? assets - cash - (liabilities - debt)
      : null;
  };
  const changeInNonCashWorkingCapital = periodKey => {
    const priorPeriodKey = previousPeriod(periodKey);
    if (!priorPeriodKey) return null;
    const current = nonCashWorkingCapital(periodKey);
    const prior = nonCashWorkingCapital(priorPeriodKey);
    return current != null && prior != null ? current - prior : null;
  };
  const effectiveTaxRate = periodKey => {
    const reported = metric("income", ["TaxRateForCalcs"], periodKey);
    if (reported != null) {
      const normalized = reported > 1 ? reported / 100 : reported;
      if (normalized >= 0 && normalized <= 1) return normalized;
    }
    const pretax = pretaxIncome(periodKey);
    const tax = metric("income", ["TaxProvision"], periodKey);
    if (pretax == null || pretax <= 0 || tax == null || tax < 0) return null;
    const rate = tax / pretax;
    return rate >= 0 && rate <= 1 ? rate : null;
  };
  const nopat = periodKey => {
    const periodEbit = ebit(periodKey);
    const taxRate = effectiveTaxRate(periodKey);
    return periodEbit != null && taxRate != null
      ? periodEbit * (1 - taxRate)
      : null;
  };
  const netCapitalExpenditure = periodKey => {
    const capex = capitalExpenditure(periodKey);
    const depreciation = depreciationAndAmortization(periodKey);
    return capex != null && depreciation != null
      ? capex - depreciation
      : null;
  };
  const reinvestment = periodKey => {
    const netCapex = netCapitalExpenditure(periodKey);
    const workingCapitalChange = changeInNonCashWorkingCapital(periodKey);
    return netCapex != null && workingCapitalChange != null
      ? netCapex + workingCapitalChange
      : null;
  };
  const reinvestmentRate = periodKey => {
    const amount = reinvestment(periodKey);
    const afterTaxOperatingIncome = nopat(periodKey);
    return amount != null
      && afterTaxOperatingIncome != null
      && afterTaxOperatingIncome > 0
      ? ratio(amount, afterTaxOperatingIncome, 100)
      : null;
  };
  const returnOnInvestedCapital = periodKey => {
    const afterTaxOperatingIncome = nopat(periodKey);
    const averageCapital = averageValue(investedCapital, periodKey);
    return afterTaxOperatingIncome != null
      && averageCapital != null
      && averageCapital > 0
      ? ratio(afterTaxOperatingIncome, averageCapital, 100)
      : null;
  };
  const netBorrowing = periodKey => {
    const reported = metric(
      "cash",
      ["NetIssuancePaymentsOfDebt", "NetLongTermDebtIssuance"],
      periodKey
    );
    if (reported != null) return reported;
    const issued = metric("cash", ["IssuanceOfDebt"], periodKey);
    const repaid = absoluteMetric("cash", ["RepaymentOfDebt"], periodKey);
    return issued != null && repaid != null ? issued - repaid : null;
  };
  const fcfe = periodKey => {
    const operatingCash = operatingCashFlow(periodKey);
    const capex = capitalExpenditure(periodKey);
    const borrowing = netBorrowing(periodKey);
    return operatingCash != null && capex != null && borrowing != null
      ? operatingCash - capex + borrowing
      : null;
  };
  const dividends = periodKey =>
    absoluteMetric("cash", ["CashDividendsPaid"], periodKey);
  const repurchases = periodKey =>
    absoluteMetric("cash", ["RepurchaseOfCapitalStock"], periodKey);
  const shareholderCashReturns = periodKey => {
    const paidDividends = dividends(periodKey);
    const buybacks = repurchases(periodKey);
    return paidDividends != null && buybacks != null
      ? paidDividends + buybacks
      : null;
  };
  const averageAssets = periodKey =>
    averageValue(totalAssets, periodKey);
  const averageEquity = periodKey =>
    averageValue(equity, periodKey);
  const averageInventory = periodKey =>
    averageValue(inventory, periodKey);
  const averageReceivables = periodKey =>
    averageValue(accountsReceivable, periodKey);
  const averagePayables = periodKey =>
    averageValue(accountsPayable, periodKey);
  const averageNetPpe = periodKey =>
    averageValue(netPpe, periodKey);
  const estimatedPurchases = periodKey => {
    const priorPeriodKey = previousPeriod(periodKey);
    if (!priorPeriodKey) return null;
    const cost = costOfRevenue(periodKey);
    const currentInventory = inventory(periodKey);
    const priorInventory = inventory(priorPeriodKey);
    if (cost == null || currentInventory == null || priorInventory == null) {
      return null;
    }
    const purchases = cost + currentInventory - priorInventory;
    return purchases > 0 ? purchases : null;
  };
  const daysSalesOutstanding = periodKey => {
    const days = periodDays(periodKey);
    const sales = revenue(periodKey);
    const receivables = averageReceivables(periodKey);
    return days != null
      && sales != null
      && sales > 0
      && receivables != null
      && receivables >= 0
      ? ratio(days * receivables, sales)
      : null;
  };
  const daysInventoryOutstanding = periodKey => {
    const days = periodDays(periodKey);
    const cost = costOfRevenue(periodKey);
    const stock = averageInventory(periodKey);
    return days != null
      && cost != null
      && cost > 0
      && stock != null
      && stock >= 0
      ? ratio(days * stock, cost)
      : null;
  };
  const daysPayablesOutstanding = periodKey => {
    const days = periodDays(periodKey);
    const purchases = estimatedPurchases(periodKey);
    const payables = averagePayables(periodKey);
    return days != null
      && purchases != null
      && purchases > 0
      && payables != null
      && payables >= 0
      ? ratio(days * payables, purchases)
      : null;
  };
  const cashConversionCycle = periodKey => {
    const dso = daysSalesOutstanding(periodKey);
    const dio = daysInventoryOutstanding(periodKey);
    const dpo = daysPayablesOutstanding(periodKey);
    return dso != null && dio != null && dpo != null
      ? dso + dio - dpo
      : null;
  };
  const assetTurnover = periodKey => {
    const sales = revenue(periodKey);
    const assets = averageAssets(periodKey);
    return sales != null && sales > 0 && assets != null && assets > 0
      ? ratio(sales, assets)
      : null;
  };
  const equityMultiplier = periodKey => {
    const assets = averageAssets(periodKey);
    const shareholderEquity = averageEquity(periodKey);
    return assets != null
      && assets > 0
      && shareholderEquity != null
      && shareholderEquity > 0
      ? ratio(assets, shareholderEquity)
      : null;
  };
  const dupontNetMargin = periodKey => {
    const income = netIncome(periodKey);
    const sales = revenue(periodKey);
    return income != null && sales != null && sales > 0
      ? ratio(income, sales, 100)
      : null;
  };
  const dupontRoe = periodKey => {
    const margin = dupontNetMargin(periodKey);
    const turnover = assetTurnover(periodKey);
    const multiplier = equityMultiplier(periodKey);
    return margin != null && turnover != null && multiplier != null
      ? (margin / 100) * turnover * multiplier * 100
      : null;
  };

  const definitions = {
    "earnings-debt": [
      {
        key: "cash-conversion",
        category: "Qualità degli utili",
        label: "Conversione utile in cassa",
        formula: "Flusso di cassa operativo / Utile netto positivo",
        format: "multiple",
        calculate: periodKey => {
          const income = netIncome(periodKey);
          return income != null && income > 0
            ? ratio(operatingCashFlow(periodKey), income)
            : null;
        },
      },
      {
        key: "free-cash-conversion",
        category: "Qualità degli utili",
        label: "Conversione utile in FCF",
        formula: "Free cash flow / Utile netto positivo",
        format: "multiple",
        calculate: periodKey => {
          const income = netIncome(periodKey);
          return income != null && income > 0
            ? ratio(freeCashFlow(periodKey), income)
            : null;
        },
      },
      {
        key: "operating-accrual-ratio",
        category: "Qualità degli utili",
        label: "Accrual operativo su attività",
        formula: "(Utile netto − CFO) / Attività totali medie",
        format: "percent",
        calculate: periodKey => {
          const income = netIncome(periodKey);
          const operatingCash = operatingCashFlow(periodKey);
          const assets = averageAssets(periodKey);
          return income != null
            && operatingCash != null
            && assets != null
            && assets > 0
            ? ratio(income - operatingCash, assets, 100)
            : null;
        },
      },
      {
        key: "unusual-items-weight",
        category: "Qualità degli utili",
        label: "Peso elementi non ricorrenti",
        formula: "|Elementi non ricorrenti| / |Utile ante imposte|",
        format: "percent",
        calculate: periodKey => {
          const unusualItems = absoluteMetric(
            "income",
            ["TotalUnusualItemsExcludingGoodwill", "TotalUnusualItems"],
            periodKey
          );
          const pretax = pretaxIncome(periodKey);
          return unusualItems != null && pretax != null && pretax !== 0
            ? ratio(unusualItems, Math.abs(pretax), 100)
            : null;
        },
      },
      {
        key: "interest-coverage",
        category: "Copertura del debito",
        label: "Copertura degli interessi",
        formula: "EBIT (fallback: utile operativo) / |Interessi passivi|",
        format: "multiple",
        calculate: periodKey => {
          const expense = absoluteMetric(
            "income",
            ["InterestExpense", "InterestExpenseNonOperating"],
            periodKey
          );
          return expense != null && expense > 0
            ? ratio(ebit(periodKey), expense)
            : null;
        },
      },
      {
        key: "net-debt-ebitda",
        category: "Copertura del debito",
        label: "Debito netto / EBITDA",
        formula: "(Debito totale − Liquidità e investimenti a breve) / EBITDA",
        format: "multiple",
        calculate: periodKey => {
          const debt = totalDebt(periodKey);
          const cash = cashAndInvestments(periodKey);
          const periodEbitda = ebitda(periodKey);
          return debt != null
            && cash != null
            && periodEbitda != null
            && periodEbitda > 0
            ? ratio(debt - cash, periodEbitda)
            : null;
        },
      },
      {
        key: "free-cash-debt-coverage",
        category: "Copertura del debito",
        label: "Copertura debito con FCF",
        formula: "Free cash flow / Debito totale",
        format: "percent",
        calculate: periodKey => {
          const debt = totalDebt(periodKey);
          return debt != null && debt > 0
            ? ratio(freeCashFlow(periodKey), debt, 100)
            : null;
        },
      },
    ],
    efficiency: [
      {
        key: "days-sales-outstanding",
        label: "Giorni medi di incasso (DSO)",
        formula: "Giorni del periodo × Crediti medi / Ricavi",
        format: "days",
        calculate: daysSalesOutstanding,
      },
      {
        key: "days-inventory-outstanding",
        label: "Giorni medi di magazzino (DIO)",
        formula: "Giorni del periodo × Rimanenze medie / Costo dei ricavi",
        format: "days",
        calculate: daysInventoryOutstanding,
      },
      {
        key: "days-payables-outstanding",
        label: "Giorni medi di pagamento (DPO)",
        formula: "Giorni del periodo × Debiti medi / Acquisti stimati",
        format: "days",
        calculate: daysPayablesOutstanding,
      },
      {
        key: "cash-conversion-cycle",
        label: "Ciclo di conversione della cassa",
        formula: "DSO + DIO − DPO",
        format: "days",
        calculate: cashConversionCycle,
      },
      {
        key: "fixed-asset-turnover",
        label: "Rotazione immobilizzazioni",
        formula: "Ricavi / Immobilizzazioni materiali nette medie",
        format: "multiple",
        calculate: periodKey => {
          const sales = revenue(periodKey);
          const fixedAssets = averageNetPpe(periodKey);
          return sales != null
            && sales > 0
            && fixedAssets != null
            && fixedAssets > 0
            ? ratio(sales, fixedAssets)
            : null;
        },
      },
    ],
    dupont: [
      {
        key: "dupont-net-margin",
        label: "Margine netto",
        formula: "Utile netto / Ricavi",
        format: "percent",
        calculate: dupontNetMargin,
      },
      {
        key: "dupont-asset-turnover",
        label: "Rotazione attività",
        formula: "Ricavi / Attività totali medie",
        format: "multiple",
        calculate: assetTurnover,
      },
      {
        key: "equity-multiplier",
        label: "Moltiplicatore del patrimonio",
        formula: "Attività totali medie / Patrimonio netto medio positivo",
        format: "multiple",
        calculate: equityMultiplier,
      },
      {
        key: "dupont-roe",
        label: "ROE DuPont",
        formula: "Margine netto × Rotazione attività × Moltiplicatore",
        format: "percent",
        calculate: dupontRoe,
      },
    ],
    "capital-allocation": [
      {
        key: "net-capex",
        label: "Capex netto",
        formula: "|Capex| − Ammortamenti e svalutazioni",
        format: "statement",
        calculate: netCapitalExpenditure,
      },
      {
        key: "change-non-cash-working-capital",
        label: "Variazione capitale circolante non monetario",
        formula: "NCWC finale − NCWC iniziale",
        format: "statement",
        calculate: changeInNonCashWorkingCapital,
      },
      {
        key: "total-reinvestment",
        label: "Reinvestimento operativo",
        formula: "Capex netto + Variazione NCWC",
        format: "statement",
        calculate: reinvestment,
      },
      {
        key: "reinvestment-rate",
        label: "Tasso di reinvestimento",
        formula: "Reinvestimento operativo / NOPAT positivo",
        format: "percent",
        calculate: reinvestmentRate,
      },
      {
        key: "research-intensity",
        label: "Intensità R&D",
        formula: "Ricerca e sviluppo / Ricavi",
        format: "percent",
        calculate: periodKey => {
          const research = absoluteMetric(
            "income",
            ["ResearchAndDevelopment"],
            periodKey
          );
          const sales = revenue(periodKey);
          return research != null && sales != null && sales > 0
            ? ratio(research, sales, 100)
            : null;
        },
      },
      {
        key: "fcfe",
        label: "Free cash flow to equity (FCFE)",
        formula: "CFO − |Capex| + Indebitamento netto",
        format: "statement",
        calculate: fcfe,
      },
      {
        key: "acquisitions",
        label: "Acquisizioni di aziende",
        formula: "|Cassa impiegata per acquisizioni|",
        format: "statement",
        calculate: periodKey =>
          absoluteMetric(
            "cash",
            ["PurchaseOfBusiness", "NetBusinessPurchases"],
            periodKey
          ),
      },
      {
        key: "shareholder-cash-returns",
        label: "Cassa restituita agli azionisti",
        formula: "|Dividendi| + |Riacquisti lordi|",
        format: "statement",
        calculate: shareholderCashReturns,
      },
      {
        key: "cash-returned-fcfe",
        label: "Distribuzioni / FCFE",
        formula: "Cassa restituita agli azionisti / FCFE positivo",
        format: "percent",
        calculate: periodKey => {
          const returned = shareholderCashReturns(periodKey);
          const equityCashFlow = fcfe(periodKey);
          return returned != null && equityCashFlow != null && equityCashFlow > 0
            ? ratio(returned, equityCashFlow, 100)
            : null;
        },
      },
      {
        key: "share-count-change",
        label: "Variazione azioni in circolazione",
        formula: "(Azioni finali / Azioni iniziali − 1) × 100",
        format: "percent",
        calculate: periodKey => {
          const priorPeriodKey = previousPeriod(periodKey);
          const currentShares = metric(
            "balance",
            ["OrdinarySharesNumber", "ShareIssued"],
            periodKey
          );
          const priorShares = priorPeriodKey
            ? metric(
                "balance",
                ["OrdinarySharesNumber", "ShareIssued"],
                priorPeriodKey
              )
            : null;
          return currentShares != null && priorShares != null && priorShares > 0
            ? ((currentShares / priorShares) - 1) * 100
            : null;
        },
      },
      {
        key: "implied-operating-growth",
        label: "Crescita operativa implicita",
        formula: "Tasso di reinvestimento × ROIC",
        format: "percent",
        calculate: periodKey => {
          const rate = reinvestmentRate(periodKey);
          const roic = returnOnInvestedCapital(periodKey);
          return rate != null && roic != null ? (rate * roic) / 100 : null;
        },
      },
    ],
  };

  const materializeRows = sectionKey =>
    (definitions[sectionKey] || [])
      .map(definition => ({
        ...definition,
        values: Object.fromEntries(
          periodKeys.map(periodKey => [
            periodKey,
            definition.calculate(periodKey),
          ])
        ),
      }))
      .filter(row =>
        periodKeys.some(
          periodKey => toFinancialNumber(row.values[periodKey]) != null
        )
      );

  const groups = ADVANCED_ANALYSIS_SECTIONS
    .map(section => ({
      ...section,
      rows: materializeRows(section.key),
    }))
    .filter(section => section.rows.length > 0);

  return { periods: datedPeriods, groups };
};

const formatAnalysisNumber = (value, maximumFractionDigits = 2) => {
  const number = toFinancialNumber(value);
  if (number == null) return "N/D";
  return new Intl.NumberFormat("it-IT", {
    minimumFractionDigits: Math.min(1, maximumFractionDigits),
    maximumFractionDigits,
  }).format(number);
};

const datedPeriodKeysFromStatements = (statements, preferredPeriods = []) => {
  const keys = new Set(
    (Array.isArray(preferredPeriods) ? preferredPeriods : [])
      .map(period => period?.key)
      .filter(key => key && key !== "TTM")
  );
  Object.values(statements || {}).forEach(statement => {
    (statement?.periods || []).forEach(period => {
      if (period?.key && period.key !== "TTM") keys.add(period.key);
    });
  });
  return [...keys].sort((a, b) => b.localeCompare(a)).slice(0, 10);
};

export const buildConsistencyChecks = (
  statements,
  periods,
  metadata = {}
) => {
  if (!statements) return [];

  const periodKeys = datedPeriodKeysFromStatements(statements, periods);
  const metric = (statementKey, keys, periodKey) =>
    getMetricValue(statements, statementKey, keys, periodKey);
  const checks = [];

  const addReconciliation = ({
    key,
    title,
    formula,
    tolerance,
    calculate,
    interpretation,
  }) => {
    const evaluations = periodKeys
      .map(periodKey => {
        const result = calculate(periodKey);
        const actual = toFinancialNumber(result?.actual);
        const expected = toFinancialNumber(result?.expected);
        if (actual == null || expected == null) return null;
        const scale = Math.max(Math.abs(actual), Math.abs(expected), 1);
        return {
          periodKey,
          deviation: (Math.abs(actual - expected) / scale) * 100,
        };
      })
      .filter(Boolean);

    if (!evaluations.length) {
      checks.push({
        key,
        title,
        status: "unavailable",
        statusLabel: "Non verificabile",
        severity: "low",
        detail: `${formula}. Mancano una o più voci necessarie.`,
        evidence: "Nessun esercizio con tutti i dati richiesti.",
      });
      return;
    }

    const failed = evaluations.filter(item => item.deviation > tolerance);
    const worst = evaluations.reduce((currentWorst, item) =>
      !currentWorst || item.deviation > currentWorst.deviation
        ? item
        : currentWorst
    , null);
    const status = failed.length ? "attention" : "pass";
    checks.push({
      key,
      title,
      status,
      statusLabel: status === "pass" ? "Coerente" : "Da verificare",
      severity: status === "pass" ? "low" : "medium",
      detail:
        status === "pass"
          ? `${formula}. Tutti gli esercizi verificabili rispettano la tolleranza del ${formatAnalysisNumber(tolerance, 1)}%.`
          : `${formula}. ${failed.length} esercizi superano la tolleranza del ${formatAnalysisNumber(tolerance, 1)}%. ${interpretation}`,
      evidence: `${evaluations.length - failed.length}/${evaluations.length} esercizi riconciliati · scostamento massimo ${formatAnalysisNumber(worst?.deviation)}% (${formatPeriod(worst?.periodKey)})`,
    });
  };

  addReconciliation({
    key: "balance-equation",
    title: "Quadratura dello stato patrimoniale",
    formula: "Attività = Passività + Patrimonio netto",
    tolerance: 1,
    calculate: periodKey => ({
      actual: metric("balance", ["TotalAssets"], periodKey),
      expected: (() => {
        const liabilities = metric(
          "balance",
          ["TotalLiabilitiesNetMinorityInterest"],
          periodKey
        );
        const shareholderEquity = metric(
          "balance",
          ["TotalEquityGrossMinorityInterest", "StockholdersEquity"],
          periodKey
        );
        return liabilities != null && shareholderEquity != null
          ? liabilities + shareholderEquity
          : null;
      })(),
    }),
    interpretation:
      "Lo scostamento può dipendere da minoranze, riclassifiche o periodi non perfettamente allineati.",
  });

  addReconciliation({
    key: "gross-profit-bridge",
    title: "Riconciliazione dell’utile lordo",
    formula: "Utile lordo = Ricavi − Costo dei ricavi",
    tolerance: 1,
    calculate: periodKey => {
      const revenue = metric(
        "income",
        ["TotalRevenue", "OperatingRevenue"],
        periodKey
      );
      const cost = metric(
        "income",
        ["CostOfRevenue", "ReconciledCostOfRevenue"],
        periodKey
      );
      return {
        actual: metric("income", ["GrossProfit"], periodKey),
        expected:
          revenue != null && cost != null
            ? revenue - Math.abs(cost)
            : null,
      };
    },
    interpretation:
      "Controllare il segno del costo, eventuali riclassifiche e l’uso di ricavi operativi anziché totali.",
  });

  addReconciliation({
    key: "free-cash-flow-bridge",
    title: "Riconciliazione del free cash flow",
    formula: "FCF = Flusso di cassa operativo − Capex",
    tolerance: 1,
    calculate: periodKey => {
      const operatingCash = metric(
        "cash",
        ["OperatingCashFlow", "TotalCashFromOperatingActivities"],
        periodKey
      );
      const capex = metric(
        "cash",
        ["CapitalExpenditure", "PurchaseOfPPE"],
        periodKey
      );
      return {
        actual: metric("cash", ["FreeCashFlow"], periodKey),
        expected:
          operatingCash != null && capex != null
            ? operatingCash - Math.abs(capex)
            : null,
      };
    },
    interpretation:
      "La fonte può includere nel FCF investimenti diversi dal solo capex materiale.",
  });

  addReconciliation({
    key: "debt-bridge",
    title: "Riconciliazione del debito",
    formula: "Debito totale = Debito corrente + Debito a lungo termine",
    tolerance: 3,
    calculate: periodKey => {
      const currentDebt = metric("balance", ["CurrentDebt"], periodKey);
      const longTermDebt = metric("balance", ["LongTermDebt"], periodKey);
      return {
        actual: metric("balance", ["TotalDebt"], periodKey),
        expected:
          currentDebt != null && longTermDebt != null
            ? currentDebt + longTermDebt
            : null,
      };
    },
    interpretation:
      "Il totale può comprendere leasing o altre passività finanziarie non esposte separatamente.",
  });

  const statementCoverage = ["income", "balance", "cash"].map(statementKey => {
    const statementPeriods = new Set(
      (statements?.[statementKey]?.periods || [])
        .map(period => period?.key)
        .filter(key => key && key !== "TTM")
    );
    return {
      statementKey,
      count: statementPeriods.size,
      latest: [...statementPeriods].sort((a, b) => b.localeCompare(a))[0] || null,
    };
  });
  const latestDates = statementCoverage
    .map(item => new Date(`${item.latest}T00:00:00Z`).getTime())
    .filter(Number.isFinite);
  const dateSpread =
    latestDates.length === statementCoverage.length
      ? (Math.max(...latestDates) - Math.min(...latestDates)) / 86_400_000
      : null;
  const minimumCoverage = Math.min(
    ...statementCoverage.map(item => item.count)
  );
  const coveragePass =
    statementCoverage.every(item => item.count > 0)
    && dateSpread != null
    && dateSpread <= 45
    && minimumCoverage >= 5;
  checks.push({
    key: "historical-coverage",
    title: "Copertura e allineamento storico",
    status: coveragePass ? "pass" : "attention",
    statusLabel: coveragePass ? "Coerente" : "Copertura limitata",
    severity: coveragePass ? "low" : "medium",
    detail: coveragePass
      ? "I tre prospetti hanno almeno cinque esercizi e le date più recenti sono allineate entro 45 giorni."
      : "Uno o più prospetti hanno meno di cinque esercizi oppure le date più recenti non sono sufficientemente allineate.",
    evidence: `Conto economico ${statementCoverage[0].count} · Stato patrimoniale ${statementCoverage[1].count} · Flussi ${statementCoverage[2].count}${
      dateSpread != null
        ? ` · scarto date ${formatAnalysisNumber(dateSpread, 0)} gg`
        : ""
    }`,
  });

  const duplicateRowKeys = Object.values(statements || {}).reduce(
    (total, statement) => {
      const rowKeys = (statement?.rows || []).map(row => row.key).filter(Boolean);
      return total + (rowKeys.length - new Set(rowKeys).size);
    },
    0
  );
  const duplicatePeriodKeys = Object.values(statements || {}).reduce(
    (total, statement) => {
      const statementPeriodKeys = (statement?.periods || [])
        .map(period => period?.key)
        .filter(Boolean);
      return total
        + (statementPeriodKeys.length - new Set(statementPeriodKeys).size);
    },
    0
  );
  const structurePass = duplicateRowKeys === 0 && duplicatePeriodKeys === 0;
  checks.push({
    key: "data-structure",
    title: "Unicità della struttura dati",
    status: structurePass ? "pass" : "attention",
    statusLabel: structurePass ? "Coerente" : "Duplicati rilevati",
    severity: structurePass ? "low" : "high",
    detail: structurePass
      ? "Ogni voce e ogni periodo compaiono una sola volta nel rispettivo prospetto."
      : "Sono presenti chiavi duplicate che possono alterare tabelle e formule.",
    evidence: `${duplicateRowKeys} voci duplicate · ${duplicatePeriodKeys} periodi duplicati`,
  });

  const officialFilings = metadata?.officialFilings || {};
  const annualFiling = (officialFilings.items || []).find(
    filing => filing.category === "annual"
  );
  const latestFinancialPeriod = periodKeys[0] || null;
  if (!annualFiling || !latestFinancialPeriod || !annualFiling.reportDate) {
    checks.push({
      key: "official-filing-alignment",
      title: "Allineamento con il filing annuale",
      status: "unavailable",
      statusLabel: "Non verificabile",
      severity: "low",
      detail:
        officialFilings.reason
        || "Non sono disponibili insieme filing annuale e periodo finanziario.",
      evidence: officialFilings.cik
        ? `CIK ${officialFilings.cik}`
        : "Nessun CIK SEC associato.",
    });
  } else {
    const filingReportTime = new Date(
      `${annualFiling.reportDate}T00:00:00Z`
    ).getTime();
    const financialPeriodTime = new Date(
      `${latestFinancialPeriod}T00:00:00Z`
    ).getTime();
    const differenceDays =
      Number.isFinite(filingReportTime) && Number.isFinite(financialPeriodTime)
        ? Math.abs(filingReportTime - financialPeriodTime) / 86_400_000
        : null;
    const aligned = differenceDays != null && differenceDays <= 60;
    checks.push({
      key: "official-filing-alignment",
      title: "Allineamento con il filing annuale",
      status: aligned ? "pass" : "attention",
      statusLabel: aligned ? "Coerente" : "Da verificare",
      severity: aligned ? "low" : "medium",
      detail: aligned
        ? "Il periodo più recente della tabella è compatibile con il report date dell’ultimo filing annuale SEC."
        : "Il periodo più recente della tabella non coincide con quello dell’ultimo filing annuale SEC entro 60 giorni.",
      evidence: `${annualFiling.form} depositato il ${formatPeriod(annualFiling.filingDate)} · periodo ${formatPeriod(annualFiling.reportDate)}${
        differenceDays != null
          ? ` · scarto ${formatAnalysisNumber(differenceDays, 0)} gg`
          : ""
      }`,
    });
  }

  return checks;
};

export const buildFinalSummary = (
  statements,
  advancedAnalysis,
  consistencyChecks
) => {
  const periods = advancedAnalysis?.periods || [];
  const periodKeys = periods.map(period => period.key);
  const strengths = [];
  const attentions = [];
  const seenKeys = new Set();
  const addFinding = (target, finding) => {
    if (!finding?.key || seenKeys.has(finding.key)) return;
    seenKeys.add(finding.key);
    target.push(finding);
  };
  const metric = (statementKey, keys, periodKey) =>
    getMetricValue(statements, statementKey, keys, periodKey);
  const advancedRow = (groupKey, rowKey) =>
    advancedAnalysis?.groups
      ?.find(group => group.key === groupKey)
      ?.rows.find(row => row.key === rowKey) || null;
  const latestPair = row => {
    if (!row) return { latest: null, prior: null, latestPeriod: null };
    const available = periodKeys
      .map(periodKey => ({
        periodKey,
        value: toFinancialNumber(row.values?.[periodKey]),
      }))
      .filter(item => item.value != null);
    return {
      latest: available[0]?.value ?? null,
      prior: available[1]?.value ?? null,
      latestPeriod: available[0]?.periodKey || null,
    };
  };

  const latestPeriod = periodKeys[0];
  const priorPeriod = periodKeys[1];
  const latestRevenue = metric(
    "income",
    ["TotalRevenue", "OperatingRevenue"],
    latestPeriod
  );
  const priorRevenue = metric(
    "income",
    ["TotalRevenue", "OperatingRevenue"],
    priorPeriod
  );
  if (latestRevenue != null && priorRevenue != null && priorRevenue > 0) {
    const growth = ((latestRevenue / priorRevenue) - 1) * 100;
    if (growth >= 3) {
      addFinding(strengths, {
        key: "revenue-growth",
        title: "Ricavi in crescita",
        reason:
          "L’ultimo esercizio mostra un aumento dei ricavi superiore al 3% rispetto all’esercizio precedente.",
        evidence: `${formatPeriod(latestPeriod)}: +${formatAnalysisNumber(growth)}% anno su anno`,
      });
    } else if (growth <= -3) {
      addFinding(attentions, {
        key: "revenue-contraction",
        title: "Contrazione dei ricavi",
        reason:
          "I ricavi dell’ultimo esercizio sono diminuiti di almeno il 3%; occorre distinguere calo operativo, cambi di perimetro ed effetti valutari.",
        evidence: `${formatPeriod(latestPeriod)}: ${formatAnalysisNumber(growth)}% anno su anno`,
      });
    }
  }

  const operatingMargin = periodKey => {
    const operatingIncome = metric(
      "income",
      ["OperatingIncome", "TotalOperatingIncomeAsReported"],
      periodKey
    );
    const revenue = metric(
      "income",
      ["TotalRevenue", "OperatingRevenue"],
      periodKey
    );
    return operatingIncome != null && revenue != null && revenue > 0
      ? ratio(operatingIncome, revenue, 100)
      : null;
  };
  const latestOperatingMargin = operatingMargin(latestPeriod);
  const priorOperatingMargin = operatingMargin(priorPeriod);
  if (latestOperatingMargin != null && priorOperatingMargin != null) {
    const marginChange = latestOperatingMargin - priorOperatingMargin;
    if (latestOperatingMargin > 0 && marginChange >= 1) {
      addFinding(strengths, {
        key: "operating-margin-expansion",
        title: "Margine operativo in espansione",
        reason:
          "La redditività operativa è positiva e cresce di almeno un punto percentuale rispetto all’esercizio precedente.",
        evidence: `${formatAnalysisNumber(latestOperatingMargin)}% · variazione +${formatAnalysisNumber(marginChange)} p.p.`,
      });
    } else if (latestOperatingMargin < 0 || marginChange <= -2) {
      addFinding(attentions, {
        key: "operating-margin-pressure",
        title: "Pressione sul margine operativo",
        reason:
          latestOperatingMargin < 0
            ? "Il risultato operativo è negativo rispetto ai ricavi."
            : "Il margine operativo ha perso almeno due punti percentuali nell’ultimo esercizio.",
        evidence: `${formatAnalysisNumber(latestOperatingMargin)}% · variazione ${formatAnalysisNumber(marginChange)} p.p.`,
      });
    }
  }

  const cashConversion = latestPair(
    advancedRow("earnings-debt", "cash-conversion")
  );
  if (cashConversion.latest != null) {
    if (cashConversion.latest >= 1) {
      addFinding(strengths, {
        key: "cash-backed-earnings",
        title: "Utili sostenuti dalla cassa",
        reason:
          "Il flusso di cassa operativo è almeno pari all’utile netto positivo, riducendo il divario tra utile contabile e cassa.",
        evidence: `${formatPeriod(cashConversion.latestPeriod)}: ${formatCalculatedValue(cashConversion.latest, "multiple")} CFO / utile netto`,
      });
    } else if (cashConversion.latest < 0.8) {
      addFinding(attentions, {
        key: "weak-cash-conversion",
        title: "Conversione degli utili in cassa debole",
        reason:
          "Il CFO copre meno dell’80% dell’utile netto positivo; la differenza può dipendere da capitale circolante o componenti non monetarie.",
        evidence: `${formatPeriod(cashConversion.latestPeriod)}: ${formatCalculatedValue(cashConversion.latest, "multiple")}`,
      });
    }
  }

  const netDebtEbitda = latestPair(
    advancedRow("earnings-debt", "net-debt-ebitda")
  );
  if (netDebtEbitda.latest != null) {
    if (netDebtEbitda.latest <= 0) {
      addFinding(strengths, {
        key: "net-cash-position",
        title: "Posizione di cassa netta",
        reason:
          "Liquidità e investimenti a breve superano il debito totale nella formula Debito netto / EBITDA.",
        evidence: `${formatPeriod(netDebtEbitda.latestPeriod)}: ${formatCalculatedValue(netDebtEbitda.latest, "multiple")}`,
      });
    } else if (netDebtEbitda.latest > 4) {
      addFinding(attentions, {
        key: "high-net-debt",
        title: "Debito netto elevato rispetto all’EBITDA",
        reason:
          "Il debito netto supera quattro volte l’EBITDA positivo; la sostenibilità dipende dalla stabilità dei flussi futuri.",
        evidence: `${formatPeriod(netDebtEbitda.latestPeriod)}: ${formatCalculatedValue(netDebtEbitda.latest, "multiple")}`,
      });
    }
  }

  const interestCoverageRow = advancedRow(
    "earnings-debt",
    "interest-coverage"
  );
  const interestCoverage = latestPair(interestCoverageRow);
  if (interestCoverage.latest != null) {
    if (interestCoverage.latest >= 5) {
      addFinding(strengths, {
        key: "strong-interest-coverage",
        title: "Ampia copertura degli interessi",
        reason:
          "L’EBIT copre almeno cinque volte gli interessi passivi nell’ultimo esercizio disponibile.",
        evidence: `${formatPeriod(interestCoverage.latestPeriod)}: ${formatCalculatedValue(interestCoverage.latest, "multiple")}`,
      });
    } else if (interestCoverage.latest < 2) {
      addFinding(attentions, {
        key: "thin-interest-coverage",
        title: "Copertura degli interessi ridotta",
        reason:
          "L’EBIT copre meno di due volte gli interessi passivi, lasciando meno margine in caso di calo operativo.",
        evidence: `${formatPeriod(interestCoverage.latestPeriod)}: ${formatCalculatedValue(interestCoverage.latest, "multiple")}`,
      });
    }
  } else {
    const latestDebt = metric("balance", ["TotalDebt"], latestPeriod);
    if (latestDebt != null && latestDebt > 0) {
      addFinding(attentions, {
        key: "missing-interest-coverage",
        title: "Copertura degli interessi non verificabile",
        reason:
          "Il debito è presente, ma interessi passivi o EBIT non sono disponibili nello stesso periodo.",
        evidence: "Indicatore N/D: non viene stimato con valori inventati.",
      });
    }
  }

  const currentAssets = metric("balance", ["CurrentAssets"], latestPeriod);
  const currentLiabilities = metric(
    "balance",
    ["CurrentLiabilities"],
    latestPeriod
  );
  const currentRatio =
    currentAssets != null && currentLiabilities != null && currentLiabilities > 0
      ? ratio(currentAssets, currentLiabilities)
      : null;
  if (currentRatio != null) {
    if (currentRatio >= 1.5) {
      addFinding(strengths, {
        key: "liquidity-buffer",
        title: "Buon margine di liquidità corrente",
        reason:
          "Le attività correnti coprono almeno 1,5 volte le passività correnti nell’ultimo esercizio.",
        evidence: `${formatPeriod(latestPeriod)}: Current ratio ${formatCalculatedValue(currentRatio, "multiple")}`,
      });
    } else if (currentRatio < 1) {
      addFinding(attentions, {
        key: "current-liquidity-gap",
        title: "Copertura corrente inferiore a 1x",
        reason:
          "Le attività correnti risultano inferiori alle passività correnti; vanno considerate rotazione della cassa e accesso al credito.",
        evidence: `${formatPeriod(latestPeriod)}: Current ratio ${formatCalculatedValue(currentRatio, "multiple")}`,
      });
    }
  }

  const cashCycle = latestPair(
    advancedRow("efficiency", "cash-conversion-cycle")
  );
  if (cashCycle.latest != null && cashCycle.prior != null) {
    const change = cashCycle.latest - cashCycle.prior;
    if (change <= -5) {
      addFinding(strengths, {
        key: "cash-cycle-improvement",
        title: "Ciclo di cassa più efficiente",
        reason:
          "Il ciclo di conversione della cassa si è accorciato di almeno cinque giorni rispetto al periodo precedente.",
        evidence: `${formatCalculatedValue(cashCycle.latest, "days")} · miglioramento ${formatAnalysisNumber(Math.abs(change))} gg`,
      });
    } else if (change >= 10) {
      addFinding(attentions, {
        key: "cash-cycle-deterioration",
        title: "Ciclo di cassa in allungamento",
        reason:
          "Il capitale resta impegnato almeno dieci giorni in più; il dettaglio DSO, DIO e DPO aiuta a identificare la causa.",
        evidence: `${formatCalculatedValue(cashCycle.latest, "days")} · peggioramento +${formatAnalysisNumber(change)} gg`,
      });
    }
  }

  const dupontRoe = latestPair(advancedRow("dupont", "dupont-roe"));
  if (dupontRoe.latest != null && dupontRoe.prior != null) {
    const change = dupontRoe.latest - dupontRoe.prior;
    if (dupontRoe.latest > 0 && change >= 2) {
      addFinding(strengths, {
        key: "dupont-roe-improvement",
        title: "ROE DuPont in miglioramento",
        reason:
          "La combinazione di margine netto, rotazione delle attività e moltiplicatore del patrimonio aumenta il ROE di almeno due punti.",
        evidence: `${formatCalculatedValue(dupontRoe.latest, "percent")} · variazione +${formatAnalysisNumber(change)} p.p.`,
      });
    } else if (dupontRoe.latest < 0 || change <= -5) {
      addFinding(attentions, {
        key: "dupont-roe-deterioration",
        title: "ROE DuPont in deterioramento",
        reason:
          dupontRoe.latest < 0
            ? "La scomposizione DuPont restituisce un ROE negativo."
            : "Il ROE DuPont diminuisce di almeno cinque punti percentuali; verificare separatamente margine, rotazione e leva.",
        evidence: `${formatCalculatedValue(dupontRoe.latest, "percent")} · variazione ${formatAnalysisNumber(change)} p.p.`,
      });
    }
  }

  const cashReturned = latestPair(
    advancedRow("capital-allocation", "cash-returned-fcfe")
  );
  if (cashReturned.latest != null) {
    if (cashReturned.latest > 0 && cashReturned.latest <= 100) {
      addFinding(strengths, {
        key: "distributions-covered",
        title: "Distribuzioni coperte dal FCFE",
        reason:
          "Dividendi e riacquisti lordi non superano il free cash flow to equity positivo del periodo.",
        evidence: `${formatPeriod(cashReturned.latestPeriod)}: ${formatCalculatedValue(cashReturned.latest, "percent")} del FCFE`,
      });
    } else if (cashReturned.latest > 100) {
      addFinding(attentions, {
        key: "distributions-over-fcfe",
        title: "Distribuzioni superiori al FCFE",
        reason:
          "Dividendi e riacquisti lordi superano il FCFE positivo del periodo e possono richiedere cassa accumulata o nuovo finanziamento.",
        evidence: `${formatPeriod(cashReturned.latestPeriod)}: ${formatCalculatedValue(cashReturned.latest, "percent")} del FCFE`,
      });
    }
  }

  const shareCount = latestPair(
    advancedRow("capital-allocation", "share-count-change")
  );
  if (shareCount.latest != null) {
    if (shareCount.latest <= -1) {
      addFinding(strengths, {
        key: "share-count-reduction",
        title: "Riduzione delle azioni in circolazione",
        reason:
          "Il numero di azioni si riduce di almeno l’1%, quindi i riacquisti netti superano l’effetto delle nuove emissioni.",
        evidence: `${formatPeriod(shareCount.latestPeriod)}: ${formatCalculatedValue(shareCount.latest, "percent")}`,
      });
    } else if (shareCount.latest >= 1) {
      addFinding(attentions, {
        key: "share-dilution",
        title: "Aumento delle azioni in circolazione",
        reason:
          "Il numero di azioni cresce di almeno l’1%, con possibile diluizione della quota economica per azione.",
        evidence: `${formatPeriod(shareCount.latestPeriod)}: +${formatCalculatedValue(shareCount.latest, "percent")}`,
      });
    }
  }

  const reconciliationChecks = (consistencyChecks || []).filter(check =>
    [
      "balance-equation",
      "gross-profit-bridge",
      "free-cash-flow-bridge",
      "debt-bridge",
      "data-structure",
    ].includes(check.key)
  );
  const availableReconciliations = reconciliationChecks.filter(
    check => check.status !== "unavailable"
  );
  const failedReconciliations = availableReconciliations.filter(
    check => check.status === "attention"
  );
  if (
    availableReconciliations.length >= 3
    && failedReconciliations.length === 0
  ) {
    addFinding(strengths, {
      key: "reconciliations-pass",
      title: "Principali riconciliazioni superate",
      reason:
        "Le identità contabili verificabili e l’unicità della struttura rientrano nelle tolleranze dichiarate.",
      evidence: `${availableReconciliations.length}/${availableReconciliations.length} controlli disponibili coerenti`,
    });
  } else if (failedReconciliations.length) {
    addFinding(attentions, {
      key: "reconciliations-failed",
      title: "Scostamenti nei controlli di coerenza",
      reason:
        "Una o più riconciliazioni superano la tolleranza; può trattarsi di riclassifiche, definizioni diverse o periodi disallineati.",
      evidence: failedReconciliations.map(check => check.title).join(" · "),
    });
  }

  const filingCheck = (consistencyChecks || []).find(
    check => check.key === "official-filing-alignment"
  );
  if (filingCheck?.status === "pass") {
    addFinding(strengths, {
      key: "official-filing-traceability",
      title: "Periodo tracciabile al filing ufficiale",
      reason:
        "La data dell’ultimo esercizio è allineata con il report date del filing annuale SEC disponibile.",
      evidence: filingCheck.evidence,
    });
  } else if (filingCheck?.status === "attention") {
    addFinding(attentions, {
      key: "official-filing-mismatch",
      title: "Periodo non allineato al filing annuale",
      reason:
        "La tabella e l’ultimo filing annuale SEC non riportano periodi compatibili entro la tolleranza dichiarata.",
      evidence: filingCheck.evidence,
    });
  }

  return {
    strengths: strengths.slice(0, 7),
    attentions: attentions.slice(0, 7),
  };
};

const AdvancedAnalysisPanel = ({ group, periods }) => {
  if (!group) return null;

  const highlightRows = group.highlightKeys
    .map(key => group.rows.find(row => row.key === key))
    .filter(Boolean);

  return (
    <div
      className="financial-advanced-panel"
      id={`financial-advanced-panel-${group.key}`}
      role="tabpanel"
      aria-labelledby={`financial-advanced-tab-${group.key}`}
    >
      <div className="financial-advanced-panel-heading">
        <div>
          <span className="financial-eyebrow">{group.eyebrow}</span>
          <h3>{group.title}</h3>
        </div>
        <p>{group.description}</p>
      </div>

      {highlightRows.length > 0 && (
        <div className="financial-advanced-highlights">
          {highlightRows.map(row => {
            const latestPeriod = periods.find(
              period => toFinancialNumber(row.values?.[period.key]) != null
            );
            const value = latestPeriod
              ? toFinancialNumber(row.values?.[latestPeriod.key])
              : null;

            return (
              <article className="financial-advanced-kpi" key={row.key}>
                <span>{row.label}</span>
                <strong>{formatCalculatedValue(value, row.format)}</strong>
                <small>
                  {latestPeriod
                    ? `Ultimo disponibile · ${formatPeriod(latestPeriod.label)}`
                    : "Dato non disponibile"}
                </small>
              </article>
            );
          })}
        </div>
      )}

      <div className="financial-calculations-scroll financial-advanced-table-scroll">
        <table className="financial-calculations-table financial-advanced-table">
          <thead>
            <tr>
              <th scope="col">Indicatore</th>
              <th scope="col" className="financial-calculation-formula-heading">
                Formula
              </th>
              {periods.map(period => (
                <th scope="col" key={period.key}>
                  {formatPeriod(period.label)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {group.rows.map((row, rowIndex) => {
              const previousCategory = group.rows[rowIndex - 1]?.category;
              const showCategory = row.category && row.category !== previousCategory;

              return (
                <React.Fragment key={row.key}>
                  {showCategory && (
                    <tr className="financial-advanced-category-row">
                      <th colSpan={periods.length + 2} scope="colgroup">
                        {row.category}
                      </th>
                    </tr>
                  )}
                  <tr>
                    <th scope="row">{row.label}</th>
                    <td className="financial-calculation-formula">{row.formula}</td>
                    {periods.map(period => {
                      const value = toFinancialNumber(row.values?.[period.key]);
                      return (
                        <td
                          className={
                            value != null && value < 0 ? "negative-value" : ""
                          }
                          key={period.key}
                        >
                          {formatCalculatedValue(value, row.format)}
                        </td>
                      );
                    })}
                  </tr>
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="financial-advanced-note">
        Gli indicatori basati su saldi medi richiedono anche l’esercizio precedente:
        per questo il periodo meno recente può risultare N/D. I valori non sono
        confrontati con benchmark di altre aziende.
      </p>
    </div>
  );
};

const OfficialFilingsPanel = ({ filings }) => {
  const items = filings?.items || [];

  return (
    <article className="financial-verification-panel financial-filings-panel">
      <div className="financial-verification-panel-heading">
        <div className="financial-verification-icon" aria-hidden="true">
          <FiFileText />
        </div>
        <div>
          <span className="financial-eyebrow">Documenti originali</span>
          <h3>Filing ufficiali</h3>
        </div>
        {filings?.companyUrl && (
          <a
            className="financial-panel-link"
            href={filings.companyUrl}
            target="_blank"
            rel="noreferrer"
          >
            Profilo SEC
            <FiExternalLink aria-hidden="true" />
          </a>
        )}
      </div>

      {items.length > 0 ? (
        <div className="financial-filing-list">
          {items.map(filing => (
            <div
              className="financial-filing-row"
              key={filing.accessionNumber}
            >
              <span
                className={`financial-filing-form financial-filing-form--${filing.category}`}
              >
                {filing.form}
              </span>
              <div className="financial-filing-copy">
                <strong>{filing.categoryLabel}</strong>
                <span>
                  Depositato {formatPeriod(filing.filingDate)}
                  {filing.reportDate
                    ? ` · Periodo ${formatPeriod(filing.reportDate)}`
                    : ""}
                </span>
              </div>
              <div className="financial-filing-actions">
                <a
                  href={filing.documentUrl || filing.filingUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Apri
                  <FiExternalLink aria-hidden="true" />
                </a>
                {filing.documentUrl && (
                  <a
                    className="secondary"
                    href={filing.filingUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Indice
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="financial-panel-empty">
          <FiInfo aria-hidden="true" />
          <div>
            <strong>Filing SEC non disponibili</strong>
            <p>
              {filings?.reason
                || "Nessun documento ufficiale associato al ticker."}
            </p>
          </div>
        </div>
      )}

      <p className="financial-panel-footnote">
        {filings?.cik
          ? `Fonte: SEC EDGAR · CIK ${filings.cik}. I link aprono il documento depositato e il relativo indice ufficiale.`
          : "Per emittenti non registrati presso la SEC è necessario consultare il registro ufficiale del mercato di origine."}
      </p>
    </article>
  );
};

const ConsistencyChecksPanel = ({ checks }) => (
  <article className="financial-verification-panel financial-checks-panel">
    <div className="financial-verification-panel-heading">
      <div className="financial-verification-icon" aria-hidden="true">
        <FiCheckCircle />
      </div>
      <div>
        <span className="financial-eyebrow">Qualità dei dati</span>
        <h3>Controlli di coerenza</h3>
      </div>
    </div>

    <div className="financial-check-list">
      {checks.map(check => {
        const StatusIcon =
          check.status === "pass"
            ? FiCheckCircle
            : check.status === "attention"
              ? FiAlertTriangle
              : FiInfo;
        return (
          <div
            className={`financial-check financial-check--${check.status}`}
            key={check.key}
          >
            <StatusIcon className="financial-check-icon" aria-hidden="true" />
            <div>
              <div className="financial-check-title">
                <strong>{check.title}</strong>
                <span>{check.statusLabel}</span>
              </div>
              <p>{check.detail}</p>
              <small>{check.evidence}</small>
            </div>
          </div>
        );
      })}
    </div>
  </article>
);

const DataNotesPanel = ({ currency, provenance }) => {
  const notes = [
    {
      key: "origin",
      title: "Origine e priorità",
      text:
        provenance?.method
        || "I valori disponibili dalla fonte primaria vengono mantenuti; le fonti secondarie completano soltanto le lacune.",
    },
    {
      key: "unit",
      title: "Unità e valuta",
      text: `Gli importi della tabella sono mostrati in migliaia${
        currency ? ` di ${currency}` : ""
      }; EPS e numero di azioni mantengono la propria unità.`,
    },
    {
      key: "averages",
      title: "Saldi medi",
      text:
        "Efficienza, DuPont e ROIC usano la media tra saldo finale corrente e precedente. Il dato più vecchio può quindi essere N/D.",
    },
    {
      key: "meaning",
      title: "Come leggere i controlli",
      text:
        "“Coerente” conferma una relazione aritmetica entro la tolleranza, non la qualità economica dell’azienda. Uno scostamento può derivare anche da riclassifiche o definizioni diverse.",
    },
  ];

  return (
    <section className="financial-data-notes" aria-labelledby="financial-notes-title">
      <div className="financial-data-notes-heading">
        <FiInfo aria-hidden="true" />
        <div>
          <span className="financial-eyebrow">Metodologia</span>
          <h3 id="financial-notes-title">Note di lettura</h3>
        </div>
      </div>
      <div className="financial-data-note-grid">
        {notes.map(note => (
          <article key={note.key}>
            <strong>{note.title}</strong>
            <p>{note.text}</p>
          </article>
        ))}
      </div>
    </section>
  );
};

const SummaryColumn = ({ type, title, findings }) => {
  const Icon = type === "strength" ? FiCheckCircle : FiAlertTriangle;

  return (
    <section
      className={`financial-summary-column financial-summary-column--${type}`}
    >
      <div className="financial-summary-column-heading">
        <Icon aria-hidden="true" />
        <div>
          <h3>{title}</h3>
          <span>
            {findings.length
              ? `${findings.length} evidenze motivate`
              : "Nessuna evidenza automatica"}
          </span>
        </div>
      </div>

      {findings.length > 0 ? (
        <div className="financial-summary-list">
          {findings.map(finding => (
            <article key={finding.key}>
              <Icon aria-hidden="true" />
              <div>
                <strong>{finding.title}</strong>
                <p>{finding.reason}</p>
                <small>{finding.evidence}</small>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="financial-summary-empty">
          I dati disponibili non soddisfano nessuna delle regole trasparenti
          previste per questa sezione.
        </p>
      )}
    </section>
  );
};

const FinalSummaryPanel = ({ summary }) => (
  <section className="financial-card financial-summary-card">
    <div className="financial-summary-heading">
      <div>
        <span className="financial-eyebrow">Lettura conclusiva</span>
        <h2>Riepilogo finale</h2>
      </div>
      <p>
        Nessun punteggio unico: ogni conclusione mostra regola, valore e
        motivazione.
      </p>
    </div>
    <div className="financial-summary-grid">
      <SummaryColumn
        type="strength"
        title="Punti di forza"
        findings={summary.strengths}
      />
      <SummaryColumn
        type="attention"
        title="Segnali di attenzione"
        findings={summary.attentions}
      />
    </div>
    <p className="financial-summary-disclaimer">
      Il riepilogo usa soglie aritmetiche dichiarate e variazioni storiche della
      stessa società; non utilizza confronti con altre aziende e non sostituisce
      la lettura dei filing ufficiali.
    </p>
  </section>
);

export const formatForecastPercent = (value, signed = true) => {
  if (value == null || value === "") return "N/D";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "N/D";
  const sign = signed && numeric > 0 ? "+" : "";
  return `${sign}${numeric.toLocaleString("it-IT", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
};

const formatForecastDecimal = value => {
  if (value == null || value === "") return "N/D";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "N/D";
  return numeric.toLocaleString("it-IT", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });
};

const formatForecastPoints = value => {
  if (value == null || value === "") return "N/D";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "N/D";
  const sign = numeric > 0 ? "+" : "";
  return `${sign}${numeric.toLocaleString("it-IT", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}`;
};

const formatForecastDate = value => {
  if (!value) return "N/D";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString("it-IT", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
};

export const getForecastValidationPresentation = prediction => {
  const promotionDecision = String(
    prediction?.promotionDecision || ""
  ).trim().toLowerCase();
  if (prediction?.abstained === true || promotionDecision === "reject") {
    return {
      key: "abstained",
      label: "Previsione sospesa",
      detail:
        prediction?.abstentionReason ||
        "Questo orizzonte non ha superato i gate indipendenti di promozione.",
    };
  }
  const explicit = String(
    prediction?.validation?.status ||
      prediction?.validationStatus ||
      prediction?.performance?.validationStatus ||
      ""
  )
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase();
  const coverage = Number(prediction?.performance?.interval80CoveragePct);
  const publishable = prediction?.publishable;

  if (
    ["not-validated", "limited-no-independent-holdout"].includes(explicit) ||
    publishable === false
  ) {
    return {
      key: "unvalidated",
      label: "Non validato",
      detail: "Il modello non ha dimostrato un vantaggio sufficiente sulla baseline.",
    };
  }
  if (explicit === "prospective-confirmation-required") {
    return {
      key: "prospective",
      label: "Conferma prospettica richiesta",
      detail: "La selezione resta esplorativa finché non matura una nuova finestra mai osservata.",
    };
  }
  if (explicit === "holdout-not-confirmed") {
    return {
      key: "caveat",
      label: "Holdout non confermato",
      detail: "Il segnale di sviluppo non è stato confermato nella finestra temporale finale.",
    };
  }
  if (explicit === "legacy-artifact") {
    return {
      key: "caveat",
      label: "Backtest legacy con caveat",
      detail: "Questo artifact precede i controlli cross-sectional e bootstrap della validazione v4.",
    };
  }
  if (Number.isFinite(coverage) && coverage < 75) {
    return {
      key: "caveat",
      label: "Backtest con caveat",
      detail: `L'intervallo nominale all'80% ha coperto il ${coverage.toLocaleString(
        "it-IT",
        { maximumFractionDigits: 1 }
      )}% dell'holdout.`,
    };
  }
  return {
    key: "confirmed",
    label: prediction?.validation?.label || "Backtest confermato con caveat",
    detail:
      prediction?.validation?.detail ||
      "Il risultato ha superato il controllo temporale, ma non costituisce una garanzia futura.",
  };
};

export const getForecastMaeEdgePct = performance => {
  const explicit = Number(performance?.maeRelativeImprovementVsZeroPct);
  if (Number.isFinite(explicit)) return explicit;

  const modelMae = Number(performance?.oosMaePct);
  const baselineMae = Number(performance?.baselineZeroMaePct);
  if (
    !Number.isFinite(modelMae) ||
    !Number.isFinite(baselineMae) ||
    baselineMae <= 0
  ) {
    return null;
  }
  return ((baselineMae - modelMae) / baselineMae) * 100;
};

export const buildForecastWarningList = dataQuality => {
  const structured = Array.isArray(dataQuality?.warningObjects)
    ? dataQuality.warningObjects
        .filter(item => item && typeof item === "object")
        .map((item, index) => ({
          code: item.code || `warning-${index}`,
          severity: item.severity || "warning",
          title: item.title || "Limite del modello",
          detail: item.detail || "",
          horizons: Array.isArray(item.horizons) ? item.horizons : [],
        }))
    : [];
  if (structured.length) return structured;
  return (Array.isArray(dataQuality?.warnings) ? dataQuality.warnings : [])
    .filter(warning => typeof warning === "string" && warning.trim())
    .map((warning, index) => ({
      code: `legacy-${index}`,
      severity: "warning",
      title: "Limite del modello",
      detail: warning,
      horizons: [],
    }));
};

const ForecastDriverColumn = ({ type, title, items, scopeLabel }) => {
  const Icon = type === "positive" ? FiTrendingUp : FiTrendingDown;
  return (
    <section className={`financial-forecast-drivers financial-forecast-drivers--${type}`}>
      <div className="financial-forecast-drivers-heading">
        <Icon aria-hidden="true" />
        <div>
          <h3>{title}</h3>
          <span>
            {items.length
              ? `${items.length} contributi principali`
              : "Nessun contributo"}
          </span>
        </div>
      </div>
      {items.length ? (
        <div className="financial-forecast-driver-list">
          {items.map((item, index) => (
            <article key={item.feature || item.label || index}>
              <div>
                <strong>{item.label || item.feature}</strong>
                <span>{item.formattedValue || "Valore disponibile"}</span>
              </div>
              <b>
                {formatForecastPoints(item.effectPctPoints)}
                <small> p.p.</small>
              </b>
              <p>
                Contributo locale {scopeLabel || "medio sui tre orizzonti"},
                attribuito dal modello selezionato alla feature trasformata.
              </p>
            </article>
          ))}
        </div>
      ) : (
        <p className="financial-forecast-driver-empty">
          I dati disponibili non isolano un contributo interpretabile.
        </p>
      )}
    </section>
  );
};

const ForecastDriversPanel = ({ data, predictions }) => {
  const horizonDrivers =
    data?.driversByHorizon || data?.drivers?.byHorizon || {};
  const options = predictions.filter(prediction => {
    const group = horizonDrivers?.[prediction.horizon];
    return prediction?.abstained !== true && group && typeof group === "object";
  });
  const [activeHorizon, setActiveHorizon] = useState(
    options[0]?.horizon || "aggregate"
  );

  useEffect(() => {
    if (
      activeHorizon !== "aggregate" &&
      !options.some(option => option.horizon === activeHorizon)
    ) {
      setActiveHorizon(options[0]?.horizon || "aggregate");
    }
  }, [activeHorizon, options]);

  const activePrediction = predictions.find(
    prediction => prediction.horizon === activeHorizon
  );
  const activeGroup =
    activeHorizon === "aggregate"
      ? data?.drivers || {}
      : horizonDrivers?.[activeHorizon] || data?.drivers || {};
  const strengths = Array.isArray(activeGroup?.strengths)
    ? activeGroup.strengths.filter(item => item && typeof item === "object")
    : [];
  const attentions = Array.isArray(activeGroup?.attentionSignals)
    ? activeGroup.attentionSignals.filter(
        item => item && typeof item === "object"
      )
    : [];
  const scopeLabel =
    activeHorizon === "aggregate"
      ? "medio sui tre orizzonti"
      : `per l'orizzonte ${
          activePrediction?.label || activePrediction?.horizon || activeHorizon
        }`;

  return (
    <section className="financial-forecast-driver-section">
      <div className="financial-forecast-driver-toolbar">
        <div>
          <span className="financial-eyebrow">Spiegazione locale</span>
          <h3>Fattori usati dal modello</h3>
        </div>
        {options.length > 0 && (
          <div
            className="financial-forecast-driver-tabs"
            role="tablist"
            aria-label="Orizzonte dei contributi"
          >
            {options.map(option => (
              <button
                type="button"
                role="tab"
                aria-selected={activeHorizon === option.horizon}
                className={activeHorizon === option.horizon ? "active" : ""}
                key={option.horizon}
                onClick={() => setActiveHorizon(option.horizon)}
              >
                {option.label || option.horizon}
              </button>
            ))}
            <button
              type="button"
              role="tab"
              aria-selected={activeHorizon === "aggregate"}
              className={activeHorizon === "aggregate" ? "active" : ""}
              onClick={() => setActiveHorizon("aggregate")}
            >
              Sintesi
            </button>
          </div>
        )}
      </div>
      <div className="financial-forecast-driver-grid">
        <ForecastDriverColumn
          type="positive"
          title="Fattori che sostengono la stima"
          items={strengths}
          scopeLabel={scopeLabel}
        />
        <ForecastDriverColumn
          type="negative"
          title="Fattori che frenano la stima"
          items={attentions}
          scopeLabel={scopeLabel}
        />
      </div>
    </section>
  );
};

const FundamentalForecastPanel = ({ data, loading, error, onRetry }) => {
  if (loading) {
    return (
      <section className="financial-card financial-forecast-card">
        <div className="financial-forecast-heading">
          <div>
            <span className="financial-eyebrow">Modello fondamentale</span>
            <h2>Stima statistica del rendimento</h2>
          </div>
        </div>
        <div className="financial-forecast-loading" aria-label="Caricamento modello ML">
          <div />
          <div />
          <div />
        </div>
      </section>
    );
  }

  if (error || !data) {
    return (
      <section className="financial-card financial-forecast-card">
        <div className="financial-forecast-heading">
          <div>
            <span className="financial-eyebrow">Modello fondamentale</span>
            <h2>Stima statistica del rendimento</h2>
          </div>
          <span className="financial-forecast-status financial-forecast-status--unavailable">
            Non disponibile
          </span>
        </div>
        <div className="financial-forecast-unavailable">
          <FiInfo aria-hidden="true" />
          <div>
            <strong>La stima ML non è disponibile per questo titolo</strong>
            <p>{error || "Filing o modello non disponibili."}</p>
          </div>
          <button type="button" onClick={onRetry}>
            <FiRefreshCw aria-hidden="true" />
            Riprova
          </button>
        </div>
      </section>
    );
  }

  const predictions = Array.isArray(data.predictions)
    ? data.predictions.filter(
        prediction => prediction && typeof prediction === "object"
      )
    : [];
  const warnings = buildForecastWarningList(data.dataQuality);
  const validationPriority = {
    abstained: 5,
    unvalidated: 4,
    prospective: 3,
    caveat: 2,
    confirmed: 1,
  };
  const overallValidation = predictions
    .map(getForecastValidationPresentation)
    .sort(
      (left, right) =>
        (validationPriority[right.key] || 0) -
        (validationPriority[left.key] || 0)
    )[0] || {
    key: "unvalidated",
    label: "Non validato",
    detail: "Nessun orizzonte validato.",
  };
  const targetKind = String(data.dataset?.targetKind || "raw").toLowerCase();
  const isRelativeTarget = targetKind !== "raw";
  const hasIndependentPromotion = predictions.some(
    prediction =>
      typeof prediction?.promoted === "boolean" ||
      ["promote", "reject"].includes(
        String(prediction?.promotionDecision || "").toLowerCase()
      )
  );
  const promotedCount = predictions.filter(
    prediction =>
      prediction?.promoted === true ||
      String(prediction?.promotionDecision || "").toLowerCase() === "promote"
  ).length;
  const overallStatusLabel = hasIndependentPromotion
    ? `${promotedCount}/${predictions.length} orizzonti promossi`
    : overallValidation.label;
  const centralEstimateLabel = isRelativeTarget
    ? "Extra-rendimento centrale stimato"
    : "Rendimento centrale stimato";
  const positiveFrequencyLabel = isRelativeTarget
    ? "Frequenza empirica stimata di extra-rendimento positivo"
    : "Frequenza empirica stimata di rendimento positivo";

  if (!predictions.length) {
    return (
      <section className="financial-card financial-forecast-card">
        <div className="financial-forecast-heading">
          <div>
            <span className="financial-eyebrow">Modello fondamentale</span>
            <h2>Stima statistica del rendimento</h2>
          </div>
          <span className="financial-forecast-status financial-forecast-status--unavailable">
            Non disponibile
          </span>
        </div>
        <div className="financial-forecast-unavailable">
          <FiInfo aria-hidden="true" />
          <div>
            <strong>Nessuna previsione valida ricevuta</strong>
            <p>Il modello non ha restituito orizzonti utilizzabili.</p>
          </div>
          <button type="button" onClick={onRetry}>
            <FiRefreshCw aria-hidden="true" />
            Riprova
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="financial-card financial-forecast-card">
      <div className="financial-forecast-heading">
        <div>
          <span className="financial-eyebrow">Modello fondamentale point-in-time</span>
          <h2>Stima statistica del rendimento</h2>
          <p>
            Relazione storica tra bilanci già pubblicati e rendimenti successivi,
            misurata fuori campione con finestre temporali.
            {isRelativeTarget
              ? " Il target è relativo al benchmark indicato, non il rendimento assoluto del titolo."
              : ""}
          </p>
        </div>
        <span
          className={`financial-forecast-status financial-forecast-status--${
            hasIndependentPromotion
              ? promotedCount === predictions.length
                ? "ready"
                : "limited"
              : overallValidation.key === "confirmed"
                ? "ready"
                : "limited"
          }`}
          title={overallValidation.detail}
        >
          {overallStatusLabel}
        </span>
      </div>

      <div className="financial-forecast-grid">
        {predictions.map(prediction => {
          const abstained =
            prediction?.abstained === true ||
            String(prediction?.promotionDecision || "").toLowerCase() ===
              "reject";
          const hasExpected =
            !abstained &&
            prediction.expectedReturnPct != null &&
            prediction.expectedReturnPct !== "" &&
            Number.isFinite(Number(prediction.expectedReturnPct));
          const expected = hasExpected
            ? Number(prediction.expectedReturnPct)
            : null;
          const direction = !hasExpected
            ? "neutral"
            : expected >= 0
              ? "positive"
              : "negative";
          const Icon =
            direction === "positive"
              ? FiTrendingUp
              : direction === "negative"
                ? FiTrendingDown
                : FiActivity;
          const interval = Array.isArray(prediction.interval80Pct)
            ? prediction.interval80Pct
            : [];
          const performance = prediction.performance || {};
          const validation = getForecastValidationPresentation(prediction);
          const maeEdge = getForecastMaeEdgePct(performance);
          const evaluationCount =
            performance.uniqueEvaluationMonths ??
            performance.crossSectionalRankIcDateCount ??
            performance.sampleSize;
          const evaluationCountLabel =
            performance.uniqueEvaluationMonths != null
              ? "Mesi valutati"
              : performance.crossSectionalRankIcDateCount != null
                ? "Date IC"
                : "Osservazioni grezze";
          const rankIc =
            performance.crossSectionalRankIcMean ?? performance.rankIc;
          const maeEdgeCi = Array.isArray(performance.maeEdgeVsZeroCi95Pct)
            ? performance.maeEdgeVsZeroCi95Pct
            : [];
          const rankIcCi = Array.isArray(
            performance.crossSectionalRankIcMeanCi95
          )
            ? performance.crossSectionalRankIcMeanCi95
            : [];
          return (
            <article
              className={`financial-forecast-horizon financial-forecast-horizon--${
                direction
              }`}
              key={prediction.horizon}
            >
              <div className="financial-forecast-horizon-top">
                <div>
                  <span>Orizzonte</span>
                  <h3>{prediction.label || prediction.horizon}</h3>
                  <small className="financial-forecast-model-chip">
                    {prediction.modelDisplayName || "Ridge"}
                  </small>
                  {prediction.objectiveMode && (
                    <small className="financial-forecast-objective-chip">
                      {prediction.objectiveMode === "ranking"
                        ? "Ranking cross-sectional"
                        : prediction.objectiveMode === "classification"
                          ? "Classificazione"
                          : "Regressione"}
                    </small>
                  )}
                </div>
                <Icon aria-hidden="true" />
              </div>
              <div
                className={`financial-forecast-validation financial-forecast-validation--${validation.key}`}
                title={validation.detail}
              >
                <span>{validation.label}</span>
                <small>{validation.detail}</small>
              </div>
              <div className="financial-forecast-return">
                <span>{abstained ? "Output operativo" : centralEstimateLabel}</span>
                <strong>
                  {abstained
                    ? "Previsione sospesa"
                    : formatForecastPercent(prediction.expectedReturnPct)}
                </strong>
              </div>
              <div className="financial-forecast-range">
                <span>Intervallo previsionale 80%</span>
                <strong>
                  {formatForecastPercent(interval[0])}
                  <i>–</i>
                  {formatForecastPercent(interval[1])}
                </strong>
              </div>
              <div className="financial-forecast-probability">
                <span>{positiveFrequencyLabel}</span>
                <b>{formatForecastPercent(prediction.probabilityPositivePct, false)}</b>
              </div>
              <div
                className={`financial-forecast-quality financial-forecast-quality--${
                  prediction.quality?.key || "insufficient"
                }`}
                title={prediction.quality?.detail}
              >
                <span>Affidabilità</span>
                <strong>{prediction.quality?.label || "Non verificata"}</strong>
              </div>
              <dl className="financial-forecast-metrics">
                <div>
                  <dt title="Errore assoluto medio del modello nel periodo fuori campione">
                    MAE modello
                  </dt>
                  <dd>{formatForecastPercent(performance.oosMaePct, false)}</dd>
                </div>
                <div>
                  <dt title="Errore della previsione nulla: rendimento sempre pari a zero">
                    MAE baseline
                  </dt>
                  <dd>
                    {formatForecastPercent(performance.baselineZeroMaePct, false)}
                  </dd>
                </div>
                <div>
                  <dt title="Riduzione percentuale del MAE rispetto alla baseline nulla">
                    Vantaggio MAE
                  </dt>
                  <dd className={maeEdge != null && maeEdge < 0 ? "negative" : ""}>
                    {formatForecastPercent(maeEdge)}
                  </dd>
                </div>
                <div>
                  <dt title="Correlazione cross-sectional tra ranking previsto e osservato">
                    {performance.crossSectionalRankIcMean != null
                      ? "IC medio mensile"
                      : "Rank IC"}
                  </dt>
                  <dd>{formatForecastDecimal(rankIc)}</dd>
                </div>
                <div>
                  <dt title="Copertura empirica dell'intervallo nominale all'80%">
                    Copertura 80%
                  </dt>
                  <dd>
                    {formatForecastPercent(
                      performance.interval80CoveragePct,
                      false
                    )}
                  </dd>
                </div>
                <div>
                  <dt title={performance.sampleSizeNote || "Ampiezza della valutazione fuori campione"}>
                    {evaluationCountLabel}
                  </dt>
                  <dd>
                    {evaluationCount != null &&
                    evaluationCount !== "" &&
                    Number.isFinite(Number(evaluationCount))
                      ? Number(evaluationCount).toLocaleString("it-IT", {
                          maximumFractionDigits: 0,
                        })
                      : "N/D"}
                  </dd>
                </div>
              </dl>
              {(maeEdgeCi.length === 2 || rankIcCi.length === 2) && (
                <div className="financial-forecast-confidence">
                  {maeEdgeCi.length === 2 && (
                    <span>
                      <b>IC 95% Δ MAE</b>
                      {formatForecastPercent(maeEdgeCi[0])} –{" "}
                      {formatForecastPercent(maeEdgeCi[1])}
                    </span>
                  )}
                  {rankIcCi.length === 2 && (
                    <span>
                      <b>IC 95% Rank IC</b>
                      {formatForecastDecimal(rankIcCi[0])} –{" "}
                      {formatForecastDecimal(rankIcCi[1])}
                    </span>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>

      <ForecastDriversPanel data={data} predictions={predictions} />

      <div className="financial-forecast-audit">
        <div className="financial-forecast-audit-main">
          <FiFileText aria-hidden="true" />
          <div>
            <span>Filing realmente utilizzato</span>
            <strong>
              {data.filing?.form || "10-K"} · esercizio{" "}
              {formatForecastDate(data.filing?.reportDate)}
            </strong>
            <small>
              Pubblico dal {formatForecastDate(data.filing?.acceptedAt)}
              {data.filing?.filingAgeDays != null &&
              data.filing?.filingAgeDays !== "" &&
              Number.isFinite(Number(data.filing?.filingAgeDays))
                ? ` · ${Number(data.filing.filingAgeDays)} giorni fa`
                : ""}
            </small>
          </div>
          {data.filing?.url && (
            <a href={data.filing.url} target="_blank" rel="noreferrer">
              Apri filing
              <FiExternalLink aria-hidden="true" />
            </a>
          )}
        </div>
        <div className="financial-forecast-audit-meta">
          <span>
            <b>Modello</b>
            {data.modelSummary?.displayName || "Ridge"}
            <small>{data.modelVersion || "N/D"}</small>
          </span>
          <span>
            <b>Training fino al</b>
            {formatForecastDate(data.dataset?.trainingEnd)}
          </span>
          <span>
            <b>Copertura feature</b>
            {formatForecastPercent(data.dataQuality?.featureCoveragePct, false)}
          </span>
          <span>
            <b>Dataset</b>
            {Number(data.dataset?.rows || 0).toLocaleString("it-IT")} snapshot ·{" "}
            {Number(data.dataset?.issuers || 0).toLocaleString("it-IT")} emittenti
          </span>
          <span>
            <b>Prezzo usato</b>
            {data.dataQuality?.priceSource || "N/D"}
            <small>al {formatForecastDate(data.dataQuality?.priceAsOf)}</small>
          </span>
          <span>
            <b>Target</b>
            {data.dataset?.targetLabel ||
              data.methodology?.targetLabel ||
              "Rendimento totale futuro"}
          </span>
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="financial-forecast-warnings">
          <FiAlertTriangle aria-hidden="true" />
          <div>
            <strong>Limiti da considerare</strong>
            <ul>
              {warnings.map((warning, index) => (
                <li key={`${warning.code}-${index}`}>
                  <b>{warning.title}</b>
                  {warning.detail ? `: ${warning.detail}` : ""}
                  {warning.horizons.length
                    ? ` (${warning.horizons.join(", ")})`
                    : ""}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="financial-forecast-method">
        <FiBarChart2 aria-hidden="true" />
        <p>
          <strong>Come leggerla.</strong> Il valore centrale non è un obiettivo di
          prezzo: l’intervallo mostra quanto i risultati storici siano dispersi.
          {` ${data.methodology?.model || "Il modello fondamentale"}; ${
            data.methodology?.target ||
            "target rettificati per split e dividendi"
          } e validazione walk-forward, senza divisione casuale dei dati.`}
        </p>
        <FiActivity aria-hidden="true" />
      </div>
      <p className="financial-forecast-disclaimer">{data.disclaimer}</p>
    </section>
  );
};

const FinancialTableSkeleton = () => (
  <div className="financial-skeleton" aria-label="Caricamento bilancio">
    <div className="financial-skeleton-line financial-skeleton-line--wide" />
    <div className="financial-skeleton-line" />
    <div className="financial-skeleton-line" />
    <div className="financial-skeleton-line" />
    <div className="financial-skeleton-line" />
    <div className="financial-skeleton-line" />
  </div>
);

export default function FundamentalAnalysis({ darkMode }) {
  const [searchParams] = useSearchParams();
  const symbol = normalizeTicker(
    searchParams.get("ticker") || localStorage.getItem("lastTicker") || "AAPL"
  );
  const [activeStatement, setActiveStatement] = useState("income");
  const [frequency, setFrequency] = useState("annual");
  const [tableMode, setTableMode] = useState("reported");
  const [expanded, setExpanded] = useState(false);
  const [financialData, setFinancialData] = useState(null);
  const [annualFinancialData, setAnnualFinancialData] = useState(null);
  const [activeAdvancedSection, setActiveAdvancedSection] =
    useState("earnings-debt");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [forecastData, setForecastData] = useState(null);
  const [forecastLoading, setForecastLoading] = useState(true);
  const [forecastError, setForecastError] = useState("");
  const [forecastReloadToken, setForecastReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    const loadFinancials = async () => {
      setLoading(true);
      setError("");
      try {
        const response = await fetch(
          apiUrl(
            `/stock/${encodeURIComponent(symbol)}/financials?frequency=${frequency}`
          ),
          { signal: controller.signal }
        );
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload?.error || "Dati di bilancio non disponibili.");
        }
        setFinancialData(payload);
        if (frequency === "annual") {
          setAnnualFinancialData({ requestSymbol: symbol, payload });
        }
      } catch (requestError) {
        if (requestError?.name === "AbortError") return;
        setFinancialData(null);
        setError(requestError?.message || "Errore durante il caricamento del bilancio.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    loadFinancials();
    return () => controller.abort();
  }, [frequency, reloadToken, symbol]);

  useEffect(() => {
    setExpanded(false);
  }, [activeStatement, frequency]);

  useEffect(() => {
    const controller = new AbortController();

    const loadForecast = async () => {
      setForecastLoading(true);
      setForecastError("");
      try {
        const response = await fetch(
          apiUrl(
            `/stock/${encodeURIComponent(symbol)}/fundamental-return-forecast`
          ),
          { signal: controller.signal }
        );
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            payload?.reason
            || payload?.error
            || "Previsione fondamentale non disponibile."
          );
        }
        setForecastData(payload);
      } catch (requestError) {
        if (requestError?.name === "AbortError") return;
        setForecastData(null);
        setForecastError(
          requestError?.message || "Errore durante il caricamento del modello."
        );
      } finally {
        if (!controller.signal.aborted) setForecastLoading(false);
      }
    };

    loadForecast();
    return () => controller.abort();
  }, [forecastReloadToken, symbol]);

  const annualAnalysisData =
    annualFinancialData?.requestSymbol === symbol
      ? annualFinancialData.payload
      : null;
  const statement = financialData?.statements?.[activeStatement] || {
    periods: [],
    rows: [],
  };
  const hasDetails = statement.rows.some(row => row.detail);
  const visibleRows = useMemo(
    () => statement.rows.filter(row => expanded || !row.detail),
    [expanded, statement.rows]
  );
  const calculationPeriods = useMemo(
    () =>
      activeStatement === "income"
        ? statement.periods.filter(period => period.key !== "TTM")
        : statement.periods,
    [activeStatement, statement.periods]
  );
  const calculatedRows = useMemo(
    () =>
      buildCalculatedRows(
        financialData?.statements,
        activeStatement,
        calculationPeriods,
        frequency
      ),
    [activeStatement, calculationPeriods, financialData?.statements, frequency]
  );
  const trendCards = useMemo(
    () =>
      buildTrendCards(
        financialData?.statements,
        activeStatement,
        statement.periods
      ),
    [activeStatement, financialData?.statements, statement.periods]
  );
  const advancedAnalysis = useMemo(
    () =>
      buildAdvancedAnalysis(
        annualAnalysisData?.statements,
        annualAnalysisData?.statements?.income?.periods || [],
        "annual"
      ),
    [annualAnalysisData]
  );
  const consistencyChecks = useMemo(
    () =>
      buildConsistencyChecks(
        annualAnalysisData?.statements,
        advancedAnalysis.periods,
        {
          officialFilings: annualAnalysisData?.officialFilings,
          currency: annualAnalysisData?.currency,
          unit: annualAnalysisData?.unit,
        }
      ),
    [
      advancedAnalysis.periods,
      annualAnalysisData?.currency,
      annualAnalysisData?.officialFilings,
      annualAnalysisData?.statements,
      annualAnalysisData?.unit,
    ]
  );
  const finalSummary = useMemo(
    () =>
      buildFinalSummary(
        annualAnalysisData?.statements,
        advancedAnalysis,
        consistencyChecks
      ),
    [advancedAnalysis, annualAnalysisData?.statements, consistencyChecks]
  );
  const activeAdvancedGroup =
    advancedAnalysis.groups.find(group => group.key === activeAdvancedSection)
    || advancedAnalysis.groups[0]
    || null;
  const commonSizeConfig = COMMON_SIZE_CONFIG[activeStatement];
  const hasCommonSizeData = useMemo(
    () =>
      statement.rows.some(row =>
        statement.periods.some(
          period =>
            getCommonSizeValue(
              financialData?.statements,
              activeStatement,
              row,
              period.key
            ) != null
        )
      ),
    [
      activeStatement,
      financialData?.statements,
      statement.periods,
      statement.rows,
    ]
  );

  useEffect(() => {
    if (tableMode === "common-size" && !hasCommonSizeData) {
      setTableMode("reported");
    }
  }, [hasCommonSizeData, tableMode]);

  useEffect(() => {
    if (
      advancedAnalysis.groups.length > 0
      && !advancedAnalysis.groups.some(
        group => group.key === activeAdvancedSection
      )
    ) {
      setActiveAdvancedSection(advancedAnalysis.groups[0].key);
    }
  }, [activeAdvancedSection, advancedAnalysis.groups]);

  const quote = financialData?.quote || {};
  const currency = financialData?.currency || "";
  const dailyChange = Number(quote.dailyChange);
  const hasDailyChange = Number.isFinite(dailyChange);

  return (
    <main className={`financial-page ${darkMode ? "dark" : "light"}`}>
      <div className="financial-shell">
        <nav className="financial-nav-cards" aria-label="Sezioni del titolo">
          <button type="button" onClick={() => window.location.assign(`/search?query=${encodeURIComponent(symbol)}`)}>
            <span className="financial-nav-icon"><FiSearch /></span><span>Cerca</span>
          </button>
          <button type="button" onClick={() => window.location.assign(`/technicals?ticker=${encodeURIComponent(symbol)}`)}>
            <span className="financial-nav-icon"><FiTrendingUp /></span><span>Tecnici</span>
          </button>
          <button type="button" onClick={() => window.location.assign(`/Previsione?ticker=${encodeURIComponent(symbol)}`)}>
            <span className="financial-nav-icon"><FiClock /></span><span>Previsioni</span>
          </button>
          <button type="button" onClick={() => window.location.assign(`/Stagionalita?ticker=${encodeURIComponent(symbol)}`)}>
            <span className="financial-nav-icon"><FiCalendar /></span><span>Stagionalita</span>
          </button>
          <button type="button" onClick={() => window.location.assign(`/quantitativi?ticker=${encodeURIComponent(symbol)}`)}>
            <span className="financial-nav-icon"><FiBarChart2 /></span><span>Quantitativi</span>
          </button>
        </nav>

        <header className="financial-quote-header">
          <div className="financial-identity">
            <span className="financial-symbol">{symbol}</span>
            <div>
              <h1>{quote.shortName || symbol}</h1>
              <p>
                {[quote.exchange, currency].filter(Boolean).join(" · ") ||
                  "Dati finanziari"}
              </p>
            </div>
          </div>

          <div className="financial-price-block">
            <strong>{formatPrice(quote.currentPrice, currency)}</strong>
            {hasDailyChange && (
              <span className={dailyChange >= 0 ? "positive" : "negative"}>
                {dailyChange >= 0 ? "+" : ""}
                {dailyChange.toFixed(2)}%
              </span>
            )}
          </div>
        </header>

        <section className="financial-card">
          <div className="financial-card-heading">
            <div>
              <span className="financial-eyebrow">Dati societari</span>
              <h2>Bilancio</h2>
            </div>

            <div className="financial-frequency" aria-label="Frequenza dati">
              <button
                type="button"
                className={frequency === "annual" ? "active" : ""}
                onClick={() => setFrequency("annual")}
              >
                Annuale
              </button>
              <button
                type="button"
                className={frequency === "quarterly" ? "active" : ""}
                onClick={() => setFrequency("quarterly")}
              >
                Trimestrale
              </button>
            </div>
          </div>

          <nav className="financial-tabs" aria-label="Prospetti finanziari">
            {STATEMENT_TABS.map(tab => (
              <button
                key={tab.key}
                type="button"
                className={activeStatement === tab.key ? "active" : ""}
                onClick={() => setActiveStatement(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          {!loading && !error && trendCards.length > 0 && (
            <section className="financial-trends" aria-labelledby="financial-trends-title">
              <div className="financial-trends-heading">
                <div>
                  <span className="financial-eyebrow">Andamento storico</span>
                  <h3 id="financial-trends-title">
                    {STATEMENT_TABS.find(tab => tab.key === activeStatement)?.label}
                  </h3>
                </div>
                <p>
                  {frequency === "annual"
                    ? "Fino a 10 esercizi, dal meno recente al più recente."
                    : "Fino a 12 trimestri, dal meno recente al più recente."}
                </p>
              </div>
              <div className="financial-trend-grid">
                {trendCards.map(chart => (
                  <TrendChartCard
                    key={chart.key}
                    chart={chart}
                    currency={currency}
                    darkMode={darkMode}
                  />
                ))}
              </div>
            </section>
          )}

          <div className="financial-table-toolbar">
            <span>
              {tableMode === "common-size"
                ? `Vista common-size · ${commonSizeConfig?.label || "% della base"}`
                : `Tutti i valori in migliaia${
                    currency ? ` · Valuta ${currency}` : ""
                  }`}
            </span>
            <div className="financial-table-toolbar-actions">
              <div className="financial-view-switch" aria-label="Vista tabella">
                <button
                  type="button"
                  className={tableMode === "reported" ? "active" : ""}
                  aria-pressed={tableMode === "reported"}
                  onClick={() => setTableMode("reported")}
                >
                  Valori
                </button>
                <button
                  type="button"
                  className={tableMode === "common-size" ? "active" : ""}
                  aria-pressed={tableMode === "common-size"}
                  disabled={!hasCommonSizeData}
                  onClick={() => setTableMode("common-size")}
                  title={
                    hasCommonSizeData
                      ? "Mostra ogni voce come percentuale della base"
                      : "Base common-size non disponibile"
                  }
                >
                  Common-size
                </button>
              </div>
              {hasDetails && (
                <button
                  className="financial-expand-button"
                  type="button"
                  onClick={() => setExpanded(value => !value)}
                >
                  {expanded ? (
                    <FiChevronDown aria-hidden="true" />
                  ) : (
                    <FiChevronRight aria-hidden="true" />
                  )}
                  {expanded ? "Comprimi" : "Espandi tutto"}
                </button>
              )}
            </div>
          </div>

          {loading ? (
            <FinancialTableSkeleton />
          ) : error ? (
            <div className="financial-error">
              <strong>Impossibile caricare il bilancio</strong>
              <p>{error}</p>
              <button type="button" onClick={() => setReloadToken(value => value + 1)}>
                <FiRefreshCw aria-hidden="true" />
                Riprova
              </button>
            </div>
          ) : visibleRows.length ? (
            <div
              className={`financial-table-scroll ${
                expanded ? "financial-table-scroll--expanded" : ""
              }`}
            >
              <table className="financial-table">
                <thead>
                  <tr>
                    <th scope="col">Dettaglio</th>
                    {statement.periods.map(period => (
                      <th scope="col" key={period.key}>
                        {formatPeriod(period.label)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map(row => (
                    <tr
                      key={row.key}
                      className={row.detail ? "financial-detail-row" : ""}
                    >
                      <th scope="row">
                        {row.detail && <span className="financial-row-indent" />}
                        {row.label}
                      </th>
                      {statement.periods.map(period => {
                        const reportedValue = row.values?.[period.key];
                        const value =
                          tableMode === "common-size"
                            ? getCommonSizeValue(
                                financialData?.statements,
                                activeStatement,
                                row,
                                period.key
                              )
                            : reportedValue;
                        return (
                          <td
                            key={period.key}
                            className={Number(value) < 0 ? "negative-value" : ""}
                          >
                            {tableMode === "common-size"
                              ? formatCommonSizeValue(value)
                              : formatStatementValue(value, row.format)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="financial-empty">
              Nessun dato disponibile per questo prospetto.
            </div>
          )}

          {!loading && !error && calculatedRows.length > 0 && (
            <div className="financial-calculations">
              <div className="financial-calculations-heading">
                <div>
                  <span className="financial-eyebrow">Analisi derivata</span>
                  <h3>{CALCULATION_TITLES[activeStatement]}</h3>
                </div>
                <p>Calcoli ottenuti dai valori di bilancio dello stesso periodo.</p>
              </div>

              {["income", "balance"].includes(activeStatement) && (
                <div className="financial-assessment-panel">
                  <div className="financial-assessment-legend" aria-label="Legenda valutazioni">
                    <span className="financial-assessment financial-assessment--excellent">
                      Ottimo
                    </span>
                    <span className="financial-assessment financial-assessment--good">
                      Buono
                    </span>
                    <span className="financial-assessment financial-assessment--weak">
                      Neutro
                    </span>
                    <span className="financial-assessment financial-assessment--poor">
                      Pessimo
                    </span>
                    <span className="financial-assessment financial-assessment--neutral">
                      N/D
                    </span>
                  </div>
                  {activeStatement === "income" ? (
                    <p>
                      Valutazione assoluta, senza confronti con altre aziende:
                      margine lordo 50 / 30 / 10%, margini operativo e netto
                      20 / 10 / 5%, ROIC 15 / 10 / 5%. L&apos;Operating income
                      usa solo la crescita {frequency === "quarterly" ? "YoY" : "annuale"}{" "}
                      della stessa società.
                    </p>
                  ) : (
                    <p>
                      Soglie assolute indicative, senza confronti esterni. Liquidità:
                      Current 2 / 1,5 / 1x, Quick 1,5 / 1 / 0,5x, immediata
                      1 / 0,5 / 0,2x. Leva: D/E 0,43 / 1 / 2,33x e
                      Debito/Capitale 30 / 50 / 70%; per la leva valori più bassi
                      sono migliori. Current liabilities e NWC sono giudicati sulla
                      copertura, non sull&apos;importo.
                    </p>
                  )}
                </div>
              )}

              <div className="financial-calculations-scroll">
                <table className="financial-calculations-table">
                  <thead>
                    <tr>
                      <th scope="col">Indicatore</th>
                      <th scope="col" className="financial-calculation-formula-heading">
                        Formula
                      </th>
                      {calculationPeriods.map(period => (
                        <th scope="col" key={period.key}>
                          {formatPeriod(period.label)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {calculatedRows.map(row => (
                      <tr key={row.key}>
                        <th scope="row">{row.label}</th>
                        <td className="financial-calculation-formula">{row.formula}</td>
                        {calculationPeriods.map(period => {
                          const value = toFinancialNumber(row.values[period.key]);
                          const assessmentValue = row.assessmentValues
                            ? toFinancialNumber(row.assessmentValues[period.key])
                            : value;
                          const assessmentContext =
                            row.assessmentContexts?.[period.key] || null;
                          const assessment =
                            activeStatement === "income"
                              ? evaluateIncomeIndicator(
                                  row,
                                  value,
                                  period.key,
                                  calculationPeriods.map(item => item.key),
                                  frequency
                                )
                              : activeStatement === "balance"
                                ? evaluateBalanceIndicator(
                                    row,
                                    value,
                                    assessmentValue,
                                    assessmentContext
                                  )
                                : null;
                          const valueClass =
                            row.signed && value != null && value < 0
                              ? "negative-value"
                              : "";
                          return (
                            <td className={valueClass} key={period.key}>
                              <div className="financial-calculated-value">
                                <span>{formatCalculatedValue(value, row.format)}</span>
                                {assessment && (
                                  <span
                                    className={`financial-assessment financial-assessment--${assessment.key}`}
                                    title={assessment.detail}
                                  >
                                    {assessment.label}
                                  </span>
                                )}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>

        {activeAdvancedGroup && (
          <section className="financial-card financial-advanced-card">
            <div className="financial-advanced-heading">
              <div>
                <span className="financial-eyebrow">Analisi avanzata</span>
                <h2>Qualità, rendimento e impiego del capitale</h2>
              </div>
              <p>Analisi annuale · fino a 10 esercizi disponibili</p>
            </div>

            <nav
              className="financial-advanced-selector"
              aria-label="Sezioni dell’analisi avanzata"
              role="tablist"
            >
              {advancedAnalysis.groups.map(group => {
                const isActive = group.key === activeAdvancedGroup.key;
                return (
                  <button
                    type="button"
                    id={`financial-advanced-tab-${group.key}`}
                    className={isActive ? "active" : ""}
                    role="tab"
                    aria-selected={isActive}
                    aria-controls={`financial-advanced-panel-${group.key}`}
                    tabIndex={isActive ? 0 : -1}
                    key={group.key}
                    onClick={() => setActiveAdvancedSection(group.key)}
                  >
                    <span>{group.eyebrow}</span>
                    <strong>{group.title}</strong>
                  </button>
                );
              })}
            </nav>

            <AdvancedAnalysisPanel
              group={activeAdvancedGroup}
              periods={advancedAnalysis.periods}
            />
          </section>
        )}

        {annualAnalysisData && (
          <section className="financial-card financial-verification-card">
            <div className="financial-verification-heading">
              <div>
                <span className="financial-eyebrow">Verifica documentale</span>
                <h2>Fonti ufficiali, note e coerenza</h2>
              </div>
              <p>
                Valori:{" "}
                {annualAnalysisData.dataProvenance?.statementPrimary
                  || "fonte finanziaria primaria"}
                {annualAnalysisData.dataProvenance?.statementFallback
                  ? ` · integrazione ${annualAnalysisData.dataProvenance.statementFallback}`
                  : ""}
              </p>
            </div>

            <div className="financial-verification-grid">
              <OfficialFilingsPanel
                filings={annualAnalysisData.officialFilings}
              />
              <ConsistencyChecksPanel checks={consistencyChecks} />
            </div>

            <DataNotesPanel
              currency={annualAnalysisData.currency}
              provenance={annualAnalysisData.dataProvenance}
            />
          </section>
        )}

        {annualAnalysisData && <FinalSummaryPanel summary={finalSummary} />}

        <FundamentalForecastPanel
          data={forecastData}
          loading={forecastLoading}
          error={forecastError}
          onRetry={() => setForecastReloadToken(value => value + 1)}
        />

        <p className="financial-disclaimer">
          I dati sono informativi e possono differire dai documenti depositati dalla
          società. Per decisioni finanziarie consulta sempre le comunicazioni ufficiali.
        </p>
      </div>
    </main>
  );
}
