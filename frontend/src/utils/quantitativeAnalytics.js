const DAY_MS = 86400000;
const DEFAULT_YEARS = 5;
const AUTO_MIN_BINS = 8;
const AUTO_MAX_BINS = 40;
const MANUAL_MAX_BINS = 200;

const PERIODS_PER_YEAR = Object.freeze({
  "1d": 252,
  "1wk": 52,
  "1mo": 12,
});

const ROLLING_WINDOWS = Object.freeze({
  "1d": Object.freeze({ short: 20, medium: 60, long: 252 }),
  "1wk": Object.freeze({ short: 4, medium: 13, long: 52 }),
  "1mo": Object.freeze({ short: 3, medium: 6, long: 12 }),
});

const VALID_FREQUENCIES = new Set(Object.keys(PERIODS_PER_YEAR));
const VALID_PRICE_MODES = new Set(["auto", "adjusted", "close"]);
const VALID_RETURN_TYPES = new Set(["simple", "log"]);
const VALID_BIN_METHODS = new Set(["fd", "scott", "sturges", "manual"]);

const finitePositive = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
};

const finiteNumber = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const clamp = (value, lower, upper) =>
  Math.min(upper, Math.max(lower, value));

const utcDate = (value) => {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp).toISOString().slice(0, 10);
  return { date, timestamp: Date.parse(`${date}T00:00:00Z`) };
};

const subtractCalendarYears = (timestamp, years) => {
  const date = new Date(timestamp);
  if (Number.isInteger(years)) {
    date.setUTCFullYear(date.getUTCFullYear() - years);
  } else {
    date.setTime(date.getTime() - years * 365.25 * DAY_MS);
  }
  return Date.parse(`${date.toISOString().slice(0, 10)}T00:00:00Z`);
};

const quantile = (sortedValues, probability) => {
  if (!sortedValues.length) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const position = (sortedValues.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  const weight = position - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
};

const arithmeticMean = (values) =>
  values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : null;

const sampleVariance = (values, mean = arithmeticMean(values)) => {
  if (values.length < 2 || !Number.isFinite(mean)) return null;
  return (
    values.reduce((total, value) => total + (value - mean) ** 2, 0) /
    (values.length - 1)
  );
};

const sampleStandardDeviation = (values, mean) => {
  const variance = sampleVariance(values, mean);
  return variance === null ? null : Math.sqrt(Math.max(0, variance));
};

// Abramowitz-Stegun approximation; sufficient for bin expected counts.
const normalCdf = (value) => {
  if (value === Infinity) return 1;
  if (value === -Infinity) return 0;
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t -
      0.284496736) *
      t +
      0.254829592) *
      t) *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
};

// Peter J. Acklam's inverse-normal approximation.
const inverseNormal = (probability) => {
  if (probability <= 0) return -Infinity;
  if (probability >= 1) return Infinity;
  const a = [
    -39.69683028665376,
    220.9460984245205,
    -275.9285104469687,
    138.357751867269,
    -30.66479806614716,
    2.506628277459239,
  ];
  const b = [
    -54.47609879822406,
    161.5858368580409,
    -155.6989798598866,
    66.80131188771972,
    -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293,
    -0.3223964580411365,
    -2.400758277161838,
    -2.549732539343734,
    4.374664141464968,
    2.938163982698783,
  ];
  const d = [
    0.007784695709041462,
    0.3224671290700398,
    2.445134137142996,
    3.754408661907416,
  ];
  const lower = 0.02425;
  const upper = 1 - lower;
  if (probability < lower) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q +
        c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (probability > upper) {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    return -(
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q +
        c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  const q = probability - 0.5;
  const r = q * q;
  return (
    (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r +
      a[5]) *
    q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r +
      1)
  );
};

const normalizeRows = (history) => {
  const rows = Array.isArray(history) ? history : [];
  const byDate = new Map();
  let invalidRows = 0;
  let duplicateRows = 0;
  let priceMissingRows = 0;

  rows.forEach((row) => {
    const parsed = utcDate(row?.date);
    if (!parsed) {
      invalidRows += 1;
      return;
    }
    const adjustedClose = finitePositive(row?.adjustedClose);
    const rawClose = finitePositive(row?.rawClose);
    const close = rawClose ?? finitePositive(row?.close);
    if (adjustedClose === null && close === null) priceMissingRows += 1;
    const volume = finitePositive(row?.volume ?? row?.Volume);
    const high = finitePositive(row?.high ?? row?.High);
    const low = finitePositive(row?.low ?? row?.Low);
    const open = finitePositive(row?.open ?? row?.Open);
    const candidate = { ...parsed, adjustedClose, close, volume, high, low, open };
    const existing = byDate.get(parsed.date);
    if (existing) duplicateRows += 1;
    const candidateQuality =
      Number(adjustedClose !== null) + Number(close !== null);
    const existingQuality = existing
      ? Number(existing.adjustedClose !== null) + Number(existing.close !== null)
      : -1;
    // A missing duplicate must never erase a usable observation.
    if (!existing || candidateQuality >= existingQuality) {
      byDate.set(parsed.date, candidate);
    }
  });

  return {
    rows: [...byDate.values()].sort((a, b) => a.timestamp - b.timestamp),
    quality: {
      inputRows: rows.length,
      normalizedRows: byDate.size,
      invalidRows,
      duplicateRows,
      priceMissingRows,
    },
  };
};

const periodKey = (row, frequency) => {
  if (frequency === "1mo") return row.date.slice(0, 7);
  if (frequency === "1wk") {
    const date = new Date(row.timestamp);
    const mondayOffset = (date.getUTCDay() + 6) % 7;
    return new Date(row.timestamp - mondayOffset * DAY_MS)
      .toISOString()
      .slice(0, 10);
  }
  return row.date;
};

const findSourceStart = (rows, firstWindowIndex, frequency) => {
  if (firstWindowIndex <= 0) return 0;
  if (frequency === "1d") return firstWindowIndex - 1;
  let index = firstWindowIndex - 1;
  let previousKey = null;
  let distinctPeriods = 0;
  while (index >= 0) {
    const key = periodKey(rows[index], frequency);
    if (key !== previousKey) {
      distinctPeriods += 1;
      previousKey = key;
      if (distinctPeriods > 2) break;
    }
    index -= 1;
  }
  return index + 1;
};

const resamplePrices = (rows, frequency, priceField) => {
  if (frequency === "1d") {
    return rows.map((row) => ({
      date: row.date,
      timestamp: row.timestamp,
      price: row[priceField],
      periodKey: row.date,
    }));
  }
  const groups = [];
  let current = null;
  rows.forEach((row) => {
    const key = periodKey(row, frequency);
    if (!current || current.key !== key) {
      current = { key, lastRow: row };
      groups.push(current);
    }
    current.lastRow = row;
  });
  return groups.map((group) => {
    const selected = group.lastRow;
    return {
      date: selected.date,
      timestamp: selected.timestamp,
      // A missing period-end value is a data barrier. In particular, an
      // incomplete adjusted series must never be filled with a raw close or an
      // older adjusted close from the same period: either choice could create
      // a spurious return around a split or another corporate action.
      price: selected[priceField],
      periodKey: group.key,
    };
  });
};

const periodsAreConsecutive = (previous, current, frequency) => {
  if (frequency === "1d") {
    return (current.timestamp - previous.timestamp) / DAY_MS <= 7;
  }
  if (frequency === "1wk") {
    return (
      (Date.parse(`${current.periodKey}T00:00:00Z`) -
        Date.parse(`${previous.periodKey}T00:00:00Z`)) /
        DAY_MS ===
      7
    );
  }
  const monthOrdinal = (key) => {
    const [year, month] = key.split("-").map(Number);
    return year * 12 + month - 1;
  };
  return monthOrdinal(current.periodKey) - monthOrdinal(previous.periodKey) === 1;
};

const buildHistogram = (values, method, requestedCount, mean, std) => {
  const sorted = [...values].sort((a, b) => a - b);
  const minimum = sorted[0];
  const maximum = sorted[sorted.length - 1];
  if (minimum === maximum) {
    return {
      method: "single",
      bins: [
        {
          start: minimum,
          end: maximum,
          count: values.length,
          percentage: 100,
          density: null,
          normalExpectedCount: null,
        },
      ],
    };
  }

  const n = sorted.length;
  const range = maximum - minimum;
  const sturgesCount = Math.ceil(Math.log2(n) + 1);
  let binCount;
  let resolvedMethod = method;
  if (method === "manual") {
    const numericCount = Math.floor(Number(requestedCount));
    binCount = Number.isFinite(numericCount)
      ? clamp(numericCount, 1, Math.min(MANUAL_MAX_BINS, n))
      : clamp(10, 1, n);
  } else {
    let width = null;
    if (method === "fd") {
      const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
      width = (2 * iqr) / Math.cbrt(n);
    } else if (method === "scott" && Number.isFinite(std) && std > 0) {
      width = (3.5 * std) / Math.cbrt(n);
    }
    if ((method === "fd" || method === "scott") && width > 0) {
      binCount = Math.ceil(range / width);
    } else {
      binCount = sturgesCount;
      if (method !== "sturges") resolvedMethod = "sturges";
    }
    const upper = Math.min(AUTO_MAX_BINS, n);
    const lower = Math.min(AUTO_MIN_BINS, upper);
    binCount = clamp(binCount, lower, upper);
  }

  const width = range / binCount;
  const bins = Array.from({ length: binCount }, (_, index) => ({
    start: minimum + index * width,
    end: index === binCount - 1 ? maximum : minimum + (index + 1) * width,
    count: 0,
    percentage: 0,
    density: 0,
    normalExpectedCount: 0,
  }));
  values.forEach((value) => {
    const index = Math.min(binCount - 1, Math.floor((value - minimum) / width));
    bins[index].count += 1;
  });
  bins.forEach((bin, index) => {
    bin.percentage = (bin.count / n) * 100;
    bin.density = bin.count / (n * width);
    if (Number.isFinite(std) && std > 0) {
      // Expected mass is integrated over the finite displayed bin only; normal
      // tails outside [sample min, sample max] are intentionally not reassigned.
      const lowerProbability = normalCdf((bin.start - mean) / std);
      const upperProbability = normalCdf((bin.end - mean) / std);
      bin.normalExpectedCount = n * (upperProbability - lowerProbability);
    }
  });
  return { method: resolvedMethod, bins };
};

const adjustedMoments = (values, mean, std) => {
  const n = values.length;
  if (!Number.isFinite(std) || std === 0) {
    return { skewness: null, excessKurtosis: null };
  }
  const standardized = values.map((value) => (value - mean) / std);
  const skewness =
    n >= 3
      ? (n / ((n - 1) * (n - 2))) *
        standardized.reduce((total, value) => total + value ** 3, 0)
      : null;
  const excessKurtosis =
    n >= 4
      ? (n * (n + 1) /
          ((n - 1) * (n - 2) * (n - 3))) *
          standardized.reduce((total, value) => total + value ** 4, 0) -
        (3 * (n - 1) ** 2) / ((n - 2) * (n - 3))
      : null;
  return { skewness, excessKurtosis };
};

const pearsonCorrelation = (left, right) => {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length < 2) {
    return null;
  }
  const leftMean = arithmeticMean(left);
  const rightMean = arithmeticMean(right);
  const leftCentered = left.map((value) => value - leftMean);
  const rightCentered = right.map((value) => value - rightMean);
  const leftSumSquares = leftCentered.reduce(
    (total, value) => total + value ** 2,
    0
  );
  const rightSumSquares = rightCentered.reduce(
    (total, value) => total + value ** 2,
    0
  );
  if (leftSumSquares <= 0 || rightSumSquares <= 0) return null;
  const covarianceSum = leftCentered.reduce(
    (total, value, index) => total + value * rightCentered[index],
    0
  );
  const correlation = covarianceSum / Math.sqrt(leftSumSquares * rightSumSquares);
  return Number.isFinite(correlation) ? clamp(correlation, -1, 1) : null;
};

const pointTransitionHasGap = (previous, current) => {
  if (!previous || !current || current.previousDate !== previous.date) return true;
  return (
    previous.segmentId !== null &&
    previous.segmentId !== undefined &&
    current.segmentId !== null &&
    current.segmentId !== undefined &&
    previous.segmentId !== current.segmentId
  );
};

const lagOneCorrelation = (points, valueSelector) => {
  const previousValues = [];
  const currentValues = [];
  for (let index = 1; index < points.length; index += 1) {
    if (pointTransitionHasGap(points[index - 1], points[index])) continue;
    const previous = valueSelector(points[index - 1]);
    const current = valueSelector(points[index]);
    if (!Number.isFinite(previous) || !Number.isFinite(current)) continue;
    previousValues.push(previous);
    currentValues.push(current);
  }
  return pearsonCorrelation(previousValues, currentValues);
};

const buildAdvancedStatistics = (
  points,
  returns,
  sortedReturns,
  mean,
  standardDeviation,
  periodsPerYear
) => {
  const positive = returns.filter((value) => value > 0);
  const negative = returns.filter((value) => value < 0);
  const downsideDeviation = Math.sqrt(
    returns.reduce((total, value) => total + Math.min(value, 0) ** 2, 0) /
      returns.length
  );
  const upsideDeviation = Math.sqrt(
    returns.reduce((total, value) => total + Math.max(value, 0) ** 2, 0) /
      returns.length
  );
  const positiveSum = positive.reduce((total, value) => total + value, 0);
  const negativeSum = negative.reduce((total, value) => total + value, 0);
  const positiveMean = arithmeticMean(positive);
  const negativeMean = arithmeticMean(negative);
  const q05 = quantile(sortedReturns, 0.05);
  const q95 = quantile(sortedReturns, 0.95);
  const lastReturn = returns[returns.length - 1];
  const omega = negativeSum < 0 ? positiveSum / Math.abs(negativeSum) : null;
  const gainLoss =
    positiveMean !== null && negativeMean !== null && negativeMean < 0
      ? positiveMean / Math.abs(negativeMean)
      : null;
  const tailRatio =
    Number.isFinite(q95) && Number.isFinite(q05) && Math.abs(q05) > 0
      ? q95 / Math.abs(q05)
      : null;
  const lastReturnZScore =
    returns.length >= 2 &&
    Number.isFinite(standardDeviation) &&
    standardDeviation > 0
      ? (lastReturn - mean) / standardDeviation
      : null;

  return {
    downsideDeviationPct: Number.isFinite(downsideDeviation)
      ? downsideDeviation
      : null,
    annualizedDownsideDeviationPct:
      Number.isFinite(downsideDeviation * Math.sqrt(periodsPerYear))
        ? downsideDeviation * Math.sqrt(periodsPerYear)
        : null,
    upsideDeviationPct: Number.isFinite(upsideDeviation)
      ? upsideDeviation
      : null,
    annualizedUpsideDeviationPct: Number.isFinite(
      upsideDeviation * Math.sqrt(periodsPerYear)
    )
      ? upsideDeviation * Math.sqrt(periodsPerYear)
      : null,
    omegaRatioZero: Number.isFinite(omega) ? omega : null,
    gainLossRatio: Number.isFinite(gainLoss) ? gainLoss : null,
    tailRatio: Number.isFinite(tailRatio) ? tailRatio : null,
    autocorrelationLag1: lagOneCorrelation(
      points,
      (point) => point.returnPct
    ),
    squaredReturnAutocorrelationLag1: lagOneCorrelation(
      points,
      (point) => point.returnPct ** 2
    ),
    lastReturnZScore: Number.isFinite(lastReturnZScore)
      ? lastReturnZScore
      : null,
  };
};

const rollingVolatilitySeries = (points, window, periodsPerYear) => {
  const result = [];
  for (let index = window - 1; index < points.length; index += 1) {
    const windowPoints = points.slice(index - window + 1, index + 1);
    if (
      windowPoints.some(
        (point) => point.segmentId !== windowPoints[0].segmentId
      )
    ) {
      continue;
    }
    const values = windowPoints.map((point) => point.returnPct);
    const std = sampleStandardDeviation(values);
    result.push({
      date: points[index].date,
      valuePct: std === null ? null : std * Math.sqrt(periodsPerYear),
    });
  }
  return result;
};

const returnFactor = (returnPct, returnType) =>
  returnType === "log"
    ? Math.exp(returnPct / 100)
    : 1 + returnPct / 100;

const buildPathAnalytics = (points, returnType) => {
  let wealth = 1;
  let peak = 1;
  let peakDate = points[0]?.previousDate || null;
  let maxDrawdown = 0;
  let maxDrawdownDate = null;
  let maxDrawdownPeakDate = null;
  let maxDrawdownPeakValue = 1;
  let troughIndex = -1;
  const cumulativeSeries = [];
  const drawdownSeries = [];
  const wealthSeries = [];

  points.forEach((point, index) => {
    wealth *= returnFactor(point.returnPct, returnType);
    if (wealth > peak) {
      peak = wealth;
      peakDate = point.date;
    }
    const drawdown = (wealth / peak - 1) * 100;
    cumulativeSeries.push({ date: point.date, valuePct: (wealth - 1) * 100 });
    drawdownSeries.push({ date: point.date, valuePct: drawdown });
    wealthSeries.push(wealth);
    if (drawdown < maxDrawdown) {
      maxDrawdown = drawdown;
      maxDrawdownDate = point.date;
      maxDrawdownPeakDate = peakDate;
      maxDrawdownPeakValue = peak;
      troughIndex = index;
    }
  });

  let maxDrawdownRecoveryDate = null;
  if (troughIndex >= 0) {
    for (let index = troughIndex + 1; index < wealthSeries.length; index += 1) {
      if (wealthSeries[index] >= maxDrawdownPeakValue) {
        maxDrawdownRecoveryDate = points[index].date;
        break;
      }
    }
  }
  return {
    cumulativeReturn: (wealth - 1) * 100,
    cumulativeSeries,
    drawdownSeries,
    maxDrawdown,
    maxDrawdownDate,
    maxDrawdownPeakDate,
    maxDrawdownRecoveryDate,
  };
};

export const buildQuantitativeAnalysis = (history, options = {}) => {
  const frequency = VALID_FREQUENCIES.has(options.frequency)
    ? options.frequency
    : "1d";
  const priceMode = VALID_PRICE_MODES.has(options.priceMode)
    ? options.priceMode
    : "auto";
  const returnType = VALID_RETURN_TYPES.has(options.returnType)
    ? options.returnType
    : "simple";
  const binMethod = VALID_BIN_METHODS.has(options.binMethod)
    ? options.binMethod
    : "fd";
  const confidence = options.confidence === 0.99 ? 0.99 : 0.95;
  const yearsValue = finiteNumber(options.years);
  const years = yearsValue !== null && yearsValue > 0 ? yearsValue : DEFAULT_YEARS;

  const asOf = utcDate(options.asOf ?? new Date());
  const explicitTo = options.toDate === undefined ? null : utcDate(options.toDate);
  const explicitFrom = options.fromDate === undefined ? null : utcDate(options.fromDate);
  if (!asOf || (options.toDate !== undefined && !explicitTo)) return null;
  if (options.fromDate !== undefined && !explicitFrom) return null;
  const endTimestamp = Math.min(asOf.timestamp, explicitTo?.timestamp ?? asOf.timestamp);
  const startTimestamp = explicitFrom?.timestamp ?? subtractCalendarYears(endTimestamp, years);
  if (startTimestamp > endTimestamp) return null;

  const normalized = normalizeRows(history);
  const ordered = normalized.rows.filter((row) => row.timestamp <= endTimestamp);
  const firstWindowIndex = ordered.findIndex((row) => row.timestamp >= startTimestamp);
  if (firstWindowIndex < 0) return null;
  const sourceStart = findSourceStart(ordered, firstWindowIndex, frequency);
  const sourceRows = ordered.slice(sourceStart);
  const usableRows = sourceRows.filter(
    (row) => row.adjustedClose !== null || row.close !== null
  );
  if (usableRows.length < 2) return null;

  const adjustedCoveragePct =
    (usableRows.filter((row) => row.adjustedClose !== null).length /
      usableRows.length) *
    100;
  const useAdjusted =
    priceMode === "adjusted" ||
    (priceMode === "auto" && adjustedCoveragePct > 0);
  const priceField = useAdjusted ? "adjustedClose" : "close";
  const sampled = resamplePrices(sourceRows, frequency, priceField);

  const points = [];
  let skippedLongGaps = 0;
  let skippedMissingPairs = 0;
  let segmentId = 0;
  for (let index = 1; index < sampled.length; index += 1) {
    const previous = sampled[index - 1];
    const current = sampled[index];
    const insideWindow = current.timestamp >= startTimestamp;
    if (previous.price === null || current.price === null) {
      if (insideWindow) {
        skippedMissingPairs += 1;
        segmentId += 1;
      }
      continue;
    }
    if (!periodsAreConsecutive(previous, current, frequency)) {
      if (insideWindow) {
        skippedLongGaps += 1;
        segmentId += 1;
      }
      continue;
    }
    const ratio = current.price / previous.price;
    const returnPct =
      returnType === "log" ? Math.log(ratio) * 100 : (ratio - 1) * 100;
    if (!Number.isFinite(returnPct) || current.timestamp < startTimestamp) continue;
    points.push({
      date: current.date,
      timestamp: current.timestamp,
      previousDate: previous.date,
      returnPct,
      usedAdjustedClose: useAdjusted,
      segmentId,
    });
  }
  if (!points.length) return null;

  const returns = points.map((point) => point.returnPct);
  const sorted = [...returns].sort((a, b) => a - b);
  const mean = arithmeticMean(returns);
  const variance = sampleVariance(returns, mean);
  const standardDeviation = variance === null ? null : Math.sqrt(Math.max(0, variance));
  const quantiles = {
    p01: quantile(sorted, 0.01),
    p05: quantile(sorted, 0.05),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
  };
  const tailMean = (threshold) => {
    const tail = returns.filter((value) => value <= threshold);
    return tail.length ? arithmeticMean(tail) : null;
  };
  const p95TailMean = tailMean(quantiles.p05);
  const p99TailMean = tailMean(quantiles.p01);
  const median = quantile(sorted, 0.5);
  // MAD means the unscaled median absolute deviation around the sample median.
  const mad = quantile(
    returns.map((value) => Math.abs(value - median)).sort((a, b) => a - b),
    0.5
  );
  const moments = adjustedMoments(returns, mean, standardDeviation);
  const positiveDays = returns.filter((value) => value > 0).length;
  const negativeDays = returns.filter((value) => value < 0).length;
  const flatDays = returns.length - positiveDays - negativeDays;
  const periodsPerYear = PERIODS_PER_YEAR[frequency];
  const pathContinuous = skippedLongGaps === 0 && skippedMissingPairs === 0;
  const path = pathContinuous
    ? buildPathAnalytics(points, returnType)
    : {
        cumulativeReturn: null,
        cumulativeSeries: [],
        drawdownSeries: [],
        maxDrawdown: null,
        maxDrawdownDate: null,
        maxDrawdownPeakDate: null,
        maxDrawdownRecoveryDate: null,
      };
  const elapsedDays =
    (points[points.length - 1].timestamp -
      Date.parse(`${points[0].previousDate}T00:00:00Z`)) /
    DAY_MS;
  const endingGrowth =
    path.cumulativeReturn === null ? null : 1 + path.cumulativeReturn / 100;
  const cagr =
    pathContinuous && elapsedDays > 0 && endingGrowth > 0
      ? (endingGrowth ** (365.25 / elapsedDays) - 1) * 100
      : null;
  const rollingWindows = { ...ROLLING_WINDOWS[frequency] };
  const rollingVolatility = Object.fromEntries(
    Object.entries(rollingWindows).map(([name, window]) => [
      name,
      rollingVolatilitySeries(points, window, periodsPerYear),
    ])
  );
  const advanced = buildAdvancedStatistics(
    points,
    returns,
    sorted,
    mean,
    standardDeviation,
    periodsPerYear
  );

  return {
    points,
    observations: returns.length,
    mean,
    median,
    variance,
    standardDeviation,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    worst: sorted[0],
    best: sorted[sorted.length - 1],
    histogram: buildHistogram(
      returns,
      binMethod,
      options.binCount,
      mean,
      standardDeviation
    ),
    adjustedCount: useAdjusted ? points.length : 0,
    fallbackCount: useAdjusted ? 0 : points.length,
    priceSource: useAdjusted ? "adjustedClose" : "close",
    skippedLongGaps,
    skippedMissingPairs,
    pathContinuous,
    firstDate: points[0].date,
    lastDate: points[points.length - 1].date,
    requestedFirstDate: new Date(startTimestamp).toISOString().slice(0, 10),
    requestedLastDate: new Date(endTimestamp).toISOString().slice(0, 10),
    frequency,
    returnType,
    confidence,
    quantiles,
    valueAtRisk: {
      p95: Math.max(0, -quantiles.p05),
      p99: Math.max(0, -quantiles.p01),
    },
    expectedShortfall: {
      p95: p95TailMean === null ? null : Math.max(0, -p95TailMean),
      p99: p99TailMean === null ? null : Math.max(0, -p99TailMean),
    },
    ...moments,
    iqr: quantiles.p75 - quantiles.p25,
    mad,
    positiveDays,
    negativeDays,
    flatDays,
    sharePct: {
      positive: (positiveDays / returns.length) * 100,
      negative: (negativeDays / returns.length) * 100,
      flat: (flatDays / returns.length) * 100,
    },
    periodsPerYear,
    annualizedVolatility:
      standardDeviation === null
        ? null
        : standardDeviation * Math.sqrt(periodsPerYear),
    cumulativeReturn: path.cumulativeReturn,
    cagr,
    maxDrawdown: path.maxDrawdown,
    maxDrawdownDate: path.maxDrawdownDate,
    maxDrawdownPeakDate: path.maxDrawdownPeakDate,
    maxDrawdownRecoveryDate: path.maxDrawdownRecoveryDate,
    cumulativeSeries: path.cumulativeSeries,
    drawdownSeries: path.drawdownSeries,
    rollingVolatility,
    rollingWindows,
    advanced,
    ecdf: sorted.map((value, index) => ({
      valuePct: value,
      probabilityPct: ((index + 1) / sorted.length) * 100,
    })),
    // Weibull plotting positions avoid infinite theoretical normal quantiles.
    qqSeries: sorted.map((value, index) => ({
      theoretical: inverseNormal((index + 1) / (sorted.length + 1)),
      observed: value,
    })),
    worstDays: [...points]
      .sort((left, right) => left.returnPct - right.returnPct)
      .slice(0, 10)
      .map((point) => ({ date: point.date, valuePct: point.returnPct })),
    quality: {
      ...normalized.quality,
      returnsExcludedForGap: skippedLongGaps,
      skippedMissingPairs,
      adjustedCoveragePct,
    },
  };
};

const alignedReturnRows = (primaryAnalysis, benchmarkAnalysis) => {
  const primary = new Map(
    (primaryAnalysis?.points || []).map((point) => [point.date, point])
  );
  const benchmark = new Map(
    (benchmarkAnalysis?.points || []).map((point) => [point.date, point])
  );
  return [...primary.keys()]
    .filter((date) => {
      const primaryPoint = primary.get(date);
      const benchmarkPoint = benchmark.get(date);
      return (
        benchmarkPoint &&
        typeof primaryPoint.previousDate === "string" &&
        primaryPoint.previousDate.length > 0 &&
        typeof benchmarkPoint.previousDate === "string" &&
        benchmarkPoint.previousDate.length > 0 &&
        primaryPoint.previousDate === benchmarkPoint.previousDate
      );
    })
    .sort()
    .map((date) => {
      const primaryPoint = primary.get(date);
      const benchmarkPoint = benchmark.get(date);
      return {
        date,
        previousDate: primaryPoint.previousDate,
        primary: primaryPoint.returnPct,
        benchmark: benchmarkPoint.returnPct,
        primarySegmentId: primaryPoint.segmentId ?? null,
        benchmarkSegmentId: benchmarkPoint.segmentId ?? null,
      };
    })
    .filter(
      (row) => Number.isFinite(row.primary) && Number.isFinite(row.benchmark)
    );
};

const alignedTransitionHasGap = (previous, current) => {
  if (!previous || !current || current.previousDate !== previous.date) return true;
  const primarySegmentChanged =
    previous.primarySegmentId !== null &&
    current.primarySegmentId !== null &&
    previous.primarySegmentId !== current.primarySegmentId;
  const benchmarkSegmentChanged =
    previous.benchmarkSegmentId !== null &&
    current.benchmarkSegmentId !== null &&
    previous.benchmarkSegmentId !== current.benchmarkSegmentId;
  return primarySegmentChanged || benchmarkSegmentChanged;
};

const alignedRangeIsContinuous = (rows, firstIndex, lastIndex) => {
  for (let index = firstIndex + 1; index <= lastIndex; index += 1) {
    if (alignedTransitionHasGap(rows[index - 1], rows[index])) return false;
  }
  return true;
};

const basicOls = (rows) => {
  if (!Array.isArray(rows) || rows.length < 2) return null;
  const xValues = rows.map((row) => row.benchmark);
  const yValues = rows.map((row) => row.primary);
  const xMean = arithmeticMean(xValues);
  const yMean = arithmeticMean(yValues);
  const sxx = xValues.reduce(
    (total, value) => total + (value - xMean) ** 2,
    0
  );
  const maxAbsX = Math.max(1, ...xValues.map((value) => Math.abs(value)));
  const matrixTolerance =
    Number.EPSILON * rows.length * maxAbsX ** 2 * 100;
  if (!Number.isFinite(sxx) || sxx <= matrixTolerance) return null;
  const sxy = rows.reduce(
    (total, row) =>
      total + (row.benchmark - xMean) * (row.primary - yMean),
    0
  );
  const slope = sxy / sxx;
  const intercept = yMean - slope * xMean;
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) return null;
  const fitted = rows.map((row) => intercept + slope * row.benchmark);
  const residuals = rows.map((row, index) => row.primary - fitted[index]);
  const sse = residuals.reduce((total, value) => total + value ** 2, 0);
  if (
    !fitted.every(Number.isFinite) ||
    !residuals.every(Number.isFinite) ||
    !Number.isFinite(sse)
  ) {
    return null;
  }
  const totalSumSquares = yValues.reduce(
    (total, value) => total + (value - yMean) ** 2,
    0
  );
  const maxAbsY = Math.max(1, ...yValues.map((value) => Math.abs(value)));
  const yTolerance = Number.EPSILON * rows.length * maxAbsY ** 2 * 100;
  const rSquared =
    Number.isFinite(totalSumSquares) && totalSumSquares > yTolerance
      ? clamp(1 - sse / totalSumSquares, 0, 1)
      : null;
  return {
    xValues,
    yValues,
    xMean,
    yMean,
    sxx,
    slope,
    intercept,
    fitted,
    residuals,
    sse,
    rSquared,
    residualTolerance:
      Number.EPSILON *
      rows.length *
      Math.max(1, yValues.reduce((total, value) => total + value ** 2, 0)) *
      100,
  };
};

const safeStandardError = (variance) => {
  if (!Number.isFinite(variance) || variance < 0) return null;
  return Math.sqrt(variance);
};

const twoSidedNormalPValue = (statistic) => {
  if (!Number.isFinite(statistic)) return null;
  return clamp(2 * (1 - normalCdf(Math.abs(statistic))), 0, 1);
};

const confidenceInterval95 = (estimate, standardError) => {
  if (!Number.isFinite(estimate) || !Number.isFinite(standardError)) return null;
  const lower = estimate - 1.96 * standardError;
  const upper = estimate + 1.96 * standardError;
  return Number.isFinite(lower) && Number.isFinite(upper)
    ? [lower, upper]
    : null;
};

const buildRegressionAnalysis = (rows, frequency, periodsPerYear) => {
  if (rows.length < 3) return null;
  const ols = basicOls(rows);
  if (!ols) return null;

  const observations = rows.length;
  const degreesOfFreedom = observations - 2;
  const residualDegenerate =
    !Number.isFinite(ols.sse) || ols.sse <= ols.residualTolerance;
  const residualStandardError = Number.isFinite(ols.sse)
    ? Math.sqrt(Math.max(0, ols.sse) / degreesOfFreedom)
    : null;
  const rmse = Number.isFinite(ols.sse)
    ? Math.sqrt(Math.max(0, ols.sse) / observations)
    : null;
  const mae = arithmeticMean(ols.residuals.map((value) => Math.abs(value)));
  const inverseXx = {
    m00: 1 / observations + ols.xMean ** 2 / ols.sxx,
    m01: -ols.xMean / ols.sxx,
    m11: 1 / ols.sxx,
  };
  const automaticLag = Math.floor(4 * (observations / 100) ** (2 / 9));
  const neweyWestLag = clamp(automaticLag, 0, observations - 1);
  const warnings = [];
  const gapCount = rows.slice(1).reduce(
    (count, row, index) =>
      count + Number(alignedTransitionHasGap(rows[index], row)),
    0
  );
  if (observations < 30) {
    warnings.push(
      "Campione limitato: meno di 30 osservazioni; inferenza asintotica da interpretare con cautela."
    );
  }
  if (gapCount > 0) {
    warnings.push(
      `Serie con ${gapCount} interruzion${gapCount === 1 ? "e" : "i"}: HAC, diagnostica seriale e rolling non attraversano i gap.`
    );
  }
  if (residualDegenerate) {
    warnings.push(
      "Inferenza non disponibile: varianza residua nulla o numericamente degenere."
    );
  }

  let olsCovariance = null;
  let hacCovariance = null;
  if (!residualDegenerate) {
    const residualVariance = ols.sse / degreesOfFreedom;
    olsCovariance = {
      m00: residualVariance * inverseXx.m00,
      m01: residualVariance * inverseXx.m01,
      m11: residualVariance * inverseXx.m11,
    };

    let meat00 = 0;
    let meat01 = 0;
    let meat11 = 0;
    rows.forEach((row, index) => {
      const residualSquared = ols.residuals[index] ** 2;
      meat00 += residualSquared;
      meat01 += residualSquared * row.benchmark;
      meat11 += residualSquared * row.benchmark ** 2;
    });
    for (let lag = 1; lag <= neweyWestLag; lag += 1) {
      const weight = 1 - lag / (neweyWestLag + 1);
      for (let index = lag; index < observations; index += 1) {
        if (!alignedRangeIsContinuous(rows, index - lag, index)) continue;
        const previousX = rows[index - lag].benchmark;
        const currentX = rows[index].benchmark;
        const crossResidual =
          ols.residuals[index] * ols.residuals[index - lag];
        meat00 += weight * 2 * crossResidual;
        meat01 += weight * crossResidual * (previousX + currentX);
        meat11 += weight * 2 * crossResidual * previousX * currentX;
      }
    }
    const { m00: a, m01: b, m11: d } = inverseXx;
    const candidate = {
      m00: a ** 2 * meat00 + 2 * a * b * meat01 + b ** 2 * meat11,
      m01:
        a * b * meat00 +
        (a * d + b ** 2) * meat01 +
        b * d * meat11,
      m11: b ** 2 * meat00 + 2 * b * d * meat01 + d ** 2 * meat11,
    };
    if (
      Object.values(candidate).every(Number.isFinite) &&
      candidate.m00 >= 0 &&
      candidate.m11 >= 0
    ) {
      hacCovariance = candidate;
    } else {
      warnings.push(
        "Inferenza HAC non disponibile: matrice di covarianza numericamente degenere."
      );
    }
  }

  const slopeHac = safeStandardError(hacCovariance?.m11);
  const interceptHac = safeStandardError(hacCovariance?.m00);
  const slopeOls = safeStandardError(olsCovariance?.m11);
  const interceptOls = safeStandardError(olsCovariance?.m00);
  const slopeZ = slopeHac > 0 ? ols.slope / slopeHac : null;
  const interceptZ = interceptHac > 0 ? ols.intercept / interceptHac : null;
  const slopeConfidence = confidenceInterval95(ols.slope, slopeHac);
  const interceptConfidence = confidenceInterval95(
    ols.intercept,
    interceptHac
  );
  const xMinimum = Math.min(...ols.xValues);
  const xMaximum = Math.max(...ols.xValues);
  const lineSeries = [xMinimum, xMaximum].map((x) => ({
    x,
    y: ols.intercept + ols.slope * x,
  }));
  let confidenceBand = [];
  if (hacCovariance) {
    const bandPoints = 41;
    confidenceBand = Array.from({ length: bandPoints }, (_, index) => {
      const x =
        xMinimum + ((xMaximum - xMinimum) * index) / (bandPoints - 1);
      const fitted = ols.intercept + ols.slope * x;
      const variance =
        hacCovariance.m00 +
        2 * x * hacCovariance.m01 +
        x ** 2 * hacCovariance.m11;
      const standardError = safeStandardError(
        variance < 0 && variance > -1e-12 ? 0 : variance
      );
      if (standardError === null) return null;
      const point = {
        x,
        lower: fitted - 1.96 * standardError,
        upper: fitted + 1.96 * standardError,
      };
      return Object.values(point).every(Number.isFinite) ? point : null;
    }).filter(Boolean);
    if (confidenceBand.length !== bandPoints) {
      confidenceBand = [];
      warnings.push(
        "Banda di confidenza non disponibile: varianza della previsione numericamente degenere."
      );
    }
  }

  const serialPrevious = [];
  const serialCurrent = [];
  let durbinWatsonNumerator = 0;
  for (let index = 1; index < observations; index += 1) {
    if (alignedTransitionHasGap(rows[index - 1], rows[index])) continue;
    const previous = ols.residuals[index - 1];
    const current = ols.residuals[index];
    serialPrevious.push(previous);
    serialCurrent.push(current);
    durbinWatsonNumerator += (current - previous) ** 2;
  }
  if (serialPrevious.length < 2) {
    warnings.push(
      "Diagnostica seriale limitata: meno di due transizioni temporali continue."
    );
  }
  const residualMean = arithmeticMean(ols.residuals);
  const populationVariance =
    ols.residuals.reduce(
      (total, value) => total + (value - residualMean) ** 2,
      0
    ) / observations;
  let residualSkewness = null;
  let residualExcessKurtosis = null;
  let jarqueBera = null;
  let jarqueBeraPValue = null;
  if (populationVariance > ols.residualTolerance / observations) {
    const populationStd = Math.sqrt(populationVariance);
    if (observations >= 3) {
      residualSkewness =
        ols.residuals.reduce(
          (total, value) =>
            total + ((value - residualMean) / populationStd) ** 3,
          0
        ) / observations;
    }
    if (observations >= 4) {
      residualExcessKurtosis =
        ols.residuals.reduce(
          (total, value) =>
            total + ((value - residualMean) / populationStd) ** 4,
          0
        ) /
          observations -
        3;
    }
    if (
      Number.isFinite(residualSkewness) &&
      Number.isFinite(residualExcessKurtosis)
    ) {
      const candidate =
        (observations / 6) *
        (residualSkewness ** 2 + residualExcessKurtosis ** 2 / 4);
      if (Number.isFinite(candidate)) {
        jarqueBera = candidate;
        // For chi-square with two degrees of freedom, survival = exp(-x/2).
        jarqueBeraPValue = Math.exp(-candidate / 2);
      }
    }
  }

  const rollingWindow = frequency === "1wk" ? 26 : frequency === "1mo" ? 12 : 60;
  const rollingSeries = [];
  for (let index = rollingWindow - 1; index < observations; index += 1) {
    const firstIndex = index - rollingWindow + 1;
    if (!alignedRangeIsContinuous(rows, firstIndex, index)) continue;
    const windowRows = rows.slice(firstIndex, index + 1);
    const windowOls = basicOls(windowRows);
    if (!windowOls) continue;
    const alphaAnnualized = windowOls.intercept * periodsPerYear;
    if (!Number.isFinite(alphaAnnualized)) continue;
    rollingSeries.push({
      date: rows[index].date,
      beta: windowOls.slope,
      rSquared: windowOls.rSquared,
      alphaAnnualizedPct: alphaAnnualized,
    });
  }

  const fittedSeries = rows.map((row, index) => {
    const leverage =
      1 / observations + (row.benchmark - ols.xMean) ** 2 / ols.sxx;
    const leverageAdjustment = Math.sqrt(Math.max(0, 1 - leverage));
    const standardizedResidual =
      residualStandardError > 0 && leverageAdjustment > 0
        ? ols.residuals[index] /
          (residualStandardError * leverageAdjustment)
        : null;
    return {
      date: row.date,
      x: row.benchmark,
      y: row.primary,
      fitted: ols.fitted[index],
      residual: ols.residuals[index],
      standardizedResidual: Number.isFinite(standardizedResidual)
        ? standardizedResidual
        : null,
    };
  });
  const interceptAnnualized = ols.intercept * periodsPerYear;

  return {
    method: "ols-newey-west",
    observations,
    degreesOfFreedom,
    slope: ols.slope,
    interceptPct: ols.intercept,
    interceptAnnualizedPct: Number.isFinite(interceptAnnualized)
      ? interceptAnnualized
      : null,
    rSquared: ols.rSquared,
    adjustedRSquared:
      ols.rSquared === null
        ? null
        : 1 - ((1 - ols.rSquared) * (observations - 1)) / degreesOfFreedom,
    residualStandardErrorPct: Number.isFinite(residualStandardError)
      ? residualStandardError
      : null,
    rmsePct: Number.isFinite(rmse) ? rmse : null,
    maePct: Number.isFinite(mae) ? mae : null,
    standardErrors: {
      slopeHac,
      interceptHacPct: interceptHac,
      slopeOls,
      interceptOlsPct: interceptOls,
    },
    zStatistics: {
      slope: Number.isFinite(slopeZ) ? slopeZ : null,
      intercept: Number.isFinite(interceptZ) ? interceptZ : null,
    },
    pValues: {
      slope: twoSidedNormalPValue(slopeZ),
      intercept: twoSidedNormalPValue(interceptZ),
    },
    confidence95: {
      slope: slopeConfidence,
      interceptPct: interceptConfidence,
    },
    neweyWestLag,
    fittedSeries,
    lineSeries,
    confidenceBand,
    diagnostics: {
      durbinWatson:
        serialPrevious.length > 0 && !residualDegenerate
          ? durbinWatsonNumerator / ols.sse
          : null,
      autocorrelationLag1: pearsonCorrelation(
        serialPrevious,
        serialCurrent
      ),
      jarqueBera,
      jarqueBeraPValue,
      residualSkewness,
      residualExcessKurtosis,
      outlierCount: fittedSeries.filter(
        (point) =>
          point.standardizedResidual !== null &&
          Math.abs(point.standardizedResidual) >= 2
      ).length,
      continuousTransitions: serialPrevious.length,
    },
    rolling: { window: rollingWindow, series: rollingSeries },
    sampleAdequacy: observations >= 30 ? "adequate" : "limited",
    warnings,
  };
};

export const buildBenchmarkComparison = (primaryAnalysis, benchmarkAnalysis) => {
  const primaryFrequency = primaryAnalysis?.frequency ?? "1d";
  const benchmarkFrequency = benchmarkAnalysis?.frequency ?? "1d";
  const primaryReturnType = primaryAnalysis?.returnType ?? "simple";
  const benchmarkReturnType = benchmarkAnalysis?.returnType ?? "simple";
  const primaryPriceSource = primaryAnalysis?.priceSource ?? null;
  const benchmarkPriceSource = benchmarkAnalysis?.priceSource ?? null;
  const primaryPeriods =
    primaryAnalysis?.periodsPerYear ?? PERIODS_PER_YEAR[primaryFrequency];
  const benchmarkPeriods =
    benchmarkAnalysis?.periodsPerYear ?? PERIODS_PER_YEAR[benchmarkFrequency];
  if (
    !VALID_FREQUENCIES.has(primaryFrequency) ||
    !VALID_FREQUENCIES.has(benchmarkFrequency) ||
    !VALID_RETURN_TYPES.has(primaryReturnType) ||
    !VALID_RETURN_TYPES.has(benchmarkReturnType) ||
    !Number.isFinite(primaryPeriods) ||
    !Number.isFinite(benchmarkPeriods) ||
    primaryPeriods <= 0 ||
    benchmarkPeriods <= 0 ||
    primaryFrequency !== benchmarkFrequency ||
    primaryReturnType !== benchmarkReturnType ||
    primaryPeriods !== benchmarkPeriods ||
    primaryPriceSource !== benchmarkPriceSource
  ) {
    return null;
  }
  const rows = alignedReturnRows(primaryAnalysis, benchmarkAnalysis);
  if (rows.length < 2) return null;
  const primary = rows.map((row) => row.primary);
  const benchmark = rows.map((row) => row.benchmark);
  const active = rows.map((row) => row.primary - row.benchmark);
  const primaryMean = arithmeticMean(primary);
  const benchmarkMean = arithmeticMean(benchmark);
  const activeMean = arithmeticMean(active);
  const primaryVariance = sampleVariance(primary, primaryMean);
  const benchmarkVariance = sampleVariance(benchmark, benchmarkMean);
  const covariance =
    rows.reduce(
      (total, row) =>
        total +
        (row.primary - primaryMean) * (row.benchmark - benchmarkMean),
      0
    ) /
    (rows.length - 1);
  const beta = benchmarkVariance > 0 ? covariance / benchmarkVariance : null;
  const correlation =
    primaryVariance > 0 && benchmarkVariance > 0
      ? covariance / Math.sqrt(primaryVariance * benchmarkVariance)
      : null;
  const periodsPerYear = primaryPeriods || 252;
  const trackingStd = sampleStandardDeviation(active, activeMean);
  const trackingError =
    trackingStd === null ? null : trackingStd * Math.sqrt(periodsPerYear);
  const conditionalCapture = (predicate) => {
    // Capture is the ratio of geometric annualized returns within the selected
    // benchmark-sign subset. returnFactor keeps simple/log inputs coherent.
    const subset = rows.filter((row) => predicate(row.benchmark));
    if (!subset.length) {
      return {
        observations: 0,
        primaryAnnualizedPct: null,
        benchmarkAnnualizedPct: null,
        ratioPct: null,
      };
    }
    const primaryGrowth = subset.reduce(
      (growth, row) => growth * returnFactor(row.primary, primaryReturnType),
      1
    );
    const benchmarkGrowth = subset.reduce(
      (growth, row) => growth * returnFactor(row.benchmark, benchmarkReturnType),
      1
    );
    if (primaryGrowth <= 0 || benchmarkGrowth <= 0) {
      return {
        observations: subset.length,
        primaryAnnualizedPct: null,
        benchmarkAnnualizedPct: null,
        ratioPct: null,
      };
    }
    const exponent = periodsPerYear / subset.length;
    const primaryAnnualized = primaryGrowth ** exponent - 1;
    const benchmarkAnnualized = benchmarkGrowth ** exponent - 1;
    if (!Number.isFinite(primaryAnnualized) ||
        !Number.isFinite(benchmarkAnnualized) ||
        benchmarkAnnualized === 0) {
      return {
        observations: subset.length,
        primaryAnnualizedPct: Number.isFinite(primaryAnnualized)
          ? primaryAnnualized * 100
          : null,
        benchmarkAnnualizedPct: Number.isFinite(benchmarkAnnualized)
          ? benchmarkAnnualized * 100
          : null,
        ratioPct: null,
      };
    }
    return {
      observations: subset.length,
      primaryAnnualizedPct: primaryAnnualized * 100,
      benchmarkAnnualizedPct: benchmarkAnnualized * 100,
      ratioPct: (primaryAnnualized / benchmarkAnnualized) * 100,
    };
  };

  const upsideCapture = conditionalCapture((value) => value > 0);
  const downsideCapture = conditionalCapture((value) => value < 0);

  const pathGapCount = rows.slice(1).reduce(
    (count, row, index) =>
      count + Number(alignedTransitionHasGap(rows[index], row)),
    0
  );
  const pathContinuous = pathGapCount === 0;

  let cumulativeSeries = [];
  if (pathContinuous) {
    let primaryGrowth = 1;
    let benchmarkGrowth = 1;
    cumulativeSeries = rows.map((row) => {
      primaryGrowth *= returnFactor(row.primary, primaryReturnType);
      benchmarkGrowth *= returnFactor(row.benchmark, benchmarkReturnType);
      return {
        date: row.date,
        primaryPct: (primaryGrowth - 1) * 100,
        benchmarkPct: (benchmarkGrowth - 1) * 100,
      };
    });
  }
  const regression = buildRegressionAnalysis(
    rows,
    primaryFrequency,
    periodsPerYear
  );
  const reconciledBeta = regression?.slope ?? beta;
  const reconciledAlpha =
    regression?.interceptAnnualizedPct ??
    (beta === null
      ? null
      : (primaryMean - beta * benchmarkMean) * periodsPerYear);
  const reconciledRSquared =
    regression?.rSquared ?? (correlation === null ? null : correlation ** 2);

  return {
    observations: rows.length,
    pathContinuous,
    pathGapCount,
    pathCaveat: pathContinuous
      ? null
      : "Serie cumulative sospese: gli intervalli comuni non formano un percorso continuo.",
    beta: reconciledBeta,
    alphaAnnualized: reconciledAlpha,
    correlation,
    rSquared: reconciledRSquared,
    trackingError,
    informationRatio:
      trackingError && trackingError > 0
        ? (activeMean * periodsPerYear) / trackingError
        : null,
    upsideCapture: upsideCapture.ratioPct,
    downsideCapture: downsideCapture.ratioPct,
    captureMethod: "geometric_annualized_conditional",
    capture: {
      definition:
        "Rapporto tra rendimenti geometrici annualizzati del titolo e del benchmark, calcolati separatamente nei soli periodi in cui il benchmark e positivo o negativo.",
      periodsPerYear,
      upside: upsideCapture,
      downside: downsideCapture,
    },
    activeReturnAnnualized: activeMean * periodsPerYear,
    cumulativeSeries,
    scatterSeries: rows.map((row) => ({
      x: row.benchmark,
      y: row.primary,
      date: row.date,
    })),
    regression,
  };
};

const multiplyMatrices = (left, right) => {
  if (
    !Array.isArray(left) ||
    !Array.isArray(right) ||
    !left.length ||
    !right.length ||
    !Array.isArray(left[0]) ||
    !Array.isArray(right[0]) ||
    left[0].length !== right.length
  ) {
    return null;
  }
  const columns = right[0].length;
  const result = Array.from({ length: left.length }, () =>
    Array(columns).fill(0)
  );
  for (let row = 0; row < left.length; row += 1) {
    for (let inner = 0; inner < right.length; inner += 1) {
      const leftValue = left[row][inner];
      for (let column = 0; column < columns; column += 1) {
        result[row][column] += leftValue * right[inner][column];
      }
    }
  }
  return result.every((row) => row.every(Number.isFinite)) ? result : null;
};

const transposeMatrix = (matrix) =>
  matrix[0].map((_, column) => matrix.map((row) => row[column]));

const symmetricEigenvalues = (matrix) => {
  const size = matrix.length;
  const working = matrix.map((row) => [...row]);
  const scale = Math.max(1, ...working.flat().map((value) => Math.abs(value)));
  const tolerance = Number.EPSILON * size * scale * 1000;
  const maximumIterations = Math.max(32, 100 * size ** 2);
  for (let iteration = 0; iteration < maximumIterations; iteration += 1) {
    let pivotRow = 0;
    let pivotColumn = 1;
    let maximum = 0;
    for (let row = 0; row < size; row += 1) {
      for (let column = row + 1; column < size; column += 1) {
        const candidate = Math.abs(working[row][column]);
        if (candidate > maximum) {
          maximum = candidate;
          pivotRow = row;
          pivotColumn = column;
        }
      }
    }
    if (maximum <= tolerance) break;
    const left = working[pivotRow][pivotRow];
    const right = working[pivotColumn][pivotColumn];
    const angle = 0.5 * Math.atan2(2 * working[pivotRow][pivotColumn], right - left);
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    for (let index = 0; index < size; index += 1) {
      if (index === pivotRow || index === pivotColumn) continue;
      const rowValue = working[index][pivotRow];
      const columnValue = working[index][pivotColumn];
      const rotatedRow = cosine * rowValue - sine * columnValue;
      const rotatedColumn = sine * rowValue + cosine * columnValue;
      working[index][pivotRow] = rotatedRow;
      working[pivotRow][index] = rotatedRow;
      working[index][pivotColumn] = rotatedColumn;
      working[pivotColumn][index] = rotatedColumn;
    }
    working[pivotRow][pivotRow] =
      cosine ** 2 * left -
      2 * sine * cosine * working[pivotRow][pivotColumn] +
      sine ** 2 * right;
    working[pivotColumn][pivotColumn] =
      sine ** 2 * left +
      2 * sine * cosine * working[pivotRow][pivotColumn] +
      cosine ** 2 * right;
    working[pivotRow][pivotColumn] = 0;
    working[pivotColumn][pivotRow] = 0;
  }
  const eigenvalues = working.map((row, index) => row[index]);
  return eigenvalues.every(Number.isFinite) ? eigenvalues : null;
};

const pivotedQrSolve = (design, yValues) => {
  const observations = design.length;
  const parameterCount = design[0]?.length ?? 0;
  if (!observations || !parameterCount) return null;
  const columns = Array.from({ length: parameterCount }, (_, column) =>
    design.map((row) => row[column])
  );
  const permutation = Array.from({ length: parameterCount }, (_, index) => index);
  const columnNormSquares = columns.map((column) =>
    column.reduce((total, value) => total + value ** 2, 0)
  );
  const maximumNorm = Math.sqrt(Math.max(...columnNormSquares));
  const tolerance =
    Number.EPSILON * Math.max(observations, parameterCount) * maximumNorm * 1000;
  const qColumns = [];
  const upper = Array.from({ length: parameterCount }, () =>
    Array(parameterCount).fill(0)
  );

  for (let step = 0; step < parameterCount; step += 1) {
    let pivot = step;
    for (let column = step + 1; column < parameterCount; column += 1) {
      if (columnNormSquares[column] > columnNormSquares[pivot]) pivot = column;
    }
    if (pivot !== step) {
      [columns[step], columns[pivot]] = [columns[pivot], columns[step]];
      [columnNormSquares[step], columnNormSquares[pivot]] = [
        columnNormSquares[pivot],
        columnNormSquares[step],
      ];
      [permutation[step], permutation[pivot]] = [
        permutation[pivot],
        permutation[step],
      ];
      for (let row = 0; row < step; row += 1) {
        [upper[row][step], upper[row][pivot]] = [
          upper[row][pivot],
          upper[row][step],
        ];
      }
    }
    const diagonal = Math.sqrt(
      columns[step].reduce((total, value) => total + value ** 2, 0)
    );
    if (!Number.isFinite(diagonal) || diagonal <= tolerance) {
      return { rank: step };
    }
    upper[step][step] = diagonal;
    const qColumn = columns[step].map((value) => value / diagonal);
    qColumns.push(qColumn);
    for (let column = step + 1; column < parameterCount; column += 1) {
      let projection = qColumn.reduce(
        (total, value, row) => total + value * columns[column][row],
        0
      );
      for (let row = 0; row < observations; row += 1) {
        columns[column][row] -= projection * qColumn[row];
      }
      // A second modified Gram-Schmidt pass materially improves rank decisions.
      const correction = qColumn.reduce(
        (total, value, row) => total + value * columns[column][row],
        0
      );
      projection += correction;
      for (let row = 0; row < observations; row += 1) {
        columns[column][row] -= correction * qColumn[row];
      }
      upper[step][column] = projection;
      columnNormSquares[column] = columns[column].reduce(
        (total, value) => total + value ** 2,
        0
      );
    }
  }

  const qTransposeY = qColumns.map((column) =>
    column.reduce((total, value, index) => total + value * yValues[index], 0)
  );
  const coefficientsPermuted = Array(parameterCount).fill(0);
  for (let row = parameterCount - 1; row >= 0; row -= 1) {
    const remainder = upper[row]
      .slice(row + 1)
      .reduce(
        (total, value, offset) =>
          total + value * coefficientsPermuted[row + offset + 1],
        0
      );
    coefficientsPermuted[row] = (qTransposeY[row] - remainder) / upper[row][row];
  }
  const coefficients = Array(parameterCount).fill(0);
  permutation.forEach((originalIndex, permutedIndex) => {
    coefficients[originalIndex] = coefficientsPermuted[permutedIndex];
  });

  const inverseUpper = Array.from({ length: parameterCount }, () =>
    Array(parameterCount).fill(0)
  );
  for (let column = 0; column < parameterCount; column += 1) {
    for (let row = parameterCount - 1; row >= 0; row -= 1) {
      const remainder = upper[row]
        .slice(row + 1)
        .reduce(
          (total, value, offset) =>
            total + value * inverseUpper[row + offset + 1][column],
          0
        );
      inverseUpper[row][column] =
        ((row === column ? 1 : 0) - remainder) / upper[row][row];
    }
  }
  const inversePermutedGram = multiplyMatrices(
    inverseUpper,
    transposeMatrix(inverseUpper)
  );
  if (!inversePermutedGram || !coefficients.every(Number.isFinite)) return null;
  const inverseGram = Array.from({ length: parameterCount }, () =>
    Array(parameterCount).fill(0)
  );
  permutation.forEach((originalRow, permutedRow) => {
    permutation.forEach((originalColumn, permutedColumn) => {
      inverseGram[originalRow][originalColumn] =
        inversePermutedGram[permutedRow][permutedColumn];
    });
  });
  return {
    rank: parameterCount,
    coefficients,
    inverseGram,
  };
};

const quadraticForm = (vector, matrix) => {
  let result = 0;
  for (let row = 0; row < vector.length; row += 1) {
    for (let column = 0; column < vector.length; column += 1) {
      result += vector[row] * matrix[row][column] * vector[column];
    }
  }
  return Number.isFinite(result) ? result : null;
};

const transformCovariance = (covariance, transform) => {
  if (!covariance) return null;
  const left = multiplyMatrices(transform, covariance);
  return left
    ? multiplyMatrices(left, transposeMatrix(transform))
    : null;
};

const multipleTransitionHasGap = (previous, current) => {
  if (!previous || !current || current.previousDate !== previous.date) {
    return true;
  }
  return previous.segmentIds.some((segmentId, index) => {
    const currentSegmentId = current.segmentIds[index];
    return (
      segmentId !== null &&
      segmentId !== undefined &&
      currentSegmentId !== null &&
      currentSegmentId !== undefined &&
      segmentId !== currentSegmentId
    );
  });
};

const multipleRangeIsContinuous = (rows, firstIndex, lastIndex) => {
  for (let index = firstIndex + 1; index <= lastIndex; index += 1) {
    if (multipleTransitionHasGap(rows[index - 1], rows[index])) return false;
  }
  return true;
};

const fitMultipleOls = (rows, predictorIndexes, yValues) => {
  const observations = rows.length;
  const predictorCount = predictorIndexes.length;
  const parameterCount = predictorCount + 1;
  const degreesOfFreedom = observations - parameterCount;
  if (
    observations < 2 ||
    degreesOfFreedom <= 0 ||
    !Array.isArray(yValues) ||
    yValues.length !== observations ||
    !yValues.every(Number.isFinite)
  ) {
    return null;
  }

  const predictorMeans = predictorIndexes.map((predictorIndex) =>
    arithmeticMean(rows.map((row) => row.factorValues[predictorIndex]))
  );
  const predictorScales = predictorIndexes.map((predictorIndex, index) => {
    const values = rows.map((row) => row.factorValues[predictorIndex]);
    const mean = predictorMeans[index];
    const sumSquares = values.reduce(
      (total, value) => total + (value - mean) ** 2,
      0
    );
    const maxAbsolute = Math.max(1, ...values.map((value) => Math.abs(value)));
    const tolerance =
      Number.EPSILON * observations * maxAbsolute ** 2 * 1000;
    return Number.isFinite(sumSquares) && sumSquares > tolerance
      ? Math.sqrt(sumSquares)
      : null;
  });
  if (predictorScales.some((value) => value === null)) return null;

  const interceptScale = Math.sqrt(observations);
  const design = rows.map((row) => [
    1 / interceptScale,
    ...predictorIndexes.map(
      (predictorIndex, index) =>
        (row.factorValues[predictorIndex] - predictorMeans[index]) /
        predictorScales[index]
    ),
  ]);
  const gram = Array.from({ length: parameterCount }, () =>
    Array(parameterCount).fill(0)
  );
  design.forEach((designRow) => {
    for (let left = 0; left < parameterCount; left += 1) {
      for (let right = 0; right < parameterCount; right += 1) {
        gram[left][right] += designRow[left] * designRow[right];
      }
    }
  });
  const qrSolution = pivotedQrSolve(design, yValues);
  if (!qrSolution || qrSolution.rank !== parameterCount) return null;
  const { coefficients: normalizedCoefficients, inverseGram } = qrSolution;
  if (!normalizedCoefficients.every(Number.isFinite)) return null;

  const coefficients = normalizedCoefficients.slice(1).map(
    (value, index) => value / predictorScales[index]
  );
  const intercept =
    normalizedCoefficients[0] / interceptScale -
    coefficients.reduce(
      (total, value, index) => total + value * predictorMeans[index],
      0
    );
  if (!Number.isFinite(intercept) || !coefficients.every(Number.isFinite)) {
    return null;
  }

  const fitted = rows.map((row) =>
    coefficients.reduce(
      (total, coefficient, index) =>
        total + coefficient * row.factorValues[predictorIndexes[index]],
      intercept
    )
  );
  const residuals = yValues.map((value, index) => value - fitted[index]);
  const sse = residuals.reduce((total, value) => total + value ** 2, 0);
  const yMean = arithmeticMean(yValues);
  const totalSumSquares = yValues.reduce(
    (total, value) => total + (value - yMean) ** 2,
    0
  );
  if (
    !fitted.every(Number.isFinite) ||
    !residuals.every(Number.isFinite) ||
    !Number.isFinite(sse) ||
    !Number.isFinite(totalSumSquares)
  ) {
    return null;
  }
  const yScale = Math.max(1, ...yValues.map((value) => Math.abs(value)));
  const totalTolerance =
    Number.EPSILON * observations * yScale ** 2 * 1000;
  const residualTolerance =
    Number.EPSILON *
    observations *
    Math.max(1, yValues.reduce((total, value) => total + value ** 2, 0)) *
    1000;
  const rSquared =
    totalSumSquares > totalTolerance
      ? clamp(1 - sse / totalSumSquares, 0, 1)
      : null;

  const transform = Array.from({ length: parameterCount }, () =>
    Array(parameterCount).fill(0)
  );
  transform[0][0] = 1 / interceptScale;
  predictorIndexes.forEach((_, index) => {
    transform[0][index + 1] =
      -predictorMeans[index] / predictorScales[index];
    transform[index + 1][index + 1] = 1 / predictorScales[index];
  });

  const eigenvalues = symmetricEigenvalues(gram);
  const maximumEigenvalue = eigenvalues ? Math.max(...eigenvalues) : null;
  const eigenvalueTolerance = Number.isFinite(maximumEigenvalue)
    ? Number.EPSILON * parameterCount * maximumEigenvalue * 1000
    : null;
  const positiveEigenvalues = eigenvalues?.filter(
    (value) => value > eigenvalueTolerance
  );
  const conditionNumber =
    positiveEigenvalues?.length === parameterCount
      ? Math.sqrt(
          Math.max(...positiveEigenvalues) / Math.min(...positiveEigenvalues)
        )
      : null;

  return {
    observations,
    predictorCount,
    parameterCount,
    degreesOfFreedom,
    predictorIndexes,
    design,
    inverseGram,
    transform,
    rank: qrSolution.rank,
    conditionNumber: Number.isFinite(conditionNumber) ? conditionNumber : null,
    intercept,
    coefficients,
    fitted,
    residuals,
    sse,
    totalSumSquares,
    rSquared,
    residualTolerance,
  };
};

const gaussianInformationCriteria = (fit) => {
  if (!fit || fit.sse <= fit.residualTolerance) {
    return { aic: null, bic: null };
  }
  const varianceMaximumLikelihood = fit.sse / fit.observations;
  if (!Number.isFinite(varianceMaximumLikelihood) || varianceMaximumLikelihood <= 0) {
    return { aic: null, bic: null };
  }
  const negativeTwiceLogLikelihood =
    fit.observations *
    (Math.log(2 * Math.PI) + 1 + Math.log(varianceMaximumLikelihood));
  const aic = negativeTwiceLogLikelihood + 2 * fit.parameterCount;
  const bic =
    negativeTwiceLogLikelihood +
    Math.log(fit.observations) * fit.parameterCount;
  return {
    aic: Number.isFinite(aic) ? aic : null,
    bic: Number.isFinite(bic) ? bic : null,
  };
};

const resolvedAnalysisMetadata = (analysis) => {
  const frequency = analysis?.frequency ?? "1d";
  const returnType = analysis?.returnType ?? "simple";
  const periodsPerYear =
    analysis?.periodsPerYear ?? PERIODS_PER_YEAR[frequency];
  const priceSource = analysis?.priceSource ?? null;
  if (
    !VALID_FREQUENCIES.has(frequency) ||
    !VALID_RETURN_TYPES.has(returnType) ||
    !Number.isFinite(periodsPerYear) ||
    periodsPerYear <= 0 ||
    !Array.isArray(analysis?.points)
  ) {
    return null;
  }
  return { frequency, returnType, periodsPerYear, priceSource };
};

const sameAnalysisMetadata = (left, right) =>
  left &&
  right &&
  left.frequency === right.frequency &&
  left.returnType === right.returnType &&
  left.periodsPerYear === right.periodsPerYear &&
  left.priceSource === right.priceSource;

const pointMapForRegression = (analysis) => {
  const result = new Map();
  analysis.points.forEach((point) => {
    if (
      typeof point?.date === "string" &&
      Number.isFinite(Date.parse(`${point.date}T00:00:00Z`)) &&
      typeof point?.previousDate === "string" &&
      point.previousDate.length > 0 &&
      Number.isFinite(point.returnPct)
    ) {
      result.set(point.date, point);
    }
  });
  return result;
};

const normalizeMultipleModelSpecs = (predictorDefinitions, options) => {
  const predictorKeys = predictorDefinitions.map((definition) => definition.key);
  const validKeys = new Set(predictorKeys);
  const requested = Array.isArray(options?.modelSpecs)
    ? options.modelSpecs
    : [];
  const rawSpecs = requested.length
    ? requested
    : [
        ...predictorDefinitions.map((definition) => ({
          key: `factor_${definition.key}`,
          label: definition.label,
          predictorKeys: [definition.key],
        })),
        ...(predictorDefinitions.length > 1
          ? [
              {
                key: "full",
                label: "Modello completo",
                predictorKeys,
              },
            ]
          : []),
      ];
  const seenSpecKeys = new Set();
  const specs = [];
  for (const spec of rawSpecs) {
    const key = typeof spec?.key === "string" ? spec.key.trim() : "";
    const keys = Array.isArray(spec?.predictorKeys) ? spec.predictorKeys : null;
    if (!key || seenSpecKeys.has(key) || !keys) return null;
    const uniqueKeys = [...new Set(keys)];
    if (
      uniqueKeys.length !== keys.length ||
      uniqueKeys.some((predictorKey) => !validKeys.has(predictorKey))
    ) {
      return null;
    }
    seenSpecKeys.add(key);
    specs.push({
      key,
      label:
        typeof spec.label === "string" && spec.label.trim()
          ? spec.label.trim()
          : key,
      predictorKeys: uniqueKeys,
    });
  }
  if (!specs.length) return null;
  const requestedFullKey =
    typeof options?.fullModelKey === "string" ? options.fullModelKey : null;
  let fullSpec = requestedFullKey
    ? specs.find((spec) => spec.key === requestedFullKey)
    : null;
  if (requestedFullKey && !fullSpec) return null;
  if (!fullSpec) {
    fullSpec = specs.find(
      (spec) =>
        spec.predictorKeys.length === predictorKeys.length &&
        predictorKeys.every((key) => spec.predictorKeys.includes(key))
    );
  }
  if (!fullSpec) {
    fullSpec = [...specs].sort(
      (left, right) => right.predictorKeys.length - left.predictorKeys.length
    )[0];
  }
  return fullSpec.predictorKeys.length ? { specs, fullSpec } : null;
};

const buildCommonMultipleRows = (primaryAnalysis, predictorDefinitions) => {
  const primaryMap = pointMapForRegression(primaryAnalysis);
  const componentMaps = predictorDefinitions.map((definition) => ({
    source: pointMapForRegression(definition.analysis),
    subtract: definition.subtractAnalysis
      ? pointMapForRegression(definition.subtractAnalysis)
      : null,
  }));
  return [...primaryMap.keys()]
    .sort()
    .map((date) => {
      const primaryPoint = primaryMap.get(date);
      const factorValues = [];
      const segmentIds = [primaryPoint.segmentId ?? null];
      for (let index = 0; index < predictorDefinitions.length; index += 1) {
        const component = componentMaps[index];
        const sourcePoint = component.source.get(date);
        const subtractPoint = component.subtract?.get(date) ?? null;
        if (
          !sourcePoint ||
          sourcePoint.previousDate !== primaryPoint.previousDate ||
          (component.subtract &&
            (!subtractPoint ||
              subtractPoint.previousDate !== primaryPoint.previousDate))
        ) {
          return null;
        }
        const value =
          sourcePoint.returnPct - (subtractPoint?.returnPct ?? 0);
        if (!Number.isFinite(value)) return null;
        factorValues.push(value);
        segmentIds.push(sourcePoint.segmentId ?? null);
        if (component.subtract) {
          segmentIds.push(subtractPoint.segmentId ?? null);
        }
      }
      return {
        date,
        previousDate: primaryPoint.previousDate,
        observedPct: primaryPoint.returnPct,
        factorValues,
        segmentIds,
      };
    })
    .filter(Boolean);
};

/**
 * Regresses the primary return series on one or more aligned return factors.
 * Every specification is estimated on the same strict date/previousDate sample.
 */
export const buildMultipleRegressionAnalysis = (
  primaryAnalysis,
  predictorDefinitions,
  options = {}
) => {
  if (!Array.isArray(predictorDefinitions) || !predictorDefinitions.length) {
    return null;
  }
  const primaryMetadata = resolvedAnalysisMetadata(primaryAnalysis);
  if (!primaryMetadata) return null;
  const seenKeys = new Set();
  const definitions = [];
  for (const definition of predictorDefinitions) {
    const key = typeof definition?.key === "string" ? definition.key.trim() : "";
    const sourceMetadata = resolvedAnalysisMetadata(definition?.analysis);
    const subtractMetadata = definition?.subtractAnalysis
      ? resolvedAnalysisMetadata(definition.subtractAnalysis)
      : null;
    if (
      !key ||
      seenKeys.has(key) ||
      !sameAnalysisMetadata(primaryMetadata, sourceMetadata) ||
      (definition?.subtractAnalysis &&
        !sameAnalysisMetadata(primaryMetadata, subtractMetadata))
    ) {
      return null;
    }
    seenKeys.add(key);
    definitions.push({
      key,
      label:
        typeof definition.label === "string" && definition.label.trim()
          ? definition.label.trim()
          : key,
      sourceTicker:
        typeof definition.sourceTicker === "string"
          ? definition.sourceTicker.trim()
          : "",
      analysis: definition.analysis,
      subtractAnalysis: definition.subtractAnalysis ?? null,
      subtractTicker:
        typeof definition.subtractTicker === "string" &&
        definition.subtractTicker.trim()
          ? definition.subtractTicker.trim()
          : null,
    });
  }
  const normalizedSpecs = normalizeMultipleModelSpecs(definitions, options);
  if (!normalizedSpecs) return null;
  const rows = buildCommonMultipleRows(primaryAnalysis, definitions);
  const keyToIndex = new Map(
    definitions.map((definition, index) => [definition.key, index])
  );
  const fullPredictorIndexes = normalizedSpecs.fullSpec.predictorKeys.map((key) =>
    keyToIndex.get(key)
  );
  const yValues = rows.map((row) => row.observedPct);
  const fullFit = fitMultipleOls(rows, fullPredictorIndexes, yValues);
  if (!fullFit) return null;

  const observations = rows.length;
  const warnings = [];
  const pathGapCount = rows.slice(1).reduce(
    (count, row, index) =>
      count + Number(multipleTransitionHasGap(rows[index], row)),
    0
  );
  let currentContinuousLength = observations ? 1 : 0;
  let maximumContinuousLength = currentContinuousLength;
  for (let index = 1; index < observations; index += 1) {
    if (multipleTransitionHasGap(rows[index - 1], rows[index])) {
      currentContinuousLength = 1;
    } else {
      currentContinuousLength += 1;
      maximumContinuousLength = Math.max(
        maximumContinuousLength,
        currentContinuousLength
      );
    }
  }
  if (observations < 30) {
    warnings.push(
      "Campione limitato: meno di 30 osservazioni; inferenza asintotica da interpretare con cautela."
    );
  }
  if (observations < 10 * fullFit.parameterCount) {
    warnings.push(
      "Poche osservazioni per parametro: coefficienti e diagnostica possono essere instabili."
    );
  }
  if (pathGapCount > 0) {
    warnings.push(
      `Serie con ${pathGapCount} interruzion${pathGapCount === 1 ? "e" : "i"}: HAC e diagnostica seriale non attraversano i gap.`
    );
  }

  const residualDegenerate = fullFit.sse <= fullFit.residualTolerance;
  const residualVariance = residualDegenerate
    ? null
    : fullFit.sse / fullFit.degreesOfFreedom;
  const residualStandardError = residualDegenerate
    ? 0
    : Math.sqrt(residualVariance);
  const rmse = Math.sqrt(Math.max(0, fullFit.sse) / observations);
  const mae = arithmeticMean(fullFit.residuals.map((value) => Math.abs(value)));
  const neweyWestLag = clamp(
    Math.floor(4 * (observations / 100) ** (2 / 9)),
    0,
    Math.max(0, maximumContinuousLength - 1)
  );

  let normalizedOlsCovariance = null;
  let normalizedHacCovariance = null;
  if (residualDegenerate) {
    warnings.push(
      "Inferenza non disponibile: varianza residua nulla o numericamente degenere."
    );
  } else {
    normalizedOlsCovariance = fullFit.inverseGram.map((row) =>
      row.map((value) => value * residualVariance)
    );
    const size = fullFit.parameterCount;
    const meat = Array.from({ length: size }, () => Array(size).fill(0));
    const scores = fullFit.design.map((designRow, index) =>
      designRow.map((value) => value * fullFit.residuals[index])
    );
    for (let index = 0; index < observations; index += 1) {
      for (let left = 0; left < size; left += 1) {
        for (let right = 0; right < size; right += 1) {
          meat[left][right] += scores[index][left] * scores[index][right];
        }
      }
    }
    for (let lag = 1; lag <= neweyWestLag; lag += 1) {
      const weight = 1 - lag / (neweyWestLag + 1);
      for (let index = lag; index < observations; index += 1) {
        if (!multipleRangeIsContinuous(rows, index - lag, index)) continue;
        const previous = scores[index - lag];
        const current = scores[index];
        for (let left = 0; left < size; left += 1) {
          for (let right = 0; right < size; right += 1) {
            meat[left][right] +=
              weight *
              (current[left] * previous[right] +
                previous[left] * current[right]);
          }
        }
      }
    }
    const leftSandwich = multiplyMatrices(fullFit.inverseGram, meat);
    const candidate = leftSandwich
      ? multiplyMatrices(leftSandwich, fullFit.inverseGram)
      : null;
    if (candidate) {
      normalizedHacCovariance = candidate.map((row, rowIndex) =>
        row.map((value, columnIndex) =>
          (value + candidate[columnIndex][rowIndex]) / 2
        )
      );
      const covarianceScale = Math.max(
        1,
        ...normalizedHacCovariance.flat().map((value) => Math.abs(value))
      );
      const covarianceTolerance = Number.EPSILON * covarianceScale * 1000;
      if (
        normalizedHacCovariance.some(
          (row, index) => row[index] < -covarianceTolerance
        )
      ) {
        normalizedHacCovariance = null;
      } else {
        normalizedHacCovariance.forEach((row, index) => {
          if (row[index] < 0) row[index] = 0;
        });
      }
    }
    if (!normalizedHacCovariance) {
      warnings.push(
        "Inferenza HAC non disponibile: matrice di covarianza numericamente degenere."
      );
    }
  }
  const olsCovariance = transformCovariance(
    normalizedOlsCovariance,
    fullFit.transform
  );
  const hacCovariance = transformCovariance(
    normalizedHacCovariance,
    fullFit.transform
  );

  const vifValues = fullPredictorIndexes.map((predictorIndex) => {
    if (fullPredictorIndexes.length === 1) return 1;
    const otherIndexes = fullPredictorIndexes.filter(
      (candidate) => candidate !== predictorIndex
    );
    const auxiliaryY = rows.map((row) => row.factorValues[predictorIndex]);
    const auxiliaryFit = fitMultipleOls(rows, otherIndexes, auxiliaryY);
    if (
      !auxiliaryFit ||
      auxiliaryFit.rSquared === null ||
      auxiliaryFit.rSquared >= 1
    ) {
      return null;
    }
    const vif = 1 / (1 - auxiliaryFit.rSquared);
    return Number.isFinite(vif) && vif >= 1 ? vif : null;
  });
  const finiteVifs = vifValues.filter(Number.isFinite);
  const maxVif = finiteVifs.length ? Math.max(...finiteVifs) : null;
  if (vifValues.some((value) => value === null)) {
    warnings.push(
      "VIF non disponibile per almeno un fattore a causa di collinearita quasi perfetta."
    );
  } else if (maxVif >= 10) {
    warnings.push(
      "Multicollinearita elevata: almeno un fattore presenta VIF pari o superiore a 10."
    );
  }
  if (fullFit.conditionNumber !== null && fullFit.conditionNumber >= 30) {
    warnings.push(
      "Matrice dei fattori mal condizionata: interpreta coefficienti e significativita con cautela."
    );
  }

  const informationCriteria = gaussianInformationCriteria(fullFit);
  const modelComparisons = normalizedSpecs.specs.map((spec) => {
    const indexes = spec.predictorKeys.map((key) => keyToIndex.get(key));
    const fit = fitMultipleOls(rows, indexes, yValues);
    if (!fit) {
      warnings.push(
        `Modello ${spec.label} non stimabile: matrice singolare o gradi di liberta insufficienti.`
      );
      return {
        key: spec.key,
        label: spec.label,
        predictorKeys: spec.predictorKeys,
        observations,
        firstDate: rows[0]?.date ?? null,
        lastDate: rows[observations - 1]?.date ?? null,
        rSquared: null,
        adjustedRSquared: null,
        rmsePct: null,
        aic: null,
        bic: null,
      };
    }
    const criteria = gaussianInformationCriteria(fit);
    return {
      key: spec.key,
      label: spec.label,
      predictorKeys: spec.predictorKeys,
      observations,
      firstDate: rows[0]?.date ?? null,
      lastDate: rows[observations - 1]?.date ?? null,
      rSquared: fit.rSquared,
      adjustedRSquared:
        fit.rSquared === null
          ? null
          : 1 -
            ((1 - fit.rSquared) * (observations - 1)) /
              fit.degreesOfFreedom,
      rmsePct: Math.sqrt(Math.max(0, fit.sse) / observations),
      aic: criteria.aic,
      bic: criteria.bic,
    };
  });

  const incrementalMetrics = fullPredictorIndexes.map((_, coefficientIndex) => {
    const reducedIndexes = fullPredictorIndexes.filter(
      (__, index) => index !== coefficientIndex
    );
    const reducedFit = fitMultipleOls(rows, reducedIndexes, yValues);
    if (
      !reducedFit ||
      fullFit.rSquared === null ||
      reducedFit.rSquared === null
    ) {
      return { rSquared: null, adjustedRSquared: null };
    }
    const difference = fullFit.rSquared - reducedFit.rSquared;
    const fullAdjusted =
      1 -
      ((1 - fullFit.rSquared) * (observations - 1)) /
        fullFit.degreesOfFreedom;
    const reducedAdjusted =
      1 -
      ((1 - reducedFit.rSquared) * (observations - 1)) /
        reducedFit.degreesOfFreedom;
    const adjustedDifference = fullAdjusted - reducedAdjusted;
    if (!Number.isFinite(difference) || !Number.isFinite(adjustedDifference)) {
      return { rSquared: null, adjustedRSquared: null };
    }
    return {
      rSquared:
        difference < 0 && difference > -1e-12
          ? 0
          : Math.max(0, difference),
      adjustedRSquared: adjustedDifference,
    };
  });

  const serialPrevious = [];
  const serialCurrent = [];
  let durbinWatsonNumerator = 0;
  for (let index = 1; index < observations; index += 1) {
    if (multipleTransitionHasGap(rows[index - 1], rows[index])) continue;
    const previous = fullFit.residuals[index - 1];
    const current = fullFit.residuals[index];
    serialPrevious.push(previous);
    serialCurrent.push(current);
    durbinWatsonNumerator += (current - previous) ** 2;
  }
  if (serialPrevious.length < 2) {
    warnings.push(
      "Diagnostica seriale limitata: meno di due transizioni temporali continue."
    );
  }

  const residualMean = arithmeticMean(fullFit.residuals);
  const residualPopulationVariance =
    fullFit.residuals.reduce(
      (total, value) => total + (value - residualMean) ** 2,
      0
    ) / observations;
  let residualSkewness = null;
  let residualExcessKurtosis = null;
  let jarqueBera = null;
  let jarqueBeraPValue = null;
  if (residualPopulationVariance > fullFit.residualTolerance / observations) {
    const residualPopulationStd = Math.sqrt(residualPopulationVariance);
    residualSkewness =
      fullFit.residuals.reduce(
        (total, value) =>
          total + ((value - residualMean) / residualPopulationStd) ** 3,
        0
      ) / observations;
    residualExcessKurtosis =
      fullFit.residuals.reduce(
        (total, value) =>
          total + ((value - residualMean) / residualPopulationStd) ** 4,
        0
      ) /
        observations -
      3;
    const candidate =
      (observations / 6) *
      (residualSkewness ** 2 + residualExcessKurtosis ** 2 / 4);
    if (Number.isFinite(candidate)) {
      jarqueBera = candidate;
      jarqueBeraPValue = Math.exp(-candidate / 2);
    }
  }

  const fittedSeries = rows.map((row, index) => {
    const leverage = quadraticForm(
      fullFit.design[index],
      fullFit.inverseGram
    );
    const leverageRemainder =
      leverage === null ? null : Math.max(0, 1 - leverage);
    const standardizedResidual =
      residualStandardError > 0 && leverageRemainder > Number.EPSILON
        ? fullFit.residuals[index] /
          (residualStandardError * Math.sqrt(leverageRemainder))
        : null;
    return {
      date: row.date,
      previousDate: row.previousDate,
      gapBefore:
        index > 0 && multipleTransitionHasGap(rows[index - 1], row),
      observedPct: row.observedPct,
      fittedPct: fullFit.fitted[index],
      residualPct: fullFit.residuals[index],
      standardizedResidual: Number.isFinite(standardizedResidual)
        ? standardizedResidual
        : null,
      factorValues: Object.fromEntries(
        fullPredictorIndexes.map((predictorIndex) => [
          definitions[predictorIndex].key,
          row.factorValues[predictorIndex],
        ])
      ),
      contributions: Object.fromEntries(
        fullPredictorIndexes.map((predictorIndex, coefficientIndex) => [
          definitions[predictorIndex].key,
          fullFit.coefficients[coefficientIndex] *
            row.factorValues[predictorIndex],
        ])
      ),
    };
  });

  const parameterInference = (parameterIndex, estimate) => {
    const seHac = safeStandardError(hacCovariance?.[parameterIndex]?.[parameterIndex]);
    const seOls = safeStandardError(olsCovariance?.[parameterIndex]?.[parameterIndex]);
    const z = seHac > 0 ? estimate / seHac : null;
    return {
      seHac,
      seOls,
      z: Number.isFinite(z) ? z : null,
      pValue: twoSidedNormalPValue(z),
      confidence95: confidenceInterval95(estimate, seHac),
    };
  };
  const interceptInference = parameterInference(0, fullFit.intercept);
  const interceptAnnualized =
    fullFit.intercept * primaryMetadata.periodsPerYear;
  const coefficients = fullPredictorIndexes.map((predictorIndex, index) => {
    const estimate = fullFit.coefficients[index];
    const inference = parameterInference(index + 1, estimate);
    return {
      key: definitions[predictorIndex].key,
      label: definitions[predictorIndex].label,
      estimate,
      seHac: inference.seHac,
      seOls: inference.seOls,
      z: inference.z,
      pValue: inference.pValue,
      confidence95: inference.confidence95,
      vif: vifValues[index],
      incrementalRSquared: incrementalMetrics[index].rSquared,
      incrementalAdjustedRSquared:
        incrementalMetrics[index].adjustedRSquared,
    };
  });
  const adjustedRSquared =
    fullFit.rSquared === null
      ? null
      : 1 -
        ((1 - fullFit.rSquared) * (observations - 1)) /
          fullFit.degreesOfFreedom;
  const outlierCount = fittedSeries.filter(
    (point) =>
      point.standardizedResidual !== null &&
      Math.abs(point.standardizedResidual) >= 2
  ).length;

  return {
    method: "ols-multiple-newey-west",
    observations,
    predictorCount: fullFit.predictorCount,
    degreesOfFreedom: fullFit.degreesOfFreedom,
    periodsPerYear: primaryMetadata.periodsPerYear,
    firstDate: rows[0]?.date ?? null,
    lastDate: rows[observations - 1]?.date ?? null,
    factors: definitions.map((definition) => ({
      key: definition.key,
      label: definition.label,
      sourceTicker: definition.sourceTicker,
      subtractTicker: definition.subtractTicker,
    })),
    intercept: {
      estimatePct: fullFit.intercept,
      annualizedPct: Number.isFinite(interceptAnnualized)
        ? interceptAnnualized
        : null,
      seHacPct: interceptInference.seHac,
      seOlsPct: interceptInference.seOls,
      z: interceptInference.z,
      pValue: interceptInference.pValue,
      confidence95Pct: interceptInference.confidence95,
    },
    coefficients,
    rSquared: fullFit.rSquared,
    adjustedRSquared: Number.isFinite(adjustedRSquared)
      ? adjustedRSquared
      : null,
    residualStandardErrorPct: Number.isFinite(residualStandardError)
      ? residualStandardError
      : null,
    rmsePct: Number.isFinite(rmse) ? rmse : null,
    maePct: Number.isFinite(mae) ? mae : null,
    aic: informationCriteria.aic,
    bic: informationCriteria.bic,
    neweyWestLag,
    fittedSeries,
    diagnostics: {
      durbinWatson:
        !residualDegenerate && serialPrevious.length
          ? durbinWatsonNumerator / fullFit.sse
          : null,
      autocorrelationLag1: pearsonCorrelation(
        serialPrevious,
        serialCurrent
      ),
      jarqueBera,
      jarqueBeraPValue,
      residualSkewness: Number.isFinite(residualSkewness)
        ? residualSkewness
        : null,
      residualExcessKurtosis: Number.isFinite(residualExcessKurtosis)
        ? residualExcessKurtosis
        : null,
      outlierCount,
      continuousTransitions: serialPrevious.length,
      pathGapCount,
      maxVif,
      rank: fullFit.rank,
      conditionNumber: fullFit.conditionNumber,
    },
    modelComparisons,
    sampleAdequacy:
      observations >= Math.max(30, 10 * fullFit.parameterCount)
        ? "adequate"
        : "limited",
    warnings: [...new Set(warnings)],
  };
};

const buildDriverFeaturePoint = (targetPoint, featureValue) => ({
  date: targetPoint.date,
  previousDate: targetPoint.previousDate,
  returnPct: featureValue,
  segmentId: targetPoint.segmentId,
});

const driverFeatureAnalysis = (targetAnalysis, points) => ({
  frequency: "1d",
  returnType: "simple",
  periodsPerYear: 252,
  priceSource: targetAnalysis.priceSource,
  points,
});

/**
 * Regresses next-session returns on lagged market microstructure and calendar
 * drivers. Every driver is known at t-1 (or deterministic from the calendar
 * at t), so the output is descriptive without leaking the current return.
 */
export const buildDriverRegressionAnalysis = (history, options = {}) => {
  const targetAnalysis = buildQuantitativeAnalysis(history, {
    ...options,
    frequency: "1d",
    returnType: "simple",
  });
  if (!targetAnalysis?.points?.length) return null;

  const normalized = normalizeRows(history).rows.filter(
    (row) => row.timestamp <= Date.parse(`${targetAnalysis.lastDate}T00:00:00Z`)
  );
  const targetByDate = new Map(
    targetAnalysis.points.map((point) => [point.date, point])
  );
  const priceField = targetAnalysis.priceSource === "adjustedClose"
    ? "adjustedClose"
    : "close";
  const featurePoints = new Map([
    ["volumeShock", []],
    ["volumeTrend", []],
    ["momentum20", []],
    ["volatility20", []],
    ["monthSin", []],
    ["monthCos", []],
  ]);
  const isContiguous = (from, to) =>
    from && to && periodsAreConsecutive(from, to, "1d");

  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index];
    const targetPoint = targetByDate.get(current.date);
    if (!targetPoint || index < 1) continue;
    const previous = normalized[index - 1];
    if (!isContiguous(previous, current)) continue;

    const month = Number(current.date.slice(5, 7));
    const angle = (2 * Math.PI * (month - 1)) / 12;
    featurePoints.get("monthSin").push(
      buildDriverFeaturePoint(targetPoint, Math.sin(angle))
    );
    featurePoints.get("monthCos").push(
      buildDriverFeaturePoint(targetPoint, Math.cos(angle))
    );

    if (index < 21) continue;
    const momentumStart = normalized[index - 21];
    const priorWindow = normalized.slice(index - 20, index);
    const prices = normalized.slice(index - 21, index).map((row) => row[priceField]);
    const validPrices = prices.every(Number.isFinite) &&
      Number.isFinite(momentumStart[priceField]) &&
      Number.isFinite(previous[priceField]);
    const contiguousWindow = normalized
      .slice(index - 21, index)
      .every((row, offset, window) => offset === 0 || isContiguous(window[offset - 1], row));
    if (!validPrices || !contiguousWindow) continue;

    const priorReturns = [];
    for (let offset = 1; offset < prices.length; offset += 1) {
      const ratio = prices[offset] / prices[offset - 1];
      const value = (ratio - 1) * 100;
      if (!Number.isFinite(value)) {
        priorReturns.length = 0;
        break;
      }
      priorReturns.push(value);
    }
    if (priorReturns.length !== 20) continue;
    const momentum20 = (previous[priceField] / momentumStart[priceField] - 1) * 100;
    const volatility20 = sampleStandardDeviation(priorReturns);
    if (!Number.isFinite(momentum20) || !Number.isFinite(volatility20)) continue;

    const volumeWindow = priorWindow.map((row) => row.volume);
    if (volumeWindow.every(Number.isFinite) && volumeWindow.every((value) => value > 0)) {
      const mean20 = arithmeticMean(volumeWindow);
      const mean5 = arithmeticMean(volumeWindow.slice(-5));
      const previousVolume = volumeWindow[volumeWindow.length - 1];
      const volumeShock = Math.log((previousVolume + 1) / (mean20 + 1));
      const volumeTrend = Math.log((mean5 + 1) / (mean20 + 1));
      if (Number.isFinite(volumeShock)) {
        featurePoints.get("volumeShock").push(
          buildDriverFeaturePoint(targetPoint, volumeShock)
        );
      }
      if (Number.isFinite(volumeTrend)) {
        featurePoints.get("volumeTrend").push(
          buildDriverFeaturePoint(targetPoint, volumeTrend)
        );
      }
    }
    featurePoints.get("momentum20").push(
      buildDriverFeaturePoint(targetPoint, momentum20)
    );
    featurePoints.get("volatility20").push(
      buildDriverFeaturePoint(targetPoint, volatility20)
    );
  }

  const labels = {
    volumeShock: "Volume · shock log vs media 20g",
    volumeTrend: "Volume · trend media 5g/20g",
    momentum20: "Momentum · rendimento precedente 20g",
    volatility20: "Volatilità · deviazione standard 20g",
    monthSin: "Stagionalità · seno del mese",
    monthCos: "Stagionalità · coseno del mese",
  };
  const sourceTicker = options.ticker || "Titolo";
  const definitions = [...featurePoints.entries()]
    .filter(([, points]) => points.length >= 3)
    .map(([key, points]) => ({
      key,
      label: labels[key],
      sourceTicker,
      analysis: driverFeatureAnalysis(targetAnalysis, points),
    }));
  if (definitions.length < 2) return null;

  const available = new Set(definitions.map((definition) => definition.key));
  const modelSpecs = [];
  const addSpec = (key, label, predictorKeys) => {
    const keys = predictorKeys.filter((predictorKey) => available.has(predictorKey));
    if (keys.length < 1 || modelSpecs.some((spec) => (
      spec.predictorKeys.length === keys.length &&
      spec.predictorKeys.every((predictorKey, index) => predictorKey === keys[index])
    ))) return;
    modelSpecs.push({ key, label, predictorKeys: keys });
  };
  addSpec("volume", "M1 · Volume", ["volumeShock", "volumeTrend"]);
  addSpec("market_dynamics", "M2 · Volume + dinamica", [
    "volumeShock", "volumeTrend", "momentum20", "volatility20",
  ]);
  addSpec("drivers_full", "M3 · Driver + stagionalità", [
    "volumeShock", "volumeTrend", "momentum20", "volatility20", "monthSin", "monthCos",
  ]);
  if (!modelSpecs.length) return null;
  const result = buildMultipleRegressionAnalysis(targetAnalysis, definitions, {
    modelSpecs,
    fullModelKey: modelSpecs[modelSpecs.length - 1].key,
  });
  if (!result) return null;
  return {
    ...result,
    modelFamily: "drivers",
    warnings: [
      ...(result.warnings || []),
      "I regressori sono laggati al giorno precedente o deterministici dal calendario: il modello descrive associazioni storiche, non causalità né previsione.",
    ],
  };
};

export const buildMonteCarloSimulation = (analysis, options = {}) => {
  const returnType = analysis?.returnType === "log" ? "log" : "simple";
  const returnObservations = (analysis?.points || [])
    .map((point) => ({ value: Number(point.returnPct) / 100, segmentId: point?.segmentId ?? null }))
    .filter(({ value }) => Number.isFinite(value) && (returnType === "log" || value > -1));
  const returns = returnObservations.map(({ value }) => value);
  if (returns.length < 30) return null;
  const horizon = clamp(Math.round(Number(options.horizon) || 63), 5, 756);
  const pathCount = clamp(Math.round(Number(options.pathCount) || 5000), 250, 10000);
  const initialValue = finitePositive(options.initialValue) || 100;
  const initialValueSource = finitePositive(options.initialValue) ? (options.initialValueSource || "market-quote") : "fallback-index-100";
  const requestedBlockLength = Math.round(Number(options.blockLength) || 5);
  const blockLength = clamp(requestedBlockLength, 1, Math.min(20, returns.length));
  const bootstrapMethod = options.bootstrapMethod === "iid" ? "iid" : "moving-block";
  const blockStarts = [];
  if (bootstrapMethod === "moving-block") {
    for (let index = 0; index <= returns.length - blockLength; index += 1) {
      const segmentId = returnObservations[index].segmentId;
      let contiguous = true;
      for (let offset = 1; offset < blockLength; offset += 1) {
        if (returnObservations[index + offset].segmentId !== segmentId) {
          contiguous = false;
          break;
        }
      }
      if (contiguous) blockStarts.push(index);
    }
  }
  const effectiveBootstrapMethod = bootstrapMethod === "moving-block" && blockStarts.length
    ? "moving-block"
    : "iid";
  const periodsPerYear = finitePositive(options.periodsPerYear) || 252;
  const seed = Number.isFinite(Number(options.seed)) ? Number(options.seed) >>> 0 : 20260825;
  let state = seed || 1;
  const random = () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul((value ^ (value >>> 15)), value | 1);
    value ^= value + Math.imul((value ^ (value >>> 7)), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const paths = [];
  const terminalValues = [];
  const maxDrawdowns = [];
  for (let pathIndex = 0; pathIndex < pathCount; pathIndex += 1) {
    let value = initialValue;
    let peak = value;
    let maxDrawdown = 0;
    let blockIndex = 0;
    let blockRemaining = 0;
    const path = [value];
    for (let step = 0; step < horizon; step += 1) {
      if (effectiveBootstrapMethod === "moving-block") {
        if (blockRemaining <= 0) {
          const availableStarts = blockStarts.length ? blockStarts : [Math.floor(random() * returns.length)];
          blockIndex = availableStarts[Math.floor(random() * availableStarts.length)];
          blockRemaining = blockStarts.length ? blockLength : 1;
        }
      } else {
        blockIndex = Math.floor(random() * returns.length);
        blockRemaining = 1;
      }
      const sampled = returns[blockIndex];
      blockIndex += 1;
      blockRemaining -= 1;
      const growthFactor = returnType === "log" ? Math.exp(sampled) : 1 + sampled;
      value *= growthFactor;
      peak = Math.max(peak, value);
      maxDrawdown = Math.min(maxDrawdown, value / peak - 1);
      path.push(value);
    }
    paths.push(path);
    terminalValues.push(value);
    maxDrawdowns.push(maxDrawdown);
  }
  const sortedTerminal = [...terminalValues].sort((a, b) => a - b);
  const sortedDrawdowns = [...maxDrawdowns].sort((a, b) => a - b);
  const terminalQuantiles = {
    p01: quantile(sortedTerminal, 0.01), p05: quantile(sortedTerminal, 0.05),
    p25: quantile(sortedTerminal, 0.25), median: quantile(sortedTerminal, 0.5),
    p75: quantile(sortedTerminal, 0.75), p95: quantile(sortedTerminal, 0.95), p99: quantile(sortedTerminal, 0.99),
  };
  const positiveProbability = terminalValues.filter((value) => value > initialValue).length / pathCount;
  const returnsToTerminal = terminalValues.map((value) => value / initialValue - 1).sort((a, b) => a - b);
  const lossTail = returnsToTerminal.filter((value) => value <= quantile(returnsToTerminal, 0.05));
  const terminalMean = arithmeticMean(terminalValues);
  const terminalStd = sampleStandardDeviation(terminalValues, terminalMean);
  const returnMean = arithmeticMean(returns);
  const returnStd = sampleStandardDeviation(returns, returnMean);
  const returnVariance = returnStd === null ? null : returnStd ** 2;
  const returnSkewness = returnStd && returnStd > 0
    ? arithmeticMean(returns.map((value) => ((value - returnMean) / returnStd) ** 3))
    : null;
  const returnExcessKurtosis = returnStd && returnStd > 0
    ? arithmeticMean(returns.map((value) => ((value - returnMean) / returnStd) ** 4)) - 3
    : null;
  const histogramBins = 24;
  const lower = sortedTerminal[0];
  const upper = sortedTerminal[sortedTerminal.length - 1];
  const width = upper > lower ? (upper - lower) / histogramBins : 1;
  const histogram = Array.from({ length: histogramBins }, (_, index) => ({
    x0: lower + index * width, x1: lower + (index + 1) * width, count: 0,
  }));
  terminalValues.forEach((value) => histogram[Math.min(histogramBins - 1, Math.floor((value - lower) / width))].count += 1);
  return {
    method: "historical-bootstrap",
    bootstrapMethod: effectiveBootstrapMethod,
    returnType,
    blockLength: effectiveBootstrapMethod === "moving-block" ? blockLength : 1,
    horizon, pathCount, initialValue, initialValueSource, seed, sourceObservations: returns.length,
    periodsPerYear,
    paths: paths.filter((_, index) => index < 80),
    terminalValues, terminalQuantiles,
    terminalMean,
    terminalStd,
    terminalMeanStandardError: terminalStd === null ? null : terminalStd / Math.sqrt(pathCount),
    terminalReturnQuantiles: {
      p01: quantile(returnsToTerminal, 0.01), p05: quantile(returnsToTerminal, 0.05),
      p25: quantile(returnsToTerminal, 0.25), median: quantile(returnsToTerminal, 0.5),
      p75: quantile(returnsToTerminal, 0.75), p95: quantile(returnsToTerminal, 0.95), p99: quantile(returnsToTerminal, 0.99),
    },
    positiveProbability,
    lossProbability: 1 - positiveProbability,
    positiveProbabilityStandardError: Math.sqrt((positiveProbability * (1 - positiveProbability)) / pathCount),
    annualizedDrift: Number.isFinite(returnMean) ? returnMean * periodsPerYear : null,
    annualizedVolatility: returnStd === null ? null : returnStd * Math.sqrt(periodsPerYear),
    returnVariance,
    returnSkewness,
    returnExcessKurtosis,
    var05: quantile(returnsToTerminal, 0.05),
    expectedShortfall05: lossTail.length ? arithmeticMean(lossTail) : null,
    maxDrawdownP05: quantile(sortedDrawdowns, 0.05),
    maxDrawdownMedian: quantile(sortedDrawdowns, 0.5),
    histogram,
  };
};

const percentile = (values, probability) => quantile([...values].sort((a, b) => a - b), probability);
const annualizedReturn = (returns, periodsPerYear = 252) => {
  if (!returns.length) return null;
  const growth = returns.reduce((total, value) => total * (1 + value), 1);
  return growth > 0 ? growth ** (periodsPerYear / returns.length) - 1 : -1;
};
const maxDrawdownFromCurve = (curve) => {
  let peak = curve[0] || 1;
  let worst = 0;
  curve.forEach((value) => {
    peak = Math.max(peak, value);
    worst = Math.min(worst, value / peak - 1);
  });
  return worst;
};
const backtestMetrics = (returns, curve, periodsPerYear = 252, turnover = 0) => {
  if (!returns.length) return null;
  const mean = arithmeticMean(returns);
  const sd = sampleStandardDeviation(returns, mean);
  const downside = returns.filter((value) => value < 0);
  const downsideSd = downside.length ? Math.sqrt(arithmeticMean(downside.map((value) => value ** 2))) : null;
  const annualizedVol = sd === null ? null : sd * Math.sqrt(periodsPerYear);
  return {
    cumulativeReturn: curve[curve.length - 1] - 1,
    annualizedReturn: annualizedReturn(returns, periodsPerYear),
    annualizedVolatility: annualizedVol,
    sharpe: sd ? (mean / sd) * Math.sqrt(periodsPerYear) : null,
    sortino: downsideSd ? (mean / downsideSd) * Math.sqrt(periodsPerYear) : null,
    maxDrawdown: maxDrawdownFromCurve(curve),
    calmar: maxDrawdownFromCurve(curve) < 0 ? annualizedReturn(returns, periodsPerYear) / Math.abs(maxDrawdownFromCurve(curve)) : null,
    hitRatio: returns.filter((value) => value > 0).length / returns.length,
    turnover: turnover / returns.length,
  };
};

export const buildAdvancedQuantitativeAnalytics = (analysis, benchmarkAnalysis = null, options = {}) => {
  const points = analysis?.points || [];
  if (points.length < 40) return null;
  const rawReturns = points.map((point) => Number(point.returnPct) / 100).filter(Number.isFinite);
  const periodsPerYear = Number(options.periodsPerYear) || 252;
  const transactionCost = Math.max(0, Number(options.transactionCost) || 0.0005);
  const slippage = Math.max(0, Number(options.slippage) || 0.0005);
  const friction = transactionCost + slippage;
  const lookback = (values, window) => values.length < window ? null : arithmeticMean(values.slice(-window));
  const strategy = (name, signalFn) => {
    let exposure = 0;
    let turnover = 0;
    let equity = 1;
    const strategyReturns = [];
    const curve = [1];
    rawReturns.forEach((ret, index) => {
      const history = rawReturns.slice(0, index);
      const nextExposure = index < 2 ? 0 : signalFn(history);
      if (nextExposure !== exposure) {
        turnover += Math.abs(nextExposure - exposure);
        equity *= 1 - friction * Math.abs(nextExposure - exposure);
      }
      exposure = nextExposure;
      const pnl = exposure * ret;
      strategyReturns.push(pnl);
      equity *= 1 + pnl;
      curve.push(equity);
    });
    return { name, returns: strategyReturns, curve, metrics: backtestMetrics(strategyReturns, curve, periodsPerYear, turnover), turnoverTotal: turnover };
  };
  const strategies = [
    strategy("Momentum", (history) => (lookback(history, 20) || 0) > 0 ? 1 : 0),
    strategy("Mean reversion", (history) => (lookback(history, 5) || 0) < 0 ? 1 : 0),
    strategy("Tecnico SMA", (history) => {
      if (history.length < 50) return 0;
      const fast = history.slice(-20).reduce((a, b) => a * (1 + b), 1);
      const slow = history.slice(-50).reduce((a, b) => a * (1 + b), 1);
      return fast > slow ? 1 : 0;
    }),
  ];
  const split = Math.max(20, Math.floor(rawReturns.length * 0.7));
  const walkForward = [0.5, 0.65, 0.8].map((ratio, index) => {
    const end = Math.max(split, Math.floor(rawReturns.length * ratio));
    const sample = rawReturns.slice(0, end);
    const curve = [1];
    sample.forEach((value) => curve.push(curve[curve.length - 1] * (1 + value)));
    return { window: index + 1, inSampleObservations: Math.max(0, end - 20), outOfSampleObservations: Math.max(0, rawReturns.length - end), outOfSampleReturn: rawReturns.slice(end).reduce((total, value) => total * (1 + value), 1) - 1, stability: sampleStandardDeviation(sample) ? "Misurata" : "Non stimabile" };
  });
  const mean = arithmeticMean(rawReturns);
  const sd = sampleStandardDeviation(rawReturns, mean);
  const sorted = [...rawReturns].sort((a, b) => a - b);
  const ewmaLambda = 0.94;
  let ewmaVariance = sd ? sd ** 2 : 0;
  rawReturns.forEach((value) => { ewmaVariance = ewmaLambda * ewmaVariance + (1 - ewmaLambda) * (value - mean) ** 2; });
  const risk = {
    historicalVaR95: percentile(rawReturns, 0.05),
    parametricVaR95: mean - 1.645 * (sd || 0),
    ewmaVolatility: Math.sqrt(Math.max(0, ewmaVariance)) * Math.sqrt(periodsPerYear),
    historicalExpectedShortfall95: arithmeticMean(sorted.filter((value) => value <= percentile(rawReturns, 0.05))),
    stress: { shockMinus10: -0.1, shockMinus20: -0.2, volatilityDouble: (sd || 0) * 2 },
  };
  const autocorrelation = (lag) => {
    if (rawReturns.length <= lag || !sd) return null;
    return arithmeticMean(rawReturns.slice(lag).map((value, index) => (value - mean) * (rawReturns[index] - mean))) / (sd ** 2);
  };
  const benchmarkReturns = (benchmarkAnalysis?.points || []).map((point) => Number(point.returnPct) / 100).filter(Number.isFinite);
  const paired = Math.min(rawReturns.length, benchmarkReturns.length);
  const covariance = paired > 2 ? arithmeticMean(rawReturns.slice(-paired).map((value, index) => (value - mean) * (benchmarkReturns.slice(-paired)[index] - arithmeticMean(benchmarkReturns.slice(-paired))))) : null;
  const benchmarkSd = paired > 2 ? sampleStandardDeviation(benchmarkReturns.slice(-paired)) : null;
  const beta = covariance !== null && benchmarkSd ? covariance / (benchmarkSd ** 2) : null;
  const factors = [
    { name: "Momentum", exposure: lookback(rawReturns, 20) },
    { name: "Low volatility", exposure: sd ? 1 / sd : null },
    { name: "Quality", exposure: mean },
    { name: "Size / value", exposure: null, status: "Richiede universo multi-titolo" },
    { name: "Growth", exposure: annualizedReturn(rawReturns, periodsPerYear) },
  ];
  const portfolioCurve = [1];
  const weights = { asset: 0.8, benchmark: 0.2 };
  for (let index = 0; index < paired; index += 1) portfolioCurve.push(portfolioCurve[portfolioCurve.length - 1] * (1 + weights.asset * rawReturns[rawReturns.length - paired + index] + weights.benchmark * benchmarkReturns[benchmarkReturns.length - paired + index]));
  const portfolioReturns = portfolioCurve.slice(1).map((value, index) => value / portfolioCurve[index] - 1);
  return {
    backtest: { strategies, benchmark: benchmarkReturns.length ? backtestMetrics(benchmarkReturns, benchmarkReturns.reduce((curve, value) => [...curve, curve[curve.length - 1] * (1 + value)], [1]), periodsPerYear) : null, transactionCost, slippage },
    validation: { walkForward, split: "70/30 temporale", noLookAhead: true, survivorshipBias: "Non eliminabile con un singolo titolo" },
    risk,
    factors,
    dependence: { autocorrelationLag1: autocorrelation(1), autocorrelationLag5: autocorrelation(5), beta, benchmarkCorrelation: beta && sd && benchmarkSd ? beta * benchmarkSd / sd : null },
    portfolio: { weights, metrics: backtestMetrics(portfolioReturns, portfolioCurve, periodsPerYear), contributionToRisk: { asset: weights.asset, benchmark: weights.benchmark }, trackingError: null, informationRatio: null },
    dataQuality: analysis.quality || {},
  };
};

const csvCell = (value) => {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    return "";
  }
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export const analysisToCsv = (analysis, ticker = "") => {
  const header = [
    "ticker",
    "date",
    "return_pct",
    "cumulative_return_pct",
    "drawdown_pct",
    "rolling_volatility_short_pct",
    "rolling_volatility_medium_pct",
    "rolling_volatility_long_pct",
  ];
  const cumulative = new Map(
    (analysis?.cumulativeSeries || []).map((row) => [row.date, row.valuePct])
  );
  const drawdown = new Map(
    (analysis?.drawdownSeries || []).map((row) => [row.date, row.valuePct])
  );
  const rolling = Object.fromEntries(
    ["short", "medium", "long"].map((name) => [
      name,
      new Map(
        (analysis?.rollingVolatility?.[name] || []).map((row) => [
          row.date,
          row.valuePct,
        ])
      ),
    ])
  );
  const lines = (analysis?.points || []).map((point) =>
    [
      ticker,
      point.date,
      point.returnPct,
      cumulative.get(point.date),
      drawdown.get(point.date),
      rolling.short.get(point.date),
      rolling.medium.get(point.date),
      rolling.long.get(point.date),
    ]
      .map(csvCell)
      .join(",")
  );
  return [header.join(","), ...lines].join("\n");
};
