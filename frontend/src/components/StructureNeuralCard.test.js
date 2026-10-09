import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import StructureNeuralCard, { STRUCTURE_NEURAL_VERSION } from "./StructureNeuralCard";

jest.mock("../services/apiBase", () => ({ apiUrl: (path) => path }));

const gap = { date: "2026-08-20", type: "Gap Down", start: 112, end: 116, fillPct: 12 };
const gapId = "2026-08-20|Gap Down|112|116";
const defaultProps = {
  ticker: "ENI.MI", timeframe: "1d", loading: false,
  zones: { support: [{ price: 98, strength: 80 }], resistance: [{ price: 120, strength: 85 }] },
  gaps: [gap], candles: [{ date: "2026-09-18", close: 105, volume: 123456 }],
  strengthPct: "", minDistancePct: "", gapPct: "",
};
const payload = (overrides = {}) => ({
  version: STRUCTURE_NEURAL_VERSION, status: "ready", symbol: "ENI.MI", currency: "EUR", asOf: "2026-09-18", horizon: 1, timeframe: "1d",
  inputSummary: { supports: 1, resistances: 1, openGaps: 1, price: 105 },
  trend: { status: "experimental", label: "up", probabilities: { up: 61, flat: 21, down: 18 }, trainingRows: 600, validation: { windows: 22, accuracyPct: 60, baselineAccuracyPct: 65, brier: 0.45, baselineBrier: 0.4 } },
  gaps: { status: "experimental", candidates: [{ ...gap, id: gapId, probabilityPct: 70, distancePct: 6.7 }], selectedId: null, trainingRows: 500, validation: { windows: 20, observations: 70, brier: 0.2, baselineBrier: 0.17 } },
  caveats: ["Campione limitato: risultati incerti."], ...overrides,
});
const response = (data, ok = true) => ({ ok, json: async () => data });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

describe("rete neurale sulla struttura della pagina", () => {
  let container;
  let root;
  let oldFetch;
  const render = async (props = {}) => act(async () => root.render(<StructureNeuralCard {...defaultProps} {...props} />));
  const click = async (label = "Analizza trend e gap") => {
    const button = [...container.querySelectorAll("button")].find((node) => node.textContent === label);
    expect(button).toBeDefined();
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
    jest.useRealTimers();
  });

  test("recupera un risultato già completato senza riaddestramento", async () => {
    global.fetch.mockResolvedValueOnce(response({ jobId: "job1", status: "complete", result: payload() }));
    await render(); await click();
    expect(container.textContent).toContain("Rialzista");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test("interroga il job in background e mostra il risultato", async () => {
    jest.useFakeTimers();
    global.fetch.mockResolvedValueOnce(response({ jobId: "job1", status: "queued" }));
    global.fetch.mockResolvedValueOnce(response({ jobId: "job1", status: "complete", result: payload() }));
    await render(); await click();
    expect(container.textContent).toContain("Analisi in coda");
    await act(async () => { jest.advanceTimersByTime(2000); });
    expect(global.fetch.mock.calls[1][0]).toBe("/stock/ENI.MI/structure-neural/jobs/job1");
    expect(container.textContent).toContain("Rialzista");
  });

  test("annullare l'attesa ferma il polling e non mostra risultati obsoleti", async () => {
    jest.useFakeTimers();
    global.fetch.mockResolvedValueOnce(response({ jobId: "job1", status: "running" }));
    await render(); await click(); await click("Annulla attesa");
    await act(async () => { jest.advanceTimersByTime(10000); });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("Rialzista");
  });

  test("un job fallito non diventa una previsione neutrale", async () => {
    global.fetch.mockResolvedValueOnce(response({ jobId: "job1", status: "failed", error: "Storico non disponibile" }));
    await render(); await click();
    expect(container.querySelector('[role="alert"]').textContent).toContain("Storico non disponibile");
  });

  test("il selettore aggiorna il periodo della pagina", async () => {
    const onTimeframeChange = jest.fn();
    await render({ onTimeframeChange });
    await act(async () => Simulate.change(container.querySelector("select"), { target: { value: "1w" } }));
    expect(onTimeframeChange).toHaveBeenCalledWith("1w");
  });

  test("rifiuta risultati di un periodo diverso", async () => {
    global.fetch.mockResolvedValueOnce(response(payload({ timeframe: "1w" })));
    await render(); await click();
    expect(container.textContent).toContain("non compatibile");
  });

  test("parte solo su comando e invia i livelli e gap della pagina senza volumi o tecnici", async () => {
    await render();
    expect(global.fetch).not.toHaveBeenCalled();
    await click();
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe("/stock/ENI.MI/structure-neural/jobs");
    expect(options.method).toBe("POST");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(options.body)).toEqual({
      timeframe: "1d", horizon: 1, strength: 70, min_pct: 1, gap_pct: 0.6,
      snapshot: { price: 105, asOf: "2026-09-18", gapWindowBars: 1, zones: defaultProps.zones, gaps: [{ ...gap, id: gapId }] },
    });
    expect(options.body).not.toMatch(/volume|RSI|technical|seasonality/i);
    expect(container.textContent).toContain("EUR");
  });

  test("mostra le stime sperimentali senza inventare un gap confermato e non inverte i nomi", async () => {
    await render();
    await click();
    expect(container.textContent).toContain("Rialzista");
    expect(container.textContent).toContain("61,0%");
    expect(container.textContent).toContain("Non confermato fuori campione");
    expect(container.textContent).toContain("Nessun gap confermato");
    expect(container.textContent).toContain("Gap Down");
    expect(container.textContent).not.toContain("Gap Up");
    expect(container.textContent).toContain("Sopra il prezzo");
    expect(container.textContent).toContain("non sommano al 100%");
    expect(container.textContent).toContain("almeno il 50%");
    expect(container.textContent).not.toMatch(/Acquista|Vendi/);
  });

  test("conferma solo il gap selezionato validato e conserva i prezzi esatti della pagina", async () => {
    global.fetch.mockResolvedValue(response(payload({ trend: { ...payload().trend, status: "validated" }, gaps: { ...payload().gaps, status: "validated", selectedId: gapId, candidates: [{ ...gap, id: gapId, start: 1, end: 2, probabilityPct: 77, usable: true }] } })));
    await render();
    await click();
    expect(container.querySelector("tr.is-selected").textContent).toContain("112,00 – 116,00");
    expect(container.textContent).toContain("candidato confermato");
    expect(container.textContent).not.toContain("Nessun gap confermato");
    expect(container.textContent).not.toContain("1,00 – 2,00");
  });

  test.each([["1w", 5, 80, 2, 1.2], ["1mo", 21, 90, 4, 2.5]])("invia timeframe %s con orizzonte e filtri coerenti", async (timeframe, horizon, strength, min_pct, gap_pct) => {
    await render({ timeframe });
    global.fetch.mockResolvedValueOnce(response(payload({ timeframe, horizon })));
    await click();
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toMatchObject({ timeframe, horizon, strength, min_pct, gap_pct });
    expect(container.textContent).toContain("Rialzista");
  });

  test("annulla la richiesta al cambio titolo e ignora risposte obsolete anche se fetch ignora abort", async () => {
    const pending = deferred();
    global.fetch.mockReturnValueOnce(pending.promise);
    await render();
    await click();
    const signal = global.fetch.mock.calls[0][1].signal;
    await render({ ticker: "AAPL" });
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(response(payload())));
    expect(container.textContent).not.toContain("Rialzista");
    expect(container.textContent).not.toContain("61,0%");
    global.fetch.mockResolvedValueOnce(response(payload({ symbol: "AAPL", currency: "USD" })));
    await click();
    expect(global.fetch.mock.calls[1][0]).toBe("/stock/AAPL/structure-neural/jobs");
    expect(container.textContent).toContain("USD");
  });

  test("cambio parametri, zone o prezzo invalida subito i risultati e richiede un nuovo avvio", async () => {
    await render();
    await click();
    await render({ strengthPct: "80" });
    expect(container.textContent).not.toContain("61,0%");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    await click();
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).strength).toBe(80);
    await render({ strengthPct: "80", candles: [{ date: "2026-09-18", close: 106 }] });
    expect(container.textContent).not.toContain("61,0%");
    await click();
    expect(JSON.parse(global.fetch.mock.calls[2][1].body).snapshot.price).toBe(106);
    await render({ zones: { ...defaultProps.zones, support: [{ price: 99 }] } });
    expect(container.textContent).not.toContain("61,0%");
  });

  test("cambio orizzonte invalida e annulla: nuova richiesta a 21 sedute solo dopo click", async () => {
    const pending = deferred();
    global.fetch.mockReturnValueOnce(pending.promise);
    await render();
    await click();
    const firstSignal = global.fetch.mock.calls[0][1].signal;
    await render({ timeframe: "1mo" });
    expect(firstSignal.aborted).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    global.fetch.mockResolvedValueOnce(response(payload({ horizon: 21, timeframe: "1mo" })));
    await click();
    await act(async () => pending.resolve(response(payload())));
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).horizon).toBe(21);
    expect(container.textContent).toContain("Trend stimato · 21 sedute");
  });

  test("loading della pagina rimuove le stime e impedisce analisi su dati in aggiornamento", async () => {
    await render();
    await click();
    await render({ loading: true });
    expect(container.textContent).not.toContain("61,0%");
    expect(container.querySelector("button").disabled).toBe(true);
    expect(container.textContent).toContain("Attendo l’aggiornamento");
  });

  test("gestisce errore e riprova senza confonderli con un risultato neutrale", async () => {
    global.fetch.mockResolvedValueOnce(response({ error: "Storico temporaneamente assente" }, false));
    await render();
    await click();
    expect(container.querySelector('[role="alert"]').textContent).toContain("Storico temporaneamente assente");
    expect(container.textContent).not.toContain("Laterale");
    await click("Riprova analisi");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("Rialzista");
  });

  test("versione incompatibile è un errore, dati insufficienti sono espliciti", async () => {
    global.fetch.mockResolvedValueOnce(response(payload({ version: "old" })));
    await render();
    await click();
    expect(container.textContent).toContain("non compatibile");
    global.fetch.mockResolvedValueOnce(response(payload({ status: "unavailable", reason: "Servono più chiusure storiche" })));
    await click("Riprova analisi");
    expect(container.textContent).toContain("Servono più chiusure storiche");
    expect(container.textContent).not.toContain("61,0%");
  });

  test("dati mancanti non diventano zero e gap non presenti nella pagina vengono ignorati", async () => {
    global.fetch.mockResolvedValue(response(payload({
      trend: { status: "unavailable", probabilities: null, validation: null },
      gaps: { status: "validated", candidates: [{ id: "estraneo", start: 1, end: 2, probabilityPct: 99 }], selectedId: "estraneo", validation: { brier: null } },
    })));
    await render();
    await click();
    expect(container.textContent).toContain("Trend non disponibile");
    expect(container.textContent).toContain("Nessun gap confermato");
    expect(container.textContent).not.toContain("0,000");
    expect(container.textContent).not.toContain("99,0%");
    expect(container.textContent).not.toContain("NaN");
  });

  test("prezzo non valido e parametri non numerici bloccano il modello", async () => {
    await render({ candles: [{ date: "2026-09-18", close: null }] });
    expect(container.querySelector("button").disabled).toBe(true);
    await render({ strengthPct: "non valido" });
    expect(container.querySelector("button").disabled).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("annullamento e smontaggio interrompono l’attesa senza errori tardivi", async () => {
    const pending = deferred();
    global.fetch.mockReturnValue(pending.promise);
    await render();
    await click();
    await click("Annulla attesa");
    expect(global.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => pending.resolve(response(payload())));
    expect(container.textContent).not.toContain("61,0%");
    const next = deferred();
    global.fetch.mockReturnValue(next.promise);
    await click();
    await act(async () => root.render(null));
    expect(global.fetch.mock.calls[1][1].signal.aborted).toBe(true);
    await act(async () => next.resolve(response(payload())));
    expect(container.textContent).toBe("");
  });

  test("V2 distingue errori di classe, confronti e calibrazione senza promettere precisione", async () => {
    expect(STRUCTURE_NEURAL_VERSION).toBe("structure-neural-v4.2");
    global.fetch.mockResolvedValue(response(payload({ trend: { ...payload().trend,
      validation: { ...payload().trend.validation, errorPct: 40, balancedAccuracyPct: 51, incumbentBrier: .48, linearBrier: .42,
        brierInterval95: { low: .3, high: .6 }, logLoss: .8, skillPct: -4, coveragePct: 0, selectiveAccuracyPct: null },
      modelSelection: { name: "Ensemble di due reti", folds: 3, calibration: { method: "temperature", temperature: 1.25, windows: 40 } },
    } })));
    await render(); await click();
    expect(container.textContent).toContain("Errori di classificazione osservati40,0%");
    expect(container.textContent).toContain("non un errore percentuale sul prezzo futuro");
    expect(container.textContent).toContain("Brier MLP di riferimento0,480");
    expect(container.textContent).toContain("Brier del confronto lineare0,420");
    expect(container.textContent).toContain("0,300 – 0,600");
    expect(container.textContent).toContain("Calibrazione temporale applicata: temperatura 1,25");
    expect(container.textContent).toContain("non garantisce un errore piccolo");
    expect(container.textContent).toContain("Accuratezza solo su queste osservazioni—");
  });

  test.each(["gap"])("astensione %s impedisce di confermare un gap anche con stato validato", async (which) => {
    global.fetch.mockResolvedValue(response(payload({
      trend: { ...payload().trend, status: "validated", reliability: { abstain: which === "trend", reason: "Struttura fuori dal dominio storico" } },
      gaps: { ...payload().gaps, status: "validated", selectedId: gapId,
        candidates: [{ ...gap, id: gapId, probabilityPct: 90, usable: which !== "gap", outOfDistribution: which === "gap" }] },
    })));
    await render(); await click();
    expect(container.textContent).toContain("Nessun gap confermato");
    expect(container.querySelector("tr.is-selected")).toBeNull();
    expect(container.textContent).toMatch(/dominio storico/);
  });

  test("calibrazione identità e diagnostiche mancanti restano esplicite", async () => {
    global.fetch.mockResolvedValue(response(payload({ trend: { ...payload().trend, validation: null,
      modelSelection: { name: "MLP originale 16/8", folds: 0, calibration: { method: "identity", windows: 6 } } } })));
    await render(); await click();
    expect(container.textContent).toContain("Probabilità non calibrate: campione insufficiente");
    expect(container.textContent).not.toContain("Errori di classificazione osservati0,0%");
    expect(container.textContent).not.toContain("NaN");
  });
});
