import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import HeatmapSignalCard, { FORWARD_SIGNAL_VERSION } from "./HeatmapSignalCard";
import TradingViewStockHeatmap, { HeatmapRelationsModel } from "./TradingViewStockHeatmap";

jest.mock("../services/apiBase", () => ({ apiUrl: (path) => path }));

const makeSignal = (overrides = {}) => ({
  version: FORWARD_SIGNAL_VERSION,
  action: "buy",
  status: "ready",
  bias: "Rialzista",
  asOf: "2026-09-09",
  confidence: "Moderata",
  forecastReturnPct: 3.2,
  interval80: { lowerPct: -2.5, upperPct: 8.8 },
  upsideProbability: 0.65,
  costBps: 20,
  decisionThresholdPct: 0.6,
  reasons: ["Prima motivazione", "Seconda motivazione", "Terza motivazione", "Quarta motivazione decisiva"],
  drivers: [{ feature: "Settore · rendimento 21 sedute", contributionPct: 1.25 }],
  validation: {
    status: "ready", observations: 420, nonOverlappingObservations: 20,
    folds: 4, rmsePct: 4, baselineRmsePct: 5, zeroRmsePct: 5.1,
    skillVsBaseline: 0.2, skillVsZero: 0.22, directionAccuracy: 0.7,
    baselineDirectionAccuracy: 0.6, stability: 0.75,
    start: "2024-01-01", end: "2026-08-31",
  },
  methodology: { label: "Ridge temporale", executionDelaySessions: 1, minValidationObservations: 20, sources: [], caveats: [] },
  ...overrides,
});

const signalMarkup = (signal, horizon = "monthly") => renderToStaticMarkup(
  <HeatmapSignalCard signal={signal} ticker="AAPL" horizon={horizon} onRetry={() => {}} />
);

describe("segnale predittivo della heatmap", () => {
  test("un segnale mancante o storico non viene presentato come una posizione neutra", () => {
    for (const signal of [undefined, {}, { action: "hold", label: "Neutro", scorePct: 0 }]) {
      const html = signalMarkup(signal);
      expect(html).toContain("Segnale non disponibile");
      expect(html).toContain("Riprova segnale");
      expect(html).not.toContain("Attendi");
      expect(html).not.toContain("Neutro");
    }
  });

  test.each([["buy", "Acquista"], ["sell", "Vendi"]])("mostra %s solo con validazione pronta", (action, label) => {
    expect(signalMarkup(makeSignal({ action }))).toContain(`<strong>${label}</strong>`);
    const unavailable = signalMarkup(makeSignal({ action, status: "insufficient_validation" }));
    expect(unavailable).toContain("<strong>Da validare</strong>");
    expect(unavailable).not.toContain(`<strong>${label}</strong>`);
  });

  test("distingue vantaggio insufficiente da validazione insufficiente", () => {
    const hold = signalMarkup(makeSignal({ action: "hold", status: "no_edge" }));
    expect(hold).toContain("<strong>Attendi</strong>");
    expect(hold).toContain("Vantaggio insufficiente");
    const unavailable = signalMarkup(makeSignal({ action: "unavailable", status: "insufficient_validation" }));
    expect(unavailable).toContain("Da validare");
    expect(unavailable).not.toContain("<strong>Attendi</strong>");
  });

  test("mostra tutte le motivazioni, l'incertezza e il numero di finestre non sovrapposte", () => {
    const html = signalMarkup(makeSignal());
    expect(html).toContain("Quarta motivazione decisiva");
    expect(html).toContain("+3,20%");
    expect(html).toContain("-2,50% / 8,80%");
    expect(html).toContain("20 finestre non sovrapposte");
    expect(html).toContain("65,0%");
    expect(html).toContain("+1,25 p.p.");
    expect(html).toContain("non una probabilità calibrata");
  });

  test("valori nulli restano mancanti e non diventano zeri o intervalli al 0%", () => {
    const html = signalMarkup(makeSignal({
      forecastReturnPct: null, interval80: { lowerPct: null, upperPct: null },
      upsideProbability: null, decisionThresholdPct: null, validation: {}, drivers: [],
    }));
    expect(html).toContain("<strong>—</strong>");
    expect(html).not.toContain("0,00%");
    expect(html).not.toContain("0,0%");
    expect(html).not.toContain("NaN");
  });
});

describe("richieste e selezione dell'orizzonte", () => {
  let container;
  let root;
  let oldFetch;
  const payload = (symbol = "AAPL") => ({
    target: { symbol, sector: "Technology" }, models: {},
    signals: {
      daily: makeSignal({ action: "sell", forecastReturnPct: -1 }),
      monthly: makeSignal({ action: "hold", status: "no_edge" }),
      annual: makeSignal({ action: "unavailable", status: "insufficient_validation" }),
    },
  });
  const response = (data) => ({ ok: true, json: async () => data });
  const click = async (text) => {
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent === text);
    await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  };

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    oldFetch = global.fetch;
    global.fetch = jest.fn(async () => response(payload()));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    global.fetch = oldFetch;
    delete global.IS_REACT_ACT_ENVIRONMENT;
  });

  test("cambia il segnale con l'orizzonte senza richiedere un nuovo addestramento", async () => {
    await act(async () => root.render(<HeatmapRelationsModel ticker="AAPL" sectorHint="Technology" />));
    expect(container.querySelector(".quant-signal-decision strong").textContent).toBe("Attendi");
    await click("Giornaliero");
    expect(container.querySelector(".quant-signal-decision strong").textContent).toBe("Vendi");
    expect(container.textContent).toContain("Orizzonte: 1 seduta");
    await click("Annuale");
    expect(container.querySelector(".quant-signal-decision strong").textContent).toBe("Da validare");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toContain("signalVersion=forward-ridge-v1");
    expect(container.querySelectorAll(".quant-relations-summary strong")[2].textContent).toBe("—");
  });

  test("i costi vengono applicati soltanto dopo invio e una richiesta fallita può essere ripetuta", async () => {
    await act(async () => root.render(<HeatmapRelationsModel ticker="AAPL" />));
    await act(async () => Simulate.change(container.querySelector('input[type="number"]'), { target: { value: "35" } }));
    expect(global.fetch).toHaveBeenCalledTimes(1);
    global.fetch.mockRejectedValueOnce(new Error("Connessione interrotta"));
    await act(async () => container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(global.fetch.mock.calls[1][0]).toContain("signalCostBps=35");
    expect(container.textContent).toContain("Connessione interrotta");
    expect(container.querySelector(".quant-signal-decision")).toBeNull();
    await click("Riprova modello");
    expect(container.querySelector(".quant-signal-decision strong").textContent).toBe("Attendi");
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  test("la risposta di un vecchio ticker non sovrascrive il titolo corrente", async () => {
    let resolvePrevious;
    global.fetch.mockImplementationOnce(() => new Promise((resolve) => { resolvePrevious = resolve; }));
    await act(async () => root.render(<HeatmapRelationsModel ticker="AAPL" />));
    global.fetch.mockResolvedValueOnce(response(payload("MSFT")));
    await act(async () => root.render(<HeatmapRelationsModel ticker="MSFT" />));
    expect(global.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(container.querySelector(".quant-relations-target strong").textContent).toBe("MSFT");
    await act(async () => resolvePrevious(response(payload("AAPL"))));
    expect(container.querySelector(".quant-relations-target strong").textContent).toBe("MSFT");
  });

  test("mostra valuta, cambio e modello anche quando la heatmap non risponde", async () => {
    const foreign = {
      ...payload("ENI.MI"),
      target: { symbol: "ENI.MI", sector: "Energy", currency: "EUR", quoteCurrency: "EUR", inHeatmap: false },
      dataQuality: {
        fx: { symbol: "USDEUR=X", units: "EUR per USD", lastDate: "2026-09-09" },
        warnings: ["Proxy USA, non indici locali."],
      },
    };
    global.fetch.mockImplementation(async (url) => url.includes("/heatmap-relations/")
      ? response(foreign)
      : { ok: false, json: async () => ({ error: "Heatmap offline" }) });
    await act(async () => root.render(<TradingViewStockHeatmap ticker="ENI.MI" sectorHint="Energy" />));
    expect(container.textContent).toContain("Heatmap offline");
    expect(container.textContent).toContain("Rendimenti e previsioni in EUR");
    expect(container.textContent).toContain("Titolo esterno alla heatmap");
    expect(container.textContent).toContain("USDEUR=X");
    expect(container.textContent).toContain("Proxy USA, non indici locali.");
    expect(container.querySelector(".quant-signal-decision strong").textContent).toBe("Attendi");
  });
});
