/**
 * lib/sanityCheck.js
 * ---------------------------------------------------------------------------
 * Правило: подозрительное отклонение не публикуется молча. Если новое
 * значение слишком далеко от прошлого прогона — остаётся старое значение,
 * а расхождение падает в review-queue.json на проверку человеку.
 */
const MAX_RELATIVE_CHANGE = {
  revenue: 0.5,
  netIncome: 3.0,
  operatingIncome: 2.0,
  assets: 0.5,
  netAssets: 0.5,
  ocf: 2.0,
  capex: 1.0,
  fcf: 3.0,
  dividendPayout: 3.0,
  amortization: 0.5,
  roe: 1.5,
  roa: 1.5
};

function checkField(key, newValue, previousValue) {
  if (newValue === null || newValue === undefined) {
    return { value: previousValue !== undefined ? previousValue : null, status: "kept_previous", reason: "not_available" };
  }
  if (previousValue === undefined || previousValue === null) {
    return { value: newValue, status: "accepted_first_time" };
  }
  const threshold = MAX_RELATIVE_CHANGE[key] !== undefined ? MAX_RELATIVE_CHANGE[key] : 0.5;
  const base = Math.abs(previousValue) > 1 ? Math.abs(previousValue) : 1;
  const relChange = Math.abs(newValue - previousValue) / base;
  if (relChange > threshold) {
    return {
      value: previousValue,
      status: "flagged_anomaly",
      reason: `изменение ${(relChange * 100).toFixed(0)}% превышает порог ${(threshold * 100).toFixed(0)}%`,
      candidateValue: newValue
    };
  }
  return { value: newValue, status: "accepted" };
}

module.exports = { checkField };
