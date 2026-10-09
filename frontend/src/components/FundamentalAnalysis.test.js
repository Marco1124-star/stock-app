import {
  buildAdvancedAnalysis,
  buildCalculatedRows,
  buildConsistencyChecks,
  buildFinalSummary,
  buildForecastWarningList,
  buildTrendCards,
  evaluateBalanceIndicator,
  formatForecastPercent,
  getCommonSizeValue,
  getForecastMaeEdgePct,
  getForecastValidationPresentation,
} from "./FundamentalAnalysis";

const row = (key, values, extra = {}) => ({ key, values, ...extra });
const period = key => ({ key, label: key });
const valueOf = (rows, key, periodKey) =>
  rows.find(item => item.key === key)?.values?.[periodKey];

const assess = (
  key,
  value,
  assessmentValue = value,
  assessmentContext = null
) =>
  evaluateBalanceIndicator(
    { key },
    value,
    assessmentValue,
    assessmentContext
  );

describe("presentazione della previsione fondamentale", () => {
  test("formatta rendimenti positivi, negativi e mancanti senza crash", () => {
    expect(formatForecastPercent(12.34)).toBe("+12,3%");
    expect(formatForecastPercent(-4.56)).toBe("-4,6%");
    expect(formatForecastPercent(null)).toBe("N/D");
    expect(formatForecastPercent(61.2, false)).toBe("61,2%");
  });

  test("calcola il vantaggio MAE relativo rispetto alla baseline nulla", () => {
    expect(
      getForecastMaeEdgePct({ oosMaePct: 8, baselineZeroMaePct: 10 })
    ).toBeCloseTo(20);
    expect(
      getForecastMaeEdgePct({ maeRelativeImprovementVsZeroPct: 12.5 })
    ).toBeCloseTo(12.5);
    expect(getForecastMaeEdgePct({ oosMaePct: 8 })).toBeNull();
  });

  test.each([
    [
      {
        validationStatus: "validated",
        publishable: true,
        promotionDecision: "reject",
        abstained: true,
        abstentionReason: "Gate 3m non superati",
      },
      "abstained",
    ],
    [{ validationStatus: "notValidated", publishable: false }, "unvalidated"],
    [
      {
        validationStatus: "prospectiveConfirmationRequired",
        publishable: true,
      },
      "prospective",
    ],
    [{ validationStatus: "holdoutNotConfirmed", publishable: true }, "caveat"],
    [{ validationStatus: "legacyArtifact", publishable: true }, "caveat"],
    [
      {
        validationStatus: "validated",
        publishable: true,
        performance: { interval80CoveragePct: 81 },
      },
      "confirmed",
    ],
  ])("espone lo stato di validazione %s", (prediction, expected) => {
    expect(getForecastValidationPresentation(prediction).key).toBe(expected);
  });

  test("preferisce warning strutturati e mantiene il fallback legacy", () => {
    expect(
      buildForecastWarningList({
        warningObjects: [
          { code: "coverage", title: "Copertura", detail: "Limitata" },
        ],
        warnings: ["testo precedente"],
      })
    ).toEqual([
      expect.objectContaining({ code: "coverage", title: "Copertura" }),
    ]);
    expect(
      buildForecastWarningList({ warnings: ["testo precedente"] })[0]
    ).toEqual(
      expect.objectContaining({
        code: "legacy-0",
        detail: "testo precedente",
      })
    );
  });
});

describe("valutazioni degli indicatori patrimoniali", () => {
  test.each([
    [2, "excellent"],
    [1.5, "good"],
    [1, "weak"],
    [0.99, "poor"],
  ])("classifica il current ratio %s", (value, expected) => {
    expect(assess("current-ratio", value).key).toBe(expected);
  });

  test.each([
    [1.5, "excellent"],
    [1, "good"],
    [0.5, "weak"],
    [0.49, "poor"],
  ])("classifica il quick ratio %s", (value, expected) => {
    expect(assess("quick-ratio", value).key).toBe(expected);
  });

  test.each([
    [1, "excellent"],
    [0.5, "good"],
    [0.2, "weak"],
    [0.19, "poor"],
  ])("classifica la liquidità immediata %s", (value, expected) => {
    expect(assess("immediate-liquidity-ratio", value).key).toBe(expected);
  });

  test("valuta le current liabilities tramite la copertura, non l'importo", () => {
    expect(assess("current-liabilities", 1_000_000_000, 0.8).key).toBe("poor");
    expect(assess("current-liabilities", 10_000, 2.1).key).toBe("excellent");
  });

  test.each([
    [1, "excellent"],
    [0.5, "good"],
    [0, "weak"],
    [-0.01, "poor"],
  ])("classifica il capitale circolante normalizzato %s", (value, expected) => {
    expect(assess("net-working-capital", 500_000, value).key).toBe(expected);
  });

  test.each([
    [0.42, "excellent"],
    [0.43, "good"],
    [1, "weak"],
    [2.33, "poor"],
  ])("classifica il D/E %s", (value, expected) => {
    expect(
      assess("debt-equity", value, value, { debt: 42, equity: 100 }).key
    ).toBe(expected);
  });

  test.each([
    [29.99, "excellent"],
    [30, "good"],
    [50, "weak"],
    [70, "poor"],
  ])("classifica il debito su capitale %s%%", (value, expected) => {
    expect(
      assess("total-debt-capital", value, value, { debt: 30, equity: 70 }).key
    ).toBe(expected);
  });

  test("considera pessimo un patrimonio netto nullo o negativo", () => {
    expect(
      assess("debt-equity", null, null, { debt: 10, equity: -5 }).key
    ).toBe("poor");
    expect(
      assess("total-debt-capital", null, null, { debt: 10, equity: 0 }).key
    ).toBe("poor");
  });

  test("usa N/D quando mancano i dati necessari", () => {
    expect(assess("current-ratio", null).key).toBe("neutral");
    expect(
      assess("debt-equity", null, null, { debt: null, equity: 100 }).key
    ).toBe("neutral");
  });
});

describe("common-size e trend storici", () => {
  const statements = {
    income: {
      periods: [period("2024-12-31"), period("2023-12-31")],
      rows: [
        row("TotalRevenue", {
          "2024-12-31": 200,
          "2023-12-31": 100,
        }),
        row("GrossProfit", {
          "2024-12-31": 80,
          "2023-12-31": 35,
        }),
        row(
          "DilutedEPS",
          {
            "2024-12-31": 2.5,
            "2023-12-31": 2,
          },
          { format: "perShare" }
        ),
        row("BasicAverageShares", {
          "2024-12-31": 1_000,
          "2023-12-31": 1_050,
        }),
      ],
    },
    balance: {
      periods: [period("2024-12-31")],
      rows: [
        row("TotalAssets", { "2024-12-31": 1_000 }),
        row("TotalDebt", { "2024-12-31": 300 }),
      ],
    },
    cash: {
      periods: [period("2024-12-31")],
      rows: [row("OperatingCashFlow", { "2024-12-31": 50 })],
    },
  };

  test("normalizza ogni prospetto sulla propria base", () => {
    expect(
      getCommonSizeValue(
        statements,
        "income",
        statements.income.rows[1],
        "2024-12-31"
      )
    ).toBeCloseTo(40);
    expect(
      getCommonSizeValue(
        statements,
        "balance",
        statements.balance.rows[1],
        "2024-12-31"
      )
    ).toBeCloseTo(30);
    expect(
      getCommonSizeValue(
        statements,
        "cash",
        statements.cash.rows[0],
        "2024-12-31"
      )
    ).toBeCloseTo(25);
  });

  test("non converte le metriche per azione", () => {
    expect(
      getCommonSizeValue(
        statements,
        "income",
        statements.income.rows[2],
        "2024-12-31"
      )
    ).toBeNull();
    expect(
      getCommonSizeValue(
        statements,
        "income",
        statements.income.rows[3],
        "2024-12-31"
      )
    ).toBeNull();
  });

  test("ordina i grafici dal periodo meno recente e ignora TTM", () => {
    const withTtm = {
      ...statements,
      income: {
        ...statements.income,
        periods: [
          period("TTM"),
          period("2024-12-31"),
          period("2023-12-31"),
        ],
      },
    };
    const charts = buildTrendCards(
      withTtm,
      "income",
      withTtm.income.periods
    );
    expect(charts.find(chart => chart.key === "revenue").points).toEqual([
      expect.objectContaining({ period: "2023-12-31", value: 100 }),
      expect.objectContaining({ period: "2024-12-31", value: 200 }),
    ]);
  });
});

describe("formule degli indicatori derivati", () => {
  test("elimina i duplicati e usa il dato operativo riportato", () => {
    const periods = [period("2024-12-31"), period("2023-12-31")];
    const statements = {
      income: {
        periods,
        rows: [
          row("TotalRevenue", {
            "2024-12-31": 100,
            "2023-12-31": 90,
          }),
          row("GrossProfit", {
            "2024-12-31": 50,
            "2023-12-31": 45,
          }),
          row("OperatingIncome", {
            "2024-12-31": 40,
            "2023-12-31": 35,
          }),
          row("EBIT", {
            "2024-12-31": 45,
            "2023-12-31": 40,
          }),
          row("NetIncome", {
            "2024-12-31": 20,
            "2023-12-31": 18,
          }),
        ],
      },
    };

    const calculated = buildCalculatedRows(
      statements,
      "income",
      periods,
      "annual"
    );
    const keys = calculated.map(item => item.key);

    expect(valueOf(calculated, "operating-income", "2024-12-31")).toBe(40);
    expect(keys).not.toEqual(
      expect.arrayContaining([
        "gross-margin",
        "operating-margin",
        "liquidity-ratio",
      ])
    );
  });

  test("calcola il quick ratio solo con liquidità e crediti disponibili", () => {
    const periods = [period("2024-12-31")];
    const statements = {
      balance: {
        periods,
        rows: [
          row("CurrentAssets", { "2024-12-31": 100 }),
          row("Inventory", { "2024-12-31": 20 }),
          row("CashAndCashEquivalents", { "2024-12-31": 10 }),
          row("CurrentLiabilities", { "2024-12-31": 50 }),
        ],
      },
    };
    const calculated = buildCalculatedRows(
      statements,
      "balance",
      periods,
      "annual"
    );

    expect(calculated.find(item => item.key === "quick-ratio")).toBeUndefined();
  });

  test("confronta il cash flow trimestrale con lo stesso trimestre precedente", () => {
    const keys = [
      "2025-03-31",
      "2024-12-31",
      "2024-09-30",
      "2024-06-30",
      "2024-03-31",
    ];
    const periods = keys.map(period);
    const statements = {
      cash: {
        periods,
        rows: [
          row("OperatingCashFlow", {
            "2025-03-31": 120,
            "2024-12-31": 100,
            "2024-09-30": 90,
            "2024-06-30": 85,
            "2024-03-31": 80,
          }),
        ],
      },
    };
    const calculated = buildCalculatedRows(
      statements,
      "cash",
      periods,
      "quarterly"
    );

    expect(
      valueOf(calculated, "operating-cash-growth", "2025-03-31")
    ).toBeCloseTo(50);
  });
});

describe("analisi avanzata annuale", () => {
  const periods = [period("2024-12-31"), period("2023-12-31")];
  const statements = {
    income: {
      periods,
      rows: [
        row("TotalRevenue", {
          "2024-12-31": 400,
          "2023-12-31": 360,
        }),
        row("CostOfRevenue", {
          "2024-12-31": 240,
          "2023-12-31": 220,
        }),
        row("GrossProfit", {
          "2024-12-31": 160,
          "2023-12-31": 140,
        }),
        row("OperatingIncome", {
          "2024-12-31": 60,
          "2023-12-31": 50,
        }),
        row("PretaxIncome", {
          "2024-12-31": 50,
          "2023-12-31": 40,
        }),
        row("TaxProvision", {
          "2024-12-31": 10,
          "2023-12-31": 8,
        }),
        row("NetIncomeCommonStockholders", {
          "2024-12-31": 40,
          "2023-12-31": 30,
        }),
        row("InterestExpense", {
          "2024-12-31": -10,
          "2023-12-31": -8,
        }),
        row("ResearchAndDevelopment", {
          "2024-12-31": 20,
          "2023-12-31": 18,
        }),
        row("TotalUnusualItemsExcludingGoodwill", {
          "2024-12-31": -5,
          "2023-12-31": 0,
        }),
      ],
    },
    balance: {
      periods,
      rows: [
        row("TotalAssets", {
          "2024-12-31": 500,
          "2023-12-31": 400,
        }),
        row("CurrentAssets", {
          "2024-12-31": 200,
          "2023-12-31": 180,
        }),
        row("CashCashEquivalentsAndShortTermInvestments", {
          "2024-12-31": 50,
          "2023-12-31": 45,
        }),
        row("CurrentLiabilities", {
          "2024-12-31": 120,
          "2023-12-31": 110,
        }),
        row("TotalLiabilitiesNetMinorityInterest", {
          "2024-12-31": 250,
          "2023-12-31": 200,
        }),
        row("CurrentDebt", {
          "2024-12-31": 20,
          "2023-12-31": 20,
        }),
        row("LongTermDebt", {
          "2024-12-31": 100,
          "2023-12-31": 100,
        }),
        row("TotalDebt", {
          "2024-12-31": 120,
          "2023-12-31": 120,
        }),
        row("AccountsReceivable", {
          "2024-12-31": 45,
          "2023-12-31": 35,
        }),
        row("Inventory", {
          "2024-12-31": 30,
          "2023-12-31": 20,
        }),
        row("AccountsPayable", {
          "2024-12-31": 25,
          "2023-12-31": 15,
        }),
        row("NetPPE", {
          "2024-12-31": 160,
          "2023-12-31": 140,
        }),
        row("StockholdersEquity", {
          "2024-12-31": 250,
          "2023-12-31": 200,
        }),
        row("InvestedCapital", {
          "2024-12-31": 300,
          "2023-12-31": 280,
        }),
        row("OrdinarySharesNumber", {
          "2024-12-31": 90,
          "2023-12-31": 100,
        }),
      ],
    },
    cash: {
      periods,
      rows: [
        row("OperatingCashFlow", {
          "2024-12-31": 60,
          "2023-12-31": 50,
        }),
        row("CapitalExpenditure", {
          "2024-12-31": -30,
          "2023-12-31": -25,
        }),
        row("FreeCashFlow", {
          "2024-12-31": 30,
          "2023-12-31": 25,
        }),
        row("DepreciationAndAmortization", {
          "2024-12-31": 10,
          "2023-12-31": 9,
        }),
        row("IssuanceOfDebt", {
          "2024-12-31": 5,
          "2023-12-31": 4,
        }),
        row("RepaymentOfDebt", {
          "2024-12-31": -10,
          "2023-12-31": -5,
        }),
        row("CashDividendsPaid", {
          "2024-12-31": -5,
          "2023-12-31": -4,
        }),
        row("RepurchaseOfCapitalStock", {
          "2024-12-31": -10,
          "2023-12-31": -8,
        }),
        row("PurchaseOfBusiness", {
          "2024-12-31": -12,
          "2023-12-31": 0,
        }),
      ],
    },
  };

  const build = () => buildAdvancedAnalysis(statements, periods, "annual");
  const groupRows = (analysis, groupKey) =>
    analysis.groups.find(group => group.key === groupKey)?.rows || [];

  test("misura qualità degli utili e copertura del debito", () => {
    const rows = groupRows(build(), "earnings-debt");

    expect(valueOf(rows, "cash-conversion", "2024-12-31")).toBeCloseTo(1.5);
    expect(valueOf(rows, "free-cash-conversion", "2024-12-31")).toBeCloseTo(
      0.75
    );
    expect(
      valueOf(rows, "operating-accrual-ratio", "2024-12-31")
    ).toBeCloseTo(-4.4444);
    expect(valueOf(rows, "interest-coverage", "2024-12-31")).toBeCloseTo(6);
    expect(valueOf(rows, "net-debt-ebitda", "2024-12-31")).toBeCloseTo(1);
    expect(
      valueOf(rows, "free-cash-debt-coverage", "2024-12-31")
    ).toBeCloseTo(25);
  });

  test("usa saldi medi e giorni effettivi per l'efficienza", () => {
    const rows = groupRows(build(), "efficiency");

    expect(
      valueOf(rows, "days-sales-outstanding", "2024-12-31")
    ).toBeCloseTo(36.6);
    expect(
      valueOf(rows, "days-inventory-outstanding", "2024-12-31")
    ).toBeCloseTo(38.125);
    expect(
      valueOf(rows, "days-payables-outstanding", "2024-12-31")
    ).toBeCloseTo(29.28);
    expect(
      valueOf(rows, "cash-conversion-cycle", "2024-12-31")
    ).toBeCloseTo(45.445);
    expect(
      valueOf(rows, "fixed-asset-turnover", "2024-12-31")
    ).toBeCloseTo(2.6667);
  });

  test("riconcilia il ROE tramite la scomposizione DuPont", () => {
    const rows = groupRows(build(), "dupont");

    expect(valueOf(rows, "dupont-net-margin", "2024-12-31")).toBeCloseTo(10);
    expect(
      valueOf(rows, "dupont-asset-turnover", "2024-12-31")
    ).toBeCloseTo(0.8889);
    expect(valueOf(rows, "equity-multiplier", "2024-12-31")).toBeCloseTo(2);
    expect(valueOf(rows, "dupont-roe", "2024-12-31")).toBeCloseTo(17.7778);
  });

  test("ricostruisce reinvestimento, FCFE e distribuzioni", () => {
    const rows = groupRows(build(), "capital-allocation");

    expect(valueOf(rows, "net-capex", "2024-12-31")).toBeCloseTo(20);
    expect(
      valueOf(rows, "change-non-cash-working-capital", "2024-12-31")
    ).toBeCloseTo(5);
    expect(valueOf(rows, "total-reinvestment", "2024-12-31")).toBeCloseTo(25);
    expect(valueOf(rows, "reinvestment-rate", "2024-12-31")).toBeCloseTo(
      52.0833
    );
    expect(valueOf(rows, "fcfe", "2024-12-31")).toBeCloseTo(25);
    expect(valueOf(rows, "acquisitions", "2024-12-31")).toBeCloseTo(12);
    expect(
      valueOf(rows, "shareholder-cash-returns", "2024-12-31")
    ).toBeCloseTo(15);
    expect(valueOf(rows, "cash-returned-fcfe", "2024-12-31")).toBeCloseTo(60);
    expect(valueOf(rows, "share-count-change", "2024-12-31")).toBeCloseTo(-10);
    expect(
      valueOf(rows, "implied-operating-growth", "2024-12-31")
    ).toBeCloseTo(8.6207);
  });

  test("non inventa zero quando manca un saldo medio", () => {
    const withoutWorkingCapitalBalances = {
      ...statements,
      balance: {
        ...statements.balance,
        rows: statements.balance.rows.filter(
          item =>
            !["AccountsReceivable", "Inventory", "AccountsPayable"].includes(
              item.key
            )
        ),
      },
    };
    const analysis = buildAdvancedAnalysis(
      withoutWorkingCapitalBalances,
      periods,
      "annual"
    );
    const rows = groupRows(analysis, "efficiency");

    expect(
      rows.find(item => item.key === "days-sales-outstanding")
    ).toBeUndefined();
    expect(
      rows.find(item => item.key === "days-inventory-outstanding")
    ).toBeUndefined();
    expect(
      rows.find(item => item.key === "days-payables-outstanding")
    ).toBeUndefined();
    expect(
      rows.find(item => item.key === "cash-conversion-cycle")
    ).toBeUndefined();
  });

  test("esclude TTM, limita lo storico a dieci anni e non usa dati trimestrali", () => {
    const longPeriods = [
      period("TTM"),
      ...Array.from({ length: 12 }, (_, index) =>
        period(`${2024 - index}-12-31`)
      ),
    ];
    const annual = buildAdvancedAnalysis(statements, longPeriods, "annual");
    const quarterly = buildAdvancedAnalysis(statements, periods, "quarterly");

    expect(annual.periods).toHaveLength(10);
    expect(annual.periods.some(item => item.key === "TTM")).toBe(false);
    expect(quarterly.groups).toEqual([]);
  });

  test("rimuove dal prospetto cassa gli indicatori trasferiti nell'analisi avanzata", () => {
    const rows = buildCalculatedRows(statements, "cash", periods, "annual");
    const keys = rows.map(item => item.key);

    expect(keys).not.toEqual(
      expect.arrayContaining([
        "cash-conversion",
        "free-cash-conversion",
        "capex-operating-cash",
        "dividend-coverage",
      ])
    );
  });

  test("riconcilia le identità contabili e il filing ufficiale", () => {
    const checks = buildConsistencyChecks(statements, periods, {
      officialFilings: {
        cik: "0000320193",
        items: [
          {
            form: "10-K",
            category: "annual",
            filingDate: "2025-02-20",
            reportDate: "2024-12-31",
          },
        ],
      },
    });
    const byKey = key => checks.find(check => check.key === key);

    expect(byKey("balance-equation").status).toBe("pass");
    expect(byKey("gross-profit-bridge").status).toBe("pass");
    expect(byKey("free-cash-flow-bridge").status).toBe("pass");
    expect(byKey("debt-bridge").status).toBe("pass");
    expect(byKey("data-structure").status).toBe("pass");
    expect(byKey("official-filing-alignment").status).toBe("pass");
    expect(byKey("historical-coverage").status).toBe("attention");
  });

  test("segnala uno scostamento e ne conserva la motivazione", () => {
    const inconsistent = {
      ...statements,
      income: {
        ...statements.income,
        rows: statements.income.rows.map(item =>
          item.key === "GrossProfit"
            ? row("GrossProfit", {
                ...item.values,
                "2024-12-31": 100,
              })
            : item
        ),
      },
    };
    const check = buildConsistencyChecks(inconsistent, periods).find(
      item => item.key === "gross-profit-bridge"
    );

    expect(check.status).toBe("attention");
    expect(check.detail).toContain("tolleranza");
    expect(check.evidence).toContain("scostamento massimo");
  });

  test("genera punti motivati senza un punteggio aggregato", () => {
    const analysis = build();
    const checks = buildConsistencyChecks(statements, periods, {
      officialFilings: {
        cik: "0000320193",
        items: [
          {
            form: "10-K",
            category: "annual",
            filingDate: "2025-02-20",
            reportDate: "2024-12-31",
          },
        ],
      },
    });
    const summary = buildFinalSummary(statements, analysis, checks);
    const strengthKeys = summary.strengths.map(item => item.key);

    expect(strengthKeys).toEqual(
      expect.arrayContaining([
        "revenue-growth",
        "cash-backed-earnings",
        "strong-interest-coverage",
        "liquidity-buffer",
      ])
    );
    expect(summary.strengths.every(item => item.reason && item.evidence)).toBe(
      true
    );
    expect(summary).not.toHaveProperty("score");
  });
});
