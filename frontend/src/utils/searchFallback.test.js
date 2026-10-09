import {
  buildFallbackTickerData,
  buildPerformanceHistoryFromOhlc,
  getNonEmptyHistory,
  mergeDailyQuoteIntoHistory,
  reconcileTickerPrice,
} from "./searchFallback";

const history = [
  { date: "2026-07-24 10:00", open: 310, high: 320, low: 308, close: 318 },
  { date: "2026-07-24 14:00", open: 318, high: 323, low: 316, close: 321 },
];

test("mantiene soltanto candele OHLC finite", () => {
  expect(
    getNonEmptyHistory({
      history: [...history, { date: "2026-07-25", open: 1, high: 2, low: 1, close: null }],
    })
  ).toEqual(history);
});

test("costruisce una sola chiusura giornaliera dalle barre intraday", () => {
  expect(buildPerformanceHistoryFromOhlc(history)).toEqual([
    { date: "2026-07-24", close: 321 },
  ]);
});

test("unisce prezzo e storico senza perdere i dati completi in cache", () => {
  const result = buildFallbackTickerData({
    symbol: "TSLA",
    cachedData: {
      info: { shortName: "Tesla", sector: "Auto", marketCap: 100 },
      performance: { return1Y: 12 },
      risk: { level: "Medio", index: 45, metrics: {} },
    },
    priceData: { info: { currentPrice: 321 } },
    history,
  });

  expect(result.info).toMatchObject({
    shortName: "Tesla",
    sector: "Auto",
    marketCap: 100,
    currentPrice: 321,
  });
  expect(result.ohlc).toHaveLength(2);
  expect(result.performance.return1Y).toBe(12);
  expect(result.risk.index).toBe(45);
});

test("usa l'ultima chiusura quando il prezzo della risposta è più vecchio", () => {
  const result = reconcileTickerPrice({
    info: {
      currentPrice: 319.69,
      priceDate: "2026-07-23",
      dailyChange: -14.52,
    },
    ohlc: [
      {
        date: "2026-07-23",
        open: 341,
        high: 342.11,
        low: 315.73,
        close: 319.69,
      },
      {
        date: "2026-07-24",
        open: 320.72,
        high: 322.96,
        low: 306.51,
        close: 313.03,
      },
    ],
  });

  expect(result.info).toMatchObject({
    currentPrice: 313.03,
    previousClose: 319.69,
    dailyChange: -2.08,
    priceDate: "2026-07-24",
    priceSource: "history",
  });
});

test("aggiunge la nuova seduta senza sovrascrivere quella precedente", () => {
  const result = mergeDailyQuoteIntoHistory(
    [
      {
        date: "2026-07-23",
        open: 341,
        high: 342.11,
        low: 315.73,
        close: 319.69,
      },
    ],
    {
      currentPrice: 313.03,
      dailyOpen: 320.72,
      dailyHigh: 322.96,
      dailyLow: 306.51,
      priceDate: "2026-07-24",
    }
  );

  expect(result).toHaveLength(2);
  expect(result[0].close).toBe(319.69);
  expect(result[1]).toEqual({
    date: "2026-07-24",
    open: 320.72,
    high: 322.96,
    low: 306.51,
    close: 313.03,
  });
});

test("ignora prezzi nulli, non finiti o uguali a zero", () => {
  const onlyValidCandle = [
    { date: "2026-07-24", open: 100, high: 105, low: 99, close: 103 },
  ];

  [null, 0, Number.NaN, Number.POSITIVE_INFINITY].forEach((invalidPrice) => {
    const result = reconcileTickerPrice({
      info: { currentPrice: invalidPrice, priceDate: "2026-07-25" },
      ohlc: onlyValidCandle,
    });
    expect(result.info.currentPrice).toBe(103);
  });
});
