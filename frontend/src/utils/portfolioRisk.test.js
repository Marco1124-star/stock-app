import { buildRiskSelection } from "./portfolioRisk";

const makeHistory = (returns) => {
  let price = 100;
  const rows = [{ date: "2024-01-01", close: price }];
  returns.forEach((value, index) => {
    price *= 1 + value;
    rows.push({ date: `2024-${String(Math.floor(index / 28) + 1).padStart(2, "0")}-${String((index % 28) + 1).padStart(2, "0")}`, close: price });
  });
  return rows;
};

test("seleziona un paniere diversificato con pesi inverse-volatilità", () => {
  const result = buildRiskSelection({
    AAA: makeHistory(Array.from({ length: 120 }, (_, index) => Math.sin(index * 0.21) * 0.006)),
    BBB: makeHistory(Array.from({ length: 120 }, (_, index) => Math.cos(index * 0.17) * 0.004)),
    CCC: makeHistory(Array.from({ length: 120 }, () => 0.02)),
  });
  expect(result.selectedTickers.length).toBeGreaterThanOrEqual(2);
  expect(result.selectedTickers.length).toBeLessThanOrEqual(25);
  expect(result.recommendations).toHaveLength(3);
  expect(result.portfolio.weights.reduce((sum, item) => sum + item.weight, 0)).toBeCloseTo(1, 6);
  expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/);
});
