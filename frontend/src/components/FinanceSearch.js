import React, { useEffect, useId, useRef, useState } from "react";
import { FiSearch, FiX, FiClock, FiArrowUpRight } from "react-icons/fi";
import { apiUrl } from "../services/apiBase";
import "./FinanceSearch.css";

const RECENTS_KEY = "stock-app:recent-searches:v1";
const typeLabel = (type) => ({ EQUITY: "Azione", ETF: "ETF", MUTUALFUND: "Fondo", INDEX: "Indice", CURRENCY: "Valuta", CRYPTOCURRENCY: "Crypto", FUTURE: "Future" }[type] || "Titolo");
function readRecent() {
  try {
    const saved = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter(x => x && typeof x.symbol === "string" && typeof x.name === "string").slice(0, 6) : [];
  } catch { return []; }
}
function Highlight({ text, query }) {
  const value = String(text || "");
  const at = value.toLowerCase().indexOf(query.trim().toLowerCase());
  if (at < 0 || !query.trim()) return value;
  return <>{value.slice(0, at)}<mark>{value.slice(at, at + query.trim().length)}</mark>{value.slice(at + query.trim().length)}</>;
}

export default function FinanceSearch({ value, onChange, onSelect }) {
  const id = useId();
  const input = useRef(null);
  const controller = useRef(null);
  const timer = useRef(null);
  const sequence = useRef(0);
  const pendingSubmit = useRef(false);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [recent, setRecent] = useState(readRecent);
  const [active, setActive] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const query = value.trim();
  const rows = query ? items : recent;

  const cancel = () => {
    sequence.current += 1;
    controller.current?.abort();
    clearTimeout(timer.current);
  };
  const close = () => { cancel(); pendingSubmit.current = false; setOpen(false); setBusy(false); setActive(-1); };
  const choose = (item) => {
    const next = [item, ...recent.filter(x => x.symbol !== item.symbol)].slice(0, 6);
    setRecent(next);
    try { localStorage.setItem(RECENTS_KEY, JSON.stringify(next)); } catch { /* optional storage */ }
    close();
    input.current?.blur();
    onSelect(item.symbol);
  };

  async function lookup(text, submit = false) {
    cancel();
    const token = sequence.current;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true); setError(""); setItems([]); setActive(-1);
    try {
      const response = await fetch(apiUrl(`/search/suggestions?q=${encodeURIComponent(text)}&limit=10`), { signal: abort.signal });
      if (!response.ok) throw new Error("Ricerca non disponibile. Riprova tra poco.");
      const data = await response.json();
      if (data.error) throw new Error("Ricerca non disponibile. Riprova tra poco.");
      if (sequence.current !== token || abort.signal.aborted) return;
      const seen = new Set();
      const found = (Array.isArray(data.suggestions) ? data.suggestions : []).filter(x => {
        if (!x || typeof x.symbol !== "string" || !x.symbol.trim() || seen.has(x.symbol)) return false;
        seen.add(x.symbol); return true;
      }).map(x => ({ ...x, name: typeof x.name === "string" ? x.name : x.symbol }));
      setItems(found);
      if (submit && found.length) choose(found.find(x => x.symbol.toUpperCase() === text.toUpperCase()) || found[0]);
    } catch (e) {
      if (sequence.current === token && !abort.signal.aborted) setError(e.message);
    } finally {
      if (sequence.current === token) setBusy(false);
    }
  }

  useEffect(() => {
    cancel(); setItems([]); setError(""); setActive(-1); setBusy(Boolean(open && query));
    if (open && query) {
      const submitted = pendingSubmit.current;
      pendingSubmit.current = false;
      timer.current = setTimeout(() => lookup(query, submitted), submitted ? 0 : 250);
    }
    return cancel;
    // lookup uses the query captured by this effect; sequence guards stale responses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open]);
  useEffect(() => {
    if (open && active >= 0) document.getElementById(`${id}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, open, id]);

  function submit(event) {
    event.preventDefault();
    if (event.nativeEvent?.isComposing || !query) return;
    if (open && active >= 0 && rows[active]) { choose(rows[active]); return; }
    if (!open) { pendingSubmit.current = true; setOpen(true); return; }
    if (items.length && !busy) choose(items.find(x => x.symbol.toUpperCase() === query.toUpperCase()) || items[0]);
    else lookup(query, true);
  }

  return <form className={`finance-search${open ? " is-open" : ""}`} role="search" onSubmit={submit}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }}>
    <div className="finance-search-field">
      <FiSearch aria-hidden="true" />
      <input ref={input} type="search" role="combobox" aria-label="Cerca per nome o ticker" aria-autocomplete="list"
        aria-expanded={open} aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={open && active >= 0 && rows[active] ? `${id}-${active}` : undefined}
        placeholder="Cerca un nome o un ticker" autoComplete="off" spellCheck={false} maxLength={80} value={value}
        onFocus={() => setOpen(true)} onClick={() => setOpen(true)}
        onChange={event => {
          if (event.target.value.trim() !== query) { cancel(); setItems([]); setBusy(Boolean(event.target.value.trim())); setActive(-1); }
          setOpen(true); onChange(event.target.value);
        }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") { event.preventDefault(); close(); }
          if (event.key === "Enter" && !query && active >= 0 && rows[active]) { event.preventDefault(); choose(rows[active]); }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault(); setOpen(true);
            if (rows.length) setActive(current => event.key === "ArrowDown" ? (current + 1) % rows.length : (current <= 0 ? rows.length - 1 : current - 1));
          }
        }} />
      {busy && <span className="finance-search-spinner" aria-hidden="true" />}
      {value && <button type="button" className="finance-search-clear" aria-label="Cancella ricerca" onClick={() => {
        cancel(); setItems([]); setBusy(false); onChange(""); setOpen(true); input.current?.focus();
      }}><FiX aria-hidden="true" /></button>}
    </div>
    {open && <div className="finance-search-panel">
      <div className="finance-search-caption"><span>{query ? "Titoli" : "Ricerche recenti"}</span>
        {!query && recent.length > 0 && <button type="button" onClick={() => {
          setRecent([]); setActive(-1); try { localStorage.removeItem(RECENTS_KEY); } catch { /* optional */ }
        }}>Svuota</button>}
      </div>
      <div role="status" aria-live="polite" className="finance-search-status">
        {busy ? "Ricerca in corso…" : error || (rows.length ? `${rows.length} risultati` : query ? "Nessun titolo trovato. Prova il nome completo o il ticker con la borsa, ad esempio ENI.MI." : "Cerca azioni, ETF, fondi, indici e valute.")}
      </div>
      <div id={`${id}-list`} role="listbox" aria-label={query ? "Titoli trovati" : "Titoli recenti"} aria-busy={busy} className="finance-search-list">
        {!busy && !error && rows.map((item, index) => <div key={item.symbol} id={`${id}-${index}`} role="option" aria-selected={active === index}
          className={`finance-search-result${active === index ? " is-active" : ""}`} onMouseEnter={() => setActive(index)}
          onMouseDown={event => event.preventDefault()} onClick={() => choose(item)}>
          <span className="finance-search-symbol">{!query && <FiClock aria-hidden="true" />}<Highlight text={item.symbol} query={query} /></span>
          <span className="finance-search-name"><Highlight text={item.name} query={query} /><small>{item.exchange || "Mercato non indicato"}</small></span>
          <span className="finance-search-type">{typeLabel(item.type)}</span><FiArrowUpRight aria-hidden="true" />
        </div>)}
      </div>
      <div className="finance-search-footer">↑ ↓ per scegliere <span>Invio per aprire · Esc per chiudere</span></div>
    </div>}
  </form>;
}
