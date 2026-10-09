const finite = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const correlation = (left, right) => {
  const pairs = [];
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (Number.isFinite(left[index]) && Number.isFinite(right[index])) pairs.push([left[index], right[index]]);
  }
  if (pairs.length < 30) return null;
  const leftMean = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length;
  const rightMean = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length;
  const covariance = pairs.reduce((sum, pair) => sum + (pair[0] - leftMean) * (pair[1] - rightMean), 0);
  const leftSd = Math.sqrt(pairs.reduce((sum, pair) => sum + (pair[0] - leftMean) ** 2, 0));
  const rightSd = Math.sqrt(pairs.reduce((sum, pair) => sum + (pair[1] - rightMean) ** 2, 0));
  return leftSd && rightSd ? covariance / (leftSd * rightSd) : null;
};

const covarianceMatrix = (stats) => {
  const size = stats.length;
  const matrix = Array.from({ length: size }, () => Array(size).fill(0));
  for (let left = 0; left < size; left += 1) {
    for (let right = left; right < size; right += 1) {
      const value = left === right
        ? stats[left].volatility ** 2 / 252
        : (() => {
          const dates = new Map(stats[right].returns.map((item) => [item.date, item.value]));
          const pairs = stats[left].returns.map((item) => [item.value, dates.get(item.date)]).filter((pair) => Number.isFinite(pair[1]));
          if (pairs.length < 30) return 0;
          const leftMean = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length;
          const rightMean = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length;
          return pairs.reduce((sum, pair) => sum + (pair[0] - leftMean) * (pair[1] - rightMean), 0) / Math.max(1, pairs.length - 1);
        })();
      // I rendimenti sono giornalieri; Markowitz lavora su covarianza annualizzata.
      matrix[left][right] = value * 252;
      matrix[right][left] = value * 252;
    }
  }
  const diagonalShrinkage = 0.08;
  for (let index = 0; index < size; index += 1) {
    for (let other = 0; other < size; other += 1) {
      if (index !== other) matrix[index][other] *= 1 - diagonalShrinkage;
    }
    matrix[index][index] = Math.max(matrix[index][index], 1e-8);
  }
  return matrix;
};

const normalizeWeights = (weights) => {
  const nonNegative = weights.map((value) => Math.max(0, Number(value) || 0));
  const total = nonNegative.reduce((sum, value) => sum + value, 0) || 1;
  return nonNegative.map((value) => value / total);
};

const portfolioVariance = (weights, covariance) => weights.reduce((sum, weight, left) => sum + weight * weights.reduce((inner, other, right) => inner + other * covariance[left][right], 0), 0);
const matrixVectorProduct = (matrix, vector) => matrix.map((row) => {
  let total = 0;
  for (let index = 0; index < row.length; index += 1) total += row[index] * vector[index];
  return total;
});
const vectorDot = (left, right) => {
  let total = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) total += left[index] * right[index];
  return total;
};

const optimizeMinimumVariance = (covariance) => {
  let weights = normalizeWeights(Array(covariance.length).fill(1));
  for (let iteration = 0; iteration < 900; iteration += 1) {
    const gradient = matrixVectorProduct(covariance, weights).map((value) => value * 2);
    const diagonalMaximum = covariance.reduce((maximum, row, index) => Math.max(maximum, Math.abs(row[index])), 1e-6);
    const step = Math.min(0.08, 0.08 / diagonalMaximum);
    const nextWeights = weights.map((weight, index) => weight - step * gradient[index]);
    weights = normalizeWeights(nextWeights);
  }
  return weights;
};

const optimizeMaximumSharpe = (covariance, expectedReturns, riskFreeRate = 0.02) => {
  let weights = optimizeMinimumVariance(covariance);
  for (let iteration = 0; iteration < 800; iteration += 1) {
    const sigmaSquared = Math.max(portfolioVariance(weights, covariance), 1e-10);
    const sigma = Math.sqrt(sigmaSquared);
    const excess = vectorDot(expectedReturns, weights) - riskFreeRate;
    const covarianceWeights = matrixVectorProduct(covariance, weights);
    const gradient = expectedReturns.map((value, index) => -value / sigma + excess * covarianceWeights[index] / (sigmaSquared * sigma));
    const nextWeights = weights.map((weight, index) => weight - 0.02 * gradient[index]);
    weights = normalizeWeights(nextWeights);
  }
  return weights;
};

const optimizeTargetReturn = (covariance, expectedReturns, target) => {
  let weights = optimizeMinimumVariance(covariance);
  const diagonalMaximum = covariance.reduce((maximum, row, index) => Math.max(maximum, Math.abs(row[index])), 1e-6);
  const step = Math.min(0.04, 0.03 / diagonalMaximum);
  for (let iteration = 0; iteration < 1200; iteration += 1) {
    const covarianceWeights = matrixVectorProduct(covariance, weights);
    const currentReturn = vectorDot(expectedReturns, weights);
    const returnGap = currentReturn - target;
    const gradient = covarianceWeights.map((value, index) => 2 * value + 200 * returnGap * expectedReturns[index]);
    weights = normalizeWeights(weights.map((weight, index) => weight - step * gradient[index]));
  }
  return weights;
};

const portfolioMetrics = (weights, covariance, expectedReturns, riskFreeRate = 0.02) => {
  const expectedReturn = expectedReturns.reduce((sum, value, index) => sum + value * weights[index], 0);
  const volatility = Math.sqrt(Math.max(0, portfolioVariance(weights, covariance)));
  return { expectedReturn, volatility, sharpe: volatility > 0 ? (expectedReturn - riskFreeRate) / volatility : null };
};

const extractReturns = (history = []) => {
  const rows = (Array.isArray(history) ? history : [])
    .map((row) => ({ date: String(row?.date || ""), price: finite(row?.adjustedClose ?? row?.close) }))
    .filter((row) => row.date && row.price > 0)
    .sort((left, right) => left.date.localeCompare(right.date));
  const returns = [];
  for (let index = 1; index < rows.length; index += 1) {
    const value = rows[index].price / rows[index - 1].price - 1;
    if (Number.isFinite(value) && value > -1) returns.push({ date: rows[index].date, value });
  }
  return returns;
};

export const buildRiskSelection = (histories = {}, options = {}) => {
  const minObservations = Math.max(30, Number(options.minObservations) || 60);
  const maxSelected = Math.max(2, Number(options.maxSelected) || 25);
  const entries = Object.entries(histories)
    .map(([ticker, history]) => ({ ticker: String(ticker).toUpperCase(), returns: extractReturns(history) }))
    .filter((item) => item.returns.length >= minObservations);
  if (!entries.length) return null;

  const stats = entries.map((entry) => {
    const values = entry.returns.map((item) => item.value);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length - 1);
    const volatility = Math.sqrt(Math.max(0, variance)) * Math.sqrt(252);
    const downsideValues = values.filter((value) => value < 0);
    const downsideVolatility = downsideValues.length ? Math.sqrt(downsideValues.reduce((sum, value) => sum + value ** 2, 0) / downsideValues.length) * Math.sqrt(252) : 0;
    let peak = 1;
    let equity = 1;
    let maxDrawdown = 0;
    values.forEach((value) => { equity *= 1 + value; peak = Math.max(peak, equity); maxDrawdown = Math.min(maxDrawdown, equity / peak - 1); });
    return { ticker: entry.ticker, observations: values.length, annualizedReturn: (1 + mean) ** 252 - 1, volatility, downsideVolatility, maxDrawdown, returns: entry.returns };
  });
  const correlations = [];
  const correlationCache = new Map();
  const getCorrelation = (left, right) => {
    const key = [left.ticker, right.ticker].sort().join("|");
    if (correlationCache.has(key)) return correlationCache.get(key);
    const value = correlation(left.returns.map((item) => item.value), right.returns.map((item) => item.value));
    correlationCache.set(key, value);
    if (value !== null && correlations.length < maxSelected * 100) correlations.push({ left: left.ticker, right: right.ticker, value });
    return value;
  };
  const avgVolatility = stats.reduce((sum, item) => sum + item.volatility, 0) / stats.length;
  const sortedByRisk = [...stats].sort((left, right) => left.volatility - right.volatility);
  const selected = [];
  sortedByRisk.forEach((candidate) => {
    const pairwise = selected.map((item) => getCorrelation(candidate, item)).filter(Number.isFinite);
    const maxCorrelation = pairwise.length ? Math.max(...pairwise) : null;
    const riskAdjustedReturn = candidate.volatility > 0 ? candidate.annualizedReturn / candidate.volatility : 0;
    const keep = selected.length < 2 || (selected.length < maxSelected && (maxCorrelation === null || maxCorrelation < 0.85 || riskAdjustedReturn > 0.35));
    if (keep) selected.push(candidate);
  });
  const covariance = covarianceMatrix(selected);
  const expectedReturns = selected.map((item) => item.annualizedReturn);
  const markowitzMinWeights = optimizeMinimumVariance(covariance);
  const markowitzMaxSharpeWeights = optimizeMaximumSharpe(covariance, expectedReturns, Number(options.riskFreeRate) || 0.02);
  const markowitzWeights = markowitzMinWeights;
  const selectedTickers = new Set(selected.filter((item, index) => markowitzWeights[index] >= 0.005).map((item) => item.ticker));
  if (selectedTickers.size < 2) selected.slice(0, 2).forEach((item) => selectedTickers.add(item.ticker));
  const normalizedWeights = selected.map((item, index) => ({ ticker: item.ticker, weight: markowitzWeights[index] || 0 }));
  const markowitzPortfolio = portfolioMetrics(markowitzWeights, covariance, expectedReturns, Number(options.riskFreeRate) || 0.02);
  const maxSharpePortfolio = portfolioMetrics(markowitzMaxSharpeWeights, covariance, expectedReturns, Number(options.riskFreeRate) || 0.02);
  const frontierStart = markowitzPortfolio.expectedReturn;
  const frontierEnd = Math.max(...expectedReturns);
  const frontier = Array.from({ length: 15 }, (_, index) => {
    const target = frontierStart + (frontierEnd - frontierStart) * (index / 14);
    const weights = optimizeTargetReturn(covariance, expectedReturns, target);
    const metrics = portfolioMetrics(weights, covariance, expectedReturns, Number(options.riskFreeRate) || 0.02);
    return { targetReturn: target, ...metrics, weights: selected.map((item, itemIndex) => ({ ticker: item.ticker, weight: weights[itemIndex] || 0 })) };
  });
  const recommendations = stats.map((item) => {
    const correlationsToSelected = selected.filter((candidate) => candidate.ticker !== item.ticker).map((candidate) => getCorrelation(item, candidate)).filter(Number.isFinite);
    const maxCorrelation = correlationsToSelected.length ? Math.max(...correlationsToSelected) : null;
    const weight = normalizedWeights.find((entry) => entry.ticker === item.ticker)?.weight || 0;
    const reasons = [];
    if (item.volatility > Math.max(0.35, avgVolatility * 1.35)) reasons.push("volatilità annualizzata elevata");
    if (maxCorrelation !== null && maxCorrelation >= 0.85) reasons.push("correlazione elevata con il paniere");
    if (item.maxDrawdown < -0.45) reasons.push("drawdown storico profondo");
    if (selectedTickers.has(item.ticker)) {
      if (!reasons.length) reasons.push("contribuisce alla diversificazione con rischio contenuto");
      return { ...item, decision: "mantieni", weight, maxCorrelation, reasons };
    }
    if (!reasons.length) reasons.push("ridondante rispetto ai titoli selezionati");
    return { ...item, decision: "riduci", weight: 0, maxCorrelation, reasons };
  });
  const selectedReturns = selected.flatMap((item) => item.returns);
  const portfolioVolatility = normalizedWeights.length ? markowitzPortfolio.volatility : null;
  return {
    method: "Markowitz mean-variance · matrice covarianza shrinkata · long-only",
    recommendations,
    correlations,
    selectedTickers: [...selectedTickers],
    portfolio: { volatility: portfolioVolatility, averageReturn: markowitzPortfolio.expectedReturn, sharpe: markowitzPortfolio.sharpe, observations: selectedReturns.length, weights: normalizedWeights },
    markowitz: { minimumVariance: { weights: normalizedWeights, ...markowitzPortfolio }, maximumSharpe: { weights: selected.map((item, index) => ({ ticker: item.ticker, weight: markowitzMaxSharpeWeights[index] || 0 })), ...maxSharpePortfolio }, efficientFrontier: frontier, covarianceAnnualized: covariance, expectedReturnsAnnualized: expectedReturns, riskFreeRate: Number(options.riskFreeRate) || 0.02, shrinkage: 0.08 },
    controls: { minObservations, maxSelected, maxPairCorrelation: 0.85, maxDrawdownWarning: -0.45, volatilityWarning: Math.max(0.35, avgVolatility * 1.35) },
    disclaimer: "Selezione quantitativa Markowitz per diversificazione, non consulenza finanziaria. I rendimenti attesi sono stime storiche e possono essere instabili.",
  };
};
