import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useSearchParams } from "react-router-dom";
import { Bar, Line, Scatter } from "react-chartjs-2";
import {
  BarElement,
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
  FiAlertCircle,
  FiBookOpen,
  FiCalendar,
  FiDatabase,
  FiDownload,
  FiImage,
  FiPrinter,
  FiRefreshCw,
  FiShield,
  FiSliders,
  FiSearch,
  FiClock,
  FiTrendingUp,
} from "react-icons/fi";
import { apiUrl } from "../services/apiBase";
import {
  analysisToCsv,
  buildBenchmarkComparison,
  buildDriverRegressionAnalysis,
  buildMultipleRegressionAnalysis,
  buildMonteCarloSimulation,
  buildAdvancedQuantitativeAnalytics,
  buildQuantitativeAnalysis,
} from "../utils/quantitativeAnalytics";
import TradingViewStockHeatmap from "./TradingViewStockHeatmap";
import "./QuantitativeAnalysis.css";

ChartJS.register(
  BarElement,
  CategoryScale,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip
);

const RANGE_OPTIONS = [
  { value: "1y", label: "1 anno", years: 1 },
  { value: "3y", label: "3 anni", years: 3 },
  { value: "5y", label: "5 anni", years: 5 },
  { value: "10y", label: "10 anni", years: 10 },
];
const FREQUENCY_OPTIONS = [
  { value: "1d", label: "Giornaliera" },
  { value: "1wk", label: "Settimanale" },
  { value: "1mo", label: "Mensile" },
];
const PRICE_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "adjusted", label: "Adjusted" },
  { value: "close", label: "Close" },
];
const RETURN_OPTIONS = [
  { value: "simple", label: "Semplice" },
  { value: "log", label: "Logaritmico" },
];
const BIN_OPTIONS = [
  { value: "fd", label: "Freedman–Diaconis" },
  { value: "scott", label: "Scott" },
  { value: "sturges", label: "Sturges" },
  { value: "manual", label: "Manuale" },
];
const SCALE_OPTIONS = [
  { value: "count", label: "Conteggio" },
  { value: "density", label: "Densità" },
];
const BASE_BENCHMARKS = [
  { value: "SPY", label: "SPY · S&P 500 ETF" },
  { value: "QQQ", label: "QQQ · Nasdaq 100 ETF" },
  { value: "IWM", label: "IWM · Russell 2000 ETF" },
];
const SECTOR_ETFS = {
  "basic materials": ["XLB", "Materiali"],
  materials: ["XLB", "Materiali"],
  "communication services": ["XLC", "Comunicazioni"],
  "consumer cyclical": ["XLY", "Consumi discrezionali"],
  "consumer defensive": ["XLP", "Beni di consumo"],
  energy: ["XLE", "Energia"],
  "financial services": ["XLF", "Finanziari"],
  financials: ["XLF", "Finanziari"],
  healthcare: ["XLV", "Salute"],
  industrials: ["XLI", "Industriali"],
  "real estate": ["XLRE", "Immobiliare"],
  technology: ["XLK", "Tecnologia"],
  utilities: ["XLU", "Utility"],
};
const TAB_OPTIONS = [
  ["distribution", "Distribuzione"],
  ["risk", "Rischio"],
  ["montecarlo", "Monte Carlo"],
  ["heatmap", "Heat map"],
  ["methodology", "Metodologia"],
];
const ENGINE_DEFAULTS = {
  years: 5,
  frequency: "1d",
  priceMode: "auto",
  returnType: "simple",
  binMethod: "fd",
  confidence: 0.95,
};

const normalizeTicker = (value) =>
  String(value || "").trim().toUpperCase().replace(/\s+/g, "");
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finiteNumber = (value) => {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

export const resolveQuantitativeTab = (value) => (
  TAB_OPTIONS.some(([tab]) => tab === value) ? value : "distribution"
);

export const resolveRegressionModel = (value) => (
  value === "multi" || value === "drivers" ? value : "single"
);

export const insertGapSeparators = (series = []) => {
  const rows = Array.isArray(series) ? series : [];
  return rows.reduce((display, point, index) => {
    if (index > 0 && point?.gapBefore === true) {
      display.push({
        date: `gap-${point?.previousDate || rows[index - 1]?.date || index}-${point?.date || index}`,
        separator: true,
      });
    }
    display.push({ ...point, separator: false });
    return display;
  }, []);
};

export const buildDailyReturnDistribution = (history, options = {}) =>
  buildQuantitativeAnalysis(history, { ...ENGINE_DEFAULTS, ...options });

export const buildDailyReturnSeries = (history, options = {}) => {
  const analysis = buildDailyReturnDistribution(history, options);
  return (analysis?.points || []).map((point) => ({
    date: point.date,
    value: point.returnPct,
  }));
};

export const buildPriceDistribution = buildDailyReturnDistribution;

const formatNumber = (value, digits = 2) => {
  const numeric = finiteNumber(value);
  if (numeric === null) return "—";
  return new Intl.NumberFormat("it-IT", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(numeric);
};
const formatSignedPercentage = (value, digits = 2) => {
  const numeric = finiteNumber(value);
  if (numeric === null) return "—";
  const normalized = Math.abs(numeric) < 0.5 * 10 ** -digits ? 0 : numeric;
  return `${new Intl.NumberFormat("it-IT", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    signDisplay: "exceptZero",
  }).format(normalized)}%`;
};
const formatUnsignedPercentage = (value, digits = 2) => {
  const numeric = finiteNumber(value);
  return numeric === null ? "—" : `${formatNumber(Math.abs(numeric), digits)}%`;
};
const formatPlainPercentage = (value, digits = 2) => {
  const numeric = finiteNumber(value);
  return numeric === null ? "—" : `${formatNumber(numeric, digits)}%`;
};
const formatPValue = (value) => {
  const numeric = finiteNumber(value);
  if (numeric === null) return "—";
  if (numeric < 0.001) return "< 0,001";
  return formatNumber(numeric, 3);
};
const formatVariance = (value) => {
  const numeric = finiteNumber(value);
  return numeric === null ? "—" : `${formatNumber(numeric, 4)} %²`;
};
const formatDate = (dateValue) => {
  const raw = String(dateValue || "");
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("it-IT", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
};
const formatDateTime = (dateValue) => {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("it-IT", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Rome",
  }).format(date);
};
const compactInteger = (value) => {
  const numeric = finiteNumber(value);
  return numeric === null ? "—" : Math.round(numeric).toLocaleString("it-IT");
};
const getBinDigits = (bin) => {
  const width = Math.abs(Number(bin?.end) - Number(bin?.start));
  return !Number.isFinite(width) || width <= 0
    ? 2
    : clamp(Math.ceil(-Math.log10(width)) + 1, 2, 4);
};
const binLabel = (bin) => {
  const digits = getBinDigits(bin);
  return `${formatSignedPercentage(bin?.start, digits)}–${formatSignedPercentage(bin?.end, digits)}`;
};

const csvCell = (value) => {
  if (value === null || value === undefined || (typeof value === "number" && !Number.isFinite(value))) {
    return "";
  }
  const raw = String(value);
  return /[",\n\r]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
};

export const buildQuantitativeCsvExport = ({
  analysis,
  ticker = "",
  historyPayload = {},
  benchmark = "",
  benchmarkComparison = null,
  multipleRegression = null,
  multiFactorLineage = {},
  multipleRegressionStatus = "",
  multipleRegressionReason = "",
  regressionModel = "single",
  config = {},
} = {}) => {
  if (!analysis) return "";
  const exportedMultiStatus = multipleRegressionStatus
    || (multipleRegression ? "disponibile" : "non_richiesta");
  const exportedMultiReason = multipleRegressionReason
    || (multipleRegression ? "Modello multifattoriale stimato." : "Analisi multifattoriale non caricata per questa esportazione.");
  const metadata = [
    ["anagrafica", "ticker", ticker],
    ["anagrafica", "ticker_richiesto", historyPayload?.requestedTicker],
    ["anagrafica", "ticker_risolto", historyPayload?.resolvedTicker],
    ["anagrafica", "sorgente", historyPayload?.dataSource],
    ["anagrafica", "generato_il", historyPayload?.generatedAt],
    ["campione", "range_richiesto_da", historyPayload?.rangeStart || analysis.requestedFirstDate],
    ["campione", "range_richiesto_a", historyPayload?.rangeEnd || analysis.requestedLastDate],
    ["campione", "range_analisi_da", analysis.firstDate],
    ["campione", "range_analisi_a", analysis.lastDate],
    ["campione", "osservazioni", analysis.observations],
    ["campione", "fonte_prezzo", analysis.priceSource],
    ["campione", "copertura_adjusted_pct", analysis.quality?.adjustedCoveragePct ?? historyPayload?.adjustedCloseCoveragePct],
    ["campione", "percorso_continuo", analysis.pathContinuous],
    ["campione", "gap_esclusi", analysis.quality?.returnsExcludedForGap],
    ["campione", "coppie_mancanti_escluse", analysis.quality?.skippedMissingPairs],
    ["configurazione", "periodo", config.range],
    ["configurazione", "frequenza", analysis.frequency || config.frequency],
    ["configurazione", "tipo_rendimento", analysis.returnType || config.returnType],
    ["configurazione", "modalita_prezzo", config.priceMode],
    ["configurazione", "confidenza_var", analysis.confidence ?? config.confidence],
    ["configurazione", "metodo_bin", analysis.histogram?.method || config.binMethod],
    ["configurazione", "numero_bin_richiesto", config.binCount],
    ["configurazione", "numero_bin", analysis.histogram?.bins?.length],
    ["configurazione", "scala_istogramma", config.histogramScale],
    ["configurazione", "overlay_normale", config.overlayNormal],
    ["configurazione", "modello_regressione", resolveRegressionModel(regressionModel)],
    ["metrica", "media_pct", analysis.mean],
    ["metrica", "mediana_pct", analysis.median],
    ["metrica", "varianza_pct2", analysis.variance],
    ["metrica", "deviazione_standard_pct", analysis.standardDeviation],
    ["metrica", "asimmetria", analysis.skewness],
    ["metrica", "curtosi_eccesso", analysis.excessKurtosis],
    ["metrica", "iqr_pct", analysis.iqr],
    ["metrica", "mad_pct", analysis.mad],
    ["rischio", "var_95_pct_perdita", analysis.valueAtRisk?.p95],
    ["rischio", "es_95_pct_perdita", analysis.expectedShortfall?.p95],
    ["rischio", "var_99_pct_perdita", analysis.valueAtRisk?.p99],
    ["rischio", "es_99_pct_perdita", analysis.expectedShortfall?.p99],
    ["rischio", "volatilita_annualizzata_pct", analysis.annualizedVolatility],
    ["rischio", "rendimento_cumulato_pct", analysis.cumulativeReturn],
    ["rischio", "cagr_pct", analysis.cagr],
    ["rischio", "max_drawdown_pct", analysis.maxDrawdown],
    ["rischio_avanzato", "downside_deviation_pct", analysis.advanced?.downsideDeviationPct],
    ["rischio_avanzato", "downside_deviation_annualizzata_pct", analysis.advanced?.annualizedDownsideDeviationPct],
    ["rischio_avanzato", "upside_deviation_pct", analysis.advanced?.upsideDeviationPct],
    ["rischio_avanzato", "upside_deviation_annualizzata_pct", analysis.advanced?.annualizedUpsideDeviationPct],
    ["rischio_avanzato", "omega_ratio_soglia_zero", analysis.advanced?.omegaRatioZero],
    ["rischio_avanzato", "gain_loss_ratio", analysis.advanced?.gainLossRatio],
    ["rischio_avanzato", "tail_ratio", analysis.advanced?.tailRatio],
    ["rischio_avanzato", "autocorrelazione_lag_1", analysis.advanced?.autocorrelationLag1],
    ["rischio_avanzato", "autocorrelazione_quadrati_lag_1", analysis.advanced?.squaredReturnAutocorrelationLag1],
    ["rischio_avanzato", "z_score_ultimo_rendimento", analysis.advanced?.lastReturnZScore],
    ["benchmark", "ticker", benchmark],
    ["benchmark", "osservazioni_comuni", benchmarkComparison?.observations],
    ["benchmark", "percorso_continuo", benchmarkComparison?.pathContinuous],
    ["benchmark", "gap_percorso", benchmarkComparison?.pathGapCount],
    ["benchmark", "beta", benchmarkComparison?.beta],
    ["benchmark", "alpha_regressione_ann_pct", benchmarkComparison?.alphaAnnualized],
    ["benchmark", "correlazione", benchmarkComparison?.correlation],
    ["benchmark", "r_quadro", benchmarkComparison?.rSquared],
    ["benchmark", "tracking_error_pct", benchmarkComparison?.trackingError],
    ["benchmark", "information_ratio", benchmarkComparison?.informationRatio],
    ["benchmark", "capture_up_pct", benchmarkComparison?.upsideCapture],
    ["benchmark", "capture_up_n", benchmarkComparison?.capture?.upside?.observations],
    ["benchmark", "capture_down_pct", benchmarkComparison?.downsideCapture],
    ["benchmark", "capture_down_n", benchmarkComparison?.capture?.downside?.observations],
    ["regressione", "metodo", benchmarkComparison?.regression?.method],
    ["regressione", "osservazioni", benchmarkComparison?.regression?.observations],
    ["regressione", "gradi_liberta", benchmarkComparison?.regression?.degreesOfFreedom],
    ["regressione", "beta_slope", benchmarkComparison?.regression?.slope],
    ["regressione", "intercetta_periodo_pct", benchmarkComparison?.regression?.interceptPct],
    ["regressione", "intercetta_annualizzata_pct", benchmarkComparison?.regression?.interceptAnnualizedPct],
    ["regressione", "r_quadro", benchmarkComparison?.regression?.rSquared],
    ["regressione", "r_quadro_aggiustato", benchmarkComparison?.regression?.adjustedRSquared],
    ["regressione", "rse_pct", benchmarkComparison?.regression?.residualStandardErrorPct],
    ["regressione", "rmse_pct", benchmarkComparison?.regression?.rmsePct],
    ["regressione", "mae_pct", benchmarkComparison?.regression?.maePct],
    ["regressione", "se_beta_hac", benchmarkComparison?.regression?.standardErrors?.slopeHac],
    ["regressione", "se_intercetta_hac_pct", benchmarkComparison?.regression?.standardErrors?.interceptHacPct],
    ["regressione", "se_beta_ols", benchmarkComparison?.regression?.standardErrors?.slopeOls],
    ["regressione", "se_intercetta_ols_pct", benchmarkComparison?.regression?.standardErrors?.interceptOlsPct],
    ["regressione", "z_beta_hac", benchmarkComparison?.regression?.zStatistics?.slope],
    ["regressione", "z_intercetta_hac", benchmarkComparison?.regression?.zStatistics?.intercept],
    ["regressione", "p_beta_hac", benchmarkComparison?.regression?.pValues?.slope],
    ["regressione", "p_intercetta_hac", benchmarkComparison?.regression?.pValues?.intercept],
    ["regressione", "ci95_beta_min", benchmarkComparison?.regression?.confidence95?.slope?.[0]],
    ["regressione", "ci95_beta_max", benchmarkComparison?.regression?.confidence95?.slope?.[1]],
    ["regressione", "ci95_intercetta_min_pct", benchmarkComparison?.regression?.confidence95?.interceptPct?.[0]],
    ["regressione", "ci95_intercetta_max_pct", benchmarkComparison?.regression?.confidence95?.interceptPct?.[1]],
    ["regressione", "newey_west_lag", benchmarkComparison?.regression?.neweyWestLag],
    ["regressione", "adeguatezza_campione", benchmarkComparison?.regression?.sampleAdequacy],
    ["diagnostica_regressione", "durbin_watson", benchmarkComparison?.regression?.diagnostics?.durbinWatson],
    ["diagnostica_regressione", "autocorrelazione_residui_lag_1", benchmarkComparison?.regression?.diagnostics?.autocorrelationLag1],
    ["diagnostica_regressione", "jarque_bera", benchmarkComparison?.regression?.diagnostics?.jarqueBera],
    ["diagnostica_regressione", "jarque_bera_p_value", benchmarkComparison?.regression?.diagnostics?.jarqueBeraPValue],
    ["diagnostica_regressione", "asimmetria_residui", benchmarkComparison?.regression?.diagnostics?.residualSkewness],
    ["diagnostica_regressione", "curtosi_eccesso_residui", benchmarkComparison?.regression?.diagnostics?.residualExcessKurtosis],
    ["diagnostica_regressione", "outlier_standardizzati", benchmarkComparison?.regression?.diagnostics?.outlierCount],
    ["rolling_regressione", "finestra_periodi", benchmarkComparison?.regression?.rolling?.window],
    ["regressione_multifattoriale", "metodo", multipleRegression?.method],
    ["regressione_multifattoriale", "famiglia_modello", multipleRegression?.modelFamily || "proxy"],
    ["regressione_multifattoriale", "stato", exportedMultiStatus],
    ["regressione_multifattoriale", "motivo", exportedMultiReason],
    ["regressione_multifattoriale", "osservazioni_comuni", multipleRegression?.observations],
    ["regressione_multifattoriale", "campione_da", multipleRegression?.firstDate],
    ["regressione_multifattoriale", "campione_a", multipleRegression?.lastDate],
    ["regressione_multifattoriale", "numero_fattori", multipleRegression?.predictorCount],
    ["regressione_multifattoriale", "gradi_liberta", multipleRegression?.degreesOfFreedom],
    ["regressione_multifattoriale", "alpha_periodo_pct", multipleRegression?.intercept?.estimatePct],
    ["regressione_multifattoriale", "alpha_annualizzato_pct", multipleRegression?.intercept?.annualizedPct],
    ["regressione_multifattoriale", "r_quadro", multipleRegression?.rSquared],
    ["regressione_multifattoriale", "r_quadro_aggiustato", multipleRegression?.adjustedRSquared],
    ["regressione_multifattoriale", "rse_pct", multipleRegression?.residualStandardErrorPct],
    ["regressione_multifattoriale", "rmse_pct", multipleRegression?.rmsePct],
    ["regressione_multifattoriale", "mae_pct", multipleRegression?.maePct],
    ["regressione_multifattoriale", "aic", multipleRegression?.aic],
    ["regressione_multifattoriale", "bic", multipleRegression?.bic],
    ["regressione_multifattoriale", "newey_west_lag", multipleRegression?.neweyWestLag],
    ["regressione_multifattoriale", "max_vif", multipleRegression?.diagnostics?.maxVif],
    ["regressione_multifattoriale", "condition_number", multipleRegression?.diagnostics?.conditionNumber],
    ["regressione_multifattoriale", "rank", multipleRegression?.diagnostics?.rank],
    ["regressione_multifattoriale", "adeguatezza_campione", multipleRegression?.sampleAdequacy],
  ];
  Object.entries(multiFactorLineage || {}).forEach(([sourceTicker, lineage]) => {
    metadata.push(
      ["lineage_proxy", `${sourceTicker}_ticker_richiesto`, lineage?.requestedTicker],
      ["lineage_proxy", `${sourceTicker}_ticker_risolto`, lineage?.resolvedTicker],
      ["lineage_proxy", `${sourceTicker}_sorgente`, lineage?.dataSource],
      ["lineage_proxy", `${sourceTicker}_generato_il`, lineage?.generatedAt],
      ["lineage_proxy", `${sourceTicker}_range_effettivo_da`, lineage?.actualStart],
      ["lineage_proxy", `${sourceTicker}_range_effettivo_a`, lineage?.actualEnd],
      ["lineage_proxy", `${sourceTicker}_fonte_prezzo`, lineage?.priceSource],
      ["lineage_proxy", `${sourceTicker}_copertura_adjusted_pct`, lineage?.adjustedCloseCoveragePct]
    );
  });
  const metadataCsv = [
    "sezione,campo,valore",
    ...metadata.map((row) => row.map(csvCell).join(",")),
  ].join("\n");
  const regression = benchmarkComparison?.regression;
  const fittedCsv = (regression?.fittedSeries || []).length
    ? `\n\nregressione_serie\ndata,benchmark_return_pct,titolo_return_pct,fitted_pct,residuo_pct,residuo_standardizzato\n${regression.fittedSeries
      .map((point) => [point.date, point.x, point.y, point.fitted, point.residual, point.standardizedResidual].map(csvCell).join(","))
      .join("\n")}`
    : "";
  const bandCsv = (regression?.confidenceBand || []).length
    ? `\n\nbanda_confidenza_95\nbenchmark_return_pct,limite_inferiore_pct,limite_superiore_pct\n${regression.confidenceBand
      .map((point) => [point.x, point.lower, point.upper].map(csvCell).join(","))
      .join("\n")}`
    : "";
  const rollingCsv = (regression?.rolling?.series || []).length
    ? `\n\nrolling_regressione\ndata,beta,r_quadro,alpha_annualizzata_pct\n${regression.rolling.series
      .map((point) => [point.date, point.beta, point.rSquared, point.alphaAnnualizedPct].map(csvCell).join(","))
      .join("\n")}`
    : "";
  const multiFactorCsv = (multipleRegression?.factors || []).length
    ? `\n\nregressione_multifattoriale_fattori\nchiave,etichetta,ticker_sorgente,ticker_sottratto\n${multipleRegression.factors
      .map((factor) => [factor.key, factor.label, factor.sourceTicker, factor.subtractTicker].map(csvCell).join(","))
      .join("\n")}`
    : "";
  const multiCoefficientCsv = (multipleRegression?.coefficients || []).length
    ? `\n\nregressione_multifattoriale_coefficienti\nchiave,etichetta,stima,se_hac,se_ols,z,p_value,ic95_min,ic95_max,vif,delta_r_quadro_loo_in_sample,delta_r_quadro_aggiustato_loo_in_sample\n${multipleRegression.coefficients
      .map((coefficient) => [
        coefficient.key,
        coefficient.label,
        coefficient.estimate,
        coefficient.seHac,
        coefficient.seOls,
        coefficient.z,
        coefficient.pValue,
        coefficient.confidence95?.[0],
        coefficient.confidence95?.[1],
        coefficient.vif,
        coefficient.incrementalRSquared,
        coefficient.incrementalAdjustedRSquared,
      ].map(csvCell).join(","))
      .join("\n")}`
    : "";
  const multiModelsCsv = (multipleRegression?.modelComparisons || []).length
    ? `\n\nregressione_multifattoriale_modelli\nchiave,etichetta,fattori,osservazioni,r_quadro,r_quadro_aggiustato,rmse_pct,aic,bic\n${multipleRegression.modelComparisons
      .map((model) => [
        model.key,
        model.label,
        (model.predictorKeys || []).join("|"),
        model.observations,
        model.rSquared,
        model.adjustedRSquared,
        model.rmsePct,
        model.aic,
        model.bic,
      ].map(csvCell).join(","))
      .join("\n")}`
    : "";
  const multiContributionKeys = (multipleRegression?.factors || []).map((factor) => factor.key);
  const multiFittedCsv = (multipleRegression?.fittedSeries || []).length
    ? `\n\nregressione_multifattoriale_serie\ndata,osservato_pct,stimato_pct,residuo_pct,residuo_standardizzato${multiContributionKeys.map((key) => `,fattore_${csvCell(key)}_pct`).join("")}${multiContributionKeys.map((key) => `,contributo_${csvCell(key)}_pct`).join("")}\n${multipleRegression.fittedSeries
      .map((point) => [
        point.date,
         point.observedPct,
        point.fittedPct,
        point.residualPct,
        point.standardizedResidual,
        ...multiContributionKeys.map((key) => point.factorValues?.[key]),
        ...multiContributionKeys.map((key) => point.contributions?.[key]),
      ].map(csvCell).join(","))
      .join("\n")}`
    : "";
  return `${metadataCsv}\n\nserie_storica\n${analysisToCsv(analysis, ticker)}${fittedCsv}${bandCsv}${rollingCsv}${multiFactorCsv}${multiCoefficientCsv}${multiModelsCsv}${multiFittedCsv}`;
};

const fetchJson = async (url, signal) => {
  const response = await fetch(url, { signal });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || "Dati temporaneamente non disponibili.");
  return payload;
};

export const fetchMultipleProxyHistories = async ({
  tickers = [],
  range = "5y",
  signal,
  reusedPayloads = {},
} = {}) => {
  const normalizedTickers = [...new Set(tickers.map(normalizeTicker).filter(Boolean))];
  const payloads = { ...reusedPayloads };
  const errors = {};
  const tickersToFetch = normalizedTickers.filter((sourceTicker) => !payloads[sourceTicker]);
  const results = await Promise.allSettled(tickersToFetch.map((sourceTicker) => (
    fetchJson(
      apiUrl(`/stock/${encodeURIComponent(sourceTicker)}/history?timeframe=1d&range=${range}`),
      signal
    )
  )));
  results.forEach((result, index) => {
    const sourceTicker = tickersToFetch[index];
    if (result.status === "fulfilled") payloads[sourceTicker] = result.value;
    else if (result.reason?.name !== "AbortError") {
      errors[sourceTicker] = result.reason?.message || "Storico non disponibile.";
    }
  });
  return { payloads, errors };
};

export const buildMultipleFactorPlan = ({
  ticker = "",
  targetAliases = [],
  targetPriceSource = "",
  sectorEtf = null,
  analyses = {},
  sourceMetadata = {},
  sourceErrors = {},
} = {}) => {
  const target = normalizeTicker(ticker);
  const targetIdentity = new Set([target, ...targetAliases.map(normalizeTicker)].filter(Boolean));
  const targetIsSpy = targetIdentity.has("SPY");
  const factors = [];
  const exclusions = [];
  const missingSources = [];
  const incompatibleSources = [];
  const marketAnalysis = analyses.SPY || null;
  const addMissing = (sourceTicker) => {
    const normalized = normalizeTicker(sourceTicker);
    if (!normalized || missingSources.some((item) => item.ticker === normalized)) return;
    missingSources.push({
      ticker: normalized,
      message: sourceErrors?.[normalized] || "Storico non disponibile.",
    });
  };
  const hasCompatiblePriceSource = (sourceTicker) => {
    const source = normalizeTicker(sourceTicker);
    const sourcePrice = analyses?.[source]?.priceSource;
    if (!targetPriceSource || !sourcePrice || sourcePrice === targetPriceSource) return true;
    if (!incompatibleSources.some((item) => item.ticker === source)) {
      incompatibleSources.push({ ticker: source, sourcePrice, targetPrice: targetPriceSource });
    }
    return false;
  };
  const addRawFactor = ({ key, label, sourceTicker }) => {
    const source = normalizeTicker(sourceTicker);
    if (!source) return;
    const sourceIdentity = new Set([
      source,
      normalizeTicker(sourceMetadata?.[source]?.requestedTicker),
      normalizeTicker(sourceMetadata?.[source]?.resolvedTicker),
    ].filter(Boolean));
    if ([...sourceIdentity].some((identity) => targetIdentity.has(identity))) {
      exclusions.push(`${label}: il proxy coincide con ${target}.`);
      return;
    }
    if (!analyses[source]) {
      addMissing(source);
      return;
    }
    if (!hasCompatiblePriceSource(source)) return;
    factors.push({ key, label, sourceTicker: source, analysis: analyses[source] });
  };
  const addSpreadFactor = ({ key, label, sourceTicker }) => {
    const source = normalizeTicker(sourceTicker);
    const sourceIdentity = new Set([
      source,
      normalizeTicker(sourceMetadata?.[source]?.requestedTicker),
      normalizeTicker(sourceMetadata?.[source]?.resolvedTicker),
    ].filter(Boolean));
    const marketIdentity = new Set([
      "SPY",
      normalizeTicker(sourceMetadata?.SPY?.requestedTicker),
      normalizeTicker(sourceMetadata?.SPY?.resolvedTicker),
    ].filter(Boolean));
    if (targetIsSpy || [...marketIdentity].some((identity) => targetIdentity.has(identity))) {
      exclusions.push(`${label}: escluso perché sottrarrebbe il rendimento del titolo target SPY.`);
      return;
    }
    if ([...sourceIdentity].some((identity) => targetIdentity.has(identity))) {
      exclusions.push(`${label}: il proxy ${source} coincide con il titolo target.`);
      return;
    }
    if (!analyses[source]) addMissing(source);
    if (!marketAnalysis) addMissing("SPY");
    if (!analyses[source] || !marketAnalysis) return;
    if (!hasCompatiblePriceSource(source) || !hasCompatiblePriceSource("SPY")) return;
    factors.push({
      key,
      label,
      sourceTicker: source,
      analysis: analyses[source],
      subtractAnalysis: marketAnalysis,
      subtractTicker: "SPY",
    });
  };

  addRawFactor({ key: "market", label: "Mercato · SPY", sourceTicker: "SPY" });
  addSpreadFactor({ key: "growth", label: "Nasdaq relativo · QQQ − SPY", sourceTicker: "QQQ" });
  addSpreadFactor({ key: "size", label: "Dimensione · IWM − SPY", sourceTicker: "IWM" });
  const sectorTicker = normalizeTicker(sectorEtf?.[0]);
  if (["QQQ", "IWM"].includes(sectorTicker)) {
    exclusions.push(`Fattore settore escluso: ${sectorTicker} − SPY duplica un fattore di stile già incluso.`);
  } else if (sectorTicker && sectorTicker !== "SPY") {
    addSpreadFactor({
      key: "sector",
      label: `Settore · ${sectorTicker} − SPY`,
      sourceTicker: sectorTicker,
    });
  } else if (!sectorTicker) {
    exclusions.push("Fattore settore non disponibile: settore del titolo non mappato a un ETF proxy.");
  }

  const availableKeys = new Set(factors.map((factor) => factor.key));
  const modelSpecs = [];
  const addModelSpec = (key, label, predictorKeys) => {
    if (!predictorKeys.length || modelSpecs.some((model) => (
      model.predictorKeys.length === predictorKeys.length
      && model.predictorKeys.every((predictor, index) => predictor === predictorKeys[index])
    ))) return;
    modelSpecs.push({ key, label, predictorKeys });
  };
  if (availableKeys.has("market")) {
    addModelSpec("market", "M1 · Mercato", ["market"]);
    if (availableKeys.has("growth")) {
      addModelSpec("market_growth", "M2 · Mercato + Nasdaq", ["market", "growth"]);
    }
    const styleKeys = ["market", "growth", "size"].filter((key) => availableKeys.has(key));
    if (styleKeys.length >= 2) {
      addModelSpec("market_style", "M3 · Mercato + stile", styleKeys);
    }
    const fullKeys = [...styleKeys];
    if (availableKeys.has("sector") && !fullKeys.includes("sector")) fullKeys.push("sector");
    if (fullKeys.length >= 2) addModelSpec("full", "M4 · Completo", fullKeys);
  }

  return {
    factors,
    modelSpecs,
    fullModelKey: modelSpecs[modelSpecs.length - 1]?.key || "",
    exclusions,
    missingSources,
    incompatibleSources,
  };
};

const MetricStrip = ({ items, className = "" }) => (
  <dl className={`quant-metric-strip ${className}`.trim()}>
    {items.map((item) => (
      <div className="quant-metric" key={item.label} title={item.title || undefined}>
        <dt>{item.label}</dt>
        <dd className={item.tone ? `is-${item.tone}` : ""}>{item.value}</dd>
        {item.detail && <span>{item.detail}</span>}
      </div>
    ))}
  </dl>
);

const StatePanel = ({ type = "empty", title, children, onRetry }) => (
  <section className={`quant-state is-${type}`} role={type === "error" ? "alert" : "status"}>
    <span className="quant-state-icon" aria-hidden="true">
      {type === "error" ? <FiAlertCircle /> : <FiDatabase />}
    </span>
    <h2>{title}</h2>
    <p>{children}</p>
    {onRetry && (
      <button className="quant-primary-button" type="button" onClick={onRetry}>
        <FiRefreshCw aria-hidden="true" /> Riprova
      </button>
    )}
  </section>
);

const ChartPanel = ({ eyebrow, title, description, children, className = "" }) => (
  <section className={`quant-panel ${className}`.trim()}>
    <div className="quant-panel-heading">
      <div>
        {eyebrow && <span className="quant-eyebrow">{eyebrow}</span>}
        <h3>{title}</h3>
        {description && <p>{description}</p>}
      </div>
    </div>
    {children}
  </section>
);

const Control = ({ label, htmlFor, children, className = "" }) => (
  <label className={`quant-control ${className}`.trim()} htmlFor={htmlFor}>
    <span>{label}</span>
    {children}
  </label>
);

const QuantitativeAnalysis = ({ darkMode }) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const ticker = normalizeTicker(searchParams.get("ticker"));
  const range = RANGE_OPTIONS.some((item) => item.value === searchParams.get("range"))
    ? searchParams.get("range") : "5y";
  const frequency = FREQUENCY_OPTIONS.some((item) => item.value === searchParams.get("freq"))
    ? searchParams.get("freq") : "1d";
  const priceMode = PRICE_OPTIONS.some((item) => item.value === searchParams.get("price"))
    ? searchParams.get("price") : "auto";
  const returnType = RETURN_OPTIONS.some((item) => item.value === searchParams.get("returns"))
    ? searchParams.get("returns") : "simple";
  const confidence = searchParams.get("var") === "99" ? 0.99 : 0.95;
  const binMethod = BIN_OPTIONS.some((item) => item.value === searchParams.get("bins"))
    ? searchParams.get("bins") : "fd";
  const binCount = clamp(Number(searchParams.get("binCount")) || 24, 8, 60);
  const histogramScale = searchParams.get("scale") === "density" ? "density" : "count";
  const overlayNormal = searchParams.get("normal") !== "0";
  const activeTab = resolveQuantitativeTab(searchParams.get("tab"));
  const regressionModel = resolveRegressionModel(searchParams.get("regModel"));

  const [historyPayload, setHistoryPayload] = useState(null);
  const [infoPayload, setInfoPayload] = useState(null);
  const [benchmarkPayload, setBenchmarkPayload] = useState(null);
  const [researchPayload, setResearchPayload] = useState(null);
  const [researchLoading, setResearchLoading] = useState(false);
  const [researchError, setResearchError] = useState("");
  const [mainLoading, setMainLoading] = useState(false);
  const [infoLoading, setInfoLoading] = useState(false);
  const [benchmarkLoading, setBenchmarkLoading] = useState(false);
  const [multiFactorPayloads, setMultiFactorPayloads] = useState({});
  const [multiFactorErrors, setMultiFactorErrors] = useState({});
  const [multiFactorCacheKey, setMultiFactorCacheKey] = useState("");
  const [multiFactorLoading, setMultiFactorLoading] = useState(false);
  const [mainError, setMainError] = useState("");
  const [infoError, setInfoError] = useState("");
  const [benchmarkError, setBenchmarkError] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const [isPrinting, setIsPrinting] = useState(false);
  const [mcHorizon, setMcHorizon] = useState(63);
  const [mcPathCount, setMcPathCount] = useState(5000);
  const [mcSeed, setMcSeed] = useState(20260825);
  const [mcBootstrapMethod, setMcBootstrapMethod] = useState("moving-block");
  const [mcBlockLength, setMcBlockLength] = useState(5);
  const distributionChartRef = useRef(null);
  const riskChartRef = useRef(null);
  const benchmarkChartRef = useRef(null);
  const regressionChartRef = useRef(null);
  const multipleRegressionChartRef = useRef(null);

  const updateQuery = useCallback((updates) => {
    const next = new URLSearchParams(searchParams);
    Object.entries(updates).forEach(([key, value]) => {
      if (value === null || value === undefined || value === "") next.delete(key);
      else next.set(key, String(value));
    });
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  const handleRetry = useCallback(() => {
    setMultiFactorCacheKey("");
    setRetryKey((value) => value + 1);
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [ticker]);

  useEffect(() => {
    const enterPrintMode = () => flushSync(() => setIsPrinting(true));
    const leavePrintMode = () => flushSync(() => setIsPrinting(false));
    window.addEventListener("beforeprint", enterPrintMode);
    window.addEventListener("afterprint", leavePrintMode);
    return () => {
      window.removeEventListener("beforeprint", enterPrintMode);
      window.removeEventListener("afterprint", leavePrintMode);
    };
  }, []);

  useEffect(() => {
    if (!ticker) {
      setHistoryPayload(null);
      setMainError("");
      return undefined;
    }
    const controller = new AbortController();
    setHistoryPayload(null);
    setMainLoading(true);
    setMainError("");
    fetchJson(apiUrl(`/stock/${encodeURIComponent(ticker)}/history?timeframe=1d&range=${range}`), controller.signal)
      .then(setHistoryPayload)
      .catch((error) => {
        if (error?.name !== "AbortError") {
          setHistoryPayload(null);
          setMainError(error?.message || "Storico non disponibile.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setMainLoading(false);
      });
    return () => controller.abort();
  }, [ticker, range, retryKey]);

  useEffect(() => {
    if (!ticker) {
      setInfoPayload(null);
      setInfoError("");
      return undefined;
    }
    const controller = new AbortController();
    setInfoPayload(null);
    setInfoLoading(true);
    setInfoError("");
    fetchJson(apiUrl(`/stock/${encodeURIComponent(ticker)}?timeframe=1d`), controller.signal)
      .then(setInfoPayload)
      .catch((error) => {
        if (error?.name !== "AbortError") {
          setInfoPayload(null);
          setInfoError(error?.message || "Informazioni titolo non disponibili.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setInfoLoading(false);
      });
    return () => controller.abort();
  }, [ticker, retryKey]);

  const info = infoPayload?.info || {};
  const latestHistoryRow = Array.isArray(historyPayload?.history)
    ? historyPayload.history.reduce((latest, row) => (
      !latest || String(row?.date || "") > String(latest?.date || "") ? row : latest
    ), null)
    : null;
  const currentPrice = [
    info?.currentPrice,
    latestHistoryRow?.adjustedClose,
    latestHistoryRow?.rawClose,
    latestHistoryRow?.close,
  ].map(finiteNumber).find((value) => value !== null && value > 0) ?? null;
  const tradingCurrency = String(info?.currency || "").trim().toUpperCase();
  const isUnsupportedMultiCurrency = Boolean(tradingCurrency && tradingCurrency !== "USD");
  const sectorEtf = SECTOR_ETFS[String(info?.sector || "").trim().toLowerCase()] || null;
  const targetTickerAliases = useMemo(() => new Set([
    ticker,
    normalizeTicker(historyPayload?.requestedTicker),
    normalizeTicker(historyPayload?.resolvedTicker),
  ].filter(Boolean)), [ticker, historyPayload?.requestedTicker, historyPayload?.resolvedTicker]);
  const benchmarkOptions = useMemo(() => {
    const candidates = !sectorEtf || BASE_BENCHMARKS.some((item) => item.value === sectorEtf[0])
      ? BASE_BENCHMARKS
      : [...BASE_BENCHMARKS, { value: sectorEtf[0], label: `${sectorEtf[0]} · ETF settore ${sectorEtf[1]}` }];
    return candidates.filter((item) => !targetTickerAliases.has(normalizeTicker(item.value)));
  }, [sectorEtf, targetTickerAliases]);
  const requestedBenchmark = normalizeTicker(searchParams.get("benchmark"));
  const benchmark = benchmarkOptions.some((item) => item.value === requestedBenchmark)
    ? requestedBenchmark
    : benchmarkOptions.find((item) => item.value === "SPY")?.value || benchmarkOptions[0]?.value || "";

  const multiProxyTickers = useMemo(() => {
    const values = ["SPY", "QQQ", "IWM"];
    if (sectorEtf?.[0]) values.push(sectorEtf[0]);
    return [...new Set(values.map(normalizeTicker).filter((value) => value && !targetTickerAliases.has(value)))];
  }, [sectorEtf, targetTickerAliases]);
  const multiProxyKey = multiProxyTickers.join("|");
  const currentMultiCacheKey = `${ticker}|${range}|${multiProxyKey}`;

  useEffect(() => {
    const shouldLoadMultiFactors = regressionModel === "multi";
    if (!ticker || !shouldLoadMultiFactors || infoLoading || benchmarkLoading) {
      if (!ticker) {
        setMultiFactorPayloads({});
        setMultiFactorErrors({});
        setMultiFactorCacheKey("");
        setMultiFactorLoading(false);
      } else if (!shouldLoadMultiFactors) {
        setMultiFactorLoading(false);
      }
      return undefined;
    }
    if (!isDriverRegression && isUnsupportedMultiCurrency) {
      setMultiFactorPayloads({});
      setMultiFactorErrors({});
      setMultiFactorCacheKey(currentMultiCacheKey);
      setMultiFactorLoading(false);
      return undefined;
    }
    if (multiFactorCacheKey === currentMultiCacheKey) {
      setMultiFactorLoading(false);
      return undefined;
    }
    if (!multiProxyTickers.length) {
      setMultiFactorPayloads({});
      setMultiFactorErrors({});
      setMultiFactorCacheKey(currentMultiCacheKey);
      setMultiFactorLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    setMultiFactorCacheKey("");
    const reusablePayloads = benchmarkPayload && multiProxyTickers.includes(benchmark)
      ? { [benchmark]: benchmarkPayload }
      : {};
    setMultiFactorPayloads(reusablePayloads);
    setMultiFactorErrors({});
    setMultiFactorLoading(true);
    fetchMultipleProxyHistories({
      tickers: multiProxyTickers,
      range,
      signal: controller.signal,
      reusedPayloads: reusablePayloads,
    }).then(({ payloads, errors }) => {
      if (controller.signal.aborted) return;
      setMultiFactorPayloads(payloads);
      setMultiFactorErrors(errors);
      setMultiFactorCacheKey(currentMultiCacheKey);
      setMultiFactorLoading(false);
    });
    return () => controller.abort();
  // multiProxyKey rende stabile la dipendenza pur mantenendo l'array deduplicato.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, activeTab, regressionModel, infoLoading, benchmarkLoading, benchmarkPayload, benchmark, isUnsupportedMultiCurrency, multiProxyKey, currentMultiCacheKey, multiFactorCacheKey, range, retryKey]);

  const years = RANGE_OPTIONS.find((item) => item.value === range)?.years || 5;
  const engineOptions = useMemo(() => ({
    asOf: historyPayload?.rangeEnd || undefined,
    years,
    frequency,
    priceMode,
    returnType,
    binMethod,
    binCount,
    confidence,
  }), [historyPayload?.rangeEnd, years, frequency, priceMode, returnType, binMethod, binCount, confidence]);
  const analysisResult = useMemo(() => {
    try {
      return { data: buildQuantitativeAnalysis(historyPayload?.history || [], engineOptions), error: "" };
    } catch (error) {
      return { data: null, error: error?.message || "Analisi non disponibile." };
    }
  }, [historyPayload, engineOptions]);
  const analysis = analysisResult.data;
  const monteCarloResult = useMemo(() => {
    if (!analysis) return { data: null, error: "" };
    if (currentPrice === null) return { data: null, error: "Prezzo corrente non disponibile: simulazione sospesa per evitare un valore iniziale artificiale." };
    try {
      return {
        data: buildMonteCarloSimulation(analysis, {
          horizon: mcHorizon,
          pathCount: mcPathCount,
          seed: mcSeed,
          periodsPerYear: analysis.periodsPerYear,
          initialValue: currentPrice,
          initialValueSource: currentPrice !== null && finiteNumber(info?.currentPrice) === currentPrice
            ? "quotazione corrente"
            : "ultima chiusura disponibile",
          bootstrapMethod: mcBootstrapMethod,
          blockLength: mcBlockLength,
        }),
        error: "",
      };
    } catch (error) {
      return { data: null, error: error?.message || "Simulazione Monte Carlo non disponibile." };
    }
  }, [analysis, currentPrice, info?.currentPrice, mcBootstrapMethod, mcBlockLength, mcHorizon, mcPathCount, mcSeed]);
  const monteCarlo = monteCarloResult.data;
  const activeMultiFactorPayloads = useMemo(
    () => (multiFactorCacheKey === currentMultiCacheKey ? multiFactorPayloads : {}),
    [multiFactorCacheKey, currentMultiCacheKey, multiFactorPayloads]
  );
  const activeMultiFactorErrors = useMemo(
    () => (multiFactorCacheKey === currentMultiCacheKey ? multiFactorErrors : {}),
    [multiFactorCacheKey, currentMultiCacheKey, multiFactorErrors]
  );
  const benchmarkAnalysis = useMemo(() => {
    try {
      return buildQuantitativeAnalysis(benchmarkPayload?.history || [], {
        ...engineOptions,
        asOf: benchmarkPayload?.rangeEnd || engineOptions.asOf,
      });
    } catch (_error) {
      return null;
    }
  }, [benchmarkPayload, engineOptions]);
  const advancedQuantitative = useMemo(() => {
    try {
      return buildAdvancedQuantitativeAnalytics(analysis, benchmarkAnalysis);
    } catch (_error) {
      return null;
    }
  }, [analysis, benchmarkAnalysis]);
  const benchmarkTickerAliases = useMemo(() => new Set([
    normalizeTicker(benchmark),
    normalizeTicker(benchmarkPayload?.requestedTicker),
    normalizeTicker(benchmarkPayload?.resolvedTicker),
  ].filter(Boolean)), [benchmark, benchmarkPayload?.requestedTicker, benchmarkPayload?.resolvedTicker]);
  const benchmarkMatchesTarget = useMemo(
    () => [...benchmarkTickerAliases].some((alias) => targetTickerAliases.has(alias)),
    [benchmarkTickerAliases, targetTickerAliases]
  );
  const benchmarkPriceSourceMismatch = Boolean(
    analysis?.priceSource
    && benchmarkAnalysis?.priceSource
    && analysis.priceSource !== benchmarkAnalysis.priceSource
  );
  const benchmarkBlockReason = useMemo(() => {
    if (isUnsupportedMultiCurrency) {
      return `Il titolo è quotato in ${tradingCurrency}: i benchmark ETF USA in USD non sono compatibili in modo fail-safe per valuta, calendario e orari di negoziazione.`;
    }
    if (benchmarkMatchesTarget) {
      return `Il benchmark richiesto o risolto (${benchmarkPayload?.resolvedTicker || benchmark}) coincide con il titolo analizzato. Il confronto è bloccato per evitare identità e leakage.`;
    }
    if (benchmarkPriceSourceMismatch) {
      return `Fonte prezzo incompatibile: il titolo usa ${analysis?.priceSource}, mentre ${benchmark} usa ${benchmarkAnalysis?.priceSource}. Seleziona esplicitamente Close o Adjusted; le fonti non vengono mescolate.`;
    }
    return "";
  }, [isUnsupportedMultiCurrency, tradingCurrency, benchmarkMatchesTarget, benchmarkPayload?.resolvedTicker, benchmark, benchmarkPriceSourceMismatch, analysis?.priceSource, benchmarkAnalysis?.priceSource]);
  const benchmarkComparison = useMemo(
    () => (benchmarkBlockReason ? null : buildBenchmarkComparison(analysis, benchmarkAnalysis)),
    [analysis, benchmarkAnalysis, benchmarkBlockReason]
  );
  const multiSourceAnalyses = useMemo(() => {
    const next = {};
    Object.entries(activeMultiFactorPayloads).forEach(([sourceTicker, payload]) => {
      try {
        const sourceAnalysis = buildQuantitativeAnalysis(payload?.history || [], {
          ...engineOptions,
          asOf: payload?.rangeEnd || engineOptions.asOf,
        });
        if (sourceAnalysis) next[sourceTicker] = sourceAnalysis;
      } catch (_error) {
        // Un proxy non valido viene trattato come fonte parzialmente mancante.
      }
    });
    return next;
  }, [activeMultiFactorPayloads, engineOptions]);
  const multiFactorLineage = useMemo(() => Object.fromEntries(
    Object.entries(activeMultiFactorPayloads).map(([sourceTicker, payload]) => [sourceTicker, {
      requestedTicker: payload?.requestedTicker,
      resolvedTicker: payload?.resolvedTicker,
      dataSource: payload?.dataSource,
      generatedAt: payload?.generatedAt,
      actualStart: payload?.actualStart,
      actualEnd: payload?.actualEnd,
      adjustedCloseCoveragePct: payload?.adjustedCloseCoveragePct,
      priceSource: multiSourceAnalyses?.[sourceTicker]?.priceSource,
    }])
  ), [activeMultiFactorPayloads, multiSourceAnalyses]);
  const multiFactorPlan = useMemo(() => buildMultipleFactorPlan({
    ticker,
    targetAliases: [historyPayload?.requestedTicker, historyPayload?.resolvedTicker],
    targetPriceSource: analysis?.priceSource,
    sectorEtf,
    analyses: multiSourceAnalyses,
    sourceMetadata: activeMultiFactorPayloads,
    sourceErrors: activeMultiFactorErrors,
  }), [ticker, historyPayload?.requestedTicker, historyPayload?.resolvedTicker, analysis?.priceSource, sectorEtf, multiSourceAnalyses, activeMultiFactorPayloads, activeMultiFactorErrors]);
  const multipleRegressionResult = useMemo(() => {
    if (isUnsupportedMultiCurrency || !analysis || !multiFactorPlan.factors.length || !multiFactorPlan.modelSpecs.length) {
      return { data: null, error: "" };
    }
    try {
      return {
        data: buildMultipleRegressionAnalysis(analysis, multiFactorPlan.factors, {
          modelSpecs: multiFactorPlan.modelSpecs,
          fullModelKey: multiFactorPlan.fullModelKey,
        }),
        error: "",
      };
    } catch (error) {
      return { data: null, error: error?.message || "Regressione multifattoriale non disponibile." };
    }
  }, [analysis, multiFactorPlan, isUnsupportedMultiCurrency]);
  const driverRegressionResult = useMemo(() => {
    if (!historyPayload?.history?.length || !ticker) return { data: null, error: "" };
    try {
      return {
        data: buildDriverRegressionAnalysis(historyPayload.history, {
          asOf: historyPayload.rangeEnd || undefined,
          years,
          priceMode,
          ticker,
        }),
        error: "",
      };
    } catch (error) {
      return { data: null, error: error?.message || "Regressione dei driver non disponibile." };
    }
  }, [historyPayload, ticker, years, priceMode]);
  const displayedMultipleRegressionResult = regressionModel === "drivers"
    ? driverRegressionResult
    : multipleRegressionResult;
  const multipleRegression = displayedMultipleRegressionResult.data;
  const isDriverRegression = regressionModel === "drivers";
  const isDaily = frequency === "1d";
  const periodNoun = isDaily ? "giorni" : "periodi";
  const periodLabel = isDaily ? "Giorni disponibili" : "Periodi disponibili";
  const adjustedCoveragePct = finiteNumber(
    analysis?.quality?.adjustedCoveragePct ?? historyPayload?.adjustedCloseCoveragePct
  );
  const hasPartialAdjustedCoverage = adjustedCoveragePct !== null
    && adjustedCoveragePct > 0
    && adjustedCoveragePct < 100;
  const estimatedTailCount = analysis
    ? Math.max(1, Math.ceil(analysis.observations * (1 - confidence) - Number.EPSILON))
    : 0;
  const hasThinTail = Boolean(analysis && estimatedTailCount < 10);
  const normalOverlayAvailable = Boolean(
    finiteNumber(analysis?.standardDeviation) !== null && analysis.standardDeviation > 0
  );

  const renderDarkCharts = darkMode && !isPrinting;
  const theme = useMemo(() => ({
    text: renderDarkCharts ? "#a9b8ca" : "#667085",
    grid: renderDarkCharts ? "rgba(148,163,184,.12)" : "rgba(15,23,42,.08)",
    surface: renderDarkCharts ? "#172638" : "#ffffff",
    title: renderDarkCharts ? "#f3f6fb" : "#14171f",
    green: renderDarkCharts ? "#2bd3b1" : "#168f77",
    greenSoft: renderDarkCharts ? "rgba(43,211,177,.18)" : "rgba(22,143,119,.15)",
    blue: renderDarkCharts ? "#72a7ff" : "#3972d5",
    amber: renderDarkCharts ? "#f3c969" : "#b7791f",
    red: renderDarkCharts ? "#f58b93" : "#c74452",
    redSoft: renderDarkCharts ? "rgba(245,139,147,.18)" : "rgba(199,68,82,.14)",
  }), [renderDarkCharts]);
  const chartBackgroundPlugin = useMemo(() => ({
    id: "quantitativeCanvasBackground",
    beforeDraw: (chart) => {
      const { ctx, width, height } = chart;
      ctx.save();
      ctx.globalCompositeOperation = "destination-over";
      ctx.fillStyle = theme.surface;
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    },
  }), [theme.surface]);
  const reducedMotion = typeof window !== "undefined"
    && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const baseOptions = useCallback((xTitle, yTitle) => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: reducedMotion ? false : { duration: 320 },
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: {
        display: true,
        labels: { color: theme.text, usePointStyle: true, boxWidth: 8 },
      },
      tooltip: {
        backgroundColor: theme.surface,
        titleColor: theme.title,
        bodyColor: theme.text,
        borderColor: theme.grid,
        borderWidth: 1,
        padding: 12,
      },
    },
    scales: {
      x: {
        grid: { display: false },
        border: { color: theme.grid },
        ticks: { color: theme.text, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
        title: { display: Boolean(xTitle), text: xTitle, color: theme.text },
      },
      y: {
        grid: { color: theme.grid, drawTicks: false },
        border: { display: false },
        ticks: { color: theme.text, padding: 8 },
        title: { display: Boolean(yTitle), text: yTitle, color: theme.text },
      },
    },
  }), [reducedMotion, theme]);

  const histogramData = useMemo(() => {
    const bins = analysis?.histogram?.bins || [];
    const density = histogramScale === "density";
    const datasets = [{
      type: "bar",
      label: density ? "Densità empirica" : (isDaily ? "Giorni" : "Periodi"),
      data: bins.map((bin) => (density ? bin.density : bin.count)),
      backgroundColor: bins.map((bin) => (
        (bin.start + bin.end) / 2 < 0 ? theme.redSoft : theme.greenSoft
      )),
      borderColor: bins.map((bin) => (
        (bin.start + bin.end) / 2 < 0 ? theme.red : theme.green
      )),
      borderWidth: 1,
      borderRadius: 4,
      borderSkipped: false,
      barPercentage: 0.98,
      categoryPercentage: 0.98,
    }];
    if (overlayNormal && !density && normalOverlayAvailable) {
      datasets.push({
        type: "line",
        label: "Normale attesa",
        data: bins.map((bin) => bin.normalExpectedCount),
        borderColor: theme.blue,
        backgroundColor: "transparent",
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.24,
      });
    }
    return { labels: bins.map(binLabel), datasets };
  }, [analysis, histogramScale, isDaily, normalOverlayAvailable, overlayNormal, theme]);

  const histogramOptions = useMemo(() => {
    const bins = analysis?.histogram?.bins || [];
    const options = baseOptions(
      "Rendimento del periodo (%)",
      histogramScale === "density" ? "Densità" : (isDaily ? "Numero di giorni" : "Numero di periodi")
    );
    options.plugins.legend.display = overlayNormal
      && histogramScale === "count"
      && normalOverlayAvailable;
    options.plugins.tooltip.displayColors = false;
    options.plugins.tooltip.callbacks = {
      title: (items) => {
        const bin = bins[items?.[0]?.dataIndex];
        return bin ? `Da ${binLabel(bin).replace("–", " a ")}` : "Intervallo";
      },
      label: (context) => {
        const bin = bins[context.dataIndex];
        if (context.datasetIndex > 0) {
          return `Normale attesa: ${formatNumber(bin?.normalExpectedCount, 2)} ${periodNoun}`;
        }
        return bin
          ? `${compactInteger(bin.count)} ${periodNoun} · ${formatNumber(bin.percentage, 1)}% del totale`
          : "";
      },
    };
    return options;
  }, [analysis, baseOptions, histogramScale, isDaily, normalOverlayAvailable, overlayNormal, periodNoun]);

  const ecdfData = useMemo(() => ({
    datasets: [{
      label: "Probabilità cumulata",
      data: (analysis?.ecdf || []).map((point) => ({
        x: point.valuePct,
        y: point.probabilityPct,
      })),
      borderColor: theme.green,
      backgroundColor: theme.greenSoft,
      pointRadius: 0,
      borderWidth: 2,
      showLine: true,
      stepped: "after",
      fill: true,
    }],
  }), [analysis, theme]);
  const ecdfOptions = useMemo(() => {
    const options = baseOptions("Rendimento (%)", "Probabilità cumulata (%)");
    options.scales.x.type = "linear";
    options.plugins.legend.display = false;
    options.plugins.tooltip.callbacks = {
      title: (items) => `Rendimento: ${formatSignedPercentage(items?.[0]?.raw?.x)}`,
      label: (context) => `Probabilità cumulata: ${formatPlainPercentage(context.raw?.y)}`,
    };
    return options;
  }, [baseOptions]);

  const qqData = useMemo(() => {
    const points = (analysis?.qqSeries || []).map((point) => ({
      x: point.theoretical,
      y: point.observed,
    }));
    const datasets = [{
      label: "Quantili osservati",
      data: points,
      backgroundColor: theme.green,
      borderColor: theme.green,
      pointRadius: 2.2,
      pointHoverRadius: 4,
    }];
    if (normalOverlayAvailable && points.length > 1) {
      const minimum = points[0].x;
      const maximum = points[points.length - 1].x;
      datasets.push({
        label: "Riferimento normale",
        data: [minimum, maximum].map((theoretical) => ({
          x: theoretical,
          y: analysis.mean + analysis.standardDeviation * theoretical,
        })),
        borderColor: theme.blue,
        backgroundColor: "transparent",
        borderWidth: 1.6,
        pointRadius: 0,
        showLine: true,
      });
    }
    return { datasets };
  }, [analysis, normalOverlayAvailable, theme]);
  const qqOptions = useMemo(() => {
    const options = baseOptions("Quantile normale teorico", "Rendimento osservato (%)");
    options.scales.x.type = "linear";
    options.plugins.legend.display = normalOverlayAvailable;
    options.interaction = { mode: "nearest", intersect: false };
    options.plugins.tooltip.callbacks = {
      title: (items) => items?.[0]?.datasetIndex === 0 ? "Quantile osservato" : "Riferimento normale",
      label: (context) => `Teorico: ${formatNumber(context.raw?.x, 3)} · osservato: ${formatSignedPercentage(context.raw?.y)}`,
    };
    return options;
  }, [baseOptions, normalOverlayAvailable]);

  const rollingData = useMemo(() => {
    const rolling = analysis?.rollingVolatility || {};
    const windows = analysis?.rollingWindows || {};
    const colors = { short: theme.green, medium: theme.blue, long: theme.amber };
    return {
      datasets: ["short", "medium", "long"].map((key) => ({
        label: `${windows[key] || "—"} periodi`,
        data: (rolling[key] || []).map((point) => ({ x: point.date, y: point.valuePct })),
        borderColor: colors[key],
        backgroundColor: "transparent",
        borderWidth: 1.8,
        pointRadius: 0,
        spanGaps: false,
        tension: 0.16,
      })),
    };
  }, [analysis, theme]);
  const rollingOptions = useMemo(() => {
    const options = baseOptions("Data", "Volatilità annualizzata (%)");
    options.plugins.tooltip.callbacks = {
      title: (items) => formatDate(items?.[0]?.raw?.x),
      label: (context) => `${context.dataset.label}: ${formatUnsignedPercentage(context.raw?.y)}`,
    };
    return options;
  }, [baseOptions]);

  const drawdownData = useMemo(() => ({
    datasets: [{
      label: "Drawdown",
      data: (analysis?.drawdownSeries || []).map((point) => ({
        x: point.date,
        y: point.valuePct,
      })),
      borderColor: theme.red,
      backgroundColor: renderDarkCharts ? "rgba(245,139,147,.14)" : "rgba(199,68,82,.11)",
      borderWidth: 1.8,
      pointRadius: 0,
      fill: true,
      tension: 0.12,
    }],
  }), [analysis, renderDarkCharts, theme]);
  const drawdownOptions = useMemo(() => {
    const options = baseOptions("Data", "Drawdown (%)");
    options.plugins.legend.display = false;
    options.plugins.tooltip.callbacks = {
      title: (items) => formatDate(items?.[0]?.raw?.x),
      label: (context) => `Drawdown: ${formatSignedPercentage(context.raw?.y)}`,
    };
    return options;
  }, [baseOptions]);

  const benchmarkCumulativeData = useMemo(() => ({
    labels: (benchmarkComparison?.cumulativeSeries || []).map((point) => point.date),
    datasets: [
      {
        label: ticker || "Titolo",
        data: (benchmarkComparison?.cumulativeSeries || []).map((point) => point.primaryPct),
        borderColor: theme.green,
        backgroundColor: "transparent",
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.14,
      },
      {
        label: benchmark,
        data: (benchmarkComparison?.cumulativeSeries || []).map((point) => point.benchmarkPct),
        borderColor: theme.blue,
        backgroundColor: "transparent",
        borderWidth: 1.8,
        pointRadius: 0,
        tension: 0.14,
      },
    ],
  }), [benchmarkComparison, benchmark, ticker, theme]);
  const benchmarkLineOptions = useMemo(() => {
    const options = baseOptions("Data", "Rendimento cumulato (%)");
    options.plugins.tooltip.callbacks = {
      title: (items) => formatDate(items?.[0]?.label),
      label: (context) => `${context.dataset.label}: ${formatSignedPercentage(context.raw)}`,
    };
    return options;
  }, [baseOptions]);
  const benchmarkScatterData = useMemo(() => ({
    datasets: [{
      label: `${ticker} vs ${benchmark}`,
      data: benchmarkComparison?.scatterSeries || [],
      backgroundColor: theme.greenSoft,
      borderColor: theme.green,
      borderWidth: 1,
      pointRadius: 3,
      pointHoverRadius: 5,
    }],
  }), [benchmarkComparison, benchmark, ticker, theme]);
  const benchmarkScatterOptions = useMemo(() => {
    const options = baseOptions(`${benchmark} (%)`, `${ticker || "Titolo"} (%)`);
    options.scales.x.type = "linear";
    options.plugins.legend.display = false;
    options.interaction = { mode: "nearest", intersect: false };
    options.plugins.tooltip.callbacks = {
      title: (items) => formatDate(items?.[0]?.raw?.date),
      label: (context) => `${benchmark}: ${formatSignedPercentage(context.raw?.x)} · ${ticker}: ${formatSignedPercentage(context.raw?.y)}`,
    };
    return options;
  }, [baseOptions, benchmark, ticker]);

  const regression = benchmarkComparison?.regression || null;
  const regressionScatterData = useMemo(() => {
    const confidenceBand = regression?.confidenceBand || [];
    const confidenceDatasets = confidenceBand.length ? [
      {
        type: "line",
        label: "Limite inferiore IC 95%",
        data: confidenceBand.map((point) => ({ x: point.x, y: point.lower })),
        borderColor: theme.blue,
        borderWidth: 1,
        borderDash: [5, 4],
        pointRadius: 0,
        tension: 0,
        order: 4,
      },
      {
        type: "line",
        label: "Banda di confidenza 95%",
        data: confidenceBand.map((point) => ({ x: point.x, y: point.upper })),
        borderColor: theme.blue,
        backgroundColor: renderDarkCharts ? "rgba(114,167,255,.13)" : "rgba(57,114,213,.10)",
        borderWidth: 1,
        borderDash: [5, 4],
        pointRadius: 0,
        tension: 0,
        fill: "-1",
        order: 3,
      },
    ] : [];
    return {
      datasets: [
        ...confidenceDatasets,
      {
        type: "line",
        label: "Retta OLS",
        data: (regression?.lineSeries || []).map((point) => ({ x: point.x, y: point.y })),
        borderColor: theme.amber,
        backgroundColor: "transparent",
        borderWidth: 2.5,
        pointRadius: 0,
        tension: 0,
        order: 2,
      },
      {
        label: "Osservazioni",
        data: (regression?.fittedSeries || []).map((point) => ({
          x: point.x,
          y: point.y,
          date: point.date,
        })),
        backgroundColor: theme.greenSoft,
        borderColor: theme.green,
        borderWidth: 1.3,
        pointRadius: 3.2,
        pointHoverRadius: 5,
        pointStyle: "circle",
        order: 1,
      },
      ],
    };
  }, [regression, renderDarkCharts, theme]);
  const regressionScatterOptions = useMemo(() => {
    const options = baseOptions(`${benchmark} · rendimento (%)`, `${ticker || "Titolo"} · rendimento (%)`);
    options.scales.x.type = "linear";
    options.interaction = { mode: "nearest", intersect: false };
    options.plugins.legend.labels.filter = (item) => item.text !== "Limite inferiore IC 95%";
    options.plugins.tooltip.callbacks = {
      title: (items) => {
        const point = items?.[0]?.raw;
        return point?.date ? formatDate(point.date) : items?.[0]?.dataset?.label || "Regressione";
      },
      label: (context) => {
        if (context.dataset.label === "Osservazioni") {
          return `${benchmark}: ${formatSignedPercentage(context.raw?.x)} · ${ticker}: ${formatSignedPercentage(context.raw?.y)}`;
        }
        return `${context.dataset.label}: ${formatSignedPercentage(context.raw?.y)}`;
      },
    };
    return options;
  }, [baseOptions, benchmark, ticker]);

  const residualData = useMemo(() => {
    const series = regression?.fittedSeries || [];
    return {
      labels: series.map((point) => point.date),
      datasets: [
        {
          label: "Residuo",
          data: series.map((point) => point.residual),
          borderColor: theme.green,
          backgroundColor: "transparent",
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.1,
          spanGaps: false,
        },
        {
          label: "Outlier |z| ≥ 2",
          data: series.map((point) => (
            Math.abs(finiteNumber(point.standardizedResidual) ?? 0) >= 2 ? point.residual : null
          )),
          borderColor: theme.red,
          backgroundColor: theme.red,
          pointRadius: 4.3,
          pointHoverRadius: 6,
          showLine: false,
          spanGaps: false,
        },
        {
          label: "Zero",
          data: series.map(() => 0),
          borderColor: theme.text,
          backgroundColor: "transparent",
          borderWidth: 1,
          borderDash: [5, 5],
          pointRadius: 0,
        },
      ],
    };
  }, [regression, theme]);
  const residualOptions = useMemo(() => {
    const options = baseOptions("Data", "Residuo (%)");
    options.interaction = { mode: "index", intersect: false };
    options.plugins.tooltip.callbacks = {
      title: (items) => formatDate(items?.[0]?.label),
      label: (context) => {
        const point = regression?.fittedSeries?.[context.dataIndex];
        if (context.dataset.label === "Outlier |z| ≥ 2") {
          return `Outlier: ${formatSignedPercentage(context.raw)} · z ${formatNumber(point?.standardizedResidual, 2)}`;
        }
        return `${context.dataset.label}: ${formatSignedPercentage(context.raw)}`;
      },
    };
    return options;
  }, [baseOptions, regression]);

  const rollingBetaData = useMemo(() => {
    const series = regression?.rolling?.series || [];
    return {
      labels: series.map((point) => point.date),
      datasets: [
        {
          label: "Beta mobile",
          data: series.map((point) => point.beta),
          borderColor: theme.green,
          backgroundColor: "transparent",
          borderWidth: 1.8,
          pointRadius: 0,
          tension: 0.14,
        },
        {
          label: "Beta = 1",
          data: series.map(() => 1),
          borderColor: theme.amber,
          backgroundColor: "transparent",
          borderDash: [6, 5],
          borderWidth: 1.2,
          pointRadius: 0,
        },
      ],
    };
  }, [regression, theme]);
  const rollingBetaOptions = useMemo(() => {
    const options = baseOptions("Data", "Beta");
    options.plugins.tooltip.callbacks = {
      title: (items) => formatDate(items?.[0]?.label),
      label: (context) => `${context.dataset.label}: ${formatNumber(context.raw, 3)}`,
    };
    return options;
  }, [baseOptions]);

  const rollingRSquaredData = useMemo(() => {
    const series = regression?.rolling?.series || [];
    return {
      labels: series.map((point) => point.date),
      datasets: [{
        label: "R² mobile",
        data: series.map((point) => point.rSquared),
        borderColor: theme.blue,
        backgroundColor: renderDarkCharts ? "rgba(114,167,255,.12)" : "rgba(57,114,213,.09)",
        borderWidth: 1.8,
        pointRadius: 0,
        fill: true,
        tension: 0.14,
      }],
    };
  }, [regression, renderDarkCharts, theme]);
  const rollingRSquaredOptions = useMemo(() => {
    const options = baseOptions("Data", "R²");
    options.scales.y.suggestedMin = 0;
    options.scales.y.suggestedMax = 1;
    options.plugins.legend.display = false;
    options.plugins.tooltip.callbacks = {
      title: (items) => formatDate(items?.[0]?.label),
      label: (context) => `R² mobile: ${formatNumber(context.raw, 3)}`,
    };
    return options;
  }, [baseOptions]);

  const multiModelComparisonData = useMemo(() => ({
    labels: (multipleRegression?.modelComparisons || []).map((model) => model.label || model.key),
    datasets: [{
      label: "R² aggiustato",
      data: (multipleRegression?.modelComparisons || []).map((model) => finiteNumber(model.adjustedRSquared)),
      backgroundColor: (multipleRegression?.modelComparisons || []).map((model) => (
        model.key === multiFactorPlan.fullModelKey ? theme.green : theme.blue
      )),
      borderColor: (multipleRegression?.modelComparisons || []).map((model) => (
        model.key === multiFactorPlan.fullModelKey ? theme.green : theme.blue
      )),
      borderWidth: 1,
      borderRadius: 6,
    }],
  }), [multipleRegression, multiFactorPlan.fullModelKey, theme]);
  const multiModelComparisonOptions = useMemo(() => {
    const options = baseOptions("Specificazione", "R² aggiustato");
    options.scales.y.beginAtZero = true;
    options.scales.y.suggestedMax = 1;
    options.plugins.legend.display = false;
    options.plugins.tooltip.callbacks = {
      label: (context) => `R² aggiustato: ${formatNumber(context.raw, 3)}`,
      afterLabel: (context) => {
        const model = multipleRegression?.modelComparisons?.[context.dataIndex];
        return `R² ${formatNumber(model?.rSquared, 3)} · RMSE ${formatUnsignedPercentage(model?.rmsePct)} · n ${compactInteger(model?.observations)}`;
      },
    };
    return options;
  }, [baseOptions, multipleRegression]);

  const multiCoefficientData = useMemo(() => ({
    labels: (multipleRegression?.coefficients || []).map((coefficient) => coefficient.label || coefficient.key),
    datasets: [{
      label: "Coefficiente",
      data: (multipleRegression?.coefficients || []).map((coefficient) => finiteNumber(coefficient.estimate)),
      backgroundColor: (multipleRegression?.coefficients || []).map((coefficient) => (
        (finiteNumber(coefficient.estimate) ?? 0) >= 0
          ? theme.greenSoft
          : (renderDarkCharts ? "rgba(243,201,105,.16)" : "rgba(183,121,31,.13)")
      )),
      borderColor: (multipleRegression?.coefficients || []).map((coefficient) => (
        (finiteNumber(coefficient.estimate) ?? 0) >= 0 ? theme.green : theme.amber
      )),
      borderWidth: 1.4,
      borderRadius: 5,
    }],
  }), [multipleRegression, renderDarkCharts, theme]);
  const multiCoefficientOptions = useMemo(() => {
    const options = baseOptions("Coefficiente", "Fattore");
    options.indexAxis = "y";
    options.scales.x.beginAtZero = true;
    options.plugins.legend.display = false;
    options.plugins.tooltip.callbacks = {
      label: (context) => `Stima: ${formatNumber(context.raw, 4)}`,
      afterLabel: (context) => {
        const coefficient = multipleRegression?.coefficients?.[context.dataIndex];
        return `IC 95% ${formatNumber(coefficient?.confidence95?.[0], 3)} – ${formatNumber(coefficient?.confidence95?.[1], 3)} · p ${formatPValue(coefficient?.pValue)}`;
      },
    };
    return options;
  }, [baseOptions, multipleRegression]);

  const multiObservedFittedData = useMemo(() => {
    const series = multipleRegression?.fittedSeries || [];
    return {
      labels: series.map((point) => point.date),
      datasets: [
        {
          label: "Osservato",
          data: series.map((point) => point.observedPct),
          borderColor: theme.green,
          backgroundColor: theme.greenSoft,
          borderWidth: 1.25,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.08,
        },
        {
          label: "Stimato OLS",
          data: series.map((point) => point.fittedPct),
          borderColor: theme.amber,
          backgroundColor: "transparent",
          borderWidth: 1.6,
          pointRadius: 0,
          tension: 0.08,
        },
      ],
    };
  }, [multipleRegression, theme]);
  const multiObservedFittedOptions = useMemo(() => {
    const options = baseOptions("Data", "Rendimento (%)");
    options.plugins.tooltip.callbacks = {
      title: (items) => formatDate(items?.[0]?.label),
      label: (context) => `${context.dataset.label}: ${formatSignedPercentage(context.raw)}`,
    };
    return options;
  }, [baseOptions]);

  const multiResidualData = useMemo(() => {
    const series = multipleRegression?.fittedSeries || [];
    return {
      labels: series.map((point) => point.date),
      datasets: [
        {
          label: "Residuo",
          data: series.map((point) => point.residualPct),
          borderColor: theme.blue,
          backgroundColor: "transparent",
          borderWidth: 1.4,
          pointRadius: 0,
          tension: 0.08,
        },
        {
          label: "Outlier |z| ≥ 2",
          data: series.map((point) => (
            Math.abs(finiteNumber(point.standardizedResidual) ?? 0) >= 2 ? point.residualPct : null
          )),
          borderColor: theme.red,
          backgroundColor: theme.red,
          pointRadius: 4,
          pointHoverRadius: 6,
          showLine: false,
        },
        {
          label: "Zero",
          data: series.map(() => 0),
          borderColor: theme.text,
          backgroundColor: "transparent",
          borderDash: [5, 5],
          borderWidth: 1,
          pointRadius: 0,
        },
      ],
    };
  }, [multipleRegression, theme]);
  const multiResidualOptions = useMemo(() => {
    const options = baseOptions("Data", "Residuo (%)");
    options.plugins.tooltip.callbacks = {
      title: (items) => formatDate(items?.[0]?.label),
      label: (context) => {
        const point = multipleRegression?.fittedSeries?.[context.dataIndex];
        return context.dataset.label.startsWith("Outlier")
          ? `Outlier: ${formatSignedPercentage(context.raw)} · z ${formatNumber(point?.standardizedResidual, 2)}`
          : `${context.dataset.label}: ${formatSignedPercentage(context.raw)}`;
      },
    };
    return options;
  }, [baseOptions, multipleRegression]);

  const tailKey = confidence === 0.99 ? "p99" : "p95";
  const heroMetrics = analysis ? [
    { label: periodLabel, value: compactInteger(analysis.observations) },
    { label: "Media", value: formatSignedPercentage(analysis.mean) },
    { label: "Mediana", value: formatSignedPercentage(analysis.median) },
    { label: "Varianza", value: formatVariance(analysis.variance) },
    { label: "Dev. standard", value: formatUnsignedPercentage(analysis.standardDeviation) },
    { label: "Peggiore", value: formatSignedPercentage(analysis.worst), tone: "negative" },
    { label: "Migliore", value: formatSignedPercentage(analysis.best), tone: "positive" },
  ] : [];
  const tailMetrics = analysis ? [
    {
      label: `VaR storico ${confidence * 100}%`,
      value: formatUnsignedPercentage(analysis.valueAtRisk?.[tailKey]),
      detail: "Perdita positiva",
    },
    {
      label: `Expected Shortfall ${confidence * 100}%`,
      value: formatUnsignedPercentage(analysis.expectedShortfall?.[tailKey]),
      detail: "Perdita media in coda",
    },
    { label: "Asimmetria", value: formatNumber(analysis.skewness, 3) },
    { label: "Curtosi eccesso", value: formatNumber(analysis.excessKurtosis, 3) },
    { label: "IQR", value: formatUnsignedPercentage(analysis.iqr) },
    { label: "MAD", value: formatUnsignedPercentage(analysis.mad) },
    {
      label: isDaily ? "Giorni + / −" : "Periodi + / −",
      value: `${formatNumber(analysis.sharePct?.positive, 1)}% / ${formatNumber(analysis.sharePct?.negative, 1)}%`,
      detail: `${compactInteger(analysis.flatDays)} ${isDaily ? "giorni invariati" : "periodi invariati"}`,
    },
  ] : [];
  const riskMetrics = analysis ? [
    { label: "Rendimento cumulato", value: formatSignedPercentage(analysis.cumulativeReturn) },
    { label: "CAGR", value: formatSignedPercentage(analysis.cagr) },
    { label: "Vol. annualizzata", value: formatUnsignedPercentage(analysis.annualizedVolatility) },
    { label: "Max drawdown", value: formatSignedPercentage(analysis.maxDrawdown), tone: "negative" },
  ] : [];
  const advancedRiskMetrics = analysis ? [
    { label: "Downside deviation", value: formatUnsignedPercentage(analysis.advanced?.downsideDeviationPct), detail: "Per periodo · soglia 0%" },
    { label: "Downside dev. ann.", value: formatUnsignedPercentage(analysis.advanced?.annualizedDownsideDeviationPct), detail: `${analysis.periodsPerYear || "—"} periodi/anno` },
    { label: "Upside deviation", value: formatUnsignedPercentage(analysis.advanced?.upsideDeviationPct), detail: "Per periodo · soglia 0%" },
    { label: "Upside dev. ann.", value: formatUnsignedPercentage(analysis.advanced?.annualizedUpsideDeviationPct), detail: `${analysis.periodsPerYear || "—"} periodi/anno` },
    { label: "Omega (0%)", value: formatNumber(analysis.advanced?.omegaRatioZero, 3), detail: "Guadagni / perdite oltre soglia" },
    { label: "Gain / loss", value: formatNumber(analysis.advanced?.gainLossRatio, 3), detail: "Media positiva / perdita media" },
    { label: "Tail ratio", value: formatNumber(analysis.advanced?.tailRatio, 3), detail: "Q95 / |Q05|" },
    { label: "Autocorr. r lag 1", value: formatNumber(analysis.advanced?.autocorrelationLag1, 3) },
    { label: "Autocorr. r² lag 1", value: formatNumber(analysis.advanced?.squaredReturnAutocorrelationLag1, 3), detail: "Clustering volatilità" },
    { label: "Z ultimo rendimento", value: formatNumber(analysis.advanced?.lastReturnZScore, 2), detail: "Rispetto al campione" },
  ] : [];
  const benchmarkMetrics = benchmarkComparison ? [
    { label: "Beta", value: formatNumber(benchmarkComparison.beta, 3) },
    { label: "Alpha regressione ann.", value: formatSignedPercentage(benchmarkComparison.alphaAnnualized) },
    { label: "Correlazione", value: formatNumber(benchmarkComparison.correlation, 3) },
    { label: "R²", value: formatNumber(benchmarkComparison.rSquared, 3) },
    { label: "Tracking error", value: formatUnsignedPercentage(benchmarkComparison.trackingError) },
    { label: "Information ratio", value: formatNumber(benchmarkComparison.informationRatio, 3) },
    {
      label: "Capture up / down",
      value: `${formatPlainPercentage(benchmarkComparison.upsideCapture, 1)} / ${formatPlainPercentage(benchmarkComparison.downsideCapture, 1)}`,
      detail: `n=${compactInteger(benchmarkComparison.capture?.upside?.observations)} rialzo · n=${compactInteger(benchmarkComparison.capture?.downside?.observations)} ribasso`,
    },
  ] : [];
  const regressionMetrics = regression ? [
    { label: "Beta · slope", value: formatNumber(regression.slope, 3) },
    { label: "Alpha · periodo", value: formatSignedPercentage(regression.interceptPct), detail: frequency === "1d" ? "Per giorno" : frequency === "1wk" ? "Per settimana" : "Per mese" },
    { label: "Alpha annualizzato", value: formatSignedPercentage(regression.interceptAnnualizedPct) },
    { label: "R²", value: formatNumber(regression.rSquared, 3) },
    { label: "R² aggiustato", value: formatNumber(regression.adjustedRSquared, 3) },
    { label: "p-value beta · HAC", value: formatPValue(regression.pValues?.slope) },
    { label: "Errore standard residuo", value: formatUnsignedPercentage(regression.residualStandardErrorPct), detail: "RSE" },
    { label: "Osservazioni", value: compactInteger(regression.observations), detail: `df ${compactInteger(regression.degreesOfFreedom)}` },
  ] : [];
  const multipleRegressionMetrics = multipleRegression ? [
    { label: "Fattori", value: compactInteger(multipleRegression.predictorCount), detail: (multipleRegression.factors || []).map((factor) => factor.key).join(" · ") },
    { label: "Intercetta / alpha", value: formatSignedPercentage(multipleRegression.intercept?.estimatePct), detail: frequency === "1d" ? "Descrittiva · per giorno" : frequency === "1wk" ? "Descrittiva · per settimana" : "Descrittiva · per mese" },
    { label: "Intercetta annualizzata", value: formatSignedPercentage(multipleRegression.intercept?.annualizedPct), detail: "Linearizzata × periodi/anno · senza risk-free" },
    { label: "R²", value: formatNumber(multipleRegression.rSquared, 3) },
    { label: "R² aggiustato", value: formatNumber(multipleRegression.adjustedRSquared, 3) },
    { label: "RMSE", value: formatUnsignedPercentage(multipleRegression.rmsePct) },
    {
      label: "VIF massimo",
      value: formatNumber(multipleRegression.diagnostics?.maxVif, 2),
      detail: "Collinearità tra regressori",
      tone: (finiteNumber(multipleRegression.diagnostics?.maxVif) ?? 0) >= 10 ? "negative" : "",
    },
    { label: "Campione comune", value: compactInteger(multipleRegression.observations), detail: `df ${compactInteger(multipleRegression.degreesOfFreedom)}` },
  ] : [];

  const handleCsv = () => {
    if (!analysis) return;
    const csv = buildQuantitativeCsvExport({
      analysis,
      ticker,
      historyPayload,
      benchmark,
      benchmarkComparison,
      multipleRegression,
      multiFactorLineage: isDriverRegression ? {} : multiFactorLineage,
      regressionModel,
      config: {
        range,
        frequency,
        priceMode,
        returnType,
        confidence,
        binMethod,
        binCount,
        histogramScale,
        overlayNormal,
      },
    });
    const blob = new Blob(["\uFEFF", csv], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${ticker || "titolo"}-analisi-quantitativa.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const handlePng = () => {
    const chart = activeTab === "distribution"
      ? distributionChartRef.current
      : activeTab === "risk"
        ? riskChartRef.current
        : activeTab === "benchmark"
          ? benchmarkChartRef.current
          : activeTab === "regression"
            ? (regressionModel === "single" ? regressionChartRef.current : multipleRegressionChartRef.current)
            : null;
    if (!chart?.toBase64Image) return;
    const link = document.createElement("a");
    link.href = chart.toBase64Image("image/png", 1);
    link.download = `${ticker || "titolo"}-${activeTab}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };
  const handlePrint = () => {
    flushSync(() => setIsPrinting(true));
    const schedule = window.requestAnimationFrame || ((callback) => window.setTimeout(callback, 0));
    schedule(() => {
      window.print();
      window.setTimeout(() => setIsPrinting(false), 0);
    });
  };

  const renderDistribution = () => (
    <div className="quant-tab-content" role="tabpanel" id="quant-panel-distribution" aria-labelledby="quant-tab-distribution">
      <MetricStrip items={heroMetrics} />
      <ChartPanel
        eyebrow="Istogramma"
        title="Distribuzione dei rendimenti"
        description={`Tutti i ${compactInteger(analysis.observations)} ${periodNoun} disponibili sono assegnati a un intervallo; metodo ${analysis.histogram?.method || "—"}.`}
        className="quant-panel-primary"
      >
        <div className="quant-chart-toolbar">
          <label className={histogramScale === "density" || !normalOverlayAvailable ? "is-disabled" : ""}>
            <input
              type="checkbox"
              checked={overlayNormal && histogramScale === "count"}
              disabled={histogramScale === "density" || !normalOverlayAvailable}
              onChange={(event) => updateQuery({ normal: event.target.checked ? "1" : "0" })}
            />
            Overlay normale
          </label>
          {histogramScale === "density" && <span>Overlay disponibile in scala Conteggio</span>}
          {histogramScale === "count" && !normalOverlayAvailable && (
            <span>Overlay non definito con volatilità nulla o campione insufficiente</span>
          )}
        </div>
        <div className="quant-chart quant-chart-large">
          <Bar
            ref={distributionChartRef}
            data={histogramData}
            options={histogramOptions}
            plugins={[chartBackgroundPlugin]}
            role="img"
            aria-label={`Istogramma di ${analysis.observations} rendimenti di ${ticker}.`}
          />
        </div>
      </ChartPanel>
      <MetricStrip items={tailMetrics} className="quant-tail-strip" />
      {hasThinTail && (
        <div className="quant-inline-warning" role="note">
          La coda al {formatNumber(confidence * 100, 0)}% contiene circa {compactInteger(estimatedTailCount)} {periodNoun}:
          VaR ed Expected Shortfall sono stime storiche fragili con questo campione.
        </div>
      )}
      <div className="quant-two-column">
        <ChartPanel
          title="Distribuzione cumulata empirica"
          description="Probabilità osservata di ottenere un rendimento minore o uguale alla soglia."
        >
          <div className="quant-chart">
            <Scatter data={ecdfData} options={ecdfOptions} plugins={[chartBackgroundPlugin]} role="img" aria-label={`ECDF dei rendimenti di ${ticker}.`} />
          </div>
        </ChartPanel>
        <ChartPanel
          title="Q–Q plot"
          description="Confronto dei quantili osservati con quelli di una distribuzione normale."
        >
          <div className="quant-chart">
            <Scatter data={qqData} options={qqOptions} plugins={[chartBackgroundPlugin]} role="img" aria-label={`Q-Q plot dei rendimenti di ${ticker}.`} />
          </div>
        </ChartPanel>
      </div>
      <details className="quant-table-disclosure">
        <summary>Tabella completa degli intervalli</summary>
        <div className="quant-table-wrap">
          <table>
            <caption className="quant-visually-hidden">Intervalli dell’istogramma dei rendimenti</caption>
            <thead>
              <tr><th scope="col">Intervallo</th><th scope="col">{isDaily ? "Giorni" : "Periodi"}</th><th scope="col">Totale</th><th scope="col">Densità</th><th scope="col">Normale attesa</th></tr>
            </thead>
            <tbody>
              {(analysis.histogram?.bins || []).map((bin, index) => (
                <tr key={`${bin.start}-${bin.end}-${index}`}>
                  <th scope="row">{binLabel(bin)}</th>
                  <td>{compactInteger(bin.count)}</td>
                  <td>{formatNumber(bin.percentage, 2)}%</td>
                  <td>{formatNumber(bin.density, 4)}</td>
                  <td>{formatNumber(bin.normalExpectedCount, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );

  const renderRisk = () => (
    <div className="quant-tab-content" role="tabpanel" id="quant-panel-risk" aria-labelledby="quant-tab-risk">
      {analysis.pathContinuous === false && (
        <div className="quant-inline-warning" role="note">
          Sono presenti intervalli mancanti o gap: rendimento cumulato, CAGR e drawdown sono sospesi per evitare un percorso artificiale.
          La volatilità mobile resta calcolata solo su finestre valide e contigue.
        </div>
      )}
      <MetricStrip items={riskMetrics} className="quant-four-metrics" />
      <ChartPanel
        eyebrow="Rischio avanzato"
        title="Coda, asimmetria e dipendenza seriale"
        description="Metriche complementari alla volatilità: separano downside e upside e verificano persistenza nei rendimenti e nei rendimenti al quadrato."
        className="quant-advanced-panel"
      >
        <MetricStrip items={advancedRiskMetrics} className="quant-advanced-metrics" />
      </ChartPanel>
      <ChartPanel
        title="Volatilità mobile"
        description={`Finestre di ${analysis.rollingWindows?.short}, ${analysis.rollingWindows?.medium} e ${analysis.rollingWindows?.long} ${periodNoun}; valori annualizzati.`}
        className="quant-panel-primary"
      >
        <div className="quant-chart quant-chart-large">
          <Line ref={riskChartRef} data={rollingData} options={rollingOptions} plugins={[chartBackgroundPlugin]} role="img" aria-label={`Volatilità mobile di ${ticker}.`} />
        </div>
      </ChartPanel>
      <div className="quant-two-column quant-risk-grid">
        <ChartPanel title="Underwater drawdown" description="Perdita percentuale dal precedente massimo del percorso.">
          {analysis.pathContinuous === false ? (
            <div className="quant-chart-empty" role="status">Grafico sospeso: il percorso dei prezzi non è continuo.</div>
          ) : (
            <>
              <div className="quant-chart">
                <Line data={drawdownData} options={drawdownOptions} plugins={[chartBackgroundPlugin]} role="img" aria-label={`Drawdown storico di ${ticker}.`} />
              </div>
              <div className="quant-inline-facts">
                <span>Picco: <strong>{formatDate(analysis.maxDrawdownPeakDate)}</strong></span>
                <span>Minimo: <strong>{formatDate(analysis.maxDrawdownDate)}</strong></span>
                <span>Recupero: <strong>{formatDate(analysis.maxDrawdownRecoveryDate)}</strong></span>
              </div>
            </>
          )}
        </ChartPanel>
        <ChartPanel title={`10 ${isDaily ? "giorni" : "periodi"} peggiori`} description="Eventi ordinati dal rendimento più negativo.">
          <div className="quant-table-wrap quant-compact-table">
            <table>
              <caption className="quant-visually-hidden">Dieci rendimenti peggiori</caption>
              <thead><tr><th scope="col">Data</th><th scope="col">Rendimento</th></tr></thead>
              <tbody>
                {(analysis.worstDays || []).map((row) => (
                  <tr key={row.date}><th scope="row">{formatDate(row.date)}</th><td className="is-negative">{formatSignedPercentage(row.valuePct)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </ChartPanel>
      </div>
    </div>
  );

  const renderBenchmark = () => {
    if (benchmarkLoading) {
      return (
        <div className="quant-tab-content" role="tabpanel" id="quant-panel-benchmark" aria-labelledby="quant-tab-benchmark">
          <div className="quant-tab-loading" role="status">Caricamento e allineamento del benchmark…</div>
        </div>
      );
    }
    if (benchmarkError) {
      return (
        <div className="quant-tab-content" role="tabpanel" id="quant-panel-benchmark" aria-labelledby="quant-tab-benchmark">
          <StatePanel
            type="error"
            title="Benchmark non disponibile"
            onRetry={handleRetry}
          >
            {benchmarkError}
          </StatePanel>
        </div>
      );
    }
    if (!benchmarkComparison) {
      return (
        <div className="quant-tab-content" role="tabpanel" id="quant-panel-benchmark" aria-labelledby="quant-tab-benchmark">
          <StatePanel title="Confronto non calcolabile">
            Servono almeno due {periodNoun} comuni e configurazioni compatibili, senza forward-fill.
          </StatePanel>
        </div>
      );
    }
    return (
      <div className="quant-tab-content" role="tabpanel" id="quant-panel-benchmark" aria-labelledby="quant-tab-benchmark">
        <div className="quant-benchmark-context">
          <FiShield aria-hidden="true" />
          <span>{compactInteger(benchmarkComparison.observations)} {periodNoun} comuni · benchmark ammessi esclusivamente indici o ETF</span>
        </div>
        {benchmarkComparison.pathContinuous === false && (
          <div className="quant-inline-warning" role="note">
            {benchmarkComparison.pathCaveat || "Gli intervalli comuni non formano un percorso continuo."}
            {finiteNumber(benchmarkComparison.pathGapCount) !== null
              ? ` Gap rilevati: ${compactInteger(benchmarkComparison.pathGapCount)}.`
              : ""}
          </div>
        )}
        <MetricStrip items={benchmarkMetrics} />
        <ChartPanel
          title="Performance cumulata allineata"
          description="Confronto sulle sole date e periodi precedenti comuni; nessun forward-fill."
          className="quant-panel-primary"
        >
          {benchmarkComparison.pathContinuous === false ? (
            <div className="quant-chart-empty" role="status">
              Curva cumulata sospesa: gli intervalli comuni non costituiscono un percorso continuo.
            </div>
          ) : (
            <div className="quant-chart quant-chart-large">
              <Line
                ref={benchmarkChartRef}
                data={benchmarkCumulativeData}
                options={benchmarkLineOptions}
                plugins={[chartBackgroundPlugin]}
                role="img"
                aria-label={`Rendimento cumulato di ${ticker} e ${benchmark}.`}
              />
            </div>
          )}
        </ChartPanel>
        <div className="quant-two-column">
          <ChartPanel title="Dispersione dei rendimenti" description={`${benchmark} sull’asse X, ${ticker} sull’asse Y.`}>
            <div className="quant-chart">
              <Scatter
                data={benchmarkScatterData}
                options={benchmarkScatterOptions}
                plugins={[chartBackgroundPlugin]}
                role="img"
                aria-label={`Scatter dei rendimenti di ${ticker} contro ${benchmark}.`}
              />
            </div>
          </ChartPanel>
          <ChartPanel title="Lettura del confronto" description="Metriche relative calcolate sul campione comune.">
            <dl className="quant-definition-list">
              <div><dt>Rendimento attivo ann.</dt><dd>{formatSignedPercentage(benchmarkComparison.activeReturnAnnualized)}</dd></div>
              <div><dt>Alpha regressione ann.</dt><dd>{formatSignedPercentage(benchmarkComparison.alphaAnnualized)}</dd></div>
              <div><dt>Capture rialzista · n={compactInteger(benchmarkComparison.capture?.upside?.observations)}</dt><dd>{formatPlainPercentage(benchmarkComparison.upsideCapture, 2)}</dd></div>
              <div><dt>Capture ribassista · n={compactInteger(benchmarkComparison.capture?.downside?.observations)}</dt><dd>{formatPlainPercentage(benchmarkComparison.downsideCapture, 2)}</dd></div>
            </dl>
            <p className="quant-panel-note">
              L’alpha è l’intercetta annualizzata della regressione, senza tasso risk-free.
              I capture confrontano i rendimenti geometrici annualizzati nei periodi condizionali.
            </p>
          </ChartPanel>
        </div>
      </div>
    );
  };

  const renderSingleRegression = () => {
    if (benchmarkLoading) {
      return (
        <div className="quant-regression-view">
          <div className="quant-tab-loading" role="status">Stima della regressione e delle diagnostiche…</div>
        </div>
      );
    }
    if (benchmarkError) {
      return (
        <div className="quant-regression-view">
          <StatePanel
            type="error"
            title="Regressione non disponibile"
            onRetry={handleRetry}
          >
            {benchmarkError}
          </StatePanel>
        </div>
      );
    }
    if (!benchmarkComparison || !regression) {
      return (
        <div className="quant-regression-view">
          <StatePanel title="Regressione non calcolabile">
            Servono almeno tre rendimenti allineati, configurazioni compatibili e varianza non nulla del benchmark. Non viene applicato forward-fill.
          </StatePanel>
        </div>
      );
    }
    const rollingSeries = regression.rolling?.series || [];
    const isVerySmallSample = finiteNumber(regression.observations) !== null && regression.observations < 8;
    const isLimitedSample = regression.sampleAdequacy === "limited" || regression.observations < 30;
    return (
      <div className="quant-regression-view">
        <div className="quant-benchmark-context">
          <FiActivity aria-hidden="true" />
          <span>
            OLS di {ticker} su {benchmark} · {compactInteger(regression.observations)} {periodNoun} comuni · errori standard Newey–West
          </span>
        </div>
        {isVerySmallSample && (
          <div className="quant-inline-warning is-strong" role="alert">
            Campione estremamente ridotto: la retta e la banda sono solo descrittive. Con meno di 8 osservazioni non va interpretato un pattern robusto.
          </div>
        )}
        {!isVerySmallSample && isLimitedSample && (
          <div className="quant-inline-warning" role="note">
            Campione limitato (&lt; 30 osservazioni): coefficienti, p-value e intervalli di confidenza possono essere instabili.
          </div>
        )}
        {(regression.warnings || []).map((warning, index) => (
          <div className="quant-inline-warning" role="note" key={`${warning}-${index}`}>{warning}</div>
        ))}
        <MetricStrip items={regressionMetrics} className="quant-regression-metrics" />
        <ChartPanel
          eyebrow="OLS con intercetta"
          title={`${ticker} rispetto a ${benchmark}`}
          description={regression.confidenceBand?.length
            ? "Ogni punto è un periodo comune. La linea mostra la stima OLS; la fascia tratteggiata è l’intervallo di confidenza al 95% della risposta media."
            : "Ogni punto è un periodo comune e la linea mostra la stima OLS. La banda al 95% non è stimabile per questo campione."}
          className="quant-panel-primary"
        >
          <div className="quant-chart quant-chart-large">
            <Scatter
              ref={regressionChartRef}
              data={regressionScatterData}
              options={regressionScatterOptions}
              plugins={[chartBackgroundPlugin]}
              role="img"
              aria-label={`Regressione lineare dei rendimenti di ${ticker} sui rendimenti di ${benchmark}, con retta OLS e banda di confidenza al 95%.`}
            />
          </div>
          <div className="quant-inline-facts">
            <span>β IC 95%: <strong>{formatNumber(regression.confidence95?.slope?.[0], 3)} – {formatNumber(regression.confidence95?.slope?.[1], 3)}</strong></span>
            <span>α periodo IC 95%: <strong>{formatSignedPercentage(regression.confidence95?.interceptPct?.[0])} – {formatSignedPercentage(regression.confidence95?.interceptPct?.[1])}</strong></span>
            <span>SE β HAC: <strong>{formatNumber(regression.standardErrors?.slopeHac, 4)}</strong></span>
            <span>z β: <strong>{formatNumber(regression.zStatistics?.slope, 3)}</strong></span>
          </div>
          <div className="quant-table-wrap quant-compact-table quant-coefficient-table">
            <table>
              <caption className="quant-visually-hidden">Coefficienti della regressione lineare con inferenza Newey–West</caption>
              <thead>
                <tr><th scope="col">Coefficiente</th><th scope="col">Stima</th><th scope="col">SE HAC</th><th scope="col">z</th><th scope="col">p-value</th><th scope="col">IC 95%</th></tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Alpha · periodo</th>
                  <td>{formatSignedPercentage(regression.interceptPct)}</td>
                  <td>{formatUnsignedPercentage(regression.standardErrors?.interceptHacPct)}</td>
                  <td>{formatNumber(regression.zStatistics?.intercept, 3)}</td>
                  <td>{formatPValue(regression.pValues?.intercept)}</td>
                  <td>{formatSignedPercentage(regression.confidence95?.interceptPct?.[0])} – {formatSignedPercentage(regression.confidence95?.interceptPct?.[1])}</td>
                </tr>
                <tr>
                  <th scope="row">Beta · slope</th>
                  <td>{formatNumber(regression.slope, 4)}</td>
                  <td>{formatNumber(regression.standardErrors?.slopeHac, 4)}</td>
                  <td>{formatNumber(regression.zStatistics?.slope, 3)}</td>
                  <td>{formatPValue(regression.pValues?.slope)}</td>
                  <td>{formatNumber(regression.confidence95?.slope?.[0], 3)} – {formatNumber(regression.confidence95?.slope?.[1], 3)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </ChartPanel>
        <div className="quant-two-column quant-regression-diagnostics">
          <ChartPanel
            title="Residui nel tempo"
            description="Scarto tra rendimento osservato e stimato; gli outlier hanno |residuo standardizzato| ≥ 2."
          >
            <div className="quant-chart">
              <Line
                data={residualData}
                options={residualOptions}
                plugins={[chartBackgroundPlugin]}
                role="img"
                aria-label={`Residui della regressione di ${ticker} nel tempo, con linea zero e outlier standardizzati.`}
              />
            </div>
          </ChartPanel>
          <ChartPanel
            eyebrow="Controlli del modello"
            title="Diagnostica dei residui"
            description="Errori di adattamento, dipendenza seriale e forma della distribuzione residua."
          >
            <dl className="quant-definition-list">
              <div><dt>RMSE</dt><dd>{formatUnsignedPercentage(regression.rmsePct)}</dd></div>
              <div><dt>MAE</dt><dd>{formatUnsignedPercentage(regression.maePct)}</dd></div>
              <div><dt>Durbin–Watson</dt><dd>{formatNumber(regression.diagnostics?.durbinWatson, 3)}</dd></div>
              <div><dt>Autocorr. residui · lag 1</dt><dd>{formatNumber(regression.diagnostics?.autocorrelationLag1, 3)}</dd></div>
              <div><dt>Jarque–Bera · p-value</dt><dd>{formatNumber(regression.diagnostics?.jarqueBera, 2)} · {formatPValue(regression.diagnostics?.jarqueBeraPValue)}</dd></div>
              <div><dt>Skewness residui</dt><dd>{formatNumber(regression.diagnostics?.residualSkewness, 3)}</dd></div>
              <div><dt>Curtosi eccesso residui</dt><dd>{formatNumber(regression.diagnostics?.residualExcessKurtosis, 3)}</dd></div>
              <div><dt>Outlier standardizzati</dt><dd>{compactInteger(regression.diagnostics?.outlierCount)}</dd></div>
              <div><dt>Lag Newey–West</dt><dd>{compactInteger(regression.neweyWestLag)}</dd></div>
            </dl>
            <p className="quant-panel-note">
              I p-value HAC sono approssimazioni asintotiche robuste a eteroschedasticità e autocorrelazione entro il lag indicato. Non dimostrano causalità né validità predittiva.
            </p>
          </ChartPanel>
        </div>
        <div className="quant-two-column quant-rolling-regression-grid">
          <ChartPanel
            title="Beta mobile"
            description={`Sensibilità stimata su finestre contigue di ${compactInteger(regression.rolling?.window)} ${periodNoun}; la linea tratteggiata indica beta = 1.`}
          >
            {rollingSeries.length ? (
              <div className="quant-chart">
                <Line data={rollingBetaData} options={rollingBetaOptions} plugins={[chartBackgroundPlugin]} role="img" aria-label={`Beta mobile di ${ticker} rispetto a ${benchmark}.`} />
              </div>
            ) : (
              <div className="quant-chart-empty" role="status">Campione insufficiente per il beta mobile.</div>
            )}
          </ChartPanel>
          <ChartPanel
            title="R² mobile"
            description={`Quota di variabilità spiegata dal benchmark nelle stesse finestre di ${compactInteger(regression.rolling?.window)} ${periodNoun}.`}
          >
            {rollingSeries.length ? (
              <div className="quant-chart">
                <Line data={rollingRSquaredData} options={rollingRSquaredOptions} plugins={[chartBackgroundPlugin]} role="img" aria-label={`R quadro mobile di ${ticker} rispetto a ${benchmark}.`} />
              </div>
            ) : (
              <div className="quant-chart-empty" role="status">Campione insufficiente per l’R² mobile.</div>
            )}
          </ChartPanel>
        </div>
      </div>
    );
  };

  const renderMultipleRegression = () => {
    if (isUnsupportedMultiCurrency) {
      return (
        <div className="quant-regression-view">
          <StatePanel type="error" title="Proxy USA non compatibili">
            Il titolo è quotato in {tradingCurrency}: SPY, QQQ, IWM e gli ETF settoriali USA non sono un confronto fail-safe per valuta, calendario e orari di negoziazione. La regressione multifattoriale non viene stimata.
          </StatePanel>
        </div>
      );
    }
    if (!isDriverRegression && multiFactorLoading) {
      return (
        <div className="quant-regression-view">
          <div className="quant-tab-loading" role="status" aria-live="polite">
            Allineamento dei proxy e stima dei modelli multifattoriali…
          </div>
        </div>
      );
    }

    const targetIsSpy = [
      ticker,
      historyPayload?.requestedTicker,
      historyPayload?.resolvedTicker,
    ].map(normalizeTicker).includes("SPY");
    const fittedSeries = multipleRegression?.fittedSeries || [];
    const effectiveStart = multipleRegression?.firstDate || fittedSeries[0]?.date;
    const effectiveEnd = multipleRegression?.lastDate || fittedSeries[fittedSeries.length - 1]?.date;
    const maxVif = finiteNumber(multipleRegression?.diagnostics?.maxVif);
    const severeVif = maxVif !== null && maxVif >= 10;
    const elevatedVif = maxVif !== null && maxVif >= 5;
    const minimumUsefulSample = multipleRegression
      ? Math.max(30, 10 * (Number(multipleRegression.predictorCount) + 1))
      : 30;
    const limitedSample = multipleRegression
      && (multipleRegression.sampleAdequacy === "limited" || multipleRegression.observations < minimumUsefulSample);

    if (!multipleRegression) {
      const fallbackMessage = isDriverRegression
        ? displayedMultipleRegressionResult.error || "Storico insufficiente: servono almeno 21 sedute complete con prezzi e volumi."
        : targetIsSpy
        ? "SPY è il titolo dipendente: il fattore mercato coinciderebbe con il target e i fattori relativi QQQ−SPY, IWM−SPY e settore−SPY sottrarrebbero il target. Il modello viene bloccato per evitare leakage."
        : multipleRegressionResult.error
          || "Non ci sono abbastanza fattori compatibili e osservazioni complete per stimare il modello senza forward-fill.";
      return (
        <div className="quant-regression-view">
          {!isDriverRegression && multiFactorPlan.incompatibleSources.map((item) => (
            <div className="quant-inline-warning is-strong" role="alert" key={`price-${item.ticker}`}>
              Fonte prezzo incompatibile per {item.ticker}: il titolo usa {item.targetPrice}, il proxy usa {item.sourcePrice}. Seleziona esplicitamente Close o Adjusted per tutte le serie; il motore non mescola le fonti.
            </div>
          ))}
          {!isDriverRegression && multiFactorPlan.missingSources.map((item) => (
            <div className="quant-inline-warning" role="note" key={`missing-${item.ticker}`}>
              {item.ticker}: {item.message} Il fattore dipendente da questa fonte è stato omesso.
            </div>
          ))}
          {!isDriverRegression && multiFactorPlan.exclusions.map((message, index) => (
            <div className="quant-inline-warning" role="note" key={`excluded-${index}`}>{message}</div>
          ))}
          <StatePanel title={isDriverRegression ? "Regressione driver non calcolabile" : "Modello multifattoriale non calcolabile"}>
            {fallbackMessage}
          </StatePanel>
        </div>
      );
    }

    return (
      <div className="quant-regression-view">
        <div className="quant-benchmark-context quant-multi-context">
          <FiActivity aria-hidden="true" />
          <span>
            OLS multifattoriale di {ticker} · {compactInteger(multipleRegression.observations)} {periodNoun} complete-case
            {effectiveStart && effectiveEnd ? ` · ${formatDate(effectiveStart)} – ${formatDate(effectiveEnd)}` : ""}
            {` · ${multipleRegression.predictorCount} fattori · HAC Newey–West`}
          </span>
        </div>
        <div className="quant-factor-source-list" aria-label={isDriverRegression ? "Driver quantitativi utilizzati" : "Fattori e proxy utilizzati"}>
          {(multipleRegression.factors || []).map((factor) => (
            <span key={factor.key}>
              <strong>{factor.label}</strong>
              <small>{factor.subtractTicker ? `${factor.sourceTicker} meno ${factor.subtractTicker}` : factor.sourceTicker}</small>
            </span>
          ))}
        </div>
        {!isDriverRegression && !tradingCurrency && (
          <div className="quant-inline-warning" role="note">
            Valuta del titolo non dichiarata dal provider: i proxy sono ETF USA in USD. Il risultato è mostrato con questa limitazione e non va interpretato come modello universale.
          </div>
        )}
        {!isDriverRegression && (multipleRegression.factors || []).some((factor) => factor.key === "sector") && (
          <div className="quant-inline-warning" role="note">
            L’ETF di settore deriva dalla classificazione settoriale corrente, non point-in-time.{range === "10y" ? " La sua storia può accorciare sensibilmente il campione comune a 10 anni." : " La sua storia può accorciare il campione comune."}
          </div>
        )}
        {!isDriverRegression && multiFactorPlan.incompatibleSources.map((item) => (
          <div className="quant-inline-warning is-strong" role="alert" key={`price-${item.ticker}`}>
            {item.ticker} escluso: fonte {item.sourcePrice} diversa da {item.targetPrice} del titolo. Seleziona Close o Adjusted esplicitamente; le fonti non vengono mescolate.
          </div>
        ))}
        {!isDriverRegression && multiFactorPlan.missingSources.map((item) => (
          <div className="quant-inline-warning" role="note" key={`missing-${item.ticker}`}>
            Fonte parziale · {item.ticker}: {item.message} I modelli disponibili restano calcolati senza quel fattore.
          </div>
        ))}
        {!isDriverRegression && multiFactorPlan.exclusions.map((message, index) => (
          <div className="quant-inline-warning" role="note" key={`excluded-${index}`}>{message}</div>
        ))}
        {limitedSample && (
          <div className="quant-inline-warning is-strong" role="alert">
            Campione limitato per {multipleRegression.predictorCount} fattori: n={compactInteger(multipleRegression.observations)}; come controllo prudenziale sono preferibili almeno {compactInteger(minimumUsefulSample)} osservazioni complete. Coefficienti e inferenza possono essere instabili.
          </div>
        )}
        {elevatedVif && (
          <div className={`quant-inline-warning${severeVif ? " is-strong" : ""}`} role={severeVif ? "alert" : "note"}>
            VIF massimo {formatNumber(maxVif, 2)}: {severeVif ? "forte" : "possibile"} multicollinearità. I beta individuali possono essere instabili anche con un R² elevato.
          </div>
        )}
        {(multipleRegression.warnings || []).map((warning, index) => (
          <div className="quant-inline-warning" role="note" key={`multi-warning-${index}`}>{warning}</div>
        ))}
        {isDriverRegression && (
          <div className="quant-inline-warning" role="note">
            Driver inclusi: shock e trend dei volumi, momentum e volatilità a 20 sedute, più stagionalità mensile (sin/cos). Le variabili di mercato sono ritardate di una seduta; la stagionalità è deterministica e non usa dati futuri.
          </div>
        )}
        <MetricStrip items={multipleRegressionMetrics} className="quant-regression-metrics quant-multi-regression-metrics" />
        <div className="quant-two-column quant-multi-model-grid">
          <ChartPanel
            eyebrow="Specificazioni · stesso campione"
            title="Confronto tra modelli"
            description="R² aggiustato per specificazioni stimate sulla medesima intersezione complete-case. L’asse include sempre lo zero."
            className="quant-panel-primary"
          >
            <div className="quant-chart">
              <Bar
                ref={multipleRegressionChartRef}
                data={multiModelComparisonData}
                options={multiModelComparisonOptions}
                plugins={[chartBackgroundPlugin]}
                role="img"
                aria-label={`Confronto dell'R quadro aggiustato dei modelli multifattoriali per ${ticker}, con asse che include zero.`}
              />
            </div>
          </ChartPanel>
          <ChartPanel
            eyebrow="Esposizioni condizionali"
            title="Coefficienti dei fattori"
            description="Beta parziali del modello completo: ogni stima controlla per gli altri fattori inclusi. L’asse include lo zero."
          >
            <div className="quant-chart">
              <Bar
                data={multiCoefficientData}
                options={multiCoefficientOptions}
                plugins={[chartBackgroundPlugin]}
                role="img"
                aria-label={`Coefficienti multifattoriali di ${ticker}, con linea implicita dello zero.`}
              />
            </div>
          </ChartPanel>
        </div>
        <ChartPanel
          eyebrow="Inferenza robusta"
          title="Coefficienti, incertezza e collinearità"
          description="Errori standard e p-value HAC Newey–West. ΔR² LOO misura la perdita di R² in-sample rimuovendo un fattore dal modello completo: non è un incremento sequenziale né out-of-sample."
        >
          <div className="quant-table-wrap quant-compact-table quant-multi-coefficient-table">
            <table>
              <caption className="quant-visually-hidden">Coefficienti della regressione multifattoriale con inferenza HAC, VIF e delta R quadro leave-one-out in-sample</caption>
              <thead>
                <tr>
                  <th scope="col">Coefficiente</th>
                  <th scope="col">Stima</th>
                  <th scope="col">SE HAC</th>
                  <th scope="col">z</th>
                  <th scope="col">p-value</th>
                  <th scope="col">IC 95%</th>
                  <th scope="col">VIF</th>
                  <th scope="col">ΔR² LOO · in-sample</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Intercetta / alpha descrittiva</th>
                  <td>{formatSignedPercentage(multipleRegression.intercept?.estimatePct)}</td>
                  <td>{formatUnsignedPercentage(multipleRegression.intercept?.seHacPct)}</td>
                  <td>{formatNumber(multipleRegression.intercept?.z, 3)}</td>
                  <td>{formatPValue(multipleRegression.intercept?.pValue)}</td>
                  <td>{formatSignedPercentage(multipleRegression.intercept?.confidence95Pct?.[0])} – {formatSignedPercentage(multipleRegression.intercept?.confidence95Pct?.[1])}</td>
                  <td>—</td>
                  <td>—</td>
                </tr>
                {(multipleRegression.coefficients || []).map((coefficient) => (
                  <tr key={coefficient.key}>
                    <th scope="row">{coefficient.label}</th>
                    <td>{formatNumber(coefficient.estimate, 4)}</td>
                    <td>{formatNumber(coefficient.seHac, 4)}</td>
                    <td>{formatNumber(coefficient.z, 3)}</td>
                    <td>{formatPValue(coefficient.pValue)}</td>
                    <td>{formatNumber(coefficient.confidence95?.[0], 3)} – {formatNumber(coefficient.confidence95?.[1], 3)}</td>
                    <td className={(finiteNumber(coefficient.vif) ?? 0) >= 10 ? "is-negative" : ""}>{formatNumber(coefficient.vif, 2)}</td>
                    <td>{formatNumber(coefficient.incrementalRSquared, 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ChartPanel>
        <div className="quant-two-column quant-multi-fit-grid">
          <ChartPanel
            title="Osservato e stimato"
            description="Rendimenti del titolo e valori fitted OLS sul campione comune, senza forward-fill."
          >
            <div className="quant-chart">
              <Line data={multiObservedFittedData} options={multiObservedFittedOptions} plugins={[chartBackgroundPlugin]} role="img" aria-label={`Rendimenti osservati e stimati dal modello multifattoriale per ${ticker}.`} />
            </div>
          </ChartPanel>
          <ChartPanel
            title="Residui e outlier"
            description="Scarti osservato meno stimato; gli outlier hanno |residuo standardizzato| ≥ 2."
          >
            <div className="quant-chart">
              <Line data={multiResidualData} options={multiResidualOptions} plugins={[chartBackgroundPlugin]} role="img" aria-label={`Residui del modello multifattoriale per ${ticker}, con zero e outlier standardizzati.`} />
            </div>
          </ChartPanel>
        </div>
        <div className="quant-two-column quant-multi-diagnostic-grid">
          <ChartPanel
            eyebrow="Controlli del modello completo"
            title="Diagnostica"
            description="Fit, dipendenza seriale, distribuzione dei residui e stabilità numerica."
          >
            <dl className="quant-definition-list">
              <div><dt>RSE</dt><dd>{formatUnsignedPercentage(multipleRegression.residualStandardErrorPct)}</dd></div>
              <div><dt>RMSE / MAE</dt><dd>{formatUnsignedPercentage(multipleRegression.rmsePct)} / {formatUnsignedPercentage(multipleRegression.maePct)}</dd></div>
              <div><dt>AIC / BIC</dt><dd>{formatNumber(multipleRegression.aic, 2)} / {formatNumber(multipleRegression.bic, 2)}</dd></div>
              <div><dt>Durbin–Watson</dt><dd>{formatNumber(multipleRegression.diagnostics?.durbinWatson, 3)}</dd></div>
              <div><dt>Autocorr. residui · lag 1</dt><dd>{formatNumber(multipleRegression.diagnostics?.autocorrelationLag1, 3)}</dd></div>
              <div><dt>Jarque–Bera · p-value</dt><dd>{formatNumber(multipleRegression.diagnostics?.jarqueBera, 2)} · {formatPValue(multipleRegression.diagnostics?.jarqueBeraPValue)}</dd></div>
              <div><dt>Skewness / curtosi eccesso</dt><dd>{formatNumber(multipleRegression.diagnostics?.residualSkewness, 3)} / {formatNumber(multipleRegression.diagnostics?.residualExcessKurtosis, 3)}</dd></div>
              <div><dt>Outlier standardizzati</dt><dd>{compactInteger(multipleRegression.diagnostics?.outlierCount)}</dd></div>
              <div><dt>Transizioni contigue / gap</dt><dd>{compactInteger(multipleRegression.diagnostics?.continuousTransitions)} / {compactInteger(multipleRegression.diagnostics?.pathGapCount)}</dd></div>
              <div><dt>Lag Newey–West</dt><dd>{compactInteger(multipleRegression.neweyWestLag)}</dd></div>
              {(multipleRegression.diagnostics?.conditionNumber !== undefined || multipleRegression.diagnostics?.rank !== undefined || multipleRegression.diagnostics?.matrixRank !== undefined) && (
                <div><dt>Condition number / rank</dt><dd>{formatNumber(multipleRegression.diagnostics?.conditionNumber, 2)} / {compactInteger(multipleRegression.diagnostics?.rank ?? multipleRegression.diagnostics?.matrixRank)}</dd></div>
              )}
            </dl>
          </ChartPanel>
          <ChartPanel
            eyebrow="Confronto controllato"
            title="Dettaglio specificazioni"
            description="Tutti i modelli usano la stessa intersezione di date e sono quindi confrontabili in-sample."
          >
            <div className="quant-table-wrap quant-compact-table quant-model-comparison-table">
              <table>
                <caption className="quant-visually-hidden">Specificazioni multifattoriali confrontate sullo stesso campione</caption>
                <thead><tr><th scope="col">Modello</th><th scope="col">Fattori</th><th scope="col">n</th><th scope="col">R²</th><th scope="col">R² agg.</th><th scope="col">RMSE</th><th scope="col">AIC</th><th scope="col">BIC</th></tr></thead>
                <tbody>
                  {(multipleRegression.modelComparisons || []).map((model) => (
                    <tr key={model.key}>
                      <th scope="row">{model.label || model.key}</th>
                      <td>{(model.predictorKeys || []).join(" + ") || "—"}</td>
                      <td>{compactInteger(model.observations)}</td>
                      <td>{formatNumber(model.rSquared, 3)}</td>
                      <td>{formatNumber(model.adjustedRSquared, 3)}</td>
                      <td>{formatUnsignedPercentage(model.rmsePct)}</td>
                      <td>{formatNumber(model.aic, 2)}</td>
                      <td>{formatNumber(model.bic, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="quant-panel-note">
              Un fit migliore in-sample non implica capacità predittiva. AIC e BIC sono confrontabili qui perché risposta e campione sono identici.
            </p>
          </ChartPanel>
        </div>
        <div className="quant-disclaimer quant-multi-disclaimer">
          <FiAlertCircle aria-hidden="true" />
          <p>
            Analisi descrittiva e non causale: i proxy SPY, QQQ−SPY, IWM−SPY e settore−SPY non sono fattori accademici, non incorporano il risk-free e non costituiscono una previsione dei rendimenti futuri.
          </p>
        </div>
      </div>
    );
  };

  const renderRegression = () => (
    <div className="quant-tab-content" role="tabpanel" id="quant-panel-regression" aria-labelledby="quant-tab-regression">
      <section className="quant-regression-model-header" aria-labelledby="quant-regression-model-title">
        <div>
          <span className="quant-eyebrow">Modello di regressione</span>
          <h2 id="quant-regression-model-title">Scegli il livello di analisi</h2>
          <p>Confronto singolo con il benchmark, modello multifattoriale oppure driver osservabili del titolo.</p>
        </div>
        <div className="quant-model-toggle" role="group" aria-label="Tipo di regressione lineare">
          <button
            type="button"
            className={regressionModel === "single" ? "is-active" : ""}
            aria-pressed={regressionModel === "single"}
            onClick={() => updateQuery({ regModel: "single" })}
          >
            Benchmark singolo
          </button>
          <button
            type="button"
            className={regressionModel === "multi" ? "is-active" : ""}
            aria-pressed={regressionModel === "multi"}
            onClick={() => updateQuery({ regModel: "multi" })}
          >
            Multifattoriale
          </button>
          <button
            type="button"
            className={regressionModel === "drivers" ? "is-active" : ""}
            aria-pressed={regressionModel === "drivers"}
            onClick={() => updateQuery({ regModel: "drivers" })}
          >
            Driver quantitativi
          </button>
        </div>
      </section>
      {regressionModel === "single" ? renderSingleRegression() : renderMultipleRegression()}
    </div>
  );

  const qualityRows = analysis ? [
    ["Sorgente", historyPayload?.dataSource || "Provider storico"],
    ["Generato il", historyPayload?.generatedAt ? formatDateTime(historyPayload.generatedAt) : "—"],
    ["Ticker richiesto / risolto", `${historyPayload?.requestedTicker || ticker} / ${historyPayload?.resolvedTicker || ticker}`],
    ["Range richiesto", `${formatDate(historyPayload?.rangeStart || analysis.requestedFirstDate)} – ${formatDate(historyPayload?.rangeEnd || analysis.requestedLastDate)}`],
    ["Range dati API", `${formatDate(historyPayload?.actualStart)} – ${formatDate(historyPayload?.actualEnd)}`],
    ["Range effettivo analisi", `${formatDate(analysis.firstDate)} – ${formatDate(analysis.lastDate)}`],
    ["Osservazioni API / analisi", `${compactInteger(historyPayload?.observationCount)} / ${compactInteger(analysis.observations)}`],
    ["Fonte prezzo usata", analysis.priceSource === "adjustedClose" ? "Chiusura rettificata" : "Chiusura standard"],
    ["Copertura adjusted", formatUnsignedPercentage(historyPayload?.adjustedCloseCoveragePct ?? analysis.quality?.adjustedCoveragePct)],
    ["Seed precedente al range", historyPayload?.includesPreviousClose ? "Presente" : "Non dichiarato"],
    ["Sessione incompleta", historyPayload?.excludedPotentiallyIncompleteSession ? "Esclusa" : "Non rilevata"],
    ["Righe input / normalizzate", `${compactInteger(analysis.quality?.inputRows)} / ${compactInteger(analysis.quality?.normalizedRows)}`],
    ["Date invalide / duplicati", `${compactInteger(analysis.quality?.invalidRows)} / ${compactInteger(analysis.quality?.duplicateRows)}`],
    ["Prezzi mancanti", compactInteger(analysis.quality?.priceMissingRows)],
    ["Coppie mancanti escluse", compactInteger(analysis.quality?.skippedMissingPairs)],
    ["Rendimenti esclusi per gap", compactInteger(analysis.quality?.returnsExcludedForGap)],
    ["Percorso continuo", analysis.pathContinuous === false ? "No · metriche path sospese" : "Sì"],
    ["Corporate action", compactInteger(historyPayload?.corporateActionCount)],
    ["Righe backend rimosse", compactInteger(historyPayload?.invalidRowsRemoved)],
  ] : [];

  const renderMonteCarlo = () => {
    if (!monteCarlo) {
      return (
        <div className="quant-tab-content" role="tabpanel" id="quant-panel-montecarlo" aria-labelledby="quant-tab-montecarlo">
          <StatePanel type={monteCarloResult.error && currentPrice !== null ? "error" : "warning"} title={currentPrice === null ? "In attesa della quotazione corrente" : "Simulazione non disponibile"}>
            {monteCarloResult.error || "Servono almeno 30 rendimenti validi per costruire scenari affidabili."}
          </StatePanel>
        </div>
      );
    }
    const terminal = monteCarlo.terminalQuantiles || {};
    const pathLabels = Array.from({ length: monteCarlo.horizon + 1 }, (_, index) => index);
    const pathPercentile = (step, probability) => {
      const values = monteCarlo.paths.map((path) => path[step]).filter(Number.isFinite).sort((a, b) => a - b);
      if (!values.length) return null;
      const position = (values.length - 1) * probability;
      const lower = Math.floor(position);
      const upper = Math.ceil(position);
      return values[lower] + (values[upper] - values[lower]) * (position - lower);
    };
    const pathBands = [
      { label: "P05", probability: 0.05, color: darkMode ? "rgba(248, 113, 113, 0.9)" : "rgba(190, 53, 62, 0.82)", dash: [5, 4] },
      { label: "P50", probability: 0.5, color: darkMode ? "#5be09c" : "#148e5b", dash: [] },
      { label: "P95", probability: 0.95, color: darkMode ? "rgba(91, 224, 156, 0.9)" : "rgba(20, 142, 91, 0.82)", dash: [5, 4] },
    ];
    const pathData = {
      labels: pathLabels,
      datasets: [
        ...monteCarlo.paths.map((path, index) => ({
          label: `Percorso ${index + 1}`,
          data: path,
          borderColor: darkMode ? "rgba(91, 224, 156, 0.16)" : "rgba(20, 142, 91, 0.13)",
          borderWidth: 1,
          pointRadius: 0,
          tension: 0.1,
        })),
        ...pathBands.map((band) => ({
          label: band.label,
          data: pathLabels.map((_, step) => pathPercentile(step, band.probability)),
          borderColor: band.color,
          borderWidth: band.label === "P50" ? 2.5 : 1.5,
          borderDash: band.dash,
          pointRadius: 0,
          tension: 0.18,
          order: 0,
        })),
      ],
    };
    const pathOptions = {
      ...baseOptions("Sedute simulate", "Prezzo dell'azione"),
      scales: {
        ...baseOptions("Sedute simulate", "Prezzo dell'azione").scales,
        x: { ...baseOptions("Sedute simulate", "Prezzo dell'azione").scales.x, title: { display: true, text: "Sedute future" } },
        y: { ...baseOptions("Sedute simulate", "Prezzo dell'azione").scales.y, title: { display: true, text: `Prezzo (${tradingCurrency || "valuta"})` } },
      },
      plugins: { ...baseOptions("Sedute simulate", "Prezzo dell'azione").plugins, legend: { display: false } },
    };
    const histogramLabels = monteCarlo.histogram.map((bin) => formatNumber((bin.x0 + bin.x1) / 2, 2));
    const histogramData = {
      labels: histogramLabels,
      datasets: [{
        label: "Percorsi",
        data: monteCarlo.histogram.map((bin) => bin.count),
        backgroundColor: darkMode ? "rgba(91, 224, 156, 0.65)" : "rgba(20, 142, 91, 0.62)",
        borderColor: darkMode ? "#5be09c" : "#148e5b",
        borderWidth: 1,
      }],
    };
    const histogramOptions = {
      ...baseOptions("Valore terminale", "Percorsi"),
      plugins: { ...baseOptions("Valore terminale", "Percorsi").plugins, legend: { display: false } },
    };
    const terminalReturns = monteCarlo.terminalReturnQuantiles || {};
    const horizonLabel = mcHorizon === 21
      ? "1 mese"
      : mcHorizon === 63
        ? "3 mesi"
        : mcHorizon === 126
          ? "6 mesi"
          : mcHorizon === 252
            ? "1 anno"
            : `${mcHorizon} sedute`;
    const returnFromInitial = (value) => {
      const numeric = finiteNumber(value);
      return numeric === null ? null : ((numeric / monteCarlo.initialValue) - 1) * 100;
    };
    const varianceLabel = finiteNumber(monteCarlo.returnVariance) === null
      ? "—"
      : `${formatNumber(monteCarlo.returnVariance * 10000, 4)} %²`;
    const scenarioRows = [
      { key: "p01", label: "Stress estremo", percentile: "P01", value: terminal.p01, returnValue: terminalReturns.p01, tone: "negative", interpretation: "1% degli scenari è peggiore di questo livello." },
      { key: "p05", label: "Coda negativa", percentile: "P05", value: terminal.p05, returnValue: terminalReturns.p05, tone: "negative", interpretation: "Quantile usato per VaR ed Expected Shortfall." },
      { key: "p25", label: "Scenario prudente", percentile: "P25", value: terminal.p25, returnValue: terminalReturns.p25, interpretation: "Un quarto degli scenari chiude sotto questo valore." },
      { key: "median", label: "Scenario centrale", percentile: "P50", value: terminal.median, returnValue: terminalReturns.median, tone: "positive", interpretation: "Mediana: metà degli scenari è sopra e metà sotto." },
      { key: "p75", label: "Scenario favorevole", percentile: "P75", value: terminal.p75, returnValue: terminalReturns.p75, tone: "positive", interpretation: "Tre quarti degli scenari restano sotto questo livello." },
      { key: "p95", label: "Coda positiva", percentile: "P95", value: terminal.p95, returnValue: terminalReturns.p95, tone: "positive", interpretation: "Solo il 5% degli scenari supera questo risultato." },
    ];
    const mcMetrics = [
      { label: "Rendimento atteso", value: formatSignedPercentage(returnFromInitial(monteCarlo.terminalMean)), detail: `Media terminale · ${horizonLabel}`, tone: returnFromInitial(monteCarlo.terminalMean) >= 0 ? "positive" : "negative" },
      { label: "Prob. rendimento positivo", value: formatUnsignedPercentage(monteCarlo.positiveProbability * 100), detail: "Terminale > valore iniziale" },
      { label: "Scenario mediano", value: formatSignedPercentage(terminalReturns.median * 100), detail: `P50 · ${formatNumber(terminal.median, 2)} indicizzato`, tone: terminalReturns.median >= 0 ? "positive" : "negative" },
      { label: "Intervallo P05 / P95", value: `${formatSignedPercentage(terminalReturns.p05 * 100)} / ${formatSignedPercentage(terminalReturns.p95 * 100)}`, detail: "90% degli scenari" },
      { label: "VaR simulato 5%", value: formatSignedPercentage(monteCarlo.var05 * 100), detail: "Perdita nel quantile sfavorevole", tone: "negative" },
      { label: "Expected Shortfall 5%", value: formatSignedPercentage(monteCarlo.expectedShortfall05 * 100), detail: "Media della coda peggiore", tone: "negative" },
      { label: "Max drawdown mediano", value: formatSignedPercentage(monteCarlo.maxDrawdownMedian * 100), detail: "Durante il percorso", tone: "negative" },
    ];
    return (
      <div className="quant-tab-content" role="tabpanel" id="quant-panel-montecarlo" aria-labelledby="quant-tab-montecarlo">
        <ChartPanel eyebrow="Scenario engine · historical bootstrap" title="Simulazione Monte Carlo" description="Distribuzione di scenari ottenuta ricampionando i rendimenti giornalieri osservati. Il motore è deterministico con seed visibile, così ogni risultato è riproducibile e auditabile.">
          <div className="quant-mc-hero">
            <div className="quant-mc-hero-copy">
              <span className="quant-mc-status"><span className="quant-mc-status-dot" /> Modello attivo</span>
              <span className="quant-mc-spot-price">Prezzo di partenza: <strong>{formatNumber(monteCarlo.initialValue, 2)} {tradingCurrency || ""}</strong> · {monteCarlo.initialValueSource}</span>
              <strong>{horizonLabel} · {compactInteger(monteCarlo.pathCount)} percorsi</strong>
              <span>Prezzo corrente usato come base: {formatNumber(monteCarlo.initialValue, 2)} {tradingCurrency || ""} · {monteCarlo.initialValueSource} · {compactInteger(monteCarlo.sourceObservations)} osservazioni storiche</span>
            </div>
            <div className="quant-mc-method-badge"><FiShield aria-hidden="true" /><span>{monteCarlo.bootstrapMethod === "moving-block" ? "Moving block bootstrap" : "Bootstrap IID"}</span><small>{monteCarlo.bootstrapMethod === "moving-block" ? `blocchi da ${monteCarlo.blockLength} sedute · dipendenza preservata` : "osservazioni indipendenti"}</small></div>
          </div>
          <div className="quant-controls-grid quant-montecarlo-controls">
            <Control label="Orizzonte" htmlFor="mc-horizon"><select id="mc-horizon" value={mcHorizon} onChange={(event) => setMcHorizon(Number(event.target.value))}><option value="21">1 mese · 21 sedute</option><option value="63">3 mesi · 63 sedute</option><option value="126">6 mesi · 126 sedute</option><option value="252">1 anno · 252 sedute</option></select></Control>
            <Control label="Percorsi" htmlFor="mc-paths"><select id="mc-paths" value={mcPathCount} onChange={(event) => setMcPathCount(Number(event.target.value))}><option value="1000">1.000</option><option value="2000">2.000</option><option value="5000">5.000</option><option value="10000">10.000</option></select></Control>
            <Control label="Seed" htmlFor="mc-seed"><input id="mc-seed" type="number" min="1" value={mcSeed} onChange={(event) => setMcSeed(Math.max(1, Number(event.target.value) || 1))} /></Control>
            <Control label="Campionamento" htmlFor="mc-method"><select id="mc-method" value={mcBootstrapMethod} onChange={(event) => setMcBootstrapMethod(event.target.value)}><option value="moving-block">Moving block · dipendenza</option><option value="iid">IID · indipendente</option></select></Control>
            <Control label="Ampiezza blocco" htmlFor="mc-block"><select id="mc-block" value={mcBlockLength} disabled={mcBootstrapMethod !== "moving-block"} onChange={(event) => setMcBlockLength(Number(event.target.value))}><option value="3">3 sedute</option><option value="5">5 sedute</option><option value="10">10 sedute</option><option value="20">20 sedute</option></select></Control>
          </div>
          <MetricStrip items={mcMetrics} className="quant-montecarlo-summary" />
        </ChartPanel>
        <div className="quant-two-column quant-montecarlo-grid">
          <ChartPanel title="Percorsi simulati" description={`${compactInteger(monteCarlo.paths.length)} percorsi visualizzati su ${compactInteger(monteCarlo.pathCount)} generati; traiettorie ancorate al prezzo corrente di ${formatNumber(monteCarlo.initialValue, 2)} ${tradingCurrency || ""}.`}>
            <div className="quant-chart quant-chart-large"><Line data={pathData} options={pathOptions} plugins={[chartBackgroundPlugin]} role="img" aria-label="Percorsi Monte Carlo simulati." /></div>
            <div className="quant-mc-chart-footer"><span><i className="quant-mc-legend-line" /> Percorsi bootstrap</span><span><i className="quant-mc-legend-line quant-mc-legend-band" /> P05 / P50 / P95</span><span><i className="quant-mc-legend-line quant-mc-legend-reference" /> Valore iniziale {formatNumber(monteCarlo.initialValue, 0)}</span></div>
          </ChartPanel>
          <ChartPanel title="Distribuzione del valore terminale" description="La banda P05–P95 mostra l'incertezza dello scenario alla fine dell'orizzonte selezionato.">
            <div className="quant-chart quant-chart-large"><Bar data={histogramData} options={histogramOptions} plugins={[chartBackgroundPlugin]} role="img" aria-label="Istogramma dei valori terminali simulati." /></div>
          </ChartPanel>
        </div>
        <div className="quant-two-column quant-montecarlo-grid quant-mc-detail-grid">
          <ChartPanel eyebrow="Scenario ladder" title="Percentili e lettura del rischio" description="La tabella rende esplicita la coda della distribuzione e il relativo impatto sul capitale indicizzato.">
            <div className="quant-table-wrap quant-compact-table quant-mc-scenario-table">
              <table>
                <caption className="quant-visually-hidden">Scenari percentili della simulazione Monte Carlo</caption>
                <thead><tr><th scope="col">Scenario</th><th scope="col">Percentile</th><th scope="col">Valore terminale</th><th scope="col">Rendimento</th><th scope="col">Interpretazione</th></tr></thead>
                <tbody>{scenarioRows.map((row) => (
                  <tr key={row.key}>
                    <th scope="row">{row.label}</th>
                    <td><span className="quant-mc-percentile">{row.percentile}</span></td>
                    <td>{formatNumber(row.value, 2)}</td>
                    <td className={row.tone ? `is-${row.tone}` : ""}>{formatSignedPercentage(row.returnValue * 100)}</td>
                    <td className="quant-mc-interpretation">{row.interpretation}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </ChartPanel>
          <ChartPanel eyebrow="Risk diagnostics" title="Parametri del processo" description="Statistiche annualizzate dei rendimenti usati dal bootstrap e diagnostica della forma distributiva.">
            <dl className="quant-definition-list quant-mc-diagnostics">
              <div><dt>Drift medio annualizzato</dt><dd className={monteCarlo.annualizedDrift >= 0 ? "is-positive" : "is-negative"}>{formatSignedPercentage(monteCarlo.annualizedDrift * 100)}</dd></div>
              <div><dt>Volatilità annualizzata</dt><dd>{formatUnsignedPercentage(monteCarlo.annualizedVolatility * 100)}</dd></div>
              <div><dt>Probabilità di perdita</dt><dd className="is-negative">{formatUnsignedPercentage(monteCarlo.lossProbability * 100)}</dd></div>
              <div><dt>Deviazione standard terminale</dt><dd>{formatNumber(monteCarlo.terminalStd, 2)}</dd></div>
              <div><dt>Errore standard della media</dt><dd>± {formatNumber(monteCarlo.terminalMeanStandardError, 2)}</dd></div>
              <div><dt>Errore standard P(positivo)</dt><dd>± {formatUnsignedPercentage(monteCarlo.positiveProbabilityStandardError * 100)}</dd></div>
              <div><dt>Varianza giornaliera</dt><dd>{varianceLabel}</dd></div>
              <div><dt>Asimmetria / curtosi eccesso</dt><dd>{formatNumber(monteCarlo.returnSkewness, 2)} / {formatNumber(monteCarlo.returnExcessKurtosis, 2)}</dd></div>
              <div><dt>Max drawdown P05</dt><dd className="is-negative">{formatSignedPercentage(monteCarlo.maxDrawdownP05 * 100)}</dd></div>
              <div><dt>Confidence level VaR</dt><dd>95% · coda sinistra</dd></div>
            </dl>
          </ChartPanel>
        </div>
        <div className="quant-disclaimer quant-mc-disclaimer"><FiAlertCircle aria-hidden="true" /><p><strong>Come leggere il risultato.</strong> Il valore mediano è lo scenario centrale, mentre VaR ed Expected Shortfall descrivono la coda negativa. Il bootstrap conserva la distribuzione empirica dei rendimenti, ma non modella regime change, costi, dividendi, salti o dipendenza temporale: usa questi numeri per dimensionare il rischio, non come previsione puntuale.</p></div>
        <div className="quant-panel-note"><FiAlertCircle aria-hidden="true" /><span>Questa è una distribuzione di scenari, non una previsione puntuale né una raccomandazione. Il bootstrap conserva la forma empirica dei rendimenti ma non modella regime change, costi, dividendi, salti o dipendenza temporale.</span></div>
      </div>
    );
  };

  const renderAdvanced = () => {
    if (!advancedQuantitative) {
      return <div className="quant-tab-content" role="tabpanel" id="quant-panel-advanced" aria-labelledby="quant-tab-advanced"><StatePanel title="Campione insufficiente">Servono almeno 40 rendimenti validi per l'analisi avanzata.</StatePanel></div>;
    }
    const { backtest, validation, risk, factors, dependence, portfolio } = advancedQuantitative;
    const strategyLabels = backtest.strategies.map((item) => item.name);
    const strategyData = {
      labels: strategyLabels,
      datasets: [{ label: "Rendimento cumulato", data: backtest.strategies.map((item) => item.metrics.cumulativeReturn * 100), backgroundColor: darkMode ? "rgba(91,224,156,.65)" : "rgba(20,142,91,.62)" }],
    };
    const metric = (value, digits = 2) => value === null || value === undefined || !Number.isFinite(value) ? "—" : Number(value).toFixed(digits);
    const pctMetric = (value, digits = 2) => value === null || value === undefined || !Number.isFinite(value) ? "—" : `${(Number(value) * 100).toFixed(digits)}%`;
    return (
      <div className="quant-tab-content" role="tabpanel" id="quant-panel-advanced" aria-labelledby="quant-tab-advanced">
        {researchLoading && <div className="quant-inline-warning" role="status"><FiRefreshCw aria-hidden="true" /> Caricamento dataset point-in-time, fattori e modelli challenger…</div>}
        {researchError && <div className="quant-inline-warning" role="note"><FiAlertCircle aria-hidden="true" /> {researchError}</div>}
        {researchPayload?.status === "ready" && (
          <>
            <ChartPanel eyebrow="Research infrastructure" title="Modelli point-in-time e universo cross-sectional" description={`${researchPayload.universe?.issuers || "—"} emittenti nel dataset storico; le classifiche vengono calcolate per snapshot, non sulla composizione corrente.`}>
              <div className="quant-table-wrap"><table><thead><tr><th>Orizzonte</th><th>Champion</th><th>Validazione</th><th>Rank IC medio</th><th>SHAP / contributi</th></tr></thead><tbody>{Object.entries(researchPayload.treeModels?.artifact || {}).map(([horizon, model]) => <tr key={horizon}><th>{horizon}</th><td>{model.selected || "—"}</td><td>{model.validationStatus || "—"}</td><td>{finiteNumber(model.rankIcMean) === null ? "—" : formatNumber(model.rankIcMean, 3)}</td><td>{model.selected === "ridge" ? "Coefficiente × feature" : "TreeSHAP nativo / fallback esplicito"}</td></tr>)}</tbody></table></div>
              <div className="quant-panel-note"><FiShield aria-hidden="true" /><span>Security master: <strong>{researchPayload.securityMaster?.status || "—"}</strong>. {researchPayload.securityMaster?.warning || "Intervalli point-in-time verificati."}</span></div>
            </ChartPanel>
            <div className="quant-two-column">
              <ChartPanel title="Fattori cross-sectional reali" description="Value, earnings, cash-flow, quality, profitability, size e growth con rank per data snapshot e Rank IC storico."><div className="quant-table-wrap"><table><thead><tr><th>Fattore</th><th>Valore titolo</th><th>Z-score</th><th>IC medio</th><th>Mesi positivi</th></tr></thead><tbody>{(researchPayload.factors?.["3m"]?.factors || []).map((factor) => { const ic = (researchPayload.factors?.["3m"]?.rankIc || []).find((item) => item.factor === factor.factor); return <tr key={factor.factor}><th>{factor.factor}</th><td>{formatNumber(factor.value, 3)}</td><td>{formatNumber(factor.zScore, 3)}</td><td>{formatNumber(ic?.icMean, 3)}</td><td>{formatUnsignedPercentage((ic?.icPositiveRate || 0) * 100)}</td></tr>; })}</tbody></table></div></ChartPanel>
              <ChartPanel title="GARCH e portfolio optimizer" description="Volatilità condizionale e allocazioni long-only calcolate su prezzi rettificati del cache universe."><MetricStrip items={[{ label: "GARCH", value: researchPayload.garch?.status === "ready" ? "GARCH(1,1)" : "Non disponibile" }, { label: "Persistenza α+β", value: formatNumber(researchPayload.garch?.persistence, 3) }, { label: "Vol. condizionale", value: formatUnsignedPercentage((researchPayload.garch?.conditionalVolatility || 0) * 100) }, { label: "Titoli ottimizzati", value: compactInteger(researchPayload.portfolio?.assets) }, { label: "Osservazioni prezzi", value: compactInteger(researchPayload.portfolio?.observations) }]} /><div className="quant-table-wrap"><table><thead><tr><th>Portafoglio</th><th>Primo peso</th><th>Vincolo</th></tr></thead><tbody>{["minimumVariance", "maximumSharpe", "riskParity"].map((key) => <tr key={key}><th>{key}</th><td>{formatUnsignedPercentage(((researchPayload.portfolio?.[key]?.[0]?.weight || 0) * 100))}</td><td>Long-only · max 20%</td></tr>)}</tbody></table></div></ChartPanel>
            </div>
            <ChartPanel title="Ridge, Lasso ed Elastic Net" description="Stima temporale 80/20 con imputazione e scaling appresi solo nel training fold."><div className="quant-table-wrap"><table><thead><tr><th>Modello</th><th>MAE</th><th>R² OOS</th><th>Train</th><th>Test</th></tr></thead><tbody>{Object.entries(researchPayload.regularizedModels?.["3m"]?.models || {}).map(([name, model]) => <tr key={name}><th>{name}</th><td>{formatNumber(model.mae, 4)}</td><td>{formatNumber(model.r2, 3)}</td><td>{compactInteger(model.trainRows)}</td><td>{compactInteger(model.testRows)}</td></tr>)}</tbody></table></div></ChartPanel>
          </>
        )}
        <ChartPanel eyebrow="Ricerca quantitativa" title="Backtesting e validazione" description="Strategie calcolate con segnali ritardati di una seduta, costi e slippage inclusi.">
          <div className="quant-chart quant-chart-large"><Bar data={strategyData} options={{ ...baseOptions("Strategia", "Rendimento cumulato (%)"), plugins: { ...baseOptions("Strategia", "Rendimento cumulato (%)").plugins, legend: { display: false } } }} plugins={[chartBackgroundPlugin]} role="img" aria-label="Confronto strategie di backtesting." /></div>
          <div className="quant-table-wrap"><table><thead><tr><th>Strategia</th><th>Sharpe</th><th>Sortino</th><th>Calmar</th><th>Max DD</th><th>Hit ratio</th><th>Turnover</th></tr></thead><tbody>{backtest.strategies.map((item) => <tr key={item.name}><th>{item.name}</th><td>{metric(item.metrics.sharpe)}</td><td>{metric(item.metrics.sortino)}</td><td>{metric(item.metrics.calmar)}</td><td>{pctMetric(item.metrics.maxDrawdown)}</td><td>{pctMetric(item.metrics.hitRatio)}</td><td>{pctMetric(item.metrics.turnover)}</td></tr>)}</tbody></table></div>
        </ChartPanel>
        <div className="quant-two-column">
          <ChartPanel title="Rischio avanzato" description="VaR storico, parametrico, Expected Shortfall, EWMA e stress test."><MetricStrip items={[{ label: "VaR storico 95%", value: pctMetric(risk.historicalVaR95), tone: "negative" }, { label: "VaR parametrico 95%", value: pctMetric(risk.parametricVaR95), tone: "negative" }, { label: "Expected Shortfall", value: pctMetric(risk.historicalExpectedShortfall95), tone: "negative" }, { label: "Volatilità EWMA", value: pctMetric(risk.ewmaVolatility), tone: "negative" }, { label: "Stress −20%", value: pctMetric(risk.stress.shockMinus20), tone: "negative" }]} /></ChartPanel>
          <ChartPanel title="Dipendenza e fattori" description="Esposizioni proxy calcolate sul campione corrente; i fattori cross-sectional richiedono un universo multi-titolo."><MetricStrip items={[{ label: "Autocorr. lag 1", value: metric(dependence.autocorrelationLag1) }, { label: "Autocorr. lag 5", value: metric(dependence.autocorrelationLag5) }, { label: "Beta benchmark", value: metric(dependence.beta) }, { label: "Correlazione", value: metric(dependence.benchmarkCorrelation) }]} /><div className="quant-table-wrap"><table><thead><tr><th>Fattore</th><th>Esposizione</th><th>Nota</th></tr></thead><tbody>{factors.map((factor) => <tr key={factor.name}><th>{factor.name}</th><td>{metric(factor.exposure)}</td><td>{factor.status || "Proxy time-series"}</td></tr>)}</tbody></table></div></ChartPanel>
        </div>
        <div className="quant-two-column">
          <ChartPanel title="Walk-forward e controlli" description="Split temporali progressivi per separare stima e verifica fuori campione."><div className="quant-table-wrap"><table><thead><tr><th>Finestra</th><th>In-sample</th><th>Out-of-sample</th><th>Rendimento OOS</th></tr></thead><tbody>{validation.walkForward.map((item) => <tr key={item.window}><th>{item.window}</th><td>{item.inSampleObservations}</td><td>{item.outOfSampleObservations}</td><td>{pctMetric(item.outOfSampleReturn)}</td></tr>)}</tbody></table></div><ul className="quant-method-list"><li>Look-ahead bias: <strong>controllato</strong> con segnali laggati.</li><li>Survivorship bias: <strong>non eliminabile</strong> senza security master storico.</li><li>Stabilità: misurata su finestre temporali separate.</li></ul></ChartPanel>
          <ChartPanel title="Portfolio analytics" description="Allocazione dimostrativa 80% titolo e 20% benchmark; i pesi sono trasparenti e modificabili nel motore."><MetricStrip items={[{ label: "Rendimento cumulato", value: pctMetric(portfolio.metrics?.cumulativeReturn) }, { label: "Sharpe", value: metric(portfolio.metrics?.sharpe) }, { label: "Max drawdown", value: pctMetric(portfolio.metrics?.maxDrawdown) }, { label: "Peso titolo", value: "80,00%" }, { label: "Peso benchmark", value: "20,00%" }]} /><div className="quant-panel-note"><FiShield aria-hidden="true" /><span>Contribution to risk, tracking error e information ratio diventano pienamente informativi quando vengono caricati più titoli e benchmark sincronizzati.</span></div></ChartPanel>
        </div>
        <div className="quant-panel-note"><FiDatabase aria-hidden="true" /><span>Qualità dati: {advancedQuantitative.dataQuality.normalizedRows || "—"} righe normalizzate. Il registro mantiene controlli su duplicati, prezzi mancanti, gap e copertura del campione.</span></div>
      </div>
    );
  };

  const renderMethodology = () => (
    <div className="quant-tab-content" role="tabpanel" id="quant-panel-methodology" aria-labelledby="quant-tab-methodology">
      <div className="quant-two-column quant-method-grid">
        <ChartPanel
          eyebrow="Qualità dati"
          title="Tracciabilità del campione"
          description="Copertura, fonte e trasformazioni applicate prima dei calcoli."
        >
          {infoError && <div className="quant-inline-warning">Info titolo: {infoError}</div>}
          {analysis.pathContinuous === false && (
            <div className="quant-inline-warning">
              Il percorso presenta discontinuità: cumulato, CAGR e drawdown non vengono stimati.
            </div>
          )}
          {hasPartialAdjustedCoverage && (
            <div className="quant-inline-warning">
              Copertura adjusted parziale ({formatUnsignedPercentage(adjustedCoveragePct)}): le date prive di chiusura rettificata spezzano gli intervalli,
              senza sostituzione automatica con prezzi raw.
            </div>
          )}
          <dl className="quant-quality-list">
            {qualityRows.map(([label, value]) => (
              <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
            ))}
          </dl>
        </ChartPanel>
        <ChartPanel
          eyebrow="Assunzioni"
          title="Formule e convenzioni"
          description="Definizioni necessarie per interpretare correttamente i risultati."
        >
          <ul className="quant-method-list">
            <li><strong>Rendimento {returnType === "log" ? "logaritmico" : "semplice"}:</strong> calcolato fra prezzi consecutivi della frequenza selezionata, in punti percentuali.</li>
            <li><strong>Prezzi:</strong> Auto usa l’intera serie adjusted quando ne rileva almeno un valore; i valori adjusted mancanti interrompono gli intervalli. Usa close soltanto se la copertura adjusted è zero. Le fonti non vengono mescolate.</li>
            <li><strong>Varianza e deviazione standard:</strong> campionarie con denominatore n−1; la volatilità della scheda Rischio usa {analysis?.periodsPerYear || "—"} periodi/anno.</li>
            <li><strong>VaR ed Expected Shortfall:</strong> stime storiche empiriche espresse come perdite positive, senza ipotesi di normalità; l’ES è la media dei rendimenti osservati sotto il quantile.</li>
            <li><strong>Rischio avanzato:</strong> downside e upside deviation usano soglia 0%; Omega è il rapporto fra eccedenze positive e perdite sotto la soglia; tail ratio = Q95 / |Q05|. Le autocorrelazioni a lag 1 usano coppie contigue.</li>
            <li><strong>Istogramma:</strong> include tutte le osservazioni valide senza winsorizzazione; il metodo selezionato determina i bin.</li>
            <li><strong>Benchmark:</strong> date e periodi precedenti devono coincidere; non viene applicato forward-fill. Alpha e capture seguono le definizioni indicate nella scheda.</li>
            <li><strong>Regressione:</strong> OLS con intercetta, rendimento del titolo come variabile dipendente e benchmark come esplicativa. R² aggiustato corregge per i gradi di libertà; RSE, RMSE e MAE sono espressi in punti percentuali.</li>
            <li><strong>Inferenza:</strong> errori standard e p-value dei coefficienti usano Newey–West (HAC); l’intervallo al 95% nel grafico riguarda la risposta media stimata, non un intervallo di previsione per un nuovo rendimento.</li>
            <li><strong>Diagnostica e rolling:</strong> Durbin–Watson e autocorrelazione lag 1 verificano dipendenza seriale; Jarque–Bera verifica la normalità dei residui. Beta e R² mobili sono stimati su finestre contigue, senza forward-fill.</li>
            <li><strong>Regressione multifattoriale:</strong> usa proxy osservabili: mercato = SPY, Nasdaq/tecnologia-crescita relativo = QQQ−SPY, dimensione = IWM−SPY e settore = ETF settoriale−SPY. Non sono i fattori accademici Fama–French e non includono il tasso risk-free.</li>
            <li><strong>Campione multifattoriale:</strong> titolo, proxy e componenti degli spread sono allineati sulla stessa intersezione complete-case, senza forward-fill. Tutte le specificazioni sono ristimate su quel medesimo campione; date e n possono quindi differire dalla regressione singola.</li>
            <li><strong>Coefficienti multipli:</strong> ogni beta è un’esposizione parziale condizionata agli altri regressori. HAC Newey–West governa SE, z, p-value e IC 95%; il VIF segnala collinearità. ΔR² LOO è una perdita di fit in-sample rimuovendo un fattore, non importanza causale o out-of-sample.</li>
            <li><strong>Proxy e perimetro:</strong> l’ETF settore usa la classificazione corrente, non point-in-time, e può accorciare il campione. Il modello viene bloccato per valute dichiarate diverse da USD e quando proxy/target coincidono o usano fonti prezzo incompatibili.</li>
          </ul>
          <div className="quant-disclaimer">
            <FiAlertCircle aria-hidden="true" />
            <p>
              Analisi storica descrittiva, non previsione e non raccomandazione finanziaria.
              I risultati dipendono da provider, corporate action, frequenza, finestra e benchmark.
            </p>
          </div>
        </ChartPanel>
      </div>
    </div>
  );

  const renderHeatmap = () => (
    <div className="quant-tab-content" role="tabpanel" id="quant-panel-heatmap" aria-labelledby="quant-tab-heatmap">
      <ChartPanel
        eyebrow="Mercato azionario"
        title="Heat map azioni"
        description="Performance e capitalizzazione delle principali azioni USA, raggruppate per settore, direttamente dal widget TradingView."
        className="quant-panel-primary quant-heatmap-panel"
      >
        <TradingViewStockHeatmap darkMode={darkMode} ticker={ticker} sectorHint={info?.sector} />
      </ChartPanel>
    </div>
  );

  const handleTabKeyDown = (event) => {
    const currentIndex = TAB_OPTIONS.findIndex(([value]) => value === activeTab);
    let nextIndex = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % TAB_OPTIONS.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + TAB_OPTIONS.length) % TAB_OPTIONS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = TAB_OPTIONS.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = TAB_OPTIONS[nextIndex][0];
    updateQuery({ tab: nextTab });
    window.requestAnimationFrame(() => document.getElementById(`quant-tab-${nextTab}`)?.focus());
  };

  return (
    <main className={`quantitative-page quantitative-dashboard ${darkMode ? "dark" : "light"}`}>
      <div className="quantitative-shell">
        <nav className="quant-nav-cards" aria-label="Sezioni del titolo">
          <button type="button" onClick={() => { window.location.href = `/search?query=${encodeURIComponent(ticker)}`; }}><FiSearch aria-hidden="true" /><span>Cerca</span></button>
          <button type="button" onClick={() => { window.location.href = `/technicals?ticker=${encodeURIComponent(ticker)}`; }}><FiTrendingUp aria-hidden="true" /><span>Tecnici</span></button>
          <button type="button" onClick={() => { window.location.href = `/Previsione?ticker=${encodeURIComponent(ticker)}`; }}><FiClock aria-hidden="true" /><span>Previsioni</span></button>
          <button type="button" onClick={() => { window.location.href = `/Stagionalita?ticker=${encodeURIComponent(ticker)}`; }}><FiCalendar aria-hidden="true" /><span>Stagionalità</span></button>
          <button type="button" onClick={() => { window.location.href = `/bilancio?ticker=${encodeURIComponent(ticker)}`; }}><FiBookOpen aria-hidden="true" /><span>Bilancio</span></button>
        </nav>
        <header className="quant-dashboard-header">
          <div className="quant-header-copy">
            <span className="quant-header-icon" aria-hidden="true"><FiActivity /></span>
            <div>
              <span className="quant-eyebrow">Analisi quantitativa</span>
              <h1>{info?.shortName || ticker || "Distribuzione e rischio"}</h1>
              <p>
                {ticker
                  ? `${ticker}${info?.sector && info.sector !== "N/A" ? ` · ${info.sector}` : ""} · dashboard storica configurabile`
                  : "Seleziona un titolo dalla pagina Cerca."}
              </p>
            </div>
          </div>
          <div className="quant-actions" aria-label="Esporta analisi">
            <button type="button" onClick={handleCsv} disabled={!analysis} title="Scarica dati e metriche in CSV">
              <FiDownload aria-hidden="true" /> CSV
            </button>
            <button
              type="button"
              onClick={handlePng}
              disabled={
                !analysis
                || activeTab === "methodology"
                || activeTab === "montecarlo"
              }
              title="Scarica il grafico principale della scheda"
            >
              <FiImage aria-hidden="true" /> PNG
            </button>
            <button type="button" onClick={handlePrint} disabled={!analysis} title="Stampa o salva l’analisi in PDF">
              <FiPrinter aria-hidden="true" /> Stampa/PDF
            </button>
          </div>
        </header>
        {!ticker && <StatePanel title="Nessun titolo selezionato">Apri un titolo dalla pagina Cerca e scegli la card Quantitativi.</StatePanel>}
        {ticker && (
          <>
            <section className="quant-controls-card" aria-label="Impostazioni dell’analisi">
              <div className="quant-controls-title"><FiSliders aria-hidden="true" /><div><h2>Impostazioni</h2><p>Le scelte principali restano nell’URL.</p></div></div>
              <div className="quant-controls-grid">
                <Control label="Periodo" htmlFor="quant-range"><select id="quant-range" value={range} onChange={(e) => updateQuery({ range: e.target.value })}>{RANGE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Control>
                <Control label="Frequenza" htmlFor="quant-frequency"><select id="quant-frequency" value={frequency} onChange={(e) => updateQuery({ freq: e.target.value })}>{FREQUENCY_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Control>
                <Control label="Prezzo" htmlFor="quant-price"><select id="quant-price" value={priceMode} onChange={(e) => updateQuery({ price: e.target.value })}>{PRICE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Control>
                <Control label="Rendimento" htmlFor="quant-return"><select id="quant-return" value={returnType} onChange={(e) => updateQuery({ returns: e.target.value })}>{RETURN_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Control>
                <Control label="Livello VaR" htmlFor="quant-var"><select id="quant-var" value={String(confidence)} onChange={(e) => updateQuery({ var: e.target.value === "0.99" ? "99" : "95" })}><option value="0.95">95%</option><option value="0.99">99%</option></select></Control>
                <Control label="Binning" htmlFor="quant-bins"><select id="quant-bins" value={binMethod} onChange={(e) => updateQuery({ bins: e.target.value })}>{BIN_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Control>
                {binMethod === "manual" && <Control label="Numero bin" htmlFor="quant-bin-count"><input id="quant-bin-count" type="number" min="8" max="60" value={binCount} onChange={(e) => updateQuery({ binCount: clamp(Number(e.target.value) || 8, 8, 60) })} /></Control>}
                <Control label="Scala" htmlFor="quant-scale"><select id="quant-scale" value={histogramScale} onChange={(e) => updateQuery({ scale: e.target.value })}>{SCALE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Control>
              </div>
              <div className="quant-data-status" aria-live="polite">
                <FiCalendar aria-hidden="true" />
                <span>
                  {mainLoading
                    ? "Aggiornamento campione…"
                    : analysis
                      ? `${formatDate(analysis.firstDate)} – ${formatDate(analysis.lastDate)} · ${compactInteger(analysis.observations)} ${periodNoun}`
                      : "Campione non disponibile"}
                </span>
                {infoLoading && <span>· info titolo in caricamento</span>}
              </div>
              {analysis && (hasPartialAdjustedCoverage || analysis.pathContinuous === false) && (
                <div className="quant-control-warnings" role="note">
                  {hasPartialAdjustedCoverage && (
                    <span><FiAlertCircle aria-hidden="true" /> Adjusted parziale: {formatUnsignedPercentage(adjustedCoveragePct)} di copertura.</span>
                  )}
                  {analysis.pathContinuous === false && (
                    <span><FiAlertCircle aria-hidden="true" /> Percorso discontinuo: metriche cumulative sospese.</span>
                  )}
                </div>
              )}
            </section>
            {mainLoading && !analysis && (
              <section className="quant-loading-card" aria-live="polite" aria-busy="true">
                <div className="quant-skeleton quant-skeleton-title" />
                <div className="quant-skeleton-grid">
                  {Array.from({ length: 7 }, (_, index) => <span className="quant-skeleton" key={index} />)}
                </div>
                <div className="quant-skeleton quant-skeleton-chart" />
                <span className="quant-visually-hidden">Caricamento analisi di {ticker}.</span>
              </section>
            )}
            {!mainLoading && mainError && <StatePanel type="error" title="Storico non disponibile" onRetry={handleRetry}>{mainError}</StatePanel>}
            {!mainLoading && !mainError && analysisResult.error && <StatePanel type="error" title="Analisi non calcolabile">{analysisResult.error}</StatePanel>}
            {!mainLoading && !mainError && !analysis && !analysisResult.error && <StatePanel title="Campione insufficiente">Non ci sono abbastanza prezzi validi per questa configurazione.</StatePanel>}
            {analysis && (
              <>
                <nav className="quant-tabs" role="tablist" aria-label="Sezioni analisi quantitativa">
                  {TAB_OPTIONS.map(([value, label]) => (
                    <button
                      key={value}
                      id={`quant-tab-${value}`}
                      type="button"
                      role="tab"
                      aria-selected={activeTab === value}
                      aria-controls={`quant-panel-${value}`}
                      tabIndex={activeTab === value ? 0 : -1}
                      className={activeTab === value ? "is-active" : ""}
                      onClick={() => updateQuery({ tab: value })}
                      onKeyDown={handleTabKeyDown}
                    >
                      {label}
                    </button>
                  ))}
                </nav>
                {activeTab === "distribution" && renderDistribution()}
                {activeTab === "risk" && renderRisk()}
                {activeTab === "montecarlo" && renderMonteCarlo()}
                {activeTab === "heatmap" && renderHeatmap()}
                {activeTab === "methodology" && renderMethodology()}
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
};

export default QuantitativeAnalysis;
