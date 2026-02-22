import React, { useState } from "react";

const SearchBar = ({ onSearch }) => {
  const [ticker, setTicker] = useState("");

  const handleSubmit = (e) => {
    e.preventDefault();
    if (ticker.trim() !== "") onSearch(ticker.toUpperCase());
  };

  return (
    <form onSubmit={handleSubmit} className="d-flex mb-3">
      <input
        type="text"
        className="form-control"
        placeholder="Es. AAPL, TSLA, VUSA"
        value={ticker}
        onChange={(e) => setTicker(e.target.value)}
      />
      <button className="btn btn-primary ms-2">Cerca</button>
    </form>
  );
};

export default SearchBar;
