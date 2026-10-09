import React, { act } from "react";
import { createRoot } from "react-dom/client";
import axios from "axios";
import Previsione from "./Previsione";

let mockLocation = { search: "?ticker=AAPL" };
let mockNeuralProps;
jest.mock("react-router-dom", () => ({ useLocation: () => mockLocation, useNavigate: () => jest.fn() }));
jest.mock("axios", () => ({ get: jest.fn() }));
jest.mock("react-plotly.js", () => () => <div />);
jest.mock("react-chartjs-2", () => ({ Chart: () => <div /> }));
jest.mock("chart.js", () => ({ Chart: { register: jest.fn() } }));
jest.mock("chartjs-chart-financial", () => ({}));
jest.mock("chartjs-adapter-date-fns", () => ({}));
jest.mock("chartjs-plugin-zoom", () => ({}));
jest.mock("./TechnicalsPage", () => () => null);
jest.mock("./StructureNeuralCard", () => (props) => { mockNeuralProps = props; return <div data-testid="neural-inputs" />; });
jest.mock("../services/apiBase", () => ({ apiUrl: (path) => path }));

const rows = (price) => [1, 2, 3, 4].map((n) => ({ date: `2026-09-${14 + n}`, open: price, high: price + 1, low: price - 1, close: price }));
const zones = (price) => ({ support: [{ price: price - 5, min: price - 6, max: price - 4 }], resistance: [{ price: price + 5, min: price + 4, max: price + 6 }] });
const response = (body) => ({ ok: true, json: async () => body });
const auxiliary = { oscillatorsSummary: [], movingAveragesSummary: [] };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

describe("Previsioni: provenienza degli input della rete", () => {
  let root; let container; let oldFetch; let oldScroll;
  // Native React DOM renderer, not Testing Library: act is required here.
  // eslint-disable-next-line testing-library/no-unnecessary-act
  const render = async () => act(async () => root.render(<Previsione darkMode />));
  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    oldFetch = global.fetch; oldScroll = window.scrollTo;
    window.scrollTo = jest.fn();
    mockLocation = { search: "?ticker=AAPL" }; mockNeuralProps = null;
    axios.get.mockImplementation(async (url) => {
      const price = url.includes("ENI.MI") ? 20 : 100;
      return { data: url.includes("/history?") ? { history: rows(price) } : { zones: zones(price), current_price: price } };
    });
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    global.fetch = oldFetch; window.scrollTo = oldScroll;
    delete global.IS_REACT_ACT_ENVIRONMENT;
  });

  test("attende i gap del nuovo titolo anche quando le sue zone sono già caricate", async () => {
    const apple = deferred(); const eni = deferred();
    global.fetch = jest.fn((url) => url === "/stock/AAPL?timeframe=1d" ? apple.promise :
      url === "/stock/ENI.MI?timeframe=1d" ? eni.promise : Promise.resolve(response(auxiliary)));
    await render();
    expect(mockNeuralProps.loading).toBe(true);
    await act(async () => apple.resolve(response({ ohlc: rows(100) })));
    expect(mockNeuralProps.loading).toBe(false);
    expect(mockNeuralProps.candles.at(-1).close).toBe(100);
    mockLocation = { search: "?ticker=ENI.MI" };
    await render();
    expect(mockNeuralProps.ticker).toBe("ENI.MI");
    expect(mockNeuralProps.loading).toBe(true);
    expect(mockNeuralProps.candles.at(-1).close).not.toBe(100);
    await act(async () => eni.resolve(response({ ohlc: rows(20) })));
    expect(mockNeuralProps.loading).toBe(false);
    expect(mockNeuralProps.zones).toEqual(zones(20));
    expect(mockNeuralProps.candles.at(-1).close).toBe(20);
  });

  test("una risposta principale parziale non abilita il modello con zone mancanti", async () => {
    axios.get.mockImplementation(async (url) => {
      if (url.includes("/supply_demand?")) throw new Error("provider unavailable");
      return { data: { history: rows(100) } };
    });
    global.fetch = jest.fn(async (url) => response(url === "/stock/AAPL?timeframe=1d" ? { ohlc: rows(100) } : auxiliary));
    await render();
    expect(mockNeuralProps.loading).toBe(true);
    expect(mockNeuralProps.zones).toEqual({ support: [], resistance: [] });
  });
});
