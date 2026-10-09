import React, { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import usePersistentPortfolio from "./usePersistentPortfolio";

const normalize = raw => Array.isArray(raw) ? raw : [];
let current;
function Fixture({ storageKey }) {
  current = usePersistentPortfolio(storageKey, normalize);
  return <div>{JSON.stringify(current[0])}{current[2]}</div>;
}
describe("salvataggio portafoglio", () => {
  let root, node;
  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true; localStorage.clear();
    node = document.createElement("div"); root = createRoot(node);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); jest.restoreAllMocks(); delete global.IS_REACT_ACT_ENVIRONMENT;
  });
  const render = async key => act(async () => root.render(<StrictMode><Fixture storageKey={key} /></StrictMode>));
  test("salva immediatamente e ripristina dopo la riapertura", async () => {
    await render("portfolio:user-a");
    await act(async () => {
      current[1](items => [...items, { ticker: "ENI.MI", initialPrice: 15, status: "bought" }]);
      expect(JSON.parse(localStorage.getItem("portfolio:user-a"))[0].ticker).toBe("ENI.MI");
    });
    await act(async () => root.unmount()); root = createRoot(node);
    await render("portfolio:user-a");
    expect(current[0][0]).toEqual({ ticker: "ENI.MI", initialPrice: 15, status: "bought" });
  });
  test("non perde aggiunte consecutive prima del render", async () => {
    await render("portfolio:user-a");
    await act(async () => { current[1](x => [...x, "AAPL"]); current[1](x => [...x, "TSLA"]); });
    expect(current[0]).toEqual(["AAPL", "TSLA"]);
  });
  test("cambio utente non sovrascrive dati e rifiuta callback del precedente", async () => {
    localStorage.setItem("a", '["AAPL"]'); localStorage.setItem("b", '["ENI.MI"]');
    await render("a"); const oldUpdate = current[1]; await render("b");
    await act(async () => oldUpdate(["TSLA"]));
    expect(current[0]).toEqual(["ENI.MI"]);
    expect(localStorage.getItem("a")).toBe('["AAPL"]');
    expect(localStorage.getItem("b")).toBe('["ENI.MI"]');
  });
  test("se lo storage è pieno mostra l'errore senza cancellare il salvataggio precedente", async () => {
    localStorage.setItem("a", '["AAPL"]'); await render("a");
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    await act(async () => current[1](x => [...x, "ENI.MI"]));
    expect(current[0]).toEqual(["AAPL", "ENI.MI"]);
    expect(current[2]).toContain("salvataggio non riuscito");
    expect(localStorage.getItem("a")).toBe('["AAPL"]');
  });
});
