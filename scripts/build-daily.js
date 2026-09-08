const fs = require("fs");
const path = require("path");

const { fetchAllSecurities, fetchCandles, fetchFuturesOI } = require("../lib/moexIss.js");
const { computeIndicators } = require("../lib/indicators.js");

const DATA_DIR = path.join(__dirname, "..", "data");
const FUNDAMENTALS_PATH = path.join(DATA_DIR, "fundamentals.json");
const MANUAL_PATH = path.join(DATA_DIR, "manual-inputs.json");
const TABLE_PATH = path.join(DATA_DIR, "table.json");

const futuresTickerMapFile = require("../config/futures-ticker-map.json");
const FUTURES_TICKER_MAP = futuresTickerMapFile.map || {};

function loadJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; }
}
function safeDiv(a, b) {
  return (a === null || a === undefined || b === null || b === undefined || b === 0) ? null : a / b;
}
function pct(a, b) {
  const d = safeDiv(a, b);
  return d === null ? null : d * 100;
}

async function main() {
  console.log("Получаю живые цены и капитализацию со всех торгуемых акций MOEX...");
  const securities = await fetchAllSecurities();
  console.log(`Тикеров: ${securities.length}`);

  const fundamentals = loadJsonSafe(FUNDAMENTALS_PATH);
  const manualInputs = loadJsonSafe(MANUAL_PATH);

  console.log("Запрашиваю позиции физ/юр лиц по фьючерсам (FUTOI)...");
  const secids = securities.map((s) => s.secid);
  let futoi = {};
  let futoiDiagnostics = null;
  try {
    var futoiResult = await fetchFuturesOI(FUTURES_TICKER_MAP, secids);
    futoi = futoiResult.result;
    futoiDiagnostics = futoiResult.diagnostics;
    console.log("  FUTOI:", JSON.stringify(futoiDiagnostics));
  } catch (e) {
    console.warn("FUTOI недоступен в этом прогоне:", e.message);
    futoiDiagnostics = { error: e.message };
  }

  const rows = [];
  let i = 0;
  for (const sec of securities) {
    i++;
    const secid = sec.secid;
    const fund = fundamentals[secid] || {};
    const manual = manualInputs[secid] || {};
    const isFinancial = !!fund.isFinancial;

    const marketCap = sec.marketCap;
    const liabilities = (fund.assets !== undefined && fund.assets !== null && fund.netAssets !== undefined && fund.netAssets !== null)
      ? fund.assets - fund.netAssets : null;

    const currentAssets = manual.currentAssets !== undefined ? manual.currentAssets : null;
    const nonCurrentAssets = (fund.assets !== undefined && fund.assets !== null && currentAssets !== null)
      ? fund.assets - currentAssets : null;

    const navNumerator = isFinancial
      ? (fund.netAssets !== undefined ? fund.netAssets : null)
      : (currentAssets !== null && liabilities !== null ? currentAssets - liabilities : null);

    const treasurySharesCount = manual.treasurySharesCount || 0;
    const buybackSpend = manual.buybackSpend || 0;

    // MACD/RSI — считаем сами по свечам раз в сутки
    let indicators = { macd: null, rsi: null, rating: { label: "Н/Д", score: null } };
    try {
      const closes = await fetchCandles(secid);
      if (closes.length) indicators = computeIndicators(closes);
    } catch (e) {
      // неликвидная/делистингованная бумага — пропускаем тихо, не роняем весь прогон
    }

    const row = {
      secid,
      name: fund.shortname || sec.shortname || secid,
      marketCap,
      pe: safeDiv(marketCap, fund.netIncome),
      navPct: pct(navNumerator, marketCap),
      fcfPct: fund.fcf !== undefined && fund.fcf !== null && marketCap
        ? ((fund.fcf - buybackSpend - (fund.dividendPayout || 0)) / marketCap) * 100
        : null,
      profitToNcaPct: pct(fund.netIncome, nonCurrentAssets),
      opMarginPct: pct(fund.operatingIncome, fund.revenue),
      netMarginPct: pct(fund.netIncome, fund.revenue),
      amortToNcaPct: pct(fund.amortization, nonCurrentAssets),
      buybackPct: (treasurySharesCount && sec.last && marketCap)
        ? (treasurySharesCount * sec.last / marketCap) * 100 : (treasurySharesCount === 0 ? 0 : null),
      divPct: pct(fund.dividendPayout, marketCap),
      roe: fund.roe !== undefined ? fund.roe : null,
      roa: fund.roa !== undefined ? fund.roa : null,
      futRatio: futoi[secid] !== undefined ? futoi[secid] : null,
      macd: indicators.macd ? indicators.macd.macd : null,
      macdHist: indicators.macd ? indicators.macd.hist : null,
      rsi: indicators.rsi,
      rating: indicators.rating.label
    };
    rows.push(row);

    if (i % 25 === 0) console.log(`  обработано ${i}/${securities.length}`);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    _futoiDiagnostics: futoiDiagnostics,
    rows
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TABLE_PATH, JSON.stringify(output), "utf8");
  console.log(`\nГотово. Строк: ${rows.length}. Записано в ${TABLE_PATH}.`);
}

main().catch((e) => {
  console.error("Критическая ошибка сборки:", e);
  process.exit(1);
});
