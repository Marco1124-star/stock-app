import React, { useEffect, useRef } from "react";

const TradingViewChart = ({ symbol, darkMode }) => {
  const containerRef = useRef(null);
  const widgetRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // pulisco il container ogni volta (per ricreare il widget se cambia symbol)
    containerRef.current.innerHTML = "";

    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/tv.js";
    script.async = true;

    script.onload = () => {
      try {
        widgetRef.current = new window.TradingView.widget({
          width: "100%",
          height: 610,
          symbol: symbol,
          interval: "D",
          timezone: "Etc/UTC",
          theme: darkMode ? "dark" : "light",
          style: "1",
          locale: "it",
          toolbar_bg: darkMode ? "#1e1e1e" : "#f1f3f6",
          enable_publishing: false,
          withdateranges: true,
          hide_side_toolbar: false,
          allow_symbol_change: true,
          details: true,
          container_id: containerRef.current.id
        });
      } catch (e) {
        // in caso di errori (es. TW API bloccata), loggalo
        console.error("TradingView widget error:", e);
      }
    };

    containerRef.current.appendChild(script);

    return () => {
      // cleanup: rimuovi il widget se esiste
      if (widgetRef.current && typeof widgetRef.current.remove === "function") {
        try { widgetRef.current.remove(); } catch {}
      }
    };
  }, [symbol, darkMode]);

  return (
    <div
      id={`tv-${symbol}`}
      ref={containerRef}
      style={{ width: "100%", height: "610px" }}
    />
  );
};

export default TradingViewChart;
