import React from "react";
import { FiAlertCircle, FiRefreshCw } from "react-icons/fi";

export const FORWARD_SIGNAL_VERSION = "forward-ridge-v1";

const numeric = (value) => (
  value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
    ? Number(value)
    : null
);

const number = (value, digits = 2) => {
  const result = numeric(value);
  return result === null ? "—" : result.toLocaleString("it-IT", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
};

const percent = (value, digits = 2) => numeric(value) === null ? "—" : `${number(value, digits)}%`;
const proportion = (value) => numeric(value) === null ? "—" : percent(Number(value) * 100, 1);
const signedPercent = (value) => numeric(value) === null ? "—" : `${Number(value) > 0 ? "+" : ""}${percent(value)}`;
const signedPoints = (value) => numeric(value) === null ? "—" : `${Number(value) > 0 ? "+" : ""}${number(value)} p.p.`;
const dateLabel = (value) => {
  if (!value) return "—";
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("it-IT", { day: "numeric", month: "short", year: "numeric" });
};

const HORIZONS = { daily: "1 seduta", monthly: "1 mese · 21 sedute", annual: "1 anno · 252 sedute" };
const ACTIONS = { buy: "Acquista", sell: "Vendi", hold: "Attendi", unavailable: "Non disponibile" };
const STATUSES = {
  ready: "Validazione superata",
  no_edge: "Vantaggio insufficiente",
  insufficient_data: "Storico insufficiente",
  insufficient_validation: "Da validare",
  stale_data: "Dati da aggiornare",
  incompatible_data: "Dati non confrontabili",
};

const Metric = ({ label, value, detail }) => (
  <div className="quant-signal-metric">
    <span>{label}</span>
    <strong>{value}</strong>
    {detail && <small>{detail}</small>}
  </div>
);

const HeatmapSignalCard = ({ signal, ticker, horizon, onRetry }) => {
  const compatible = signal?.version === FORWARD_SIGNAL_VERSION && Object.prototype.hasOwnProperty.call(ACTIONS, signal.action);
  if (!compatible) {
    return (
      <section className="quant-forward-signal is-unavailable" aria-label="Segnale operativo">
        <div className="quant-signal-heading">
          <div>
            <span className="quant-heatmap-kicker">Previsione e decisione</span>
            <h4><FiAlertCircle aria-hidden="true" /> Segnale non disponibile</h4>
            <p>Il servizio non ha restituito una previsione compatibile per questo orizzonte. Aggiorna i dati; se persiste, riavvia il backend aggiornato.</p>
          </div>
          {onRetry && <button type="button" className="quant-heatmap-refresh" onClick={onRetry}><FiRefreshCw aria-hidden="true" /> Riprova segnale</button>}
        </div>
      </section>
    );
  }

  const validation = signal.validation || {};
  const methodology = signal.methodology || {};
  const reasons = Array.isArray(signal.reasons) ? signal.reasons : [];
  const drivers = Array.isArray(signal.drivers) ? signal.drivers : [];
  const sources = (Array.isArray(methodology.sources) ? methodology.sources : []).filter((source) => /^https?:\/\//i.test(source?.url || ""));
  const hasInterval = numeric(signal.interval80?.lowerPct) !== null && numeric(signal.interval80?.upperPct) !== null;
  const interval = hasInterval ? `${percent(signal.interval80.lowerPct)} / ${percent(signal.interval80.upperPct)}` : "—";
  const statusLabel = STATUSES[signal.status] || "Validazione non disponibile";
  // A directional recommendation is shown only when the service says its validation passed.
  const action = signal.status === "ready" ? signal.action : signal.action === "hold" && signal.status === "no_edge" ? "hold" : "unavailable";
  const label = action === "unavailable" && signal.status === "insufficient_validation" ? "Da validare" : ACTIONS[action];

  return (
    <section className={`quant-forward-signal is-${action}`} aria-label={`Segnale operativo ${ticker}`}>
      <div className="quant-signal-heading">
        <div>
          <span className="quant-heatmap-kicker">Previsione e decisione · {ticker}</span>
          <h4>Orizzonte: {HORIZONS[horizon] || "selezionato"}</h4>
          <p>Dati al {dateLabel(signal.asOf)} · ingresso ipotizzato dopo {methodology.executionDelaySessions ?? "—"} seduta · costi totali {number(signal.costBps, 0)} bps</p>
        </div>
        <span className={`quant-signal-status is-${signal.status}`}>{statusLabel}</span>
      </div>

      <div className="quant-signal-overview">
        <div className="quant-signal-decision">
          <span>Indicazione del modello</span>
          <strong>{label}</strong>
          <small>Orientamento {signal.bias || "non stimabile"}</small>
          <small>Affidabilità {signal.confidence || "Non stimabile"}</small>
        </div>
        <div className="quant-signal-metrics">
          <Metric label="Rendimento stimato lordo" value={signedPercent(signal.forecastReturnPct)} detail="Sull’orizzonte selezionato" />
          <Metric label="Intervallo empirico 80%" value={interval} detail="Dagli errori fuori campione" />
          <Metric label="Rialzo oltre i costi · supporto empirico" value={proportion(signal.upsideProbability)} detail="Da residui storici, non una probabilità calibrata" />
          <Metric label="Soglia decisionale ±" value={percent(signal.decisionThresholdPct)} detail="Costi + margine per errore del modello" />
        </div>
      </div>

      <div className="quant-signal-reasons">
        <h5>Perché questo risultato</h5>
        {reasons.length ? <ul>{reasons.map((reason, index) => <li key={`${index}-${reason}`}>{reason}</li>)}</ul> : <p>Motivazioni non disponibili dal servizio.</p>}
      </div>

      <div className="quant-signal-validation">
        <div className="quant-signal-section-heading">
          <h5>Verifica su periodi successivi all’addestramento</h5>
          <span>{dateLabel(validation.start)} – {dateLabel(validation.end)}</span>
        </div>
        <div className="quant-signal-validation-grid">
          <Metric label="Previsioni verificate" value={number(validation.observations, 0)} detail={`${number(validation.nonOverlappingObservations, 0)} finestre non sovrapposte`} />
          <Metric label="Blocchi temporali" value={number(validation.folds, 0)} detail={`Minimo richiesto: ${number(methodology.minValidationObservations, 0)} finestre`} />
          <Metric label="Errore modello (RMSE)" value={percent(validation.rmsePct)} detail={`Media storica: ${percent(validation.baselineRmsePct)}`} />
          <Metric label="Miglioramento sulla media" value={proportion(validation.skillVsBaseline)} detail="Positivo = meno errore della media storica" />
          <Metric label="Direzione corretta" value={proportion(validation.directionAccuracy)} detail={`Media storica: ${proportion(validation.baselineDirectionAccuracy)}`} />
          <Metric label="Stabilità della direzione" value={proportion(validation.stability)} detail="Modelli delle finestre precedenti concordi sulla direzione attuale" />
        </div>
        <p className="quant-signal-footnote">Confronto aggiuntivo con rendimento nullo: errore {percent(validation.zeroRmsePct)}, miglioramento {proportion(validation.skillVsZero)}. Le finestre sovrapposte non sono osservazioni indipendenti.</p>
      </div>

      {drivers.length > 0 && (
        <div className="quant-signal-drivers">
          <div className="quant-signal-section-heading"><h5>Principali contributi alla stima</h5><span>Rispetto ai valori mediani di addestramento</span></div>
          <div className="quant-signal-driver-list">
            {drivers.map((driver, index) => <div className="quant-signal-driver" key={`${driver.feature}-${index}`}><span>{driver.feature}</span><strong className={numeric(driver.contributionPct) === null ? "" : Number(driver.contributionPct) >= 0 ? "is-positive" : "is-negative"}>{signedPoints(driver.contributionPct)}</strong></div>)}
          </div>
          <p className="quant-signal-footnote">Contributi del modello, non effetti causali. I soli contributi principali non ricostruiscono l’intera previsione.</p>
        </div>
      )}

      <details className="quant-signal-methodology">
        <summary>Metodo e limiti della stima</summary>
        <p>{methodology.label || "Regressione predittiva con verifica temporale."}</p>
        {Array.isArray(methodology.caveats) && methodology.caveats.length > 0 && <ul>{methodology.caveats.map((caveat, index) => <li key={index}>{caveat}</li>)}</ul>}
        {sources.length > 0 && <p className="quant-signal-sources">{sources.map((source) => <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer">{source.label}</a>)}</p>}
      </details>
    </section>
  );
};

export default HeatmapSignalCard;
