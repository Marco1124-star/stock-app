import React, { useEffect, useRef, useState } from "react";
import { FiActivity, FiArrowRight, FiRefreshCw } from "react-icons/fi";
import { apiUrl } from "../services/apiBase";
import "./StructureNeuralCard.css";

export const STRUCTURE_NEURAL_VERSION = "structure-neural-v4.2";
const MODES = { "1d": [1, 70, 1, 0.6, "1D"], "1w": [5, 80, 2, 1.2, "1W"], "1mo": [21, 90, 4, 2.5, "1M"] };
const numeric = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
const number = (value, digits = 2) => numeric(value) === null ? "—" : Number(value).toLocaleString("it-IT", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const percent = (value, digits = 1) => numeric(value) === null ? "—" : `${number(value, digits)}%`;
const parameter = (value, fallback) => value === "" || value === undefined || value === null ? fallback : numeric(value);
const statusLabel = (status) => status === "validated" ? "Validazione fuori campione superata" : status === "experimental" ? "Non confermato fuori campione" : "Dati insufficienti per validare";
const trendLabel = (label) => ({ up: "Rialzista", down: "Ribassista", flat: "Laterale" }[label] || label || "Non disponibile");
const gapSide = (gap, price) => numeric(price) === null ? "—" : Number(gap.start) > price ? "Sopra il prezzo" : Number(gap.end) < price ? "Sotto il prezzo" : "Sul prezzo";
const gapId = (gap) => `${gap.date}|${gap.type}|${gap.start}|${gap.end}`;

function Validation({ value = {}, gap = false, selection }) {
  value = value || {};
  const calibration = selection?.calibration;
  return <>
  {selection?.name && <p className="structure-neural__muted">{selection.name} · {number(selection.folds, 0)} finestre di selezione temporale</p>}
  <dl className="structure-neural__validation">
    <div><dt>Finestre fuori campione</dt><dd>{number(value.windows, 0)}</dd></div>
    <div><dt>Accuratezza / riferimento</dt><dd>{percent(value.accuracyPct)} / {percent(value.baselineAccuracyPct)}</dd></div>
    <div><dt>Errori di classificazione osservati</dt><dd>{percent(value.errorPct)}</dd></div>
    <div><dt>Accuratezza bilanciata fra gli esiti</dt><dd>{percent(value.balancedAccuracyPct)}</dd></div>
    {gap && <div><dt>Osservazioni sui gap</dt><dd>{number(value.observations, 0)}</dd></div>}
    {gap && <><div><dt>Finestre con primo target effettivo</dt><dd>{number(value.targetWindows, 0)}</dd></div>
      <div><dt>Primo gap corretto / semplice gap più vicino</dt><dd>{percent(value.firstTargetRankingAccuracyPct)} / {percent(value.nearestGapRankingAccuracyPct)}</dd></div>
      <div><dt>Target con probabilità ≥60%: correttezza / finestre</dt><dd>{percent(value.highProbabilityTargetPrecisionPct)} / {number(value.highProbabilityTargetWindows, 0)}</dd></div></>}
    <div><dt>Brier / riferimento · più basso è meglio</dt><dd>{number(value.brier, 3)} / {number(value.baselineBrier, 3)}</dd></div>
  </dl>
  <p className="structure-neural__muted">L’errore indica esiti classificati male nel test storico, non un errore percentuale sul prezzo futuro. Un’alta accuratezza può dipendere dall’esito più frequente: confronta anche riferimento e accuratezza bilanciata.</p>
  {selection && <details className="structure-neural__precision"><summary>Confronto degli errori e calibrazione</summary>
    <dl className="structure-neural__validation">
      <div><dt>Brier MLP di riferimento</dt><dd>{number(value.incumbentBrier, 3)}</dd></div>
      <div><dt>Brier del confronto lineare</dt><dd>{number(value.linearBrier, 3)}</dd></div>
      <div><dt>Intervallo bootstrap 95% del Brier</dt><dd>{number(value.brierInterval95?.low, 3)} – {number(value.brierInterval95?.high, 3)}</dd></div>
      <div><dt>Log loss · più bassa è meglio</dt><dd>{number(value.logLoss, 3)}</dd></div>
      <div><dt>Variazione Brier rispetto al riferimento</dt><dd>{percent(value.skillPct)}</dd></div>
      <div><dt>Osservazioni che superano i filtri di confidenza</dt><dd>{percent(value.coveragePct)}</dd></div>
      <div><dt>Accuratezza solo su queste osservazioni</dt><dd>{percent(value.selectiveAccuracyPct)}</dd></div>
    </dl>
    <p>{calibration?.method === "temperature"
      ? `Calibrazione temporale applicata: temperatura ${number(calibration.temperature, 2)}, stimata su ${number(calibration.windows, 0)} finestre fuori campione.`
      : "Probabilità non calibrate: campione insufficiente o nessun vantaggio di calibrazione rilevato nello sviluppo."}</p>
    <p className="structure-neural__muted">Una variazione Brier positiva indica un miglioramento rispetto alle frequenze storiche; negativa indica un peggioramento. La calibrazione cerca di correggere le probabilità, ma non garantisce un errore piccolo. I pesi e la calibrazione attuali sono riaddestrati: le metriche descrivono il test storico della procedura, non una garanzia sui nuovi risultati.</p>
    {Array.isArray(value.calibrationBins) && <ul>{value.calibrationBins.map((bin) => <li key={bin.fromPct}>Confidenza {number(bin.fromPct, 0)}–{number(bin.toPct, 0)}%: media dichiarata {percent(bin.meanConfidencePct)}, correttezza osservata {percent(bin.accuracyPct)} su {number(bin.windows, 0)} finestre.</li>)}</ul>}
  </details>}
  </>;
}

export default function StructureNeuralCard({ ticker, timeframe, onTimeframeChange, zones, gaps = [], candles = [], strengthPct, minDistancePct, gapPct, loading = false }) {
  const mode = MODES[timeframe] || MODES["1d"];
  const [horizon, strength, distance, gapDefault, modeLabel] = mode;
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [jobState, setJobState] = useState("");
  const request = useRef(null);
  const epoch = useRef(0);
  const currentSignature = useRef("");
  const symbol = String(ticker || "").trim().toUpperCase();
  const last = candles[candles.length - 1];
  const snapshot = {
    price: numeric(last?.close), asOf: last?.date || null, gapWindowBars: candles.length,
    zones: zones || { support: [], resistance: [] },
    gaps: gaps.map((gap) => ({ id: gapId(gap), date: gap.date, type: gap.type, start: numeric(gap.start), end: numeric(gap.end), fillPct: numeric(gap.fillPct) })),
  };
  const body = { horizon, timeframe, strength: parameter(strengthPct, strength), min_pct: parameter(minDistancePct, distance), gap_pct: parameter(gapPct, gapDefault), snapshot };
  const signature = JSON.stringify({ symbol, timeframe, loading, body });
  currentSignature.current = signature;
  const supported = Object.prototype.hasOwnProperty.call(MODES, timeframe);
  const validParams = body.strength !== null && body.strength >= 0 && body.strength <= 100 && body.min_pct !== null && body.min_pct >= 0 && body.min_pct <= 50 && body.gap_pct !== null && body.gap_pct >= 0 && body.gap_pct <= 50;
  const validSnapshot = snapshot.price > 0 && Boolean(snapshot.asOf) && !Number.isNaN(Date.parse(snapshot.asOf)) &&
    ["support", "resistance"].every((key) => Array.isArray(snapshot.zones[key]) && snapshot.zones[key].every((zone) => numeric(zone.price) !== null)) &&
    snapshot.gaps.every((gap) => gap.start > 0 && gap.end >= gap.start && gap.fillPct !== null && gap.fillPct >= 0 && gap.fillPct < 50);
  const ready = supported && Boolean(symbol) && validParams && validSnapshot && !loading;
  const data = !loading && result?.signature === signature ? result.data : null;
  const currentError = error?.signature === signature ? error.message : "";

  useEffect(() => {
    epoch.current += 1;
    request.current?.abort();
    setBusy(false);
    setResult(null);
    setError(null);
    return () => {
      epoch.current += 1;
      request.current?.abort();
    };
  }, [signature]);

  const analyze = async () => {
    if (!ready || busy) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const requestEpoch = ++epoch.current;
    setBusy(true);
    setJobState("");
    setResult(null);
    setError(null);
    try {
      const response = await fetch(apiUrl(`/stock/${encodeURIComponent(symbol)}/structure-neural/jobs`), {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify(body),
      });
      let payload = await response.json();
      if (controller.signal.aborted || requestEpoch !== epoch.current || signature !== currentSignature.current) return;
      if (!response.ok) throw new Error(payload.error || payload.reason || "Analisi non disponibile. Riprova tra poco.");
      const jobId = payload.jobId;
      const started = Date.now();
      while (jobId && payload.status !== "complete") {
        if (payload.status === "failed") throw new Error(payload.error || "Addestramento non completato.");
        if (!["queued", "running"].includes(payload.status)) throw new Error("Stato dell'analisi non valido.");
        if (Date.now() - started > 12 * 60 * 1000) throw new Error("Attesa prolungata: riprova per recuperare il risultato, senza duplicare l'analisi.");
        setJobState(payload.status);
        await new Promise((resolve, reject) => {
          const onAbort = () => { clearTimeout(timer); reject(new DOMException("Annullato", "AbortError")); };
          const timer = setTimeout(() => { controller.signal.removeEventListener("abort", onAbort); resolve(); }, 2000);
          controller.signal.addEventListener("abort", onAbort, { once: true });
          if (controller.signal.aborted) onAbort();
        });
        const statusResponse = await fetch(apiUrl(`/stock/${encodeURIComponent(symbol)}/structure-neural/jobs/${encodeURIComponent(jobId)}`), { signal: controller.signal });
        payload = await statusResponse.json();
        if (controller.signal.aborted || requestEpoch !== epoch.current || signature !== currentSignature.current) return;
        if (!statusResponse.ok) throw new Error(payload.error || "Impossibile recuperare l'analisi.");
      }
      if (jobId) payload = payload.result;
      if (!payload) throw new Error("Risultato del modello mancante.");
      if (payload.version !== STRUCTURE_NEURAL_VERSION || payload.timeframe !== timeframe || !["ready", "unavailable"].includes(payload.status) || ((payload.requestedSymbol || payload.symbol) && (payload.requestedSymbol || payload.symbol) !== symbol) || Number(payload.horizon) !== horizon) {
        throw new Error("Risposta del modello non compatibile. Aggiorna la pagina e riprova.");
      }
      setResult({ signature, data: payload });
    } catch (failure) {
      if (controller.signal.aborted || requestEpoch !== epoch.current || signature !== currentSignature.current) return;
      setError({ signature, message: failure.message || "Impossibile contattare il modello. Riprova." });
    } finally {
      if (requestEpoch === epoch.current && signature === currentSignature.current) setBusy(false);
    }
  };

  const trend = data?.trend;
  const gapModel = data?.gaps;
  // Only display gaps that still exist, with the exact identity and prices on this page.
  const pageGaps = new Map(snapshot.gaps.map((gap) => [gap.id, gap]));
  const candidates = (Array.isArray(gapModel?.candidates) ? gapModel.candidates : []).filter((gap) => pageGaps.has(gap.id)).map((gap) => ({ ...gap, ...pageGaps.get(gap.id) }));
  const selected = gapModel?.status === "validated" && gapModel?.selectedId ? candidates.find((gap) => gap.id === gapModel.selectedId && gap.usable === true) : null;
  const referencePrice = numeric(data?.inputSummary?.price) ?? snapshot.price;

  return <section className="structure-neural" aria-labelledby="structure-neural-title" aria-busy={busy}>
    <header className="structure-neural__header">
      <div className="structure-neural__heading">
        <span className="structure-neural__icon" aria-hidden="true"><FiActivity /></span>
        <div><span className="structure-neural__eyebrow">Modello integrato · 1D / 1W / 1M</span><h2 id="structure-neural-title">Trend, percorso e obiettivi gap</h2></div>
      </div>
      <span className="structure-neural__ticker">{symbol || "Seleziona un titolo"} · {modeLabel}</span>
    </header>
    <p className="structure-neural__intro">Reti neurali confrontate con modelli lineari e LightGBM. Integra struttura del prezzo, gap, Tecnici, Stagionalità, rischio e bilanci storici disponibili. Nessun valore di oggi viene retrodatato nei test.</p>
    <div className="structure-neural__controls">
      <label>Periodo<select aria-label="Orizzonte rete neurale" value={timeframe} disabled={!onTimeframeChange} onChange={(event) => onTimeframeChange?.(event.target.value)}>
        <option value="1d">1D · prossima seduta</option><option value="1w">1W · prossime 5 sedute</option><option value="1mo">1M · prossime 21 sedute</option>
      </select></label>
      <button type="button" className="structure-neural__run" disabled={!ready || busy} onClick={analyze}>
        {busy ? <FiRefreshCw className="structure-neural__spin" aria-hidden="true" /> : <FiArrowRight aria-hidden="true" />}
        {busy ? "Addestramento e verifica…" : currentError ? "Riprova analisi" : "Analizza trend e gap"}
      </button>
      {busy && <button type="button" className="structure-neural__cancel" onClick={() => { epoch.current += 1; request.current?.abort(); setBusy(false); }}>Annulla attesa</button>}
    </div>
    <p className="structure-neural__muted">Livelli {modeLabel} · gap del grafico giornaliero · orizzonte {horizon} {horizon === 1 ? "seduta" : "sedute"}. Stime e validazione separate per ciascun periodo.</p>
    {!supported && <p className="structure-neural__notice" role="status">Seleziona 1D, 1W o 1M nei controlli della pagina.</p>}
    {supported && loading && <p className="structure-neural__notice" role="status">Attendo l’aggiornamento dei supporti, delle resistenze e dei gap…</p>}
    {supported && !loading && (!validSnapshot || !validParams) && <p className="structure-neural__notice" role="status">Dati della pagina incompleti o parametri non validi. Aggiorna i dati prima di avviare l’analisi.</p>}
    {ready && !data && !currentError && !busy && <p className="structure-neural__muted">Avvio manuale: addestramento sullo storico del titolo e verifica temporale fuori campione. L’analisi può richiedere alcuni minuti.</p>}
    {busy && <p className="structure-neural__muted" role="status">{jobState === "queued" ? "Analisi in coda." : "Analisi in un processo separato: recupero dati, addestramento e verifica temporale."} Puoi continuare a usare le altre pagine. Annullare l’attesa non interrompe il lavoro; un nuovo avvio identico recupera lo stesso job.</p>}
    {currentError && <p className="structure-neural__error" role="alert">{currentError}</p>}
    {data?.status === "unavailable" && <p className="structure-neural__notice" role="status">{data.reason || "Storico insufficiente per addestrare e verificare la rete neurale."}</p>}
    {data?.status === "ready" && <>
      <p className="structure-neural__source">Dati al {String(data.asOf || snapshot.asOf).slice(0, 10)} · Chiusura {number(referencePrice)} {data.currency || ""} · {number(data.inputSummary?.supports, 0)} supporti · {number(data.inputSummary?.resistances, 0)} resistenze · {number(data.inputSummary?.openGaps, 0)} gap aperti</p>
      <div className="structure-neural__results">
        <article className="structure-neural__panel">
          <h3>Trend stimato · {horizon} sedute</h3>
          <span className={`structure-neural__badge ${trend?.status === "validated" ? "is-validated" : ""}`}>{statusLabel(trend?.status)}</span>
          <strong className="structure-neural__headline">{trend?.status === "unavailable" ? "Trend non disponibile" : trendLabel(trend?.label)}</strong>
          {trend?.status !== "unavailable" && <div className="structure-neural__probabilities">
            {[["up", "Rialzo"], ["flat", "Laterale"], ["down", "Ribasso"]].map(([key, label]) => <div key={key}><span>{label}</span><strong>{percent(trend?.probabilities?.[key])}</strong></div>)}
          </div>}
          {trend?.reason && <p>{trend.reason}</p>}
          {numeric(data.neutralBandPct) !== null && <p>Laterale: rendimento finale entro ±{percent(data.neutralBandPct, 2)}, soglia adattata alla volatilità.</p>}
          {trend?.reliability?.abstain && <p className="structure-neural__notice" role="status"><strong>Segnale sospeso.</strong> {trend.reliability.reason}</p>}
          <Validation value={trend?.validation} selection={trend?.modelSelection} />
          <small className="structure-neural__muted">Campioni di addestramento: {number(trend?.trainingRows, 0)}. Le stime non garantiscono il rendimento futuro.</small>
        </article>
        <article className="structure-neural__panel">
          <h3>Gap candidato</h3>
          <span className={`structure-neural__badge ${gapModel?.status === "validated" ? "is-validated" : ""}`}>{statusLabel(gapModel?.status)}</span>
          <strong className="structure-neural__headline">{selected ? `${number(selected.start)} – ${number(selected.end)}` : "Nessun gap confermato"}</strong>
          {selected && <p>{selected.type} · {String(selected.date).slice(0, 10)} · {gapSide(selected, referencePrice)} · stima {percent(selected.probabilityPct)}</p>}
          {gapModel?.reason && <p>{gapModel.reason}</p>}
          <p>Obiettivo: essere il primo gap candidato a raggiungere almeno il 50% di riempimento entro {horizon} sedute, prima dell’invalidazione sul livello opposto. Non significa chiusura completa. Il primo gap può essere opposto al trend finale.</p>
          {data.noGap && <p>Nessun target valido entro l’orizzonte: {percent(data.noGap.probabilityPct)} · {statusLabel(data.noGap.status)}.</p>}
          <Validation value={gapModel?.validation} selection={gapModel?.modelSelection} gap />
          <small className="structure-neural__muted">Campioni di addestramento: {number(gapModel?.trainingRows, 0)}.</small>
        </article>
      </div>
      {(data.returnInterval || data.path) && <div className="structure-neural__results">
        <article className="structure-neural__panel">
          <h3>Intervallo del rendimento · {modeLabel}</h3>
          {data.returnInterval?.status === "unavailable" ? <p>{data.returnInterval.reason}</p> : <>
            <strong className="structure-neural__headline">{percent(data.returnInterval?.lowerPct)} — {percent(data.returnInterval?.upperPct)}</strong>
            <p>Mediana stimata: {percent(data.returnInterval?.medianPct)}. Quantili 10–90%, copertura nominale 80%.</p>
            <p>Copertura osservata fuori campione: {percent(data.returnInterval?.observedCoveragePct)} su {number(data.returnInterval?.testWindows, 0)} finestre. Errore assoluto medio della mediana: {percent(data.returnInterval?.medianAbsoluteErrorPct)}.</p>
            <small>Intervallo sperimentale del rendimento rettificato, non garanzia sul prezzo futuro.</small>
          </>}
        </article>
        <article className="structure-neural__panel">
          <h3>Quale movimento avviene prima?</h3>
          <span className="structure-neural__badge">{statusLabel(data.path?.status)}</span>
          <p>Barriere a ±{percent(data.path?.barrierPct)} dalla chiusura di riferimento.</p>
          <div className="structure-neural__probabilities">{[["up", "Prima sopra"], ["down", "Prima sotto"], ["neither", "Nessuna barriera"]].map(([key, label]) => <div key={key}><span>{label}</span><strong>{percent(data.path?.probabilities?.[key])}</strong></div>)}</div>
          {data.path?.reliability?.abstain && <p className="structure-neural__notice">Segnale sospeso: {data.path.reliability.reason}</p>}
          {data.path?.reason && <p>{data.path.reason}</p>}
          <small>Ordine non ricostruibile se entrambe le barriere sono toccate nella stessa candela: {number(data.eventAudit?.ambiguousPathAnchors, 0)} casi storici esclusi.</small>
          <Validation value={data.path?.validation} selection={data.path?.modelSelection} />
        </article>
      </div>}
      {Array.isArray(data.sourceCoverage) && <details className="structure-neural__details" open><summary>Dati del sito effettivamente utilizzati</summary>
        <ul>{data.sourceCoverage.map((source) => <li key={source.page}><strong>{source.page}: {source.status === "included" ? "incluso" : "non disponibile"}.</strong> {source.detail}</li>)}</ul>
        <p>Campioni gap ambigui esclusi: {number(data.eventAudit?.ambiguousGapAnchors, 0)} / {number(data.eventAudit?.gapAnchors, 0)}. Le stime del primo target valgono per i casi ordinabili, non per tutte le sedute.</p>
      </details>}
      {candidates.length > 0 && <div className="structure-neural__ranking">
        <h3>Gap aperti della pagina · stime del modello</h3>
        <p>Probabilità stimate separatamente di essere il primo target valido: non sommano al 100% e non costituiscono una distribuzione congiunta. Casi intraday ambigui esclusi; stime, non certezze.</p>
        <div className="structure-neural__table-wrap" tabIndex={0} role="region" aria-label="Graduatoria dei gap aperti">
          <table><thead><tr><th>Gap e data</th><th>Intervallo di prezzo</th><th>Posizione</th><th>Già riempito</th><th>Primo target ≥50%</th></tr></thead>
            <tbody>{candidates.map((candidate) => {
              const gap = pageGaps.get(candidate.id);
              return <tr key={gap.id} className={selected?.id === gap.id ? "is-selected" : ""}>
                <td><strong>{gap.type}</strong><small>{String(gap.date).slice(0, 10)}{selected?.id === gap.id ? " · candidato confermato" : ""}</small></td>
                <td>{number(gap.start)} – {number(gap.end)}</td><td>{gapSide(gap, referencePrice)}</td><td>{percent(gap.fillPct)}</td><td>{percent(candidate.probabilityPct)}{candidate.outOfDistribution ? <small>Fuori dal dominio storico</small> : candidate.usable === false ? <small>Confidenza insufficiente o reti discordanti</small> : gapModel?.status !== "validated" ? <small>Stima sperimentale</small> : null}</td>
              </tr>;
            })}</tbody></table>
        </div>
      </div>}
      {!snapshot.gaps.length && <p className="structure-neural__notice">Non ci sono gap aperti nella pagina da valutare.</p>}
    </>}
    {data && <details className="structure-neural__details"><summary>Metodo e limiti</summary>
      <p>Input: i livelli e i gap aperti della pagina, con controlli su formato e aggiornamento. Le finestre di validazione sono successive ai dati usati per addestrare il modello; il riferimento serve a verificare se la rete aggiunge informazione.</p>
      <p>Il punteggio Brier misura l’errore delle probabilità: più basso è meglio. «Non confermato» significa che non ci sono prove sufficienti di un vantaggio fuori campione. Nessuna raccomandazione automatica di acquisto o vendita.</p>
      {Array.isArray(data.caveats) && data.caveats.length > 0 && <ul>{data.caveats.map((text, index) => <li key={index}>{text}</li>)}</ul>}
    </details>}
  </section>;
}
