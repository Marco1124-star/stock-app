import React from "react";

const QuantitativeAnalysis = ({ darkMode }) => {
  return (
    <div className={`container py-5 ${darkMode ? "text-light" : "text-dark"}`}>
      <h2 style={{ color: darkMode ? "#fff" : "#434689" }}>Analisi Quantitativa</h2>
      <p>Volatilità, Sharpe Ratio, Drawdown ecc.</p>
      {/* Inserisci qui i tuoi grafici e tabelle */}
    </div>
  );
};

export default QuantitativeAnalysis;
