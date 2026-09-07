function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

function computeMACD(closes) {
  if (closes.length < 35) return null;
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = closes.map((_, i) => ema12[i] - ema26[i]);
  const signalLine = ema(macdLine, 9);
  const last = macdLine.length - 1;
  return { macd: macdLine[last], signal: signalLine[last], hist: macdLine[last] - signalLine[last] };
}

function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function sma(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(closes.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function buildRating(closes, macdObj, rsi) {
  if (!macdObj || rsi === null) return { label: "Н/Д", score: null };
  let score = 0;
  if (macdObj.hist > 0) score++; else if (macdObj.hist < 0) score--;
  const sma20 = sma(closes, 20), sma50 = sma(closes, 50);
  const last = closes[closes.length - 1];
  if (sma20 !== null) score += last > sma20 ? 1 : -1;
  if (sma50 !== null) score += last > sma50 ? 1 : -1;
  if (rsi > 70) score--; else if (rsi < 30) score++;
  else if (rsi > 55) score++; else if (rsi < 45) score--;

  if (score >= 3) return { label: "Активно покупать", score };
  if (score >= 1) return { label: "Покупать", score };
  if (score <= -3) return { label: "Активно продавать", score };
  if (score <= -1) return { label: "Продавать", score };
  return { label: "Нейтрально", score };
}

function computeIndicators(closes) {
  const macd = computeMACD(closes);
  const rsi = computeRSI(closes);
  const rating = buildRating(closes, macd, rsi);
  return { macd, rsi, rating };
}

module.exports = { computeIndicators };
