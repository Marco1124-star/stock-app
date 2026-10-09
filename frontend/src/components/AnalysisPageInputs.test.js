import React, { act } from "react";
import { createRoot } from "react-dom/client";
import TechnicalsPage from "./TechnicalsPage";
import Stagionalita from "./Stagionalità";

let mockLocation = { search: "?ticker=ENI.MI" };
jest.mock("react-router-dom", () => ({ useLocation: () => mockLocation, useNavigate: () => jest.fn() }));
jest.mock("react-plotly.js", () => () => <div data-testid="plot-placeholder" />);
jest.mock("../services/apiBase", () => ({ apiUrl: (path) => path, API_BASE_URL: "" }));

const response = (data) => ({ ok: true, json: async () => data });
const season = (filtered) => {
  const years = [2021, 2022, 2023];
  const curves = Object.fromEntries(years.map((year, i) => [year, Array(12).fill(filtered ? 1 : i + 1)]));
  const percentiles = Array.from({ length: 12 }, () => ({ p10: 1, median: 2, p90: 3 }));
  return { years, months: ["Gen", "Feb", "Mar", "Apr", "Mag", "Giu", "Lug", "Ago", "Set", "Ott", "Nov", "Dic"],
    seasonalCurveByYear: curves, cumulativeCurveByYear: curves, monthlyPercentiles: percentiles,
    cumulativePercentiles: percentiles, asOf: "2026-09-11", excludeOutliers: filtered,
    outlierAudit: { limited: 2 }, calculationVersion: "analysis-pages-v1" };
};
const technical = (direction) => ({
  oscillatorsSummary: [{ name: "RSI14", value: 45, action: direction }],
  movingAveragesSummary: [{ name: "SMA20", value: 100, action: direction }],
  completedDaily: true, asOf: "2026-09-11T00:00:00",
  summary: { general: direction, oscillators: direction, movingAverages: direction,
    totalCounts: { Buy: direction === "Buy" ? 2 : 0, Sell: direction === "Sell" ? 2 : 0, Neutral: 0 }, strength: 1, strengthLabel: "Strong" },
});

describe("pagine Tecnici e Stagionalità", () => {
  let node; let root; let oldFetch; let oldScroll;
  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    oldFetch = global.fetch; oldScroll = window.scrollTo;
    window.scrollTo = jest.fn();
    mockLocation = { search: "?ticker=ENI.MI" };
    node = document.createElement("div"); document.body.appendChild(node); root = createRoot(node);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); node.remove();
    global.fetch = oldFetch; window.scrollTo = oldScroll;
    delete global.IS_REACT_ACT_ENVIRONMENT;
  });
  test("Stagionalità usa il filtro del backend, anche tornando alla risposta in cache", async () => {
    global.fetch = jest.fn(async (url) => response(season(url.includes("exclude_outliers=true"))));
    await act(async () => root.render(<Stagionalita darkMode={false} />));
    expect(global.fetch.mock.calls[0][0]).toContain("exclude_outliers=false&prior_years_only=false");
    const toggle = () => [...node.querySelectorAll("button")].find((b) => /Riduci outlier|Outlier ridotti/.test(b.textContent));
    await act(async () => toggle().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(global.fetch.mock.calls[1][0]).toContain("exclude_outliers=true");
    expect(node.textContent).toContain("2 rendimenti mensili limitati");
    await act(async () => toggle().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(node.textContent).not.toContain("2 rendimenti mensili limitati");
    expect(node.textContent).toContain("Stagionalità – ENI.MI");
  });
  test("il filtro anni precedenti esclude l’anno corrente", async () => {
    mockLocation = { search: "?ticker=ENI.MI&priorYearsOnly=1" };
    global.fetch = jest.fn(async () => response(season(true)));
    await act(async () => root.render(<Stagionalita darkMode />));
    expect(global.fetch.mock.calls[0][0]).toContain("exclude_outliers=true&prior_years_only=true");
    expect(node.textContent).toContain("Anni precedenti, senza anno corrente");
  });
  test("Tecnici ripristina il riepilogo corretto anche dal timeframe 1D in cache", async () => {
    global.fetch = jest.fn(async (url) => response(url.includes("/technicals?") ? technical(url.includes("timeframe=1w") ? "Sell" : "Buy") : null));
    await act(async () => root.render(<TechnicalsPage darkMode={false} />));
    expect(node.querySelector(".signal-main").textContent).toBe("Buy");
    const click = async (label) => act(async () => [...node.querySelectorAll("button")].find((b) => b.textContent === label).dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await click("1W");
    expect(node.querySelector(".signal-main").textContent).toBe("Sell");
    await click("1D");
    expect(node.querySelector(".signal-main").textContent).toBe("Buy");
    expect(global.fetch.mock.calls.filter(([url]) => url.includes("/technicals?")).length).toBe(2);
    expect(node.textContent).toContain("Ultima chiusura completata:");
  });
});
