const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const safeNum = (value) => (Number.isFinite(value) ? Number(value) : null);
const clampPct = (value) => clamp(value, 0, 100);

const parseHistoryDate = (value) => {
  if (!value) return null;
  const normalizedValue =
    typeof value === "string" && /^\d{4}-\d{2}$/.test(value) ? `${value}-01` : value;
  const parsed = new Date(normalizedValue);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const normalizeGapRows = (rows) =>
  (Array.isArray(rows) ? rows : [])
    .map((row, index) => {
      const open = Number(row.open);
      const high = Number(row.high);
      const low = Number(row.low);
      const close = Number(row.close);
      const dateObj = parseHistoryDate(row.date);
      return {
        index,
        date: row.date,
        dateObj,
        open,
        high,
        low,
        close,
      };
    })
    .filter(
      (row) =>
        row.dateObj &&
        Number.isFinite(row.open) &&
        Number.isFinite(row.high) &&
        Number.isFinite(row.low) &&
        Number.isFinite(row.close)
    );

const findGapsLikePrevisione = (rows, thresholdPct = 0.01) => {
  const gaps = [];
  if (!Array.isArray(rows) || rows.length < 2) return gaps;

  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1];
    const curr = rows[i];

    if (curr.low > prev.high * (1 + thresholdPct)) {
      gaps.push({
        index: i,
        date: curr.date,
        dateObj: curr.dateObj,
        type: "Gap Up",
        start: prev.high,
        end: curr.low,
        direction: "up",
      });
    } else if (curr.high < prev.low * (1 - thresholdPct)) {
      gaps.push({
        index: i,
        date: curr.date,
        dateObj: curr.dateObj,
        type: "Gap Down",
        start: curr.high,
        end: prev.low,
        direction: "down",
      });
    }
  }

  for (let i = 2; i < rows.length; i += 1) {
    const c1 = rows[i - 2];
    const c2 = rows[i - 1];
    const c3 = rows[i];

    const threeGreen = c1.close > c1.open && c2.close > c2.open && c3.close > c3.open;
    const threeRed = c1.close < c1.open && c2.close < c2.open && c3.close < c3.open;

    if (threeGreen && c3.low >= c1.high) {
      gaps.push({
        index: i,
        date: c3.date,
        dateObj: c3.dateObj,
        type: "Gap Up 3 candele",
        start: c1.high,
        end: c3.low,
        direction: "up",
      });
    } else if (threeRed && c3.high <= c1.low) {
      gaps.push({
        index: i,
        date: c3.date,
        dateObj: c3.dateObj,
        type: "Gap Down 3 candele",
        start: c3.high,
        end: c1.low,
        direction: "down",
      });
    }
  }

  return gaps;
};

const computeGapFillPct = (gap, candle) => {
  const start = Number(gap?.start);
  const end = Number(gap?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;

  const lower = Math.min(start, end);
  const upper = Math.max(start, end);
  const size = upper - lower;
  if (!(size > 0)) return 0;

  const isGapUp = gap.type === "Gap Up" || gap.type === "Gap Up 3 candele";
  if (isGapUp) {
    const low = Number(candle?.low);
    if (!Number.isFinite(low)) return 0;
    const fillAmount = upper - Math.max(low, lower);
    return Math.max(0, Math.min(100, (fillAmount / size) * 100));
  }

  const high = Number(candle?.high);
  if (!Number.isFinite(high)) return 0;
  const fillAmount = Math.min(high, upper) - lower;
  return Math.max(0, Math.min(100, (fillAmount / size) * 100));
};

const markClosedGapsLikePrevisione = (rows, gaps) =>
  (Array.isArray(gaps) ? gaps : []).map((gap) => {
    const closeThresholdPct = 50;
    let closed = false;
    let maxFillPct = 0;

    for (let i = gap.index + 1; i < rows.length; i += 1) {
      const candle = rows[i];
      const fillPct = computeGapFillPct(gap, candle);
      if (fillPct > maxFillPct) maxFillPct = fillPct;
      if (maxFillPct >= closeThresholdPct) {
        closed = true;
        break;
      }
    }

    return {
      ...gap,
      closed,
      fillPct: maxFillPct,
    };
  });

const winsorizeCurve = (sourceCurve) => {
  if (!sourceCurve) return null;
  const allValues = Object.values(sourceCurve)
    .flat()
    .filter((value) => Number.isFinite(value));

  if (allValues.length === 0) return sourceCurve;

  const sorted = [...allValues].sort((a, b) => a - b);
  const minVal = sorted[Math.floor(0.05 * (sorted.length - 1))];
  const maxVal = sorted[Math.floor(0.95 * (sorted.length - 1))];

  const out = {};
  Object.keys(sourceCurve).forEach((year) => {
    out[year] = (sourceCurve[year] || []).map((value) =>
      Number.isFinite(value) ? Math.min(Math.max(value, minVal), maxVal) : value
    );
  });
  return out;
};

const computeCumulativePercentiles = (curveData, years) => {
  if (!curveData || !years || years.length === 0) return [];
  const cumulativeByMonth = Array(12)
    .fill(null)
    .map(() => []);

  years.forEach((year) => {
    let cumulative = 0;
    (curveData?.[year] || []).forEach((value, index) => {
      if (!Number.isFinite(value)) return;
      cumulative += value;
      cumulativeByMonth[index].push(cumulative);
    });
  });

  return cumulativeByMonth.map((values) => {
    if (!values.length) return { p10: 0, median: 0, p90: 0 };
    const sorted = values.slice().sort((a, b) => a - b);
    const p10 = sorted[Math.floor(0.1 * sorted.length)] || 0;
    const median = sorted[Math.floor(0.5 * sorted.length)] || 0;
    const p90 = sorted[Math.floor(0.9 * sorted.length)] || 0;
    return { p10, median, p90 };
  });
};

export const TRADING_SIGNAL_VERSION = "institutional-v2";

const voteStrength = (value, mild = 0.16, strong = 0.5) => {
  const abs = Math.abs(Number(value) || 0);
  if (abs >= strong) return 2;
  if (abs >= mild) return 1;
  return 0;
};

const gapCloseProbability = (rows, gaps, lookaheadCandles = 10) => {
  if (!Array.isArray(gaps) || gaps.length === 0) return null;
  let closedCount = 0;

  gaps.forEach((gap) => {
    const future = rows.slice(gap.index + 1, gap.index + 1 + lookaheadCandles);
    if (future.length === 0) return;
    const maxFillPct = future.reduce(
      (maxValue, candle) => Math.max(maxValue, computeGapFillPct(gap, candle)),
      0
    );
    if (maxFillPct >= 50) closedCount += 1;
  });

  return (closedCount / gaps.length) * 100;
};

const roundNum = (value, digits = 4) =>
  Number.isFinite(value) ? Number(Number(value).toFixed(digits)) : null;

const directionFromMarketState = (value) => {
  const text = String(value || "").toUpperCase();
  if (!text) return 0;
  if (
    text.includes("BUY") ||
    text.includes("BULL") ||
    text.includes("SUPPORT") ||
    text.includes("LONG")
  ) {
    return 1;
  }
  if (
    text.includes("SELL") ||
    text.includes("BEAR") ||
    text.includes("RESIST") ||
    text.includes("SHORT")
  ) {
    return -1;
  }
  return 0;
};

const computeExecutionPlan = ({
  tone,
  currentPrice,
  supports,
  resistances,
  targetGap,
}) => {
  const entry = Number(currentPrice);
  if (!Number.isFinite(entry) || entry <= 0) return null;

  const nearestSupport = supports[0] ?? null;
  const secondSupport = supports[1] ?? null;
  const nearestResistance = resistances[0] ?? null;
  const secondResistance = resistances[1] ?? null;
  const gapTop =
    Number.isFinite(targetGap?.start) && Number.isFinite(targetGap?.end)
      ? Math.max(Number(targetGap.start), Number(targetGap.end))
      : null;
  const gapBottom =
    Number.isFinite(targetGap?.start) && Number.isFinite(targetGap?.end)
      ? Math.min(Number(targetGap.start), Number(targetGap.end))
      : null;

  if (tone === "buy") {
    const entryMin = Number.isFinite(nearestSupport)
      ? Math.min(entry, nearestSupport * 1.006)
      : entry * 0.996;
    const entryMax = Number.isFinite(nearestSupport)
      ? Math.max(entry, nearestSupport * 1.015)
      : entry * 1.004;
    const stop = Number.isFinite(nearestSupport)
      ? nearestSupport * 0.992
      : entry * 0.972;

    const tp1Candidates = [nearestResistance, gapTop].filter(
      (value) => Number.isFinite(value) && value > entryMax
    );
    const target1 =
      tp1Candidates.length > 0 ? Math.min(...tp1Candidates) : entry + (entryMax - stop) * 1.6;

    const tp2Candidates = [secondResistance, gapTop].filter(
      (value) => Number.isFinite(value) && value > target1
    );
    const target2 =
      tp2Candidates.length > 0 ? Math.min(...tp2Candidates) : target1 + (target1 - entryMax) * 0.9;

    const risk = Math.max(entryMax - stop, 1e-9);
    const rr1 = (target1 - entryMax) / risk;
    const rr2 = (target2 - entryMax) / risk;

    return {
      side: "long",
      entryMin: roundNum(entryMin),
      entryMax: roundNum(entryMax),
      stop: roundNum(stop),
      target1: roundNum(target1),
      target2: roundNum(target2),
      riskReward1: roundNum(rr1, 2),
      riskReward2: roundNum(rr2, 2),
    };
  }

  if (tone === "sell") {
    const entryMin = Number.isFinite(nearestResistance)
      ? Math.min(entry, nearestResistance * 0.985)
      : entry * 0.996;
    const entryMax = Number.isFinite(nearestResistance)
      ? Math.max(entry, nearestResistance * 0.994)
      : entry * 1.004;
    const stop = Number.isFinite(nearestResistance)
      ? nearestResistance * 1.008
      : entry * 1.028;

    const tp1Candidates = [nearestSupport, gapBottom].filter(
      (value) => Number.isFinite(value) && value < entryMin
    );
    const target1 =
      tp1Candidates.length > 0 ? Math.max(...tp1Candidates) : entry - (stop - entryMin) * 1.6;

    const tp2Candidates = [secondSupport, gapBottom].filter(
      (value) => Number.isFinite(value) && value < target1
    );
    const target2 =
      tp2Candidates.length > 0 ? Math.max(...tp2Candidates) : target1 - (entryMin - target1) * 0.9;

    const risk = Math.max(stop - entryMin, 1e-9);
    const rr1 = (entryMin - target1) / risk;
    const rr2 = (entryMin - target2) / risk;

    return {
      side: "short",
      entryMin: roundNum(entryMin),
      entryMax: roundNum(entryMax),
      stop: roundNum(stop),
      target1: roundNum(target1),
      target2: roundNum(target2),
      riskReward1: roundNum(rr1, 2),
      riskReward2: roundNum(rr2, 2),
    };
  }

  return null;
};

export const computeUnifiedTradingSignal = ({
  currentPrice,
  zones1M,
  openGaps,
  currentMedian,
  nextMedian,
  techSummary = null,
  marketState = null,
  gapCloseProbability10 = null,
  useTechFilter = false,
  minTechStrengthForEntry = 55,
}) => {
  const currentPriceRef =
    safeNum(currentPrice) && Number(currentPrice) > 0 ? Number(currentPrice) : null;

  if (!currentPriceRef) {
    return {
      strategyVersion: TRADING_SIGNAL_VERSION,
      label: "Neutro",
      displayLabel: "Neutro",
      tone: "neutral",
      score: 0,
      scorePct: 50,
      confidencePct: 0,
      regime: "Dati insufficienti",
      targetDirection: "none",
      targetGap: null,
      executionPlan: null,
      components: {
        season: 0,
        gap: 0,
        sr: 0,
        tech: 0,
        market: 0,
        bonus: 0,
        consensus: 0,
      },
    };
  }

  const monthEndBuySetup =
    currentMedian !== null && nextMedian !== null && currentMedian < 0 && nextMedian > 0;
  const monthEndSellSetup =
    currentMedian !== null && nextMedian !== null && currentMedian > 0 && nextMedian < 0;

  let seasonDirection = "neutral";
  let seasonScore = 0;
  if (currentMedian !== null && nextMedian !== null) {
    const delta = nextMedian - currentMedian;
    seasonScore = clamp(delta / 10, -1, 1);
    if (delta > 0.15) seasonDirection = "up";
    else if (delta < -0.15) seasonDirection = "down";
  }

  const supports = (zones1M?.support || [])
    .map((item) => Number(item.price))
    .filter((value) => Number.isFinite(value) && value <= currentPriceRef)
    .sort((a, b) => b - a);
  const resistances = (zones1M?.resistance || [])
    .map((item) => Number(item.price))
    .filter((value) => Number.isFinite(value) && value >= currentPriceRef)
    .sort((a, b) => a - b);

  let srScore = 0;
  let trendDirection = "neutral";
  const nearestSupport = supports[0];
  const nearestResistance = resistances[0];
  if (Number.isFinite(nearestSupport) && Number.isFinite(nearestResistance)) {
    const dSupport = Math.max(currentPriceRef - nearestSupport, 0);
    const dResistance = Math.max(nearestResistance - currentPriceRef, 0);
    const denom = dSupport + dResistance;
    // Bullish when price is closer to support than resistance.
    srScore = denom > 0 ? clamp((dResistance - dSupport) / denom, -1, 1) : 0;
    if (srScore > 0.08) trendDirection = "up";
    if (srScore < -0.08) trendDirection = "down";
  } else if (Number.isFinite(nearestSupport)) {
    srScore = 0.35;
    trendDirection = "up";
  } else if (Number.isFinite(nearestResistance)) {
    srScore = -0.35;
    trendDirection = "down";
  }

  let gapScore = 0;
  let targetDirection = "none";
  let targetGap = null;
  if (currentPriceRef && Array.isArray(openGaps) && openGaps.length > 0) {
    const gapsWithCenter = openGaps
      .map((gap) => {
        const start = Number(gap?.start);
        const end = Number(gap?.end);
        const center = (start + end) / 2;
        return {
          ...gap,
          start,
          end,
          center,
          dist: Math.abs(center - currentPriceRef),
        };
      })
      .filter((gap) => Number.isFinite(gap.center));

    const nearestUp =
      gapsWithCenter
        .filter((gap) => gap.center >= currentPriceRef)
        .sort((a, b) => a.dist - b.dist)[0] || null;
    const nearestDown =
      gapsWithCenter
        .filter((gap) => gap.center < currentPriceRef)
        .sort((a, b) => a.dist - b.dist)[0] || null;

    if (trendDirection === "up") {
      targetGap = nearestUp || null;
    } else if (trendDirection === "down") {
      targetGap = nearestDown || null;
    } else {
      targetGap =
        [nearestUp, nearestDown].filter(Boolean).sort((a, b) => a.dist - b.dist)[0] || null;
    }

    if (targetGap && Number.isFinite(targetGap.center)) {
      targetDirection = targetGap.center >= currentPriceRef ? "up" : "down";
      const distancePct = Math.abs(targetGap.center - currentPriceRef) / currentPriceRef * 100;
      const distanceFactor = clamp(1 - distancePct / 9, 0.15, 1);
      gapScore = targetDirection === "up" ? distanceFactor : -distanceFactor;
      if (Number.isFinite(gapCloseProbability10)) {
        const closeProbEdge = clamp((Number(gapCloseProbability10) - 50) / 50, -1, 1);
        const sign = gapScore >= 0 ? 1 : -1;
        gapScore = clamp(gapScore * 0.8 + sign * closeProbEdge * 0.25, -1, 1);
      }
    }
  }

  let techDirection = "neutral";
  let techStrengthPct = null;
  let techScore = 0;
  if (useTechFilter) {
    const techGeneral = String(techSummary?.general || "").toLowerCase();
    const rawTechStrength = safeNum(techSummary?.strength);
    techStrengthPct = rawTechStrength !== null ? clampPct(rawTechStrength * 100) : null;
    const counts = techSummary?.totalCounts || {};
    const buyCount = Number(counts.Buy) || 0;
    const sellCount = Number(counts.Sell) || 0;
    const neutralCount = Number(counts.Neutral) || 0;
    const totalCount = buyCount + sellCount + neutralCount;
    const countDiff =
      totalCount > 0 ? clamp((buyCount - sellCount) / totalCount, -1, 1) : 0;
    const strengthEdge =
      techStrengthPct !== null ? clamp((techStrengthPct - 50) / 45, -1, 1) : 0;

    if (techGeneral.includes("buy")) techDirection = "up";
    else if (techGeneral.includes("sell")) techDirection = "down";
    techScore = clamp(strengthEdge * 0.65 + countDiff * 0.35, -1, 1);
    if (techDirection === "up") techScore = Math.max(techScore, 0.15);
    if (techDirection === "down") techScore = Math.min(techScore, -0.15);
  }

  const marketStrengthPct = clampPct(Number(marketState?.strength) || 0);
  const marketDirection = directionFromMarketState(marketState?.state);
  const marketScore =
    marketDirection === 0 ? 0 : marketDirection * clamp(0.35 + (marketStrengthPct / 100) * 0.65, 0, 1);

  const seasonDenies =
    trendDirection !== "neutral" &&
    seasonDirection !== "neutral" &&
    seasonDirection !== trendDirection;
  const techDenies =
    useTechFilter &&
    trendDirection !== "neutral" &&
    techDirection !== "neutral" &&
    techDirection !== trendDirection;
  const marketDenies =
    trendDirection !== "neutral" &&
    marketDirection !== 0 &&
    ((trendDirection === "up" && marketDirection < 0) ||
      (trendDirection === "down" && marketDirection > 0));

  const longSetup = trendDirection === "up" && targetDirection === "up";
  const shortSetup = trendDirection === "down" && targetDirection === "down";
  const seasonLongOk = seasonDirection !== "down";
  const seasonShortOk = seasonDirection !== "up";
  const techLongOk =
    !useTechFilter ||
    (techDirection !== "down" &&
      (techStrengthPct === null || techStrengthPct >= minTechStrengthForEntry));
  const techShortOk =
    !useTechFilter ||
    (techDirection !== "up" &&
      (techStrengthPct === null || techStrengthPct >= minTechStrengthForEntry));

  let monthEndBonus = 0;
  if (currentMedian !== null && nextMedian !== null) {
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const isMonthEnd = now.getDate() >= daysInMonth - 4;
  if (isMonthEnd && monthEndBuySetup) monthEndBonus = 8;
  if (isMonthEnd && monthEndSellSetup) monthEndBonus = -8;
  }

  const srWeight = useTechFilter ? 0.32 : 0.4;
  const gapWeight = useTechFilter ? 0.23 : 0.25;
  const seasonWeight = useTechFilter ? 0.2 : 0.25;
  const techWeight = useTechFilter ? 0.17 : 0;
  const marketWeight = 0.1;

  let directionalScore =
    srScore * srWeight +
    gapScore * gapWeight +
    seasonScore * seasonWeight +
    techScore * techWeight +
    marketScore * marketWeight;
  if (seasonDenies) directionalScore *= 0.72;
  if (techDenies) directionalScore *= 0.68;
  if (marketDenies) directionalScore *= 0.8;
  directionalScore = clamp(directionalScore, -1, 1);

  let bullishVotes = 0;
  let bearishVotes = 0;
  const addVotes = (value) => {
    const vote = voteStrength(value);
    if (vote === 0) return;
    if (value > 0) bullishVotes += vote;
    if (value < 0) bearishVotes += vote;
  };
  addVotes(srScore);
  addVotes(gapScore);
  addVotes(seasonScore);
  addVotes(marketScore);
  if (useTechFilter) addVotes(techScore);

  const confirmedBuy = longSetup && seasonLongOk && techLongOk;
  const confirmedSell = shortSetup && seasonShortOk && techShortOk;
  const voteDelta = bullishVotes - bearishVotes;
  const totalVotes = bullishVotes + bearishVotes;
  const voteConsensus = totalVotes > 0 ? voteDelta / totalVotes : 0;
  const alignment = totalVotes > 0 ? Math.max(bullishVotes, bearishVotes) / totalVotes : 0;

  let confidencePct = clampPct(
    Math.abs(directionalScore) * 55 + alignment * 25 + (totalVotes > 0 ? 12 : 0)
  );
  if (useTechFilter && Number.isFinite(techStrengthPct)) {
    confidencePct = clampPct(confidencePct + (techStrengthPct - 50) * 0.15);
  }
  if (!targetGap) confidencePct = clampPct(confidencePct - 8);

  const regime =
    Math.abs(directionalScore) >= 0.5
      ? "Trend forte"
      : Math.abs(directionalScore) >= 0.25
      ? "Trend moderato"
      : "Range";

  let buyScore = clampPct(
    50 +
      directionalScore * 40 +
      monthEndBonus +
      voteConsensus * 12 +
      (confidencePct - 50) * 0.15
  );
  if (confirmedBuy) buyScore = clampPct(buyScore + 5);
  if (confirmedSell) buyScore = clampPct(buyScore - 5);

  let label = "Neutro";
  let tone = "neutral";

  if (buyScore >= 76 && confidencePct >= 70 && bullishVotes >= 3 && confirmedBuy) {
    label = "Compra forte";
    tone = "buy";
  } else if (
    buyScore >= 60 &&
    confidencePct >= 56 &&
    bullishVotes >= 2 &&
    (longSetup || seasonLongOk || voteConsensus > 0.2)
  ) {
    label = "Compra";
    tone = "buy";
  } else if (buyScore <= 24 && confidencePct >= 70 && bearishVotes >= 3 && confirmedSell) {
    label = "Vendi forte";
    tone = "sell";
  } else if (
    buyScore <= 40 &&
    confidencePct >= 56 &&
    bearishVotes >= 2 &&
    (shortSetup || seasonShortOk || voteConsensus < -0.2)
  ) {
    label = "Vendi";
    tone = "sell";
  }

  let displayLabel = label;
  if (tone === "buy" && monthEndBuySetup && buyScore >= 62) {
    displayLabel = label === "Compra forte" ? "Compra forte fine mese" : "Compra a fine mese";
  }
  if (tone === "sell" && monthEndSellSetup && buyScore <= 38) {
    displayLabel = label === "Vendi forte" ? "Vendi forte fine mese" : "Vendi fine mese";
  }

  const executionPlan = computeExecutionPlan({
    tone,
    currentPrice: currentPriceRef,
    supports,
    resistances,
    targetGap,
  });

  return {
    strategyVersion: TRADING_SIGNAL_VERSION,
    label,
    displayLabel,
    tone,
    score: directionalScore,
    scorePct: buyScore,
    confidencePct,
    regime,
    targetDirection,
    targetGap,
    executionPlan,
    components: {
      season: seasonScore * 100,
      gap: gapScore * 100,
      sr: srScore * 100,
      tech: useTechFilter ? techScore * 100 : 0,
      market: marketScore * 100,
      bonus: monthEndBonus,
      consensus: voteConsensus * 100,
    },
  };
};

export const applySignalLabelForTimeframe = (rawSignal, timeframe, referenceDate = new Date()) => {
  const signal =
    rawSignal && typeof rawSignal === "object"
      ? rawSignal
      : {
          label: "Neutro",
          displayLabel: "Neutro",
          tone: "neutral",
          confidencePct: 0,
        };

  const baseLabel =
    signal.tone === "buy" ? "Compra" : signal.tone === "sell" ? "Vendi" : "Neutro";

  if (timeframe === "1d") {
    return {
      ...signal,
      label: baseLabel,
      displayLabel: baseLabel,
    };
  }

  if (timeframe === "1w") {
    if (signal.tone === "neutral") {
      return {
        ...signal,
        label: baseLabel,
        displayLabel: baseLabel,
      };
    }

    const day = referenceDate instanceof Date ? referenceDate.getDay() : new Date().getDay();
    const nearWeekEnd = day >= 4;
    const shouldDelayToWeekEnd = !nearWeekEnd && Number(signal.confidencePct) < 72;
    return {
      ...signal,
      label: baseLabel,
      displayLabel: shouldDelayToWeekEnd
        ? signal.tone === "buy"
          ? "Compra a fine settimana"
          : "Vendi a fine settimana"
        : baseLabel,
    };
  }

  return signal;
};

export const computePortfolioTradingSignal = ({
  seasonData,
  monthlyZones,
  currentPrice,
  ohlc,
  marketState = null,
  techSummary = null,
}) => {
  const baseSignal = {
    label: "Neutro",
    displayLabel: "Neutro",
    tone: "neutral",
    scorePct: 50,
    hasData: false,
  };

  const curveByYear = seasonData?.seasonalCurveByYear;
  const years = Array.isArray(seasonData?.years) ? seasonData.years : [];
  const selectedYears = years.length > 0 ? years : Object.keys(curveByYear || {});

  const winsorizedCurve = winsorizeCurve(curveByYear || {});
  const cumulativePercentiles = computeCumulativePercentiles(winsorizedCurve, selectedYears);
  const currentMonthIndex = new Date().getMonth();
  const nextMonthIndex = (currentMonthIndex + 1) % 12;

  const currentMedian = safeNum(cumulativePercentiles?.[currentMonthIndex]?.median);
  const nextMedian = safeNum(cumulativePercentiles?.[nextMonthIndex]?.median);

  const rows = normalizeGapRows(ohlc || []);
  const detectedGaps = findGapsLikePrevisione(rows, 0.01);
  const gapStates = markClosedGapsLikePrevisione(rows, detectedGaps);
  const openGaps = gapStates.filter((gap) => !gap.closed);
  const totalCloseProb10 = gapCloseProbability(rows, gapStates, 10);
  const computed = computeUnifiedTradingSignal({
    currentPrice,
    zones1M: monthlyZones,
    openGaps,
    currentMedian,
    nextMedian,
    marketState,
    gapCloseProbability10: totalCloseProb10,
    techSummary,
    useTechFilter: true,
    minTechStrengthForEntry: 55,
  });
  const currentPriceRef = safeNum(currentPrice) && currentPrice > 0 ? Number(currentPrice) : null;

  return {
    ...baseSignal,
    ...computed,
    hasData: Boolean(currentPriceRef && cumulativePercentiles.length > 0),
  };
};
