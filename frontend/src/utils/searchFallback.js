const finiteNumber = (value) => {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const finitePrice = (value) => {
  const numeric = finiteNumber(value);
  return numeric != null && numeric > 0 ? numeric : null;
};

const datePart = (value) =>
  typeof value === "string" && value ? value.slice(0, 10) : "";

export const getNonEmptyHistory = (payload) => {
  const history = Array.isArray(payload?.history) ? payload.history : [];
  const byTimestamp = new Map();

  history.forEach((point) => {
    if (!point || typeof point.date !== "string" || !point.date) return false;
    const normalized = {};
    const isValid = ["open", "high", "low", "close"].every((key) => {
      const value = finitePrice(point[key]);
      if (value == null) return false;
      normalized[key] = value;
      return true;
    });
    if (!isValid) return;
    byTimestamp.set(point.date, { ...point, ...normalized });
  });

  return Array.from(byTimestamp.values()).sort((a, b) =>
    a.date.localeCompare(b.date)
  );
};

export const buildPerformanceHistoryFromOhlc = (history) => {
  const byDate = new Map();
  getNonEmptyHistory({ history }).forEach((point) => {
    const date = datePart(point?.date);
    const close = finitePrice(point?.close);
    if (date && close != null) {
      byDate.set(date, { date, close });
    }
  });
  return Array.from(byDate.values());
};

export const reconcileTickerPrice = (tickerData) => {
  const source =
    tickerData && typeof tickerData === "object" ? tickerData : {};
  const history = getNonEmptyHistory({ history: source.ohlc });
  const info =
    source.info && typeof source.info === "object" ? { ...source.info } : {};
  const lastCandle = history[history.length - 1] || null;
  const lastDate = datePart(lastCandle?.date);
  const infoDate =
    datePart(info.priceDate) || datePart(info.priceTimestamp);
  const infoPrice = finitePrice(info.currentPrice);
  const historyPrice = finitePrice(lastCandle?.close);
  const shouldUseHistory =
    historyPrice != null
    && (
      infoPrice == null
      || !infoDate
      || (lastDate && infoDate < lastDate)
    );

  if (shouldUseHistory) {
    const dailyCloses = buildPerformanceHistoryFromOhlc(history);
    const previousClose =
      finitePrice(dailyCloses[dailyCloses.length - 2]?.close);
    info.currentPrice = historyPrice;
    info.dailyOpen = finitePrice(lastCandle.open);
    info.dailyHigh = finitePrice(lastCandle.high);
    info.dailyLow = finitePrice(lastCandle.low);
    info.previousClose = previousClose;
    info.dailyChange =
      previousClose != null
        ? Number((((historyPrice - previousClose) / previousClose) * 100).toFixed(2))
        : null;
    info.priceDate = lastDate;
    info.priceTimestamp = lastCandle.date;
    info.priceSource = "history";
  } else if (infoPrice != null) {
    info.currentPrice = infoPrice;
  }

  return {
    ...source,
    info,
    ohlc: history,
  };
};

export const mergeDailyQuoteIntoHistory = (history, info) => {
  const normalizedHistory = getNonEmptyHistory({ history });
  const price = finitePrice(info?.currentPrice);
  const priceDate =
    datePart(info?.priceDate) || datePart(info?.priceTimestamp);
  if (price == null || !priceDate) return normalizedHistory;

  const lastCandle = normalizedHistory[normalizedHistory.length - 1];
  const lastDate = datePart(lastCandle?.date);
  if (lastDate && priceDate < lastDate) return normalizedHistory;

  const open = finitePrice(info?.dailyOpen) ?? price;
  const reportedHigh = finitePrice(info?.dailyHigh) ?? price;
  const reportedLow = finitePrice(info?.dailyLow) ?? price;
  const quoteCandle = {
    date: priceDate,
    open,
    high: Math.max(reportedHigh, open, price),
    low: Math.min(reportedLow, open, price),
    close: price,
  };

  if (lastDate === priceDate) {
    const previousHigh = finitePrice(lastCandle.high) ?? quoteCandle.high;
    const previousLow = finitePrice(lastCandle.low) ?? quoteCandle.low;
    return [
      ...normalizedHistory.slice(0, -1),
      {
        ...lastCandle,
        ...quoteCandle,
        open: finitePrice(lastCandle.open) ?? quoteCandle.open,
        high: Math.max(previousHigh, quoteCandle.high),
        low: Math.min(previousLow, quoteCandle.low),
      },
    ];
  }

  return [...normalizedHistory, quoteCandle];
};

export const buildFallbackTickerData = ({
  symbol,
  cachedData,
  priceData,
  history,
}) => {
  const cached = cachedData && typeof cachedData === "object" ? cachedData : {};
  const networkHistory = getNonEmptyHistory({ history });
  const cachedHistory = getNonEmptyHistory({ history: cached.ohlc });
  const resolvedHistory = networkHistory.length ? networkHistory : cachedHistory;
  const lastCandle = resolvedHistory[resolvedHistory.length - 1] || {};
  const previousInfo = cached.info && typeof cached.info === "object" ? cached.info : {};
  const liveInfo =
    priceData?.info && typeof priceData.info === "object" ? priceData.info : {};
  const currentPrice =
    finitePrice(liveInfo.currentPrice) ?? finitePrice(lastCandle.close);

  const cachedPerformanceHistory = Array.isArray(cached.performanceHistory)
    ? cached.performanceHistory.filter(
        (point) =>
          typeof point?.date === "string" && finiteNumber(point?.close) != null
      )
    : [];

  return reconcileTickerPrice({
    ...cached,
    info: {
      shortName: previousInfo.shortName || symbol,
      sector: previousInfo.sector || "N/A",
      ...previousInfo,
      ...liveInfo,
      ...(currentPrice != null ? { currentPrice } : {}),
    },
    ohlc: resolvedHistory,
    performanceHistory: cachedPerformanceHistory.length
      ? cachedPerformanceHistory
      : buildPerformanceHistoryFromOhlc(resolvedHistory),
    performance: cached.performance || {},
    risk: cached.risk || { level: "N/D", index: null, metrics: {} },
    partial: true,
  });
};
