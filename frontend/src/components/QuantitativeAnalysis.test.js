import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import QuantitativeAnalysis, {
  buildDailyReturnDistribution,
  buildDailyReturnSeries,
  buildMultipleFactorPlan,
  buildQuantitativeCsvExport,
  fetchMultipleProxyHistories,
  resolveQuantitativeTab,
  resolveRegressionModel,
} from "./QuantitativeAnalysis";

jest.mock("react-chartjs-2", () => {
  const ReactModule = require("react");
  const ChartStub = ReactModule.forwardRef(({ role, "aria-label": ariaLabel }, ref) => (
    <div ref={ref} role={role || "img"} aria-label={ariaLabel} data-chart-stub="true" />
  ));
  return { Bar: ChartStub, Line: ChartStub, Scatter: ChartStub };
});

const row = (date, close, extra = {}) => ({ date, close, ...extra });

describe("distribuzione dei rendimenti percentuali giornalieri", () => {
  test("calcola correttamente rendimenti consecutivi del +10% e -10%", () => {
    const analysis = buildDailyReturnDistribution([
      row("2025-01-02", 100),
      row("2025-01-03", 110),
      row("2025-01-06", 99),
    ]);

    expect(analysis.observations).toBe(2);
    expect(analysis.points).toHaveLength(2);
    expect(analysis.points[0]).toMatchObject({
      date: "2025-01-03",
      usedAdjustedClose: false,
    });
    expect(analysis.points[0].returnPct).toBeCloseTo(10, 10);
    expect(analysis.points[1]).toMatchObject({
      date: "2025-01-06",
      usedAdjustedClose: false,
    });
    expect(analysis.points[1].returnPct).toBeCloseTo(-10, 10);
    expect(analysis.mean).toBeCloseTo(0, 10);
    expect(analysis.median).toBeCloseTo(0, 10);
    expect(analysis.min).toBeCloseTo(-10, 10);
    expect(analysis.max).toBeCloseTo(10, 10);
    // Varianza campionaria: [(-10 - 0)^2 + (10 - 0)^2] / (2 - 1).
    // I rendimenti sono espressi in %, quindi variance e in %^2 e std in %.
    expect(analysis.variance).toBeCloseTo(200, 10);
    expect(analysis.standardDeviation).toBeCloseTo(Math.sqrt(200), 10);
    expect(analysis.standardDeviation ** 2).toBeCloseTo(
      analysis.variance,
      10
    );
  });

  test("assegna tutti i rendimenti ai bin, incluso il valore massimo", () => {
    const history = [row("2025-01-01", 100)];
    for (let index = 1; index <= 50; index += 1) {
      const previousClose = history[history.length - 1].close;
      history.push(
        row(
          new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
          previousClose * (1 + index / 1000)
        )
      );
    }

    const options = { asOf: "2025-02-20T12:00:00Z" };
    const analysis = buildDailyReturnDistribution(history, options);
    const dailySeries = buildDailyReturnSeries(history, options);
    const bins = analysis.histogram.bins;
    const total = bins.reduce((sum, bin) => sum + bin.count, 0);
    const percentageTotal = bins.reduce(
      (sum, bin) => sum + bin.percentage,
      0
    );
    const lastBin = bins[bins.length - 1];

    expect(analysis.observations).toBe(50);
    expect(total).toBe(analysis.observations);
    expect(total).toBe(dailySeries.length);
    expect(percentageTotal).toBeCloseTo(100, 10);
    expect(analysis.max).toBeCloseTo(5, 10);
    expect(lastBin.end).toBeGreaterThanOrEqual(analysis.max);
    expect(lastBin.count).toBeGreaterThan(0);
  });

  test("usa il close precedente al cutoff per il primo rendimento della finestra di cinque anni", () => {
    const analysis = buildDailyReturnDistribution(
      [
        row("2020-06-14", 100),
        row("2020-06-15", 110),
        row("2020-06-16", 121),
        row("2025-06-13", 200),
        row("2025-06-14", 210),
        row("2025-06-15", 231),
      ],
      { asOf: "2025-06-15" }
    );

    expect(analysis.points.map((point) => point.date)).toEqual([
      "2020-06-15",
      "2020-06-16",
      "2025-06-14",
      "2025-06-15",
    ]);
    expect(analysis.points[0].returnPct).toBeCloseTo(10, 10);
    expect(analysis.firstDate).toBe("2020-06-15");
    expect(analysis.lastDate).toBe("2025-06-15");
    expect(analysis.requestedFirstDate).toBe("2020-06-15");
    expect(analysis.requestedLastDate).toBe("2025-06-15");
    expect(analysis.observations).toBe(4);
    expect(analysis.skippedLongGaps).toBe(1);
  });

  test("ancora il range alla data corrente richiesta e non all'ultima quotazione", () => {
    const analysis = buildDailyReturnDistribution(
      [
        row("2021-08-13", 100),
        row("2021-08-14", 110),
        row("2021-08-15", 121),
        row("2025-06-15", 150),
      ],
      { asOf: "2026-08-14" }
    );

    expect(analysis.requestedFirstDate).toBe("2021-08-14");
    expect(analysis.requestedLastDate).toBe("2026-08-14");
    expect(analysis.points.map((point) => point.date)).toEqual([
      "2021-08-14",
      "2021-08-15",
    ]);
  });

  test("una riga con data valida ma chiusura invalida spezza l'adiacenza", () => {
    const analysis = buildDailyReturnDistribution([
      row("2025-01-02", 100),
      row("2025-01-03", null),
      row("2025-01-04", 121),
      row("2025-01-05", 133.1),
      row("data-non-valida", 110),
    ]);

    expect(analysis.observations).toBe(1);
    expect(analysis.points).toHaveLength(1);
    expect(analysis.points[0].date).toBe("2025-01-05");
    expect(analysis.points[0].returnPct).toBeCloseTo(10, 10);
  });

  test("un duplicato invalido non sovrascrive la chiusura valida dello stesso giorno", () => {
    const analysis = buildDailyReturnDistribution([
      row("2025-01-02", 100),
      row("2025-01-02", null),
      row("2025-01-03", 110),
    ]);

    expect(analysis.observations).toBe(1);
    expect(analysis.points[0].returnPct).toBeCloseTo(10, 10);
  });

  test("se adjustedClose è parziale mantiene la serie adjusted e spezza gli intervalli mancanti", () => {
    const analysis = buildDailyReturnDistribution([
      row("2025-01-02", 100, { adjustedClose: 50 }),
      row("2025-01-03", 110, { adjustedClose: 55 }),
      row("2025-01-06", 121),
      row("2025-01-07", 133.1, { adjustedClose: 66.55 }),
    ]);

    expect(analysis.points).toHaveLength(1);
    expect(analysis.points[0].returnPct).toBeCloseTo(10, 10);
    expect(analysis.points[0].usedAdjustedClose).toBe(true);
    expect(analysis.priceSource).toBe("adjustedClose");
    expect(analysis.adjustedCount).toBe(1);
    expect(analysis.fallbackCount).toBe(0);
    expect(analysis.skippedMissingPairs).toBe(2);
    expect(analysis.pathContinuous).toBe(false);
  });

  test("consente di scegliere esplicitamente close anche con adjusted parziale", () => {
    const analysis = buildDailyReturnDistribution([
      row("2025-01-02", 100, { adjustedClose: 50 }),
      row("2025-01-03", 110, { adjustedClose: 55 }),
      row("2025-01-06", 121),
      row("2025-01-07", 133.1, { adjustedClose: 66.55 }),
    ], { priceMode: "close" });

    expect(analysis.points).toHaveLength(3);
    analysis.points.forEach((point) => expect(point.returnPct).toBeCloseTo(10, 10));
    expect(analysis.priceSource).toBe("close");
    expect(analysis.fallbackCount).toBe(3);
    expect(analysis.pathContinuous).toBe(true);
  });

  test("in auto non crea un falso crollo da split quando adjusted è parziale", () => {
    const analysis = buildDailyReturnDistribution([
      row("2025-01-02", 100, { adjustedClose: 50 }),
      row("2025-01-03", 50, { adjustedClose: 50 }),
      row("2025-01-06", 55),
    ]);

    expect(analysis.points).toHaveLength(1);
    expect(analysis.points[0].returnPct).toBeCloseTo(0, 10);
    expect(analysis.points.some((point) => point.returnPct <= -40)).toBe(false);
    expect(analysis.cumulativeReturn).toBeNull();
    expect(analysis.pathContinuous).toBe(false);
  });

  test("usa rawClose con priorita rispetto al close arrotondato", () => {
    const analysis = buildDailyReturnDistribution([
      row("2025-03-03", 100.2, { rawClose: 100 }),
      row("2025-03-04", 109.8, { rawClose: 110 }),
    ]);

    expect(analysis.observations).toBe(1);
    expect(analysis.points[0].returnPct).toBeCloseTo(10, 10);
  });

  test("esclude i rendimenti che attraversano un gap superiore a sette giorni", () => {
    const analysis = buildDailyReturnDistribution([
      row("2025-01-01", 100),
      row("2025-01-02", 110),
      row("2025-01-20", 121),
      row("2025-01-21", 133.1),
    ]);

    expect(analysis.points.map((point) => point.date)).toEqual([
      "2025-01-02",
      "2025-01-21",
    ]);
    expect(analysis.points[0].returnPct).toBeCloseTo(10, 10);
    expect(analysis.points[1].returnPct).toBeCloseTo(10, 10);
    expect(analysis.skippedLongGaps).toBe(1);
  });

  test("gestisce prezzi costanti come rendimenti zero in un unico bin", () => {
    const history = Array.from({ length: 12 }, (_, index) =>
      row(`2025-02-${String(index + 1).padStart(2, "0")}`, 42)
    );

    const analysis = buildDailyReturnDistribution(history);

    expect(analysis).toMatchObject({
      observations: 11,
      min: 0,
      max: 0,
      mean: 0,
      median: 0,
      variance: 0,
      standardDeviation: 0,
    });
    expect(analysis.standardDeviation ** 2).toBeCloseTo(
      analysis.variance,
      10
    );
    expect(analysis.points.every((point) => point.returnPct === 0)).toBe(true);
    expect(analysis.histogram.bins).toHaveLength(1);
    expect(analysis.histogram.bins[0]).toMatchObject({
      start: 0,
      end: 0,
      count: 11,
      percentage: 100,
    });
  });

  test("restituisce null con meno di due chiusure valide", () => {
    expect(buildDailyReturnDistribution([])).toBeNull();
    expect(buildDailyReturnDistribution([row("2025-01-02", 100)])).toBeNull();
    expect(
      buildDailyReturnDistribution([
        row("2025-01-02", 100),
        row("2025-01-03", null),
        row("data-non-valida", 110),
      ])
    ).toBeNull();
  });

  test("con un solo rendimento non inventa statistiche campionarie", () => {
    const analysis = buildDailyReturnDistribution(
      [row("2025-01-02", 100), row("2025-01-03", 110)],
      { asOf: "2025-01-03T12:00:00Z" }
    );

    expect(analysis.observations).toBe(1);
    expect(analysis.points[0].returnPct).toBeCloseTo(10, 10);
    expect(analysis.variance).toBeNull();
    expect(analysis.standardDeviation).toBeNull();
  });
});

describe("serie completa dei rendimenti giornalieri", () => {
  test("espone un punto {date, value} per ogni coppia giornaliera valida", () => {
    const series = buildDailyReturnSeries(
      [
        row("2025-01-02", 100),
        row("2025-01-03", 110),
        row("2025-01-06", 99),
        row("2025-01-07", 99),
        row("2025-01-08", 108.9),
      ],
      { asOf: "2025-01-08T12:00:00Z" }
    );

    expect(series).toHaveLength(4);
    expect(series.map((point) => point.date)).toEqual([
      "2025-01-03",
      "2025-01-06",
      "2025-01-07",
      "2025-01-08",
    ]);
    expect(series.map((point) => Object.keys(point).sort())).toEqual([
      ["date", "value"],
      ["date", "value"],
      ["date", "value"],
      ["date", "value"],
    ]);
    [10, -10, 0, 10].forEach((expectedReturn, index) => {
      expect(series[index].value).toBeCloseTo(expectedReturn, 10);
    });
  });

  test("include cutoff e asOf ed esclude osservazioni future", () => {
    const series = buildDailyReturnSeries(
      [
        row("2020-06-14", 100),
        row("2020-06-15", 110),
        row("2020-06-16", 121),
        row("2025-06-14", 200),
        row("2025-06-15", 220),
        row("2025-06-16", 242),
      ],
      { asOf: "2025-06-15T12:00:00Z" }
    );

    expect(series.map((point) => point.date)).toEqual([
      "2020-06-15",
      "2020-06-16",
      "2025-06-15",
    ]);
    series.forEach((point) => {
      expect(point.value).toBeCloseTo(10, 10);
    });
  });

  test("non aggrega ne perde giorni anche quando tutti i rendimenti coincidono", () => {
    const history = Array.from({ length: 21 }, (_, index) =>
      row(
        new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
        42
      )
    );

    const series = buildDailyReturnSeries(history, {
      asOf: "2025-01-21T12:00:00Z",
    });
    const distribution = buildDailyReturnDistribution(history, {
      asOf: "2025-01-21T12:00:00Z",
    });

    expect(distribution.histogram.bins).toHaveLength(1);
    expect(series).toHaveLength(20);
    expect(series).toHaveLength(distribution.observations);
    expect(series.map((point) => point.date)).toEqual(
      history.slice(1).map((point) => point.date)
    );
    expect(series.every((point) => point.value === 0)).toBe(true);
  });

  test("preserva tutti i 1250 rendimenti disponibili negli ultimi cinque anni", () => {
    const tradingDates = [];
    const cursor = new Date(Date.UTC(2025, 5, 30));
    while (tradingDates.length < 1251) {
      const weekday = cursor.getUTCDay();
      if (weekday !== 0 && weekday !== 6) {
        tradingDates.push(cursor.toISOString().slice(0, 10));
      }
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    tradingDates.reverse();

    const history = tradingDates.map((date, index) =>
      row(date, 50 + index * 0.02 + Math.sin(index / 13))
    );
    const options = { asOf: "2025-06-30T12:00:00Z" };
    const series = buildDailyReturnSeries(history, options);
    const distribution = buildDailyReturnDistribution(history, options);
    const bins = distribution.histogram.bins;

    expect(series).toHaveLength(1250);
    expect(distribution.observations).toBe(1250);
    expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(series.length);
    expect(
      bins.reduce((sum, bin) => sum + bin.percentage, 0)
    ).toBeCloseTo(100, 10);
    expect(series.map((point) => point.date)).toEqual(tradingDates.slice(1));
    expect(bins[bins.length - 1].end).toBeGreaterThanOrEqual(
      distribution.max
    );
    expect(bins[bins.length - 1].count).toBeGreaterThan(0);
  });
});

describe("pagina Quantitativi", () => {
  const renderPage = (entry, darkMode = false) => {
    const consoleError = jest.spyOn(console, "error").mockImplementation((message) => {
      if (!String(message).includes("useLayoutEffect does nothing on the server")) {
        throw new Error(`Warning React inatteso: ${message}`);
      }
    });
    try {
      return renderToStaticMarkup(
        <MemoryRouter initialEntries={[entry]}>
          <QuantitativeAnalysis darkMode={darkMode} />
        </MemoryRouter>
      );
    } finally {
      consoleError.mockRestore();
    }
  };

  test("mostra uno stato vuoto accessibile quando manca il ticker", () => {
    const view = renderPage("/quantitativi");

    expect(view).toContain("Nessun titolo selezionato");
    expect(view).toContain("Apri un titolo dalla pagina Cerca");
    expect(view).toContain("quantitative-page quantitative-dashboard light");
    expect(view).toContain('role="status"');
  });

  test("legge dall'URL i filtri principali e li riflette nei controlli", () => {
    const view = renderPage(
      "/quantitativi?ticker=aapl&range=10y&freq=1wk&price=close&returns=log&var=99&bins=manual&binCount=31&scale=density&benchmark=QQQ",
      true
    );

    expect(view).toContain(">AAPL</h1>");
    expect(view).toContain("quantitative-page quantitative-dashboard dark");
    expect(view).toContain('<option value="10y" selected="">10 anni</option>');
    expect(view).toContain('<option value="1wk" selected="">Settimanale</option>');
    expect(view).toContain('<option value="close" selected="">Close</option>');
    expect(view).toContain('<option value="log" selected="">Logaritmico</option>');
    expect(view).toContain('<option value="0.99" selected="">99%</option>');
    expect(view).toContain('<option value="manual" selected="">Manuale</option>');
    expect(view).toContain('id="quant-bin-count" type="number" min="8" max="60" value="31"');
    expect(view).toContain('<option value="density" selected="">Densità</option>');
    expect(view).toContain('<option value="QQQ" selected="">QQQ · Nasdaq 100 ETF</option>');
  });

  test("esclude il titolo stesso dai benchmark e seleziona il primo ETF diverso", () => {
    const view = renderPage("/quantitativi?ticker=SPY&benchmark=SPY");

    expect(view).not.toContain('<option value="SPY"');
    expect(view).toContain('<option value="QQQ" selected="">QQQ · Nasdaq 100 ETF</option>');
  });

  test("accetta la scheda regressioni dall'URL e ripiega su distribuzione per valori non validi", () => {
    expect(resolveQuantitativeTab("regression")).toBe("regression");
    expect(resolveQuantitativeTab("heatmap")).toBe("heatmap");
    expect(resolveQuantitativeTab("methodology")).toBe("methodology");
    expect(resolveQuantitativeTab("sconosciuta")).toBe("distribution");
    expect(resolveQuantitativeTab(null)).toBe("distribution");
  });

  test("risolve il modello regressivo dall'URL mantenendo single come default compatibile", () => {
    expect(resolveRegressionModel("multi")).toBe("multi");
    expect(resolveRegressionModel("single")).toBe("single");
    expect(resolveRegressionModel("altro")).toBe("single");
    expect(resolveRegressionModel(null)).toBe("single");
  });

  test("il selettore accessibile persiste regModel nell'URL", async () => {
    const sampleSize = 70;
    const spyReturns = Array.from({ length: sampleSize - 1 }, (_, index) => (
      0.12 * Math.sin(index * 0.37) + 0.07 * Math.cos(index * 0.19)
    ));
    const growthReturns = spyReturns.map((_, index) => 0.08 * Math.cos(index * 0.53));
    const sizeReturns = spyReturns.map((_, index) => 0.06 * Math.sin(index * 0.71 + 0.4));
    const sectorReturns = spyReturns.map((_, index) => 0.05 * Math.cos(index * 0.41 + 0.2));
    const returnSeries = {
      SPY: spyReturns,
      QQQ: spyReturns.map((value, index) => value + growthReturns[index]),
      IWM: spyReturns.map((value, index) => value + sizeReturns[index]),
      XLK: spyReturns.map((value, index) => value + sectorReturns[index]),
      AAPL: spyReturns.map((value, index) => (
        0.015
        + 1.08 * value
        + 0.42 * growthReturns[index]
        - 0.24 * sizeReturns[index]
        + 0.31 * sectorReturns[index]
        + 0.01 * Math.sin(index * 0.83)
      )),
    };
    const makeHistory = (returns) => {
      let price = 100;
      return Array.from({ length: sampleSize }, (_, index) => {
        if (index > 0) price *= 1 + returns[index - 1] / 100;
        return {
          date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
          close: price,
          adjustedClose: price,
        };
      });
    };
    const originalFetch = global.fetch;
    const originalScrollTo = window.scrollTo;
    const originalActEnvironment = window.IS_REACT_ACT_ENVIRONMENT;
    window.IS_REACT_ACT_ENVIRONMENT = true;
    global.fetch = jest.fn((url) => {
      const rawUrl = String(url);
      if (!rawUrl.includes("/history")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ info: { shortName: "Apple", sector: "Technology", currency: "USD" } }),
        });
      }
      const sourceTicker = decodeURIComponent(rawUrl.match(/\/stock\/([^/?]+)/)?.[1] || "AAPL");
      const sourceHistory = makeHistory(returnSeries[sourceTicker] || returnSeries.AAPL);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          requestedTicker: sourceTicker,
          resolvedTicker: sourceTicker,
          rangeEnd: sourceHistory[sourceHistory.length - 1].date,
          actualStart: "2025-01-01",
          actualEnd: sourceHistory[sourceHistory.length - 1].date,
          adjustedCloseCoveragePct: 100,
          history: sourceHistory,
        }),
      });
    });
    window.scrollTo = jest.fn();
    const LocationProbe = () => {
      const location = useLocation();
      return <output data-testid="location-probe">{location.search}</output>;
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      // React 18 requires the initial createRoot render and its effects to be flushed.
      // eslint-disable-next-line testing-library/no-unnecessary-act
      await act(async () => {
        root.render(
          <MemoryRouter
            initialEntries={["/quantitativi?ticker=AAPL&tab=regression&regModel=multi"]}
            future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
          >
            <QuantitativeAnalysis darkMode={false} />
            <LocationProbe />
          </MemoryRouter>
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const buttons = [...container.querySelectorAll(".quant-model-toggle button")];
      const singleButton = buttons.find((button) => button.textContent.includes("Benchmark singolo"));
      const multiButton = buttons.find((button) => button.textContent.includes("Multifattoriale"));
      expect(singleButton).toBeTruthy();
      expect(multiButton.getAttribute("aria-pressed")).toBe("true");
      expect(container.textContent).toContain("Coefficienti, incertezza e collinearità");
      expect(container.textContent).toContain("Nasdaq relativo · QQQ − SPY");

      await act(async () => {
        singleButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(container.querySelector('[data-testid="location-probe"]').textContent).toContain("regModel=single");
      expect(singleButton.getAttribute("aria-pressed")).toBe("true");

      await act(async () => {
        multiButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(container.querySelector('[data-testid="location-probe"]').textContent).toContain("regModel=multi");
      expect(multiButton.getAttribute("aria-pressed")).toBe("true");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      global.fetch = originalFetch;
      window.scrollTo = originalScrollTo;
      window.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
    }
  });
});

describe("orchestrazione dei proxy multifattoriali", () => {
  const sourceAnalysis = (priceSource = "adjustedClose") => ({
    priceSource,
    points: [{ date: "2025-01-03", returnPct: 1 }],
  });

  test("costruisce specificazioni incrementali e conserva gli errori parziali", () => {
    const plan = buildMultipleFactorPlan({
      ticker: "AAPL",
      targetPriceSource: "adjustedClose",
      analyses: {
        SPY: sourceAnalysis(),
        QQQ: sourceAnalysis(),
      },
      sourceErrors: { IWM: "provider offline" },
    });

    expect(plan.factors.map((factor) => factor.key)).toEqual(["market", "growth"]);
    expect(plan.modelSpecs.map((model) => model.predictorKeys)).toEqual([
      ["market"],
      ["market", "growth"],
    ]);
    expect(plan.fullModelKey).toBe("market_growth");
    expect(plan.missingSources).toEqual(expect.arrayContaining([
      expect.objectContaining({ ticker: "IWM", message: "provider offline" }),
    ]));
  });

  test("blocca leakage anche usando ticker risolti e non mescola fonti prezzo", () => {
    const spyTarget = buildMultipleFactorPlan({
      ticker: "OLD-SPY",
      targetAliases: ["SPY"],
      targetPriceSource: "adjustedClose",
      analyses: {
        SPY: sourceAnalysis(),
        QQQ: sourceAnalysis(),
        IWM: sourceAnalysis(),
      },
    });
    expect(spyTarget.factors).toHaveLength(0);
    expect(spyTarget.exclusions.join(" ")).toContain("sottrarrebbe");

    const incompatible = buildMultipleFactorPlan({
      ticker: "AAPL",
      targetPriceSource: "adjustedClose",
      analyses: {
        SPY: sourceAnalysis("close"),
        QQQ: sourceAnalysis(),
        IWM: sourceAnalysis(),
      },
    });
    expect(incompatible.factors).toHaveLength(0);
    expect(incompatible.incompatibleSources).toEqual(expect.arrayContaining([
      expect.objectContaining({ ticker: "SPY", sourcePrice: "close", targetPrice: "adjustedClose" }),
    ]));
  });

  test("carica proxy unici con Promise.allSettled, riusa il benchmark e isola un errore", async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn((url) => {
      if (String(url).includes("/IWM/")) {
        return Promise.resolve({
          ok: false,
          json: () => Promise.resolve({ error: "IWM non disponibile" }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ requestedTicker: "QQQ", history: [] }),
      });
    });
    try {
      const reusedSpy = { requestedTicker: "SPY", history: [] };
      const result = await fetchMultipleProxyHistories({
        tickers: ["SPY", "QQQ", "IWM", "QQQ"],
        range: "10y",
        reusedPayloads: { SPY: reusedSpy },
      });

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(global.fetch.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([
        expect.stringContaining("/QQQ/history?timeframe=1d&range=10y"),
        expect.stringContaining("/IWM/history?timeframe=1d&range=10y"),
      ]));
      expect(result.payloads.SPY).toBe(reusedSpy);
      expect(result.payloads.QQQ).toBeTruthy();
      expect(result.payloads.IWM).toBeUndefined();
      expect(result.errors.IWM).toBe("IWM non disponibile");
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("export CSV completo", () => {
  test("include configurazione, sorgente, metriche benchmark e serie storica", () => {
    const analysis = buildDailyReturnDistribution([
      row("2025-01-02", 100),
      row("2025-01-03", 110),
      row("2025-01-06", 99),
    ]);
    analysis.advanced = {
      downsideDeviationPct: 7.1,
      annualizedDownsideDeviationPct: 112.7,
      omegaRatioZero: 1.4,
      tailRatio: 1.2,
      autocorrelationLag1: -0.1,
    };
    const csv = buildQuantitativeCsvExport({
      analysis,
      ticker: "TEST",
      historyPayload: {
        dataSource: "Provider, demo",
        generatedAt: "2025-01-07T10:30:00Z",
        requestedTicker: "TEST",
        resolvedTicker: "TEST",
      },
      benchmark: "SPY",
      benchmarkComparison: {
        observations: 2,
        pathContinuous: true,
        beta: 1.1,
        capture: {
          upside: { observations: 1 },
          downside: { observations: 1 },
        },
        regression: {
          method: "ols-newey-west",
          observations: 2,
          degreesOfFreedom: 0,
          slope: 1.1,
          interceptPct: 0.05,
          interceptAnnualizedPct: 13.4,
          rSquared: 0.8,
          adjustedRSquared: 0.7,
          residualStandardErrorPct: 0.4,
          rmsePct: 0.3,
          maePct: 0.2,
          standardErrors: { slopeHac: 0.12 },
          zStatistics: { slope: 9.1 },
          pValues: { slope: 0.0001 },
          confidence95: { slope: [0.86, 1.34], interceptPct: [-0.1, 0.2] },
          neweyWestLag: 1,
          sampleAdequacy: "limited",
          diagnostics: {
            durbinWatson: 1.9,
            autocorrelationLag1: 0.05,
            jarqueBera: 1.2,
            jarqueBeraPValue: 0.55,
            residualSkewness: 0.1,
            residualExcessKurtosis: -0.2,
            outlierCount: 0,
          },
          fittedSeries: [{
            date: "2025-01-03", x: 1, y: 1.2, fitted: 1.15, residual: 0.05, standardizedResidual: 0.2,
          }],
          confidenceBand: [{ x: 1, lower: 0.8, upper: 1.5 }],
          rolling: {
            window: 60,
            series: [{ date: "2025-01-03", beta: 1.08, rSquared: 0.78, alphaAnnualizedPct: 12 }],
          },
        },
      },
      regressionModel: "multi",
      multiFactorLineage: {
        SPY: {
          requestedTicker: "SPY",
          resolvedTicker: "SPY",
          dataSource: "Provider demo",
          generatedAt: "2025-01-07T10:00:00Z",
          actualStart: "2020-01-01",
          actualEnd: "2025-01-06",
          priceSource: "adjustedClose",
          adjustedCloseCoveragePct: 100,
        },
      },
      multipleRegression: {
        method: "ols-multiple-newey-west",
        observations: 2,
        firstDate: "2025-01-03",
        lastDate: "2025-01-06",
        predictorCount: 1,
        degreesOfFreedom: 0,
        rSquared: 0.81,
        adjustedRSquared: 0.79,
        rmsePct: 0.3,
        intercept: { estimatePct: 0.04, annualizedPct: 10.6 },
        diagnostics: { maxVif: 1, conditionNumber: 2, rank: 2 },
        factors: [{ key: "market", label: "Mercato · SPY", sourceTicker: "SPY" }],
        coefficients: [{
          key: "market",
          label: "Mercato · SPY",
          estimate: 1.05,
          seHac: 0.1,
          seOls: 0.09,
          z: 10.5,
          pValue: 0.0001,
          confidence95: [0.85, 1.25],
          vif: 1,
          incrementalRSquared: 0.4,
          incrementalAdjustedRSquared: 0.39,
        }],
        modelComparisons: [{
          key: "market",
          label: "M1 · Mercato",
          predictorKeys: ["market"],
          observations: 2,
          rSquared: 0.81,
          adjustedRSquared: 0.79,
          rmsePct: 0.3,
        }],
        fittedSeries: [{
          date: "2025-01-03",
          observedPct: 1.2,
          fittedPct: 1.15,
          residualPct: 0.05,
          standardizedResidual: 0.2,
          factorValues: { market: 1 },
          contributions: { market: 1.05 },
        }],
      },
      config: {
        range: "5y",
        frequency: "1d",
        priceMode: "auto",
        returnType: "simple",
        confidence: 0.95,
        binMethod: "fd",
      },
    });

    expect(csv).toContain("sezione,campo,valore");
    expect(csv).toContain('anagrafica,sorgente,"Provider, demo"');
    expect(csv).toContain("configurazione,periodo,5y");
    expect(csv).toContain("metrica,varianza_pct2,200");
    expect(csv).toContain("benchmark,beta,1.1");
    expect(csv).toContain("benchmark,capture_up_n,1");
    expect(csv).toContain("rischio_avanzato,downside_deviation_pct,7.1");
    expect(csv).toContain("rischio_avanzato,omega_ratio_soglia_zero,1.4");
    expect(csv).toContain("regressione,metodo,ols-newey-west");
    expect(csv).toContain("regressione,beta_slope,1.1");
    expect(csv).toContain("diagnostica_regressione,durbin_watson,1.9");
    expect(csv).toContain("regressione_serie\ndata,benchmark_return_pct,titolo_return_pct,fitted_pct,residuo_pct,residuo_standardizzato");
    expect(csv).toContain("banda_confidenza_95\nbenchmark_return_pct,limite_inferiore_pct,limite_superiore_pct");
    expect(csv).toContain("rolling_regressione\ndata,beta,r_quadro,alpha_annualizzata_pct");
    expect(csv).toContain("configurazione,modello_regressione,multi");
    expect(csv).toContain("regressione_multifattoriale,metodo,ols-multiple-newey-west");
    expect(csv).toContain("lineage_proxy,SPY_ticker_risolto,SPY");
    expect(csv).toContain("lineage_proxy,SPY_fonte_prezzo,adjustedClose");
    expect(csv).toContain("regressione_multifattoriale_coefficienti");
    expect(csv).toContain("delta_r_quadro_aggiustato_loo_in_sample");
    expect(csv).toContain("regressione_multifattoriale_modelli");
    expect(csv).toContain("fattore_market_pct,contributo_market_pct");
    expect(csv).toContain("2025-01-03,1.2,1.15,0.05,0.2,1,1.05");
    expect(csv).toContain("serie_storica\nticker,date,return_pct");
    expect(csv).toContain("TEST,2025-01-03");
  });
});
