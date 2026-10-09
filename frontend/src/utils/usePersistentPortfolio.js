import { useCallback, useRef, useState } from "react";

function load(key, normalize) {
  try {
    return { key, value: normalize(JSON.parse(localStorage.getItem(key) || "null")), error: "" };
  } catch {
    return { key, value: normalize(null), error: "Impossibile leggere il portafoglio salvato in questo browser." };
  }
}

// Persist in the event handler, not in an effect after the next render.
// Existing per-account keys and legacy normalization are preserved.
export default function usePersistentPortfolio(key, normalize) {
  const [state, setState] = useState(() => load(key, normalize));
  const current = useRef(state);
  if (state.key !== key) {
    const restored = load(key, normalize);
    current.current = restored;
    setState(restored);
  }
  const update = useCallback((updater) => {
    // A quote request belonging to a previous account must not update this one.
    if (current.current.key !== key) return;
    const value = normalize(typeof updater === "function" ? updater(current.current.value) : updater);
    let error = "";
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      error = "Portafoglio aggiornato solo in memoria: salvataggio non riuscito. Non chiudere la pagina; verifica lo spazio e i permessi del browser.";
    }
    const next = { key, value, error };
    current.current = next;
    setState(next);
  }, [key, normalize]);
  return [state.value, update, state.error];
}
