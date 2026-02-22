import React from "react";

const FundamentalAnalysis = ({ darkMode }) => {
  return (
    <div className={`container py-5 ${darkMode ? "text-light" : "text-dark"}`}>
      <h2 style={{ color: darkMode ? "#fff" : "#434689" }}>Analisi Fondamentale</h2>
      <p>Qui visualizzerai i grafici e gli indicatori tecnici delle azioni.</p>
      {/* Inserisci qui i tuoi grafici e tabelle */}
    </div>
  );
};

export default FundamentalAnalysis;
