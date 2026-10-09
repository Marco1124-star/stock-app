import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import FinanceSearch from "./FinanceSearch";

jest.mock("../services/apiBase", () => ({ apiUrl: path => path }));
const eni = { symbol: "ENI.MI", name: "Eni S.p.A.", exchange: "Milan", type: "EQUITY" };
const reply = suggestions => ({ ok: true, json: async () => ({ suggestions }) });
function Harness({ select }) {
  const [value, setValue] = useState("");
  return <FinanceSearch value={value} onChange={setValue} onSelect={select} />;
}
describe("FinanceSearch", () => {
  let root, node, select, oldFetch;
  beforeEach(async () => {
    jest.useFakeTimers(); localStorage.clear(); global.IS_REACT_ACT_ENVIRONMENT = true;
    oldFetch = global.fetch; global.fetch = jest.fn(async () => reply([eni])); select = jest.fn();
    node = document.createElement("div"); document.body.appendChild(node); root = createRoot(node);
    await act(async () => root.render(<Harness select={select} />));
  });
  afterEach(async () => {
    await act(async () => root.unmount()); node.remove(); global.fetch = oldFetch;
    jest.useRealTimers(); delete global.IS_REACT_ACT_ENVIRONMENT;
  });
  async function type(value) {
    await act(async () => { Simulate.focus(node.querySelector("input")); Simulate.change(node.querySelector("input"), { target: { value } }); });
  }
  async function wait() { await act(async () => jest.advanceTimersByTime(260)); }
  async function submit() { await act(async () => Simulate.submit(node.querySelector("form"))); }

  test("cerca per nome, mostra mercato e seleziona con tastiera", async () => {
    await type("Eni"); await wait();
    expect(global.fetch.mock.calls[0][0]).toContain("q=Eni");
    expect(node.textContent).toContain("Milan"); expect(node.textContent).toContain("Azione");
    await act(async () => Simulate.keyDown(node.querySelector("input"), { key: "ArrowDown" }));
    expect(node.querySelector('input').getAttribute("aria-activedescendant")).toBe(node.querySelector('[role="option"]').id);
    await submit(); expect(select).toHaveBeenCalledWith("ENI.MI");
    expect(JSON.parse(localStorage.getItem("stock-app:recent-searches:v1"))[0].symbol).toBe("ENI.MI");
  });
  test("Invio durante il debounce risolve il nome, mai il suggerimento precedente", async () => {
    await type("Eni"); await wait();
    global.fetch.mockResolvedValueOnce(reply([{ symbol: "TSLA", name: "Tesla" }]));
    await type("Tesla"); await submit();
    expect(select).toHaveBeenCalledWith("TSLA"); expect(select).not.toHaveBeenCalledWith("ENI.MI");
  });
  test("una risposta tardiva non sostituisce la nuova ricerca", async () => {
    let resolve;
    global.fetch.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    await type("Eni"); await wait();
    global.fetch.mockResolvedValueOnce(reply([{ symbol: "TSLA", name: "Tesla" }]));
    await type("Tesla"); await wait();
    await act(async () => resolve(reply([eni])));
    expect(node.textContent).toContain("TSLA"); expect(node.textContent).not.toContain("ENI.MI");
  });
  test("errore del servizio distinto da zero risultati", async () => {
    global.fetch.mockResolvedValueOnce({ ok: false });
    await type("Tesla"); await wait(); expect(node.textContent).toContain("Ricerca non disponibile");
    global.fetch.mockResolvedValueOnce(reply([]));
    await type("Nessuna società"); await wait(); expect(node.textContent).toContain("Nessun titolo trovato");
    expect(select).not.toHaveBeenCalled();
  });
  test("Escape chiude, Invio riapre e risolve, cancellazione mostra i recenti", async () => {
    await type("Eni"); await wait();
    await act(async () => Simulate.keyDown(node.querySelector("input"), { key: "Escape" }));
    expect(node.querySelector('[role="listbox"]')).toBeNull();
    await submit(); await wait(); expect(select).toHaveBeenCalledWith("ENI.MI");
    await act(async () => Simulate.click(node.querySelector('[aria-label="Cancella ricerca"]')));
    expect(node.textContent).toContain("Ricerche recenti"); expect(node.textContent).toContain("ENI.MI");
  });
  test("il ticker esatto ha precedenza sul primo suggerimento", async () => {
    global.fetch.mockResolvedValueOnce(reply([{ symbol: "ENI.DE", name: "Altro mercato" }, eni]));
    await type("ENI.MI"); await wait(); await submit(); expect(select).toHaveBeenCalledWith("ENI.MI");
  });
  test("spazi finali non bloccano i risultati già caricati", async () => {
    await type("Eni"); await wait(); await type("Eni ");
    expect(node.querySelector('[role="option"]')).not.toBeNull();
    await submit(); expect(select).toHaveBeenCalledWith("ENI.MI");
  });
});
