import {
  analysisToCsv,
  buildBenchmarkComparison,
  buildDriverRegressionAnalysis,
  buildMultipleRegressionAnalysis,
  buildMonteCarloSimulation,
  buildAdvancedQuantitativeAnalytics,
  buildQuantitativeAnalysis,
} from "./quantitativeAnalytics";

const row = (date, close, extra = {}) => ({ date, close, ...extra });

const historyFromSimpleReturns = (
  returns,
  start = "2025-01-01",
  initialPrice = 100
) => {
  const startTimestamp = Date.parse(`${start}T00:00:00Z`);
  let price = initialPrice;
  const history = [row(start, price)];
  returns.forEach((dailyReturn, index) => {
    price *= 1 + dailyReturn / 100;
    history.push(
      row(
        new Date(startTimestamp + (index + 1) * 86400000)
          .toISOString()
          .slice(0, 10),
        price
      )
    );
  });
  return history;
};

const analyze = (history, options = {}) =>
  buildQuantitativeAnalysis(history, {
    fromDate: history[0]?.date,
    asOf: history[history.length - 1]?.date,
    ...options,
  });

const comparisonFromReturns = (
  benchmarkReturns,
  primaryReturns,
  { frequency = "1d", periodsPerYear = 252, gapBeforeIndex = null } = {}
) => {
  const startTimestamp = Date.parse("2024-01-01T00:00:00Z");
  const makePoints = (values) =>
    values.map((returnPct, index) => {
      const date = new Date(startTimestamp + (index + 1) * 86400000)
        .toISOString()
        .slice(0, 10);
      const previousDate =
        index === gapBeforeIndex
          ? "2000-01-01"
          : new Date(startTimestamp + index * 86400000)
              .toISOString()
              .slice(0, 10);
      return {
        date,
        previousDate,
        returnPct,
        segmentId:
          gapBeforeIndex !== null && index >= gapBeforeIndex ? 1 : 0,
      };
    });
  return buildBenchmarkComparison(
    {
      frequency,
      returnType: "simple",
      periodsPerYear,
      points: makePoints(primaryReturns),
    },
    {
      frequency,
      returnType: "simple",
      periodsPerYear,
      points: makePoints(benchmarkReturns),
    }
  );
};

const regressionAnalysisFromReturns = (
  values,
  {
    frequency = "1d",
    returnType = "simple",
    periodsPerYear = 252,
    priceSource = "adjustedClose",
    start = "2024-01-01",
    segmentForIndex = () => 0,
    previousDateForIndex = null,
  } = {}
) => {
  const startTimestamp = Date.parse(`${start}T00:00:00Z`);
  return {
    frequency,
    returnType,
    periodsPerYear,
    priceSource,
    points: values.map((returnPct, index) => {
      const date = new Date(startTimestamp + (index + 1) * 86400000)
        .toISOString()
        .slice(0, 10);
      const defaultPreviousDate = new Date(startTimestamp + index * 86400000)
        .toISOString()
        .slice(0, 10);
      return {
        date,
        previousDate: previousDateForIndex
          ? previousDateForIndex(index, defaultPreviousDate)
          : defaultPreviousDate,
        returnPct,
        segmentId: segmentForIndex(index),
      };
    }),
  };
};

const runMultipleRegression = (
  target,
  factors,
  options = {}
) =>
  buildMultipleRegressionAnalysis(
    regressionAnalysisFromReturns(target),
    factors.map(({ values, subtractValues, ...definition }) => ({
      ...definition,
      analysis: regressionAnalysisFromReturns(values),
      ...(subtractValues
        ? { subtractAnalysis: regressionAnalysisFromReturns(subtractValues) }
        : {}),
    })),
    options
  );

const multiplyTestMatrices = (left, right) =>
  left.map((row) =>
    right[0].map((_, column) =>
      row.reduce(
        (total, value, index) => total + value * right[index][column],
        0
      )
    )
  );

const inverseThreeByThree = (matrix) => {
  const [[a, b, c], [d, e, f], [g, h, i]] = matrix;
  const determinant =
    a * (e * i - f * h) -
    b * (d * i - f * g) +
    c * (d * h - e * g);
  return [
    [e * i - f * h, c * h - b * i, b * f - c * e],
    [f * g - d * i, a * i - c * g, c * d - a * f],
    [d * h - e * g, b * g - a * h, a * e - b * d],
  ].map((row) => row.map((value) => value / determinant));
};

describe("buildQuantitativeAnalysis - statistiche e code", () => {
  test("calcola quantili R-7, VaR, ES, momenti e robust statistics in percentuale", () => {
    const analysis = analyze(
      historyFromSimpleReturns([-20, -10, 0, 10, 20]),
      { binMethod: "manual", binCount: 5 }
    );

    expect(analysis.observations).toBe(5);
    expect(analysis.mean).toBeCloseTo(0, 10);
    expect(analysis.median).toBeCloseTo(0, 10);
    expect(analysis.variance).toBeCloseTo(250, 10);
    expect(analysis.standardDeviation).toBeCloseTo(Math.sqrt(250), 10);
    expect(analysis.quantiles).toEqual(
      expect.objectContaining({
        p01: expect.any(Number),
        p05: expect.any(Number),
        p25: expect.any(Number),
        p75: expect.any(Number),
        p95: expect.any(Number),
        p99: expect.any(Number),
      })
    );
    expect(analysis.quantiles.p01).toBeCloseTo(-19.6, 10);
    expect(analysis.quantiles.p05).toBeCloseTo(-18, 10);
    expect(analysis.quantiles.p25).toBeCloseTo(-10, 10);
    expect(analysis.quantiles.p75).toBeCloseTo(10, 10);
    expect(analysis.quantiles.p95).toBeCloseTo(18, 10);
    expect(analysis.quantiles.p99).toBeCloseTo(19.6, 10);
    expect(analysis.valueAtRisk.p95).toBeCloseTo(18, 10);
    expect(analysis.valueAtRisk.p99).toBeCloseTo(19.6, 10);
    expect(analysis.expectedShortfall.p95).toBeCloseTo(20, 10);
    expect(analysis.expectedShortfall.p99).toBeCloseTo(20, 10);
    expect(analysis.skewness).toBeCloseTo(0, 10);
    expect(analysis.excessKurtosis).toBeCloseTo(-1.2, 10);
    expect(analysis.iqr).toBeCloseTo(20, 10);
    expect(analysis.mad).toBeCloseTo(10, 10);
    expect(analysis).toMatchObject({
      positiveDays: 2,
      negativeDays: 2,
      flatDays: 1,
      sharePct: { positive: 40, negative: 40, flat: 20 },
    });
    expect(analysis.ecdf).toHaveLength(5);
    expect(analysis.ecdf[4].probabilityPct).toBe(100);
    expect(analysis.qqSeries).toHaveLength(5);
    expect(analysis.qqSeries.every((point) => Number.isFinite(point.theoretical))).toBe(
      true
    );
    expect(analysis.worstDays.map((point) => point.valuePct)).toEqual(
      [...analysis.worstDays.map((point) => point.valuePct)].sort((a, b) => a - b)
    );
  });

  test("istogramma conserva massa, densita e massimo con conteggi normali finiti", () => {
    const analysis = analyze(
      historyFromSimpleReturns([-4, -2, -1, 0, 1, 2, 4, 8]),
      { binMethod: "manual", binCount: 4 }
    );
    const { bins } = analysis.histogram;
    const width = bins[0].end - bins[0].start;

    expect(analysis.histogram.method).toBe("manual");
    expect(bins).toHaveLength(4);
    expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(
      analysis.observations
    );
    expect(bins.reduce((sum, bin) => sum + bin.percentage, 0)).toBeCloseTo(
      100,
      10
    );
    expect(bins.reduce((sum, bin) => sum + bin.density * width, 0)).toBeCloseTo(
      1,
      10
    );
    const expectedNormalMassInVisibleRange = bins.reduce(
      (sum, bin) => sum + bin.normalExpectedCount,
      0
    );
    // La curva normale e integrata solo tra minimo e massimo osservati: le
    // code esterne al dominio visibile non vengono attribuite ai bin estremi.
    expect(expectedNormalMassInVisibleRange).toBeGreaterThan(0);
    expect(expectedNormalMassInVisibleRange).toBeLessThan(
      analysis.observations
    );
    expect(
      bins.every((bin) => Number.isFinite(bin.normalExpectedCount))
    ).toBe(true);
    expect(bins[bins.length - 1].end).toBeGreaterThanOrEqual(analysis.max);
    expect(bins[bins.length - 1].count).toBeGreaterThan(0);
  });

  test("gestisce serie costante e campione con un solo rendimento", () => {
    const constant = analyze(historyFromSimpleReturns([0, 0, 0, 0]));
    const single = analyze(historyFromSimpleReturns([10]));

    expect(constant).toMatchObject({
      variance: 0,
      standardDeviation: 0,
      skewness: null,
      excessKurtosis: null,
    });
    expect(constant.histogram.bins).toHaveLength(1);
    expect(constant.histogram.bins[0]).toMatchObject({
      density: null,
      normalExpectedCount: null,
    });
    expect(single.observations).toBe(1);
    expect(single.variance).toBeNull();
    expect(single.standardDeviation).toBeNull();
    expect(single.skewness).toBeNull();
    expect(single.excessKurtosis).toBeNull();
  });
});

describe("buildQuantitativeAnalysis - metriche avanzate", () => {
  test("calcola downside/upside, omega, gain-loss, tail ratio e z-score", () => {
    const analysis = analyze(
      historyFromSimpleReturns([-4, -1, 0, 2, 3])
    );
    const advanced = analysis.advanced;

    expect(advanced.downsideDeviationPct).toBeCloseTo(Math.sqrt(17 / 5), 10);
    expect(advanced.annualizedDownsideDeviationPct).toBeCloseTo(
      Math.sqrt(17 / 5) * Math.sqrt(252),
      10
    );
    expect(advanced.upsideDeviationPct).toBeCloseTo(Math.sqrt(13 / 5), 10);
    expect(advanced.annualizedUpsideDeviationPct).toBeCloseTo(
      Math.sqrt(13 / 5) * Math.sqrt(252),
      10
    );
    expect(advanced.omegaRatioZero).toBeCloseTo(1, 10);
    expect(advanced.gainLossRatio).toBeCloseTo(1, 10);
    expect(advanced.tailRatio).toBeCloseTo(2.8 / 3.4, 10);
    expect(advanced.lastReturnZScore).toBeCloseTo(3 / Math.sqrt(7.5), 10);
    expect(Number.isFinite(advanced.autocorrelationLag1)).toBe(true);
    expect(Number.isFinite(advanced.squaredReturnAutocorrelationLag1)).toBe(
      true
    );
  });

  test("autocorrelazioni lag-1 non attraversano gap e segmenti", () => {
    const analysis = analyze([
      row("2025-01-01", 100),
      row("2025-01-02", 101),
      row("2025-01-03", 103.02),
      row("2025-01-20", 100),
      row("2025-01-21", 200),
      row("2025-01-22", 402),
    ]);

    expect(analysis.points.map((point) => point.returnPct)).toEqual([
      expect.closeTo(1, 10),
      expect.closeTo(2, 10),
      expect.closeTo(100, 10),
      expect.closeTo(101, 10),
    ]);
    expect(analysis.advanced.autocorrelationLag1).toBeCloseTo(1, 10);
    expect(analysis.advanced.squaredReturnAutocorrelationLag1).toBeCloseTo(
      1,
      10
    );
  });

  test("gestisce serie zero e tutta positiva senza rapporti artificiali", () => {
    const zero = analyze(historyFromSimpleReturns([0, 0, 0]));
    const positive = analyze(historyFromSimpleReturns([1, 2, 3]));

    expect(zero.advanced).toMatchObject({
      downsideDeviationPct: 0,
      annualizedDownsideDeviationPct: 0,
      upsideDeviationPct: 0,
      annualizedUpsideDeviationPct: 0,
      omegaRatioZero: null,
      gainLossRatio: null,
      tailRatio: null,
      autocorrelationLag1: null,
      squaredReturnAutocorrelationLag1: null,
      lastReturnZScore: null,
    });
    expect(positive.advanced.downsideDeviationPct).toBe(0);
    expect(positive.advanced.omegaRatioZero).toBeNull();
    expect(positive.advanced.gainLossRatio).toBeNull();
    expect(positive.advanced.tailRatio).toBeGreaterThan(0);
  });
});

describe("buildQuantitativeAnalysis - percorso, frequenza e qualita", () => {
  test("usa cinque anni di default, il seed precedente e rispetta toDate/asOf", () => {
    const analysis = buildQuantitativeAnalysis(
      [
        row("2020-06-14", 100),
        row("2020-06-15", 110),
        row("2020-06-16", 121),
        row("2025-06-14", 200),
        row("2025-06-15", 220),
        row("2025-06-16", 242),
      ],
      {
        asOf: "2025-06-16",
        toDate: "2025-06-15",
        confidence: 0.99,
      }
    );

    expect(analysis.requestedFirstDate).toBe("2020-06-15");
    expect(analysis.requestedLastDate).toBe("2025-06-15");
    expect(analysis.confidence).toBe(0.99);
    expect(analysis.points.map((point) => point.date)).toEqual([
      "2020-06-15",
      "2020-06-16",
      "2025-06-15",
    ]);
    expect(analysis.points[0].returnPct).toBeCloseTo(10, 10);
    expect(analysis.points.some((point) => point.date === "2025-06-16")).toBe(
      false
    );
    expect(analysis.skippedLongGaps).toBe(1);
    expect(analysis.pathContinuous).toBe(false);
    expect(analysis).toMatchObject({
      cumulativeReturn: null,
      cagr: null,
      maxDrawdown: null,
      cumulativeSeries: [],
      drawdownSeries: [],
    });
  });

  test("non concatena segmenti daily separati da gap o prezzi mancanti", () => {
    const analysis = analyze([
      row("2025-01-01", 100),
      row("2025-01-02", 110),
      row("2025-01-20", 220),
      row("2025-01-21", 242),
      row("2025-01-22", null),
      row("2025-01-23", 266.2),
      row("2025-01-24", 292.82),
    ]);

    expect(analysis.points.map((point) => point.date)).toEqual([
      "2025-01-02",
      "2025-01-21",
      "2025-01-24",
    ]);
    analysis.points.forEach((point) =>
      expect(point.returnPct).toBeCloseTo(10, 10)
    );
    expect(analysis.skippedLongGaps).toBe(1);
    expect(analysis.skippedMissingPairs).toBe(2);
    expect(analysis.pathContinuous).toBe(false);
    expect(analysis.cumulativeReturn).toBeNull();
    expect(analysis.cagr).toBeNull();
    expect(analysis.maxDrawdown).toBeNull();
    expect(analysis.cumulativeSeries).toEqual([]);
    expect(analysis.drawdownSeries).toEqual([]);
    // Anche le finestre rolling non possono attraversare una barriera.
    expect(new Set(analysis.points.map((point) => point.segmentId)).size).toBe(3);
  });

  test("distingue rendimento semplice e logaritmico senza alterare la crescita", () => {
    const history = [
      row("2025-01-01", 100),
      row("2025-01-02", 110),
      row("2025-01-03", 99),
    ];
    const simple = analyze(history, { returnType: "simple" });
    const logarithmic = analyze(history, { returnType: "log" });

    expect(simple.points[0].returnPct).toBeCloseTo(10, 10);
    expect(simple.points[1].returnPct).toBeCloseTo(-10, 10);
    expect(logarithmic.points[0].returnPct).toBeCloseTo(
      Math.log(1.1) * 100,
      10
    );
    expect(logarithmic.points[1].returnPct).toBeCloseTo(
      Math.log(0.9) * 100,
      10
    );
    expect(simple.cumulativeReturn).toBeCloseTo(-1, 10);
    expect(logarithmic.cumulativeReturn).toBeCloseTo(-1, 10);
  });

  test("calcola cumulative path e massimo drawdown con picco, minimo e recupero", () => {
    const analysis = analyze([
      row("2025-01-01", 100),
      row("2025-01-02", 120),
      row("2025-01-03", 90),
      row("2025-01-04", 108),
      row("2025-01-05", 130),
    ]);

    expect(analysis.cumulativeReturn).toBeCloseTo(30, 10);
    expect(analysis.cumulativeSeries.map((point) => point.valuePct)).toEqual([
      expect.closeTo(20, 10),
      expect.closeTo(-10, 10),
      expect.closeTo(8, 10),
      expect.closeTo(30, 10),
    ]);
    expect(analysis.drawdownSeries.map((point) => point.valuePct)).toEqual([
      expect.closeTo(0, 10),
      expect.closeTo(-25, 10),
      expect.closeTo(-10, 10),
      expect.closeTo(0, 10),
    ]);
    expect(analysis.maxDrawdown).toBeCloseTo(-25, 10);
    expect(analysis.maxDrawdownPeakDate).toBe("2025-01-02");
    expect(analysis.maxDrawdownDate).toBe("2025-01-03");
    expect(analysis.maxDrawdownRecoveryDate).toBe("2025-01-05");
  });

  test("rolling volatility usa finestre e annualizzazione coerenti", () => {
    const returns = Array.from({ length: 21 }, () => 1);
    const analysis = analyze(historyFromSimpleReturns(returns));
    const expectedCumulative = ((1.01 ** 21) - 1) * 100;
    const expectedCagr =
      ((1 + expectedCumulative / 100) ** (365.25 / 21) - 1) * 100;

    expect(analysis.periodsPerYear).toBe(252);
    expect(analysis.rollingWindows).toEqual({ short: 20, medium: 60, long: 252 });
    expect(analysis.rollingVolatility.short).toHaveLength(2);
    expect(analysis.rollingVolatility.short[0].valuePct).toBeCloseTo(0, 8);
    expect(analysis.rollingVolatility.medium).toEqual([]);
    expect(analysis.rollingVolatility.long).toEqual([]);
    expect(analysis.cumulativeReturn).toBeCloseTo(expectedCumulative, 8);
    expect(analysis.cagr).toBeCloseTo(expectedCagr, 8);
  });

  test("resampling settimanale e mensile usa l'ultimo prezzo del periodo", () => {
    const weekly = buildQuantitativeAnalysis(
      [
        row("2025-01-06", 100),
        row("2025-01-08", 105),
        row("2025-01-10", 110),
        row("2025-01-13", 115),
        row("2025-01-17", 121),
      ],
      {
        fromDate: "2025-01-06",
        asOf: "2025-01-17",
        frequency: "1wk",
      }
    );
    const monthly = buildQuantitativeAnalysis(
      [
        row("2025-01-02", 100),
        row("2025-01-31", 110),
        row("2025-02-03", 115),
        row("2025-02-28", 121),
      ],
      {
        fromDate: "2025-01-01",
        asOf: "2025-02-28",
        frequency: "1mo",
      }
    );

    expect(weekly.points).toHaveLength(1);
    expect(weekly.points[0].date).toBe("2025-01-17");
    expect(weekly.points[0].returnPct).toBeCloseTo(10, 10);
    expect(weekly.periodsPerYear).toBe(52);
    expect(weekly.rollingWindows).toEqual({ short: 4, medium: 13, long: 52 });
    expect(monthly.points).toHaveLength(1);
    expect(monthly.points[0].date).toBe("2025-02-28");
    expect(monthly.points[0].returnPct).toBeCloseTo(10, 10);
    expect(monthly.periodsPerYear).toBe(12);
    expect(monthly.rollingWindows).toEqual({ short: 3, medium: 6, long: 12 });
  });

  test("settimanale e mensile escludono e censiscono periodi non consecutivi", () => {
    const weekly = buildQuantitativeAnalysis(
      [
        row("2025-01-06", 100),
        row("2025-01-13", 110),
        row("2025-01-27", 121),
        row("2025-02-03", 133.1),
      ],
      {
        fromDate: "2025-01-06",
        asOf: "2025-02-03",
        frequency: "1wk",
      }
    );
    const monthly = buildQuantitativeAnalysis(
      [
        row("2025-01-31", 100),
        row("2025-02-28", 110),
        row("2025-04-30", 121),
        row("2025-05-31", 133.1),
      ],
      {
        fromDate: "2025-01-01",
        asOf: "2025-05-31",
        frequency: "1mo",
      }
    );

    [weekly, monthly].forEach((analysis) => {
      expect(analysis.points).toHaveLength(2);
      analysis.points.forEach((point) =>
        expect(point.returnPct).toBeCloseTo(10, 10)
      );
      expect(analysis.skippedLongGaps).toBe(1);
      expect(analysis.quality.returnsExcludedForGap).toBe(1);
      expect(analysis.pathContinuous).toBe(false);
      expect(analysis.cumulativeReturn).toBeNull();
      expect(analysis.cagr).toBeNull();
      expect(analysis.maxDrawdown).toBeNull();
      expect(analysis.cumulativeSeries).toEqual([]);
      expect(analysis.drawdownSeries).toEqual([]);
    });
  });

  test("auto usa adjusted globalmente e una copertura parziale spezza il percorso", () => {
    const history = [
      row("2025-01-01", 100, { rawClose: 100, adjustedClose: 50 }),
      row("2025-01-02", 50, { rawClose: 50, adjustedClose: 50 }),
      row("2025-01-03", 55, { rawClose: 55, adjustedClose: null }),
    ];
    const automatic = analyze(history, { priceMode: "auto" });
    const close = analyze(history, { priceMode: "close" });
    const adjusted = analyze(history, { priceMode: "adjusted" });
    const completeAdjusted = analyze(
      [
        row("2025-02-01", 100, { adjustedClose: 50 }),
        row("2025-02-02", 110, { adjustedClose: 60 }),
        row("2025-02-03", 121, { adjustedClose: 72 }),
      ],
      { priceMode: "auto" }
    );

    expect(automatic.priceSource).toBe("adjustedClose");
    expect(automatic.points).toHaveLength(1);
    expect(automatic.points[0].returnPct).toBeCloseTo(0, 10);
    expect(automatic.skippedMissingPairs).toBe(1);
    expect(automatic.pathContinuous).toBe(false);
    expect(automatic.cumulativeReturn).toBeNull();
    expect(automatic.points.map((point) => point.returnPct)).not.toContain(-50);
    expect(automatic.points.map((point) => point.returnPct)).not.toContain(10);
    expect(close.points[0].returnPct).toBeCloseTo(-50, 10);
    expect(close.points[1].returnPct).toBeCloseTo(10, 10);
    expect(close.cumulativeReturn).toBeCloseTo(-45, 10);
    expect(adjusted.priceSource).toBe("adjustedClose");
    expect(adjusted.points).toHaveLength(1);
    expect(adjusted.points[0].returnPct).toBeCloseTo(0, 10);
    expect(adjusted.fallbackCount).toBe(0);
    expect(automatic.quality.adjustedCoveragePct).toBeCloseTo(200 / 3, 10);
    expect(completeAdjusted.priceSource).toBe("adjustedClose");
    expect(completeAdjusted.adjustedCount).toBe(2);
    expect(completeAdjusted.points[0].returnPct).toBeCloseTo(20, 10);
    expect(completeAdjusted.points[1].returnPct).toBeCloseTo(20, 10);
  });

  test("auto usa close solo quando la copertura adjusted e zero", () => {
    const automatic = analyze(
      [
        row("2025-03-03", 100.2, { rawClose: 100 }),
        row("2025-03-04", 109.8, { rawClose: 110 }),
        row("2025-03-05", 121, { rawClose: 121 }),
      ],
      { priceMode: "auto" }
    );

    expect(automatic.priceSource).toBe("close");
    expect(automatic.points).toHaveLength(2);
    automatic.points.forEach((point) =>
      expect(point.returnPct).toBeCloseTo(10, 10)
    );
    expect(automatic.adjustedCount).toBe(0);
    expect(automatic.fallbackCount).toBe(2);
    expect(automatic.quality.adjustedCoveragePct).toBe(0);
  });

  test("il valore adjusted mancante a fine periodo non viene retro-riempito", () => {
    const weekly = analyze(
      [
        row("2025-01-06", 100, { adjustedClose: 50 }),
        row("2025-01-10", 102, { adjustedClose: null }),
        row("2025-01-17", 110, { adjustedClose: 55 }),
        row("2025-01-24", 121, { adjustedClose: 60.5 }),
      ],
      { frequency: "1wk", priceMode: "auto" }
    );

    expect(weekly.priceSource).toBe("adjustedClose");
    expect(weekly.points).toHaveLength(1);
    expect(weekly.points[0].date).toBe("2025-01-24");
    expect(weekly.points[0].returnPct).toBeCloseTo(10, 10);
    expect(weekly.skippedMissingPairs).toBe(1);
    expect(weekly.pathContinuous).toBe(false);
  });

  test("dedup valido, barrier invalida, UTC e gap daily alimentano quality", () => {
    const analysis = buildQuantitativeAnalysis(
      [
        row("not-a-date", 999),
        row("2025-01-01T23:30:00-05:00", 100),
        row("2025-01-02", null),
        row("2025-01-03", 110),
        row("2025-01-04", null),
        row("2025-01-05", 121),
        row("2025-01-20", 133.1),
        row("2025-01-21", 146.41),
      ],
      { fromDate: "2025-01-01", asOf: "2025-01-21" }
    );

    // The invalid duplicate on normalized 2025-01-02 cannot erase its valid row.
    expect(analysis.points.map((point) => point.date)).toEqual([
      "2025-01-03",
      "2025-01-21",
    ]);
    expect(analysis.skippedLongGaps).toBe(1);
    expect(analysis.quality).toMatchObject({
      inputRows: 8,
      normalizedRows: 6,
      invalidRows: 1,
      duplicateRows: 1,
      priceMissingRows: 2,
      returnsExcludedForGap: 1,
    });
  });
});

describe("benchmark comparison ed export", () => {
  test("allinea esclusivamente le date comuni e calcola metriche relative", () => {
    const primary = {
      frequency: "1d",
      periodsPerYear: 252,
      returnType: "simple",
      points: [
        { date: "2025-01-02", previousDate: "2025-01-01", returnPct: 10 },
        { date: "2025-01-03", previousDate: "2025-01-02", returnPct: 999 },
        { date: "2025-01-04", previousDate: "2025-01-03", returnPct: 20 },
        { date: "2025-01-05", previousDate: "2025-01-04", returnPct: -10 },
      ],
    };
    const benchmark = {
      frequency: "1d",
      periodsPerYear: 252,
      returnType: "simple",
      points: [
        { date: "2025-01-02", previousDate: "2025-01-01", returnPct: 5 },
        { date: "2025-01-04", previousDate: "2025-01-03", returnPct: 10 },
        { date: "2025-01-05", previousDate: "2025-01-04", returnPct: -5 },
        { date: "2025-01-06", previousDate: "2025-01-05", returnPct: 888 },
      ],
    };
    const comparison = buildBenchmarkComparison(primary, benchmark);
    const active = [5, 10, -5];
    const activeMean = active.reduce((sum, value) => sum + value, 0) / 3;
    const activeVariance = active.reduce(
      (sum, value) => sum + (value - activeMean) ** 2,
      0
    ) / 2;
    const expectedTrackingError = Math.sqrt(activeVariance) * Math.sqrt(252);

    expect(comparison.observations).toBe(3);
    expect(comparison.beta).toBeCloseTo(2, 10);
    expect(comparison.alphaAnnualized).toBeCloseTo(0, 10);
    expect(comparison.correlation).toBeCloseTo(1, 10);
    expect(comparison.rSquared).toBeCloseTo(1, 10);
    expect(comparison.trackingError).toBeCloseTo(expectedTrackingError, 10);
    expect(comparison.informationRatio).toBeCloseTo(
      (activeMean * 252) / expectedTrackingError,
      10
    );
    expect(comparison.captureMethod).toBe(
      "geometric_annualized_conditional"
    );
    expect(comparison.upsideCapture).toBe(
      comparison.capture.upside.ratioPct
    );
    expect(comparison.downsideCapture).toBe(
      comparison.capture.downside.ratioPct
    );
    expect(comparison.capture.upside.observations).toBe(2);
    expect(comparison.capture.downside.observations).toBe(1);
    expect(comparison.activeReturnAnnualized).toBeCloseTo(activeMean * 252, 10);
    expect(comparison.scatterSeries).toEqual([
      { x: 5, y: 10, date: "2025-01-02" },
      { x: 10, y: 20, date: "2025-01-04" },
      { x: -5, y: -10, date: "2025-01-05" },
    ]);
    // Jan 2 -> Jan 4 non e una catena di intervalli: le statistiche statiche
    // restano valide, ma i rendimenti non devono essere composti nel tempo.
    expect(comparison.pathContinuous).toBe(false);
    expect(comparison.pathGapCount).toBe(1);
    expect(comparison.pathCaveat).toContain("intervalli comuni");
    expect(comparison.cumulativeSeries).toEqual([]);
    expect(
      buildBenchmarkComparison(primary, {
        points: [{ date: "2025-01-02", returnPct: 5 }],
      })
    ).toBeNull();
  });

  test("non confronta rendimenti con stessa data finale ma intervalli diversi", () => {
    const primary = {
      periodsPerYear: 252,
      points: [
        {
          date: "2025-01-03",
          previousDate: "2025-01-02",
          returnPct: 10,
        },
        {
          date: "2025-01-04",
          previousDate: "2025-01-03",
          returnPct: 4,
        },
        {
          date: "2025-01-05",
          previousDate: "2025-01-04",
          returnPct: -2,
        },
      ],
    };
    const benchmark = {
      periodsPerYear: 252,
      points: [
        {
          date: "2025-01-03",
          previousDate: "2025-01-01",
          returnPct: 5,
        },
        {
          date: "2025-01-04",
          previousDate: "2025-01-03",
          returnPct: 2,
        },
        {
          date: "2025-01-05",
          previousDate: "2025-01-04",
          returnPct: -1,
        },
      ],
    };

    const comparison = buildBenchmarkComparison(primary, benchmark);

    expect(comparison.observations).toBe(2);
    expect(comparison.scatterSeries.map((point) => point.date)).toEqual([
      "2025-01-04",
      "2025-01-05",
    ]);
    expect(comparison.pathContinuous).toBe(true);
    expect(comparison.pathGapCount).toBe(0);
    expect(comparison.pathCaveat).toBeNull();
    expect(comparison.cumulativeSeries).toHaveLength(2);
    expect(comparison.cumulativeSeries[1].primaryPct).toBeCloseTo(1.92, 10);
    expect(comparison.cumulativeSeries[1].benchmarkPct).toBeCloseTo(0.98, 10);
  });

  test("rifiuta metadati incompatibili e intervalli senza previousDate verificabile", () => {
    const points = [
      {
        date: "2025-01-02",
        previousDate: "2025-01-01",
        returnPct: 1,
      },
      {
        date: "2025-01-03",
        previousDate: "2025-01-02",
        returnPct: 2,
      },
    ];
    const daily = {
      frequency: "1d",
      returnType: "simple",
      periodsPerYear: 252,
      points,
    };

    expect(
      buildBenchmarkComparison(daily, { ...daily, frequency: "1wk" })
    ).toBeNull();
    expect(
      buildBenchmarkComparison(daily, { ...daily, returnType: "log" })
    ).toBeNull();
    expect(
      buildBenchmarkComparison(daily, { ...daily, periodsPerYear: 365 })
    ).toBeNull();
    expect(
      buildBenchmarkComparison(daily, { ...daily, frequency: "invalid" })
    ).toBeNull();
    expect(
      buildBenchmarkComparison(
        { ...daily, priceSource: "adjustedClose" },
        { ...daily, priceSource: "close" }
      )
    ).toBeNull();
    expect(
      buildBenchmarkComparison(daily, { ...daily, priceSource: null })
    ).not.toBeNull();
    expect(
      buildBenchmarkComparison(daily, {
        ...daily,
        points: points.map(({ previousDate, ...point }) => point),
      })
    ).toBeNull();

    const segmentBreak = buildBenchmarkComparison(
      {
        ...daily,
        points: points.map((point, index) => ({
          ...point,
          segmentId: index,
        })),
      },
      {
        ...daily,
        points: points.map((point) => ({ ...point, segmentId: 4 })),
      }
    );
    expect(segmentBreak.pathContinuous).toBe(false);
    expect(segmentBreak.pathGapCount).toBe(1);
    expect(segmentBreak.cumulativeSeries).toEqual([]);
  });

  test("capture usa rendimenti geometrici annualizzati condizionali e ne espone l'audit", () => {
    const makePoint = (date, previousDate, returnPct) => ({
      date,
      previousDate,
      returnPct,
    });
    const primary = {
      frequency: "1mo",
      returnType: "simple",
      periodsPerYear: 12,
      points: [
        makePoint("2025-01-31", "2024-12-31", 1.5),
        makePoint("2025-02-28", "2025-01-31", 3),
        makePoint("2025-03-31", "2025-02-28", -0.5),
        makePoint("2025-04-30", "2025-03-31", -1.5),
      ],
    };
    const benchmark = {
      ...primary,
      points: [
        makePoint("2025-01-31", "2024-12-31", 1),
        makePoint("2025-02-28", "2025-01-31", 2),
        makePoint("2025-03-31", "2025-02-28", -1),
        makePoint("2025-04-30", "2025-03-31", -2),
      ],
    };
    const comparison = buildBenchmarkComparison(primary, benchmark);
    const annualize = (growth, observations) =>
      (growth ** (12 / observations) - 1) * 100;
    const expectedUpsidePrimary = annualize(1.015 * 1.03, 2);
    const expectedUpsideBenchmark = annualize(1.01 * 1.02, 2);
    const expectedDownsidePrimary = annualize(0.995 * 0.985, 2);
    const expectedDownsideBenchmark = annualize(0.99 * 0.98, 2);

    expect(comparison.capture).toMatchObject({
      periodsPerYear: 12,
      upside: { observations: 2 },
      downside: { observations: 2 },
    });
    expect(comparison.capture.definition).toContain("geometrici annualizzati");
    expect(comparison.capture.upside.primaryAnnualizedPct).toBeCloseTo(
      expectedUpsidePrimary,
      10
    );
    expect(comparison.capture.upside.benchmarkAnnualizedPct).toBeCloseTo(
      expectedUpsideBenchmark,
      10
    );
    expect(comparison.upsideCapture).toBeCloseTo(
      (expectedUpsidePrimary / expectedUpsideBenchmark) * 100,
      10
    );
    expect(comparison.capture.downside.primaryAnnualizedPct).toBeCloseTo(
      expectedDownsidePrimary,
      10
    );
    expect(comparison.capture.downside.benchmarkAnnualizedPct).toBeCloseTo(
      expectedDownsideBenchmark,
      10
    );
    expect(comparison.downsideCapture).toBeCloseTo(
      (expectedDownsidePrimary / expectedDownsideBenchmark) * 100,
      10
    );
  });

  test("regressione OLS riconcilia beta, alpha e R2 su relazione perfetta", () => {
    const benchmark = [-3, -2, -1, 0, 1, 2, 3];
    const primary = benchmark.map((value) => 1 + 2 * value);
    const comparison = comparisonFromReturns(benchmark, primary);
    const regression = comparison.regression;

    expect(regression).toMatchObject({
      method: "ols-newey-west",
      observations: 7,
      degreesOfFreedom: 5,
      slope: 2,
      interceptPct: 1,
      interceptAnnualizedPct: 252,
      rSquared: 1,
      adjustedRSquared: 1,
      residualStandardErrorPct: 0,
      rmsePct: 0,
      maePct: 0,
      sampleAdequacy: "limited",
    });
    expect(comparison.beta).toBe(regression.slope);
    expect(comparison.alphaAnnualized).toBe(
      regression.interceptAnnualizedPct
    );
    expect(comparison.rSquared).toBe(regression.rSquared);
    expect(regression.fittedSeries).toHaveLength(7);
    regression.fittedSeries.forEach((point) => {
      expect(point.fitted).toBeCloseTo(point.y, 12);
      expect(point.residual).toBeCloseTo(0, 12);
      expect(point.standardizedResidual).toBeNull();
    });
    expect(regression.lineSeries).toEqual([
      { x: -3, y: -5 },
      { x: 3, y: 7 },
    ]);
    expect(regression.standardErrors).toEqual({
      slopeHac: null,
      interceptHacPct: null,
      slopeOls: null,
      interceptOlsPct: null,
    });
    expect(regression.confidence95).toEqual({
      slope: null,
      interceptPct: null,
    });
    expect(regression.confidenceBand).toEqual([]);
    expect(regression.warnings.join(" ")).toContain("varianza residua");
    expect(JSON.stringify(regression)).not.toMatch(/NaN|Infinity/);
  });

  test("HAC Newey-West produce SE, test, CI, residui e diagnostica finiti", () => {
    const benchmark = [-4, -3, -2, -1, 0, 1, 2, 3, 4, 5];
    const noise = [0.5, -0.2, 0.1, -0.4, 0.3, -0.1, 0.2, -0.3, 0.4, -0.5];
    const primary = benchmark.map(
      (value, index) => 0.75 + 1.4 * value + noise[index]
    );
    const comparison = comparisonFromReturns(benchmark, primary);
    const regression = comparison.regression;
    const xMean = benchmark.reduce((sum, value) => sum + value, 0) /
      benchmark.length;
    const yMean = primary.reduce((sum, value) => sum + value, 0) /
      primary.length;
    const expectedSlope = benchmark.reduce(
      (sum, value, index) =>
        sum + (value - xMean) * (primary[index] - yMean),
      0
    ) / benchmark.reduce((sum, value) => sum + (value - xMean) ** 2, 0);
    const expectedIntercept = yMean - expectedSlope * xMean;

    expect(regression.slope).toBeCloseTo(expectedSlope, 12);
    expect(regression.interceptPct).toBeCloseTo(expectedIntercept, 12);
    expect(regression.neweyWestLag).toBe(
      Math.floor(4 * (benchmark.length / 100) ** (2 / 9))
    );
    Object.values(regression.standardErrors).forEach((value) => {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    });
    // Valori di riferimento ricomputati con la definizione sandwich HAC
    // Bartlett/Newey-West senza correzione small-sample.
    expect(regression.standardErrors.slopeHac).toBeCloseTo(0.0241575, 7);
    expect(regression.standardErrors.interceptHacPct).toBeCloseTo(
      0.07136163,
      7
    );
    expect(regression.standardErrors.slopeOls).toBeCloseTo(0.03915076, 7);
    expect(regression.standardErrors.interceptOlsPct).toBeCloseTo(
      0.11414311,
      7
    );
    Object.values(regression.zStatistics).forEach((value) =>
      expect(Number.isFinite(value)).toBe(true)
    );
    Object.values(regression.pValues).forEach((value) => {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    });
    expect(regression.confidence95.slope[0]).toBeLessThan(regression.slope);
    expect(regression.confidence95.slope[1]).toBeGreaterThan(regression.slope);
    expect(regression.confidence95.interceptPct[0]).toBeLessThan(
      regression.interceptPct
    );
    expect(regression.confidence95.interceptPct[1]).toBeGreaterThan(
      regression.interceptPct
    );
    expect(regression.confidenceBand).toHaveLength(41);
    regression.confidenceBand.forEach((point) => {
      expect(point.lower).toBeLessThanOrEqual(point.upper);
      expect(Number.isFinite(point.x)).toBe(true);
    });
    expect(regression.diagnostics.durbinWatson).toBeGreaterThanOrEqual(0);
    expect(regression.diagnostics.durbinWatson).toBeCloseTo(3.028939285, 8);
    expect(Number.isFinite(regression.diagnostics.autocorrelationLag1)).toBe(
      true
    );
    expect(Number.isFinite(regression.diagnostics.jarqueBera)).toBe(true);
    expect(regression.diagnostics.jarqueBera).toBeCloseTo(0.840165694, 8);
    expect(regression.diagnostics.jarqueBeraPValue).toBeGreaterThanOrEqual(0);
    expect(regression.diagnostics.jarqueBeraPValue).toBeLessThanOrEqual(1);
    expect(regression.diagnostics.jarqueBeraPValue).toBeCloseTo(
      0.656992388,
      8
    );
    expect(Number.isFinite(regression.diagnostics.residualSkewness)).toBe(true);
    expect(
      Number.isFinite(regression.diagnostics.residualExcessKurtosis)
    ).toBe(true);
    expect(regression.diagnostics.outlierCount).toBeGreaterThanOrEqual(0);
    expect(regression.fittedSeries).toHaveLength(benchmark.length);
    expect(JSON.stringify(regression)).not.toMatch(/NaN|Infinity/);
  });

  test("standardizza i residui correggendo la leverage e conta gli outlier", () => {
    const benchmark = [0, -3, 3, -2, 2, -1, 1];
    const leadingResidual = Math.sqrt(48);
    const pairAdjustment = 1;
    const residuals = [
      leadingResidual,
      -leadingResidual / 6 + pairAdjustment,
      -leadingResidual / 6 + pairAdjustment,
      -leadingResidual / 6 - pairAdjustment,
      -leadingResidual / 6 - pairAdjustment,
      -leadingResidual / 6,
      -leadingResidual / 6,
    ];
    const primary = benchmark.map(
      (value, index) => value + residuals[index]
    );
    const regression = comparisonFromReturns(benchmark, primary).regression;

    expect(
      Math.abs(regression.fittedSeries[0].standardizedResidual)
    ).toBeCloseTo(2 / Math.sqrt(6 / 7), 12);
    expect(regression.diagnostics.outlierCount).toBe(1);
  });

  test("non sottoclassifica un outlier ad alta leverage", () => {
    const benchmark = [
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
      10, 11, 12, 13, 14, 15, 16, 17, 18, 100,
    ];
    const noise = [
      -0.6517911526116896,
      -0.17471729232577715,
      1.6637239913911968,
      0.659147749832255,
      -1.6413972945846467,
      -0.005203264171931977,
      -0.6234637409883934,
      0.14863152325202633,
      -1.608187784186389,
      0.2417718768768513,
      0.23538091873745476,
      1.5756260314314627,
      0.3166450164719021,
      0.5105466616976417,
      -1.4931166849642326,
      2.2527291247240275,
      -1.9156455579583005,
      1.1018018558224842,
      -0.3299040738738497,
      -0.8806465179277969,
    ];
    const primary = benchmark.map(
      (value, index) => 1 + 2 * value + noise[index]
    );
    const regression = comparisonFromReturns(benchmark, primary).regression;

    expect(regression.residualStandardErrorPct).toBeCloseTo(
      1.173525161777818,
      12
    );
    expect(regression.fittedSeries[15].standardizedResidual).toBeCloseTo(
      2.007201777538203,
      12
    );
    expect(regression.diagnostics.outlierCount).toBe(1);
  });

  test("regressione e inferenza restano null con campione o benchmark degeneri", () => {
    const constantBenchmark = comparisonFromReturns(
      [1, 1, 1, 1],
      [1, 2, 3, 4]
    );
    const twoObservations = comparisonFromReturns([1, 2], [2, 4]);

    expect(constantBenchmark.beta).toBeNull();
    expect(constantBenchmark.regression).toBeNull();
    expect(twoObservations.regression).toBeNull();
  });

  test("rolling e diagnostica seriale non attraversano interruzioni", () => {
    const benchmark = Array.from(
      { length: 125 },
      (_, index) => ((index % 11) - 5) / 10 + index * 0.001
    );
    const primary = benchmark.map(
      (value, index) => 0.2 + 1.3 * value + Math.sin(index) * 0.03
    );
    const comparison = comparisonFromReturns(benchmark, primary, {
      gapBeforeIndex: 62,
    });
    const regression = comparison.regression;
    const startTimestamp = Date.parse("2024-01-01T00:00:00Z");
    const expectedIndexes = [59, 60, 61, 121, 122, 123, 124];
    const expectedDates = expectedIndexes.map((index) =>
      new Date(startTimestamp + (index + 1) * 86400000)
        .toISOString()
        .slice(0, 10)
    );

    expect(comparison.pathGapCount).toBe(1);
    expect(regression.rolling.window).toBe(60);
    expect(regression.rolling.series.map((point) => point.date)).toEqual(
      expectedDates
    );
    expect(regression.diagnostics.continuousTransitions).toBe(123);
    expect(regression.warnings.join(" ")).toContain("non attraversano i gap");
    expect(Number.isFinite(regression.standardErrors.slopeHac)).toBe(true);
    expect(Number.isFinite(regression.diagnostics.durbinWatson)).toBe(true);
  });

  test("rolling adatta la finestra a frequenza settimanale e mensile", () => {
    const buildValues = (length) => {
      const benchmark = Array.from(
        { length },
        (_, index) => ((index % 7) - 3) * 0.2 + index * 0.001
      );
      return {
        benchmark,
        primary: benchmark.map(
          (value, index) => 0.1 + 0.8 * value + Math.cos(index) * 0.02
        ),
      };
    };
    const weeklyValues = buildValues(27);
    const monthlyValues = buildValues(13);
    const weekly = comparisonFromReturns(
      weeklyValues.benchmark,
      weeklyValues.primary,
      { frequency: "1wk", periodsPerYear: 52 }
    ).regression;
    const monthly = comparisonFromReturns(
      monthlyValues.benchmark,
      monthlyValues.primary,
      { frequency: "1mo", periodsPerYear: 12 }
    ).regression;

    expect(weekly.rolling.window).toBe(26);
    expect(weekly.rolling.series).toHaveLength(2);
    expect(monthly.rolling.window).toBe(12);
    expect(monthly.rolling.series).toHaveLength(2);
  });

  test("analysisToCsv esporta ogni rendimento e gestisce ticker da quotare", () => {
    const analysis = analyze(historyFromSimpleReturns([10, -10, 5]));
    const csv = analysisToCsv(analysis, "ACME,INC");
    const lines = csv.split("\n");

    expect(lines[0]).toBe(
      "ticker,date,return_pct,cumulative_return_pct,drawdown_pct,rolling_volatility_short_pct,rolling_volatility_medium_pct,rolling_volatility_long_pct"
    );
    expect(lines).toHaveLength(analysis.observations + 1);
    expect(lines[1]).toContain('"ACME,INC",2025-01-02,');
    expect(csv).not.toContain("undefined");
    expect(csv).not.toContain("NaN");
  });
});

describe("buildMultipleRegressionAnalysis", () => {
  const completeSpecs = [
    { key: "market_only", label: "Mercato", predictorKeys: ["market"] },
    { key: "size_only", label: "Size", predictorKeys: ["size"] },
    {
      key: "full",
      label: "Mercato + Size",
      predictorKeys: ["market", "size"],
    },
  ];

  test("stima coefficienti multipli esatti e riconcilia fitted e contributi", () => {
    const market = [-4, -3, -2, -1, 0, 1, 2, 3, 4, 5];
    const size = [2, -1, 3, -2, 0, 1, -3, 2.5, -1.5, 4];
    const target = market.map(
      (value, index) => 0.5 + 1.5 * value - 0.75 * size[index]
    );
    const result = runMultipleRegression(
      target,
      [
        { key: "market", label: "Mercato", sourceTicker: "SPY", values: market },
        { key: "size", label: "Size", sourceTicker: "IWM", values: size },
      ],
      { modelSpecs: completeSpecs, fullModelKey: "full" }
    );

    expect(result).toMatchObject({
      method: "ols-multiple-newey-west",
      observations: 10,
      predictorCount: 2,
      degreesOfFreedom: 7,
      periodsPerYear: 252,
      firstDate: "2024-01-02",
      lastDate: "2024-01-11",
      rSquared: 1,
      adjustedRSquared: 1,
      residualStandardErrorPct: 0,
    });
    expect(result.rmsePct).toBeCloseTo(0, 12);
    expect(result.maePct).toBeCloseTo(0, 12);
    expect(result.intercept.estimatePct).toBeCloseTo(0.5, 12);
    expect(result.intercept.annualizedPct).toBeCloseTo(126, 12);
    expect(result.intercept.seHacPct).toBeNull();
    expect(result.coefficients[0]).toMatchObject({
      key: "market",
      estimate: 1.5,
    });
    expect(result.coefficients[1]).toMatchObject({
      key: "size",
      estimate: -0.75,
    });
    expect(result.diagnostics.rank).toBe(3);
    expect(result.diagnostics.conditionNumber).toBeGreaterThanOrEqual(1);
    result.fittedSeries.forEach((point) => {
      const reconciled =
        result.intercept.estimatePct +
        Object.values(point.contributions).reduce(
          (total, contribution) => total + contribution,
          0
        );
      expect(point.fittedPct).toBeCloseTo(point.observedPct, 11);
      expect(reconciled).toBeCloseTo(point.fittedPct, 11);
      expect(point.standardizedResidual).toBeNull();
      expect(point.factorValues).toEqual({
        market: expect.any(Number),
        size: expect.any(Number),
      });
    });
    expect(result.modelComparisons).toHaveLength(3);
    expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/);
  });

  test("fixture rumorosa riconcilia OLS, HAC, CI e metriche gaussiane", () => {
    const market = [-4, -3, -2, -1, 0, 1, 2, 3, 4, 5, -2.5, 1.5];
    const size = [2, -1, 3, -2, 0, 1, -3, 2.5, -1.5, 4, 0.5, -2.5];
    const noise = [0.2, -0.1, 0.3, -0.25, 0.15, -0.05, 0.1, -0.2, 0.25, -0.15, 0.05, -0.3];
    const target = market.map(
      (value, index) => 0.4 + 1.2 * value - 0.65 * size[index] + noise[index]
    );
    const result = runMultipleRegression(
      target,
      [
        { key: "market", label: "Mercato", sourceTicker: "SPY", values: market },
        { key: "size", label: "Size", sourceTicker: "IWM", values: size },
      ],
      { modelSpecs: completeSpecs, fullModelKey: "full" }
    );

    const x1Mean = market.reduce((sum, value) => sum + value, 0) / market.length;
    const x2Mean = size.reduce((sum, value) => sum + value, 0) / size.length;
    const yMean = target.reduce((sum, value) => sum + value, 0) / target.length;
    const centered = market.map((value, index) => ({
      x1: value - x1Mean,
      x2: size[index] - x2Mean,
      y: target[index] - yMean,
    }));
    const s11 = centered.reduce((sum, point) => sum + point.x1 ** 2, 0);
    const s22 = centered.reduce((sum, point) => sum + point.x2 ** 2, 0);
    const s12 = centered.reduce((sum, point) => sum + point.x1 * point.x2, 0);
    const sy1 = centered.reduce((sum, point) => sum + point.y * point.x1, 0);
    const sy2 = centered.reduce((sum, point) => sum + point.y * point.x2, 0);
    const determinant = s11 * s22 - s12 ** 2;
    const expectedMarket = (sy1 * s22 - sy2 * s12) / determinant;
    const expectedSize = (sy2 * s11 - sy1 * s12) / determinant;
    const expectedIntercept = yMean - expectedMarket * x1Mean - expectedSize * x2Mean;

    expect(result.intercept.estimatePct).toBeCloseTo(expectedIntercept, 12);
    expect(result.coefficients[0].estimate).toBeCloseTo(expectedMarket, 12);
    expect(result.coefficients[1].estimate).toBeCloseTo(expectedSize, 12);
    expect(result.neweyWestLag).toBe(
      Math.floor(4 * (target.length / 100) ** (2 / 9))
    );
    const design = market.map((value, index) => [1, value, size[index]]);
    const transpose = design[0].map((_, column) =>
      design.map((row) => row[column])
    );
    const inverseGram = inverseThreeByThree(
      multiplyTestMatrices(transpose, design)
    );
    const residuals = target.map(
      (value, index) =>
        value -
        expectedIntercept -
        expectedMarket * market[index] -
        expectedSize * size[index]
    );
    const scores = design.map((row, index) =>
      row.map((value) => value * residuals[index])
    );
    const meat = Array.from({ length: 3 }, () => Array(3).fill(0));
    scores.forEach((score) => {
      for (let left = 0; left < 3; left += 1) {
        for (let right = 0; right < 3; right += 1) {
          meat[left][right] += score[left] * score[right];
        }
      }
    });
    for (let lag = 1; lag <= result.neweyWestLag; lag += 1) {
      const weight = 1 - lag / (result.neweyWestLag + 1);
      for (let index = lag; index < scores.length; index += 1) {
        for (let left = 0; left < 3; left += 1) {
          for (let right = 0; right < 3; right += 1) {
            meat[left][right] +=
              weight *
              (scores[index][left] * scores[index - lag][right] +
                scores[index - lag][left] * scores[index][right]);
          }
        }
      }
    }
    const referenceHac = multiplyTestMatrices(
      multiplyTestMatrices(inverseGram, meat),
      inverseGram
    );
    expect(result.intercept.seHacPct).toBeCloseTo(
      Math.sqrt(referenceHac[0][0]),
      10
    );
    expect(result.coefficients[0].seHac).toBeCloseTo(
      Math.sqrt(referenceHac[1][1]),
      10
    );
    expect(result.coefficients[1].seHac).toBeCloseTo(
      Math.sqrt(referenceHac[2][2]),
      10
    );
    expect(result.intercept.seHacPct).toBeGreaterThan(0);
    expect(result.intercept.seOlsPct).toBeGreaterThan(0);
    result.coefficients.forEach((coefficient) => {
      expect(coefficient.seHac).toBeGreaterThan(0);
      expect(coefficient.seOls).toBeGreaterThan(0);
      expect(coefficient.pValue).toBeGreaterThanOrEqual(0);
      expect(coefficient.pValue).toBeLessThanOrEqual(1);
      expect(coefficient.confidence95[0]).toBeLessThan(coefficient.estimate);
      expect(coefficient.confidence95[1]).toBeGreaterThan(coefficient.estimate);
      expect(coefficient.incrementalRSquared).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(coefficient.incrementalAdjustedRSquared)).toBe(true);
    });
    expect(result.aic).not.toBeNull();
    expect(result.bic).not.toBeNull();
    expect(result.diagnostics.durbinWatson).toBeGreaterThanOrEqual(0);
    expect(result.diagnostics.jarqueBeraPValue).toBeGreaterThanOrEqual(0);
    expect(result.diagnostics.jarqueBeraPValue).toBeLessThanOrEqual(1);
    const reordered = runMultipleRegression(
      target,
      [
        { key: "size", label: "Size", sourceTicker: "IWM", values: size },
        { key: "market", label: "Mercato", sourceTicker: "SPY", values: market },
      ],
      {
        modelSpecs: [
          { key: "size_only", label: "Size", predictorKeys: ["size"] },
          { key: "market_only", label: "Mercato", predictorKeys: ["market"] },
          {
            key: "full",
            label: "Size + Mercato",
            predictorKeys: ["size", "market"],
          },
        ],
        fullModelKey: "full",
      }
    );
    const byKey = (analysis) =>
      new Map(analysis.coefficients.map((coefficient) => [coefficient.key, coefficient]));
    const originalByKey = byKey(result);
    const reorderedByKey = byKey(reordered);
    ["market", "size"].forEach((key) => {
      expect(reorderedByKey.get(key).estimate).toBeCloseTo(
        originalByKey.get(key).estimate,
        12
      );
      expect(reorderedByKey.get(key).incrementalRSquared).toBeCloseTo(
        originalByKey.get(key).incrementalRSquared,
        12
      );
      expect(reorderedByKey.get(key).incrementalAdjustedRSquared).toBeCloseTo(
        originalByKey.get(key).incrementalAdjustedRSquared,
        12
      );
    });
    expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/);
  });

  test("calcola VIF e segnala multicollinearita senza alterare l'ordine", () => {
    const market = Array.from({ length: 40 }, (_, index) => index - 19.5);
    const size = market.map(
      (value, index) => value + (index % 2 === 0 ? -0.01 : 0.01)
    );
    const target = market.map(
      (value, index) => 0.2 + 1.4 * value - 0.6 * size[index] + Math.sin(index) * 0.05
    );
    const result = runMultipleRegression(
      target,
      [
        { key: "market", label: "Mercato", sourceTicker: "SPY", values: market },
        { key: "size", label: "Size", sourceTicker: "IWM", values: size },
      ],
      { modelSpecs: completeSpecs, fullModelKey: "full" }
    );

    expect(result.coefficients.map((coefficient) => coefficient.key)).toEqual([
      "market",
      "size",
    ]);
    result.coefficients.forEach((coefficient) =>
      expect(coefficient.vif).toBeGreaterThan(1000)
    );
    expect(result.diagnostics.maxVif).toBeGreaterThan(1000);
    expect(result.diagnostics.conditionNumber).toBeGreaterThan(30);
    expect(result.warnings.join(" ")).toMatch(/Multicollinearita|condizionata/);
  });

  test("tutti i modelli annidati usano lo stesso campione common-case", () => {
    const market = [-4, -3, -2, -1, 0, 1, 2, 3, 4, 5];
    const size = [2, -1, 3, -2, 0, 1, -3, 2.5, -1.5, 4];
    const target = market.map(
      (value, index) => 0.3 + 0.8 * value + 0.4 * size[index] + Math.sin(index) * 0.02
    );
    const targetAnalysis = regressionAnalysisFromReturns(target);
    const marketAnalysis = regressionAnalysisFromReturns(market);
    const sizeAnalysis = regressionAnalysisFromReturns(size);
    sizeAnalysis.points = sizeAnalysis.points.slice(2);
    const result = buildMultipleRegressionAnalysis(
      targetAnalysis,
      [
        { key: "market", label: "Mercato", sourceTicker: "SPY", analysis: marketAnalysis },
        { key: "size", label: "Size", sourceTicker: "IWM", analysis: sizeAnalysis },
      ],
      { modelSpecs: completeSpecs, fullModelKey: "full" }
    );

    expect(result.observations).toBe(8);
    expect(result.firstDate).toBe("2024-01-04");
    expect(result.lastDate).toBe("2024-01-11");
    result.modelComparisons.forEach((model) => {
      expect(model.observations).toBe(8);
      expect(model.firstDate).toBe(result.firstDate);
      expect(model.lastDate).toBe(result.lastDate);
    });
  });

  test("fattori long-short sottraggono il rendimento e conservano i metadata", () => {
    const market = [-3, -2, -1, 0, 1, 2, 3, 4];
    const sector = [1, -1, 0.5, -0.5, 0.2, -0.2, 0.7, -0.7];
    const source = market.map((value, index) => value + sector[index]);
    const longShort = source.map((value, index) => value - sector[index]);
    const target = longShort.map((value) => 0.25 + 1.75 * value);
    const result = runMultipleRegression(target, [
      {
        key: "relative_market",
        label: "Mercato relativo",
        sourceTicker: "SPY",
        subtractTicker: "XLK",
        values: source,
        subtractValues: sector,
      },
    ]);

    expect(result.intercept.estimatePct).toBeCloseTo(0.25, 12);
    expect(result.coefficients[0].estimate).toBeCloseTo(1.75, 12);
    expect(result.factors[0]).toEqual({
      key: "relative_market",
      label: "Mercato relativo",
      sourceTicker: "SPY",
      subtractTicker: "XLK",
    });
    expect(result.coefficients[0].vif).toBe(1);
  });

  test("HAC e diagnostica seriale non attraversano segmenti o gap", () => {
    const length = 40;
    const market = Array.from(
      { length },
      (_, index) => ((index % 9) - 4) * 0.3 + index * 0.002
    );
    const size = Array.from(
      { length },
      (_, index) => Math.sin(index * 0.7) + index * 0.001
    );
    const target = market.map(
      (value, index) => 0.1 + 1.1 * value - 0.4 * size[index] + Math.cos(index) * 0.04
    );
    const segmented = (values) =>
      regressionAnalysisFromReturns(values, {
        segmentForIndex: (index) => Math.floor(index / 2),
      });
    const result = buildMultipleRegressionAnalysis(
      segmented(target),
      [
        { key: "market", label: "Mercato", sourceTicker: "SPY", analysis: segmented(market) },
        { key: "size", label: "Size", sourceTicker: "IWM", analysis: segmented(size) },
      ],
      { modelSpecs: completeSpecs, fullModelKey: "full" }
    );

    expect(result.diagnostics.pathGapCount).toBe(19);
    expect(result.diagnostics.continuousTransitions).toBe(20);
    expect(result.neweyWestLag).toBe(1);
    expect(result.warnings.join(" ")).toContain("non attraversano i gap");
    expect(result.coefficients.every((coefficient) => coefficient.seHac > 0)).toBe(true);
    expect(result.fittedSeries[0]).toMatchObject({
      date: "2024-01-02",
      previousDate: "2024-01-01",
      gapBefore: false,
    });
    expect(result.fittedSeries[1].gapBefore).toBe(false);
    expect(result.fittedSeries[2]).toMatchObject({
      date: "2024-01-04",
      previousDate: "2024-01-03",
      gapBefore: true,
    });
    expect(
      result.fittedSeries.filter((point) => point.gapBefore)
    ).toHaveLength(result.diagnostics.pathGapCount);
  });

  test("rifiuta metadata o price source misti e richiede intervalli verificabili", () => {
    const target = regressionAnalysisFromReturns([1, 2, 3, 4, 5]);
    const source = regressionAnalysisFromReturns([0, 1, 0, 1, 0]);
    const mismatchedPrice = regressionAnalysisFromReturns([1, 0, 1, 0, 1], {
      priceSource: "close",
    });
    const mismatchedFrequency = regressionAnalysisFromReturns([1, 0, 1, 0, 1], {
      frequency: "1wk",
      periodsPerYear: 52,
    });
    expect(
      buildMultipleRegressionAnalysis(target, [
        { key: "mixed", label: "Misto", analysis: mismatchedPrice },
      ])
    ).toBeNull();
    expect(
      buildMultipleRegressionAnalysis(target, [
        { key: "mixed", label: "Misto", analysis: mismatchedFrequency },
      ])
    ).toBeNull();

    source.points[2] = { ...source.points[2], previousDate: "1999-01-01" };
    const aligned = buildMultipleRegressionAnalysis(target, [
      { key: "source", label: "Source", analysis: source },
    ]);
    expect(aligned.observations).toBe(4);
    expect(aligned.fittedSeries.map((point) => point.date)).not.toContain(
      "2024-01-04"
    );
  });

  test("fail-closed su singolarita, df non positivi e input non finiti", () => {
    const base = [-2, -1, 0, 1, 2, 3];
    const target = base.map((value) => 1 + value);
    const singular = runMultipleRegression(
      target,
      [
        { key: "one", label: "Uno", values: base },
        { key: "two", label: "Due", values: base.map((value) => value * 2) },
      ],
      {
        modelSpecs: [
          { key: "full", label: "Full", predictorKeys: ["one", "two"] },
        ],
        fullModelKey: "full",
      }
    );
    expect(singular).toBeNull();

    const noDf = runMultipleRegression(
      [1, 2, 3],
      [
        { key: "one", label: "Uno", values: [0, 1, 2] },
        { key: "two", label: "Due", values: [1, 0, 1] },
      ],
      {
        modelSpecs: [
          { key: "full", label: "Full", predictorKeys: ["one", "two"] },
        ],
        fullModelKey: "full",
      }
    );
    expect(noDf).toBeNull();
    expect(buildMultipleRegressionAnalysis(null, [])).toBeNull();
  });

  test("residui internamente standardizzati rilevano un outlier ad alta leverage", () => {
    const market = Array.from({ length: 30 }, (_, index) =>
      index === 29 ? 100 : index
    );
    const size = Array.from({ length: 30 }, (_, index) =>
      Math.sin(index * 0.8)
    );
    const target = market.map(
      (value, index) =>
        0.2 +
        1.1 * value -
        0.5 * size[index] +
        Math.cos(index * 1.3) * 0.15 +
        (index === 29 ? 5 : 0)
    );
    const result = runMultipleRegression(
      target,
      [
        { key: "market", label: "Mercato", sourceTicker: "SPY", values: market },
        { key: "size", label: "Size", sourceTicker: "IWM", values: size },
      ],
      { modelSpecs: completeSpecs, fullModelKey: "full" }
    );
    const leveragePoint = result.fittedSeries[29];

    expect(Math.abs(leveragePoint.standardizedResidual)).toBeGreaterThan(2);
    expect(result.diagnostics.outlierCount).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/);
  });

  test("regressione driver usa volumi, dinamica e stagionalita senza look-ahead", () => {
    const history = [];
    let price = 100;
    let day = new Date("2025-01-02T00:00:00Z");
    while (history.length < 90) {
      const weekday = day.getUTCDay();
      if (weekday !== 0 && weekday !== 6) {
        price *= 1 + (Math.sin(history.length * 0.37) * 0.6) / 100;
        history.push(row(day.toISOString().slice(0, 10), price, { volume: 1000000 + history.length * 5000 }));
      }
      day = new Date(day.getTime() + 86400000);
    }
    const result = buildDriverRegressionAnalysis(history, { ticker: "TEST", asOf: history.at(-1).date, years: 1 });
    expect(result?.modelFamily).toBe("drivers");
    expect(result?.factors.map((factor) => factor.key)).toEqual(expect.arrayContaining(["momentum20", "volatility20", "monthSin", "monthCos"]));
    expect(result?.observations).toBeGreaterThan(30);
    expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/);
  });

  test("Monte Carlo bootstrap storico è riproducibile e produce metriche finite", () => {
    const returns = Array.from({ length: 120 }, (_, index) => Math.sin(index * 0.41) * 1.4 + 0.08);
    const history = historyFromSimpleReturns(returns);
    const analysis = analyze(history);
    const result = buildMonteCarloSimulation(analysis, { horizon: 21, pathCount: 300, seed: 42 });
    const repeat = buildMonteCarloSimulation(analysis, { horizon: 21, pathCount: 300, seed: 42 });

    expect(result.method).toBe("historical-bootstrap");
    expect(result.paths).toHaveLength(80);
    expect(result.terminalValues).toHaveLength(300);
    expect(result.histogram).toHaveLength(24);
    expect(result.terminalValues).toEqual(repeat.terminalValues);
    expect(result.positiveProbability).toBeGreaterThanOrEqual(0);
    expect(result.positiveProbability).toBeLessThanOrEqual(1);
    expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/);
  });

  test("motore avanzato produce backtest, walk-forward e rischio senza valori non finiti", () => {
    const returns = Array.from({ length: 180 }, (_, index) => Math.sin(index * 0.27) * 0.9 + 0.05);
    const analysis = analyze(historyFromSimpleReturns(returns));
    const result = buildAdvancedQuantitativeAnalytics(analysis, analysis);
    expect(result.backtest.strategies).toHaveLength(3);
    expect(result.validation.walkForward).toHaveLength(3);
    expect(result.risk.historicalVaR95).not.toBeNull();
    expect(result.dependence.autocorrelationLag1).not.toBeNull();
    expect(result.portfolio.metrics).not.toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/);
  });
});
