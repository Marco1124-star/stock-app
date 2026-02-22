import React from "react";
import { Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
} from "chart.js";

// Registriamo i componenti Chart.js
ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend);

const StockDetails = ({ stock }) => {
  if (!stock) return null;

  // Prepara i dati per il grafico
  const chartData = {
    labels: stock.price.map(p => p.date),
    datasets: [
      {
        label: `${stock.symbol} - Prezzo Close`,
        data: stock.price.map(p => p.close),
        fill: false,
        borderColor: "#434689",
        backgroundColor: "#434689",
        tension: 0.2,
      },
    ],
  };

  const chartOptions = {
    responsive: true,
    plugins: {
      legend: {
        display: true,
      },
      title: {
        display: true,
        text: `Prezzi ultimi 5 giorni di ${stock.info.shortName}`,
      },
    },
    scales: {
      y: {
        beginAtZero: false,
      },
    },
  };

  return (
    <div className="card p-3 mt-3">
      <h4>{stock.info.shortName} ({stock.symbol})</h4>
      <p>Prezzo: {stock.info.currentPrice}</p>
      <p>Settore: {stock.info.sector}</p>
      <p>Market Cap: {stock.info.marketCap}</p>

      <div className="mt-4">
        <Line data={chartData} options={chartOptions} />
      </div>
    </div>
  );
};

export default StockDetails;
