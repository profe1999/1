const fs = require("fs");
const path = require("path");

const { fetchAllSecurities } = require("../lib/moexIss.js");
const { fetchCompanyFundamentals } = require("../lib/scrapeSmartlab.js");
const { checkField } = require("../lib/sanityCheck.js");

const DATA_DIR = path.join(__dirname, "..", "data");
const FUNDAMENTALS_PATH = path.join(DATA_DIR, "fundamentals.json");
const REVIEW_PATH = path.join(DATA_DIR, "review-queue-weekly.json");

const financialSector = require("../config/financial-sector.json");
const tickerOverrides = require("../config/smartlab-ticker-overrides.json");

const FINANCIAL_SET = new Set(financialSector.financialTickers || []);

function loadJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; }
}

// Денежные показатели на smart-lab даны в "млрд руб" — переводим в рубли,
// чтобы единицы совпадали с живой капитализацией (цена × число акций).
const BLN_TO_RUB = 1e9;

const FIELD_MAP_DEFAULT = {
  revenue: "revenue", operatingIncome: "operating_income", netIncome: "net_income",
  ocf: "ocf", capex: "capex", fcf: "fcf", dividendPayout: "dividend_payout",
  amortization: "amortization", assets: "assets", netAssets: "net_assets",
  roe: "roe", roa: "roa"
};
const FIELD_MAP_BANK = {
  revenue: "net_operating_income", operatingIncome: null, netIncome: "net_income",
  ocf: null, capex: null, fcf: null, dividendPayout: "dividend_payout",
  amortization: null, assets: "bank_assets", netAssets: "capital",
  roe: "roe", roa: "roa"
};
// проценты (roe/roa) не переводим в рубли — они уже в %
const PERCENT_FIELDS = new Set(["roe", "roa"]);

function convert(fields, fieldId, key) {
  if (!fieldId || fields[fieldId] === undefined || fields[fieldId] === null) return null;
  return PERCENT_FIELDS.has(key) ? fields[fieldId] : fields[fieldId] * BLN_TO_RUB;
}

async function main() {
  console.log("Получаю список всех торгуемых акций MOEX...");
  const securities = await fetchAllSecurities();
  console.log(`Найдено тикеров: ${securities.length}`);

  const previousData = loadJsonSafe(FUNDAMENTALS_PATH);
  const reviewQueue = [];
  const output = {};

  for (const sec of securities) {
    const secid = sec.secid;
    const isFinancial = FINANCIAL_SET.has(secid);
    const smartlabTicker = (tickerOverrides.map && tickerOverrides.map[secid]) || secid;

    let scraped;
    try {
      scraped = await fetchCompanyFundamentals(smartlabTicker, isFinancial ? "MSFO" : undefined);
    } catch (e) {
      reviewQueue.push({ secid, issue: "smartlab_fetch_failed", error: e.message });
      output[secid] = previousData[secid] || null;
      continue;
    }

    const { fields, reportType } = scraped;
    if (!Object.keys(fields).length) {
      reviewQueue.push({ secid, issue: "smartlab_no_data", note: "Проверьте вручную тикер на smart-lab.ru — возможно, он отличается от SECID (см. config/smartlab-ticker-overrides.json)." });
      output[secid] = previousData[secid] || null;
      continue;
    }

    const map = isFinancial ? FIELD_MAP_BANK : FIELD_MAP_DEFAULT;
    const raw = {};
    for (const key of Object.keys(map)) raw[key] = convert(fields, map[key], key);

    // банки: операционная прибыль явно не публикуется — грубое приближение
    if (isFinancial && raw.operatingIncome === null && fields.opex !== undefined && raw.revenue !== null) {
      raw.operatingIncome = raw.revenue - fields.opex * BLN_TO_RUB;
    }

    const prev = previousData[secid] || {};
    const checked = {};
    for (const key of Object.keys(raw)) {
      const result = checkField(key, raw[key], prev[key]);
      checked[key] = result.value;
      if (result.status === "flagged_anomaly") {
        reviewQueue.push({ secid, field: key, status: result.status, reason: result.reason, candidateValue: result.candidateValue });
      }
    }

    output[secid] = {
      isFinancial,
      shortname: sec.shortname,
      ...checked,
      _reportType: reportType,
      _updatedAt: new Date().toISOString()
    };
    console.log(`${secid}: OK (${reportType})`);
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FUNDAMENTALS_PATH, JSON.stringify(output, null, 2), "utf8");
  fs.writeFileSync(REVIEW_PATH, JSON.stringify(reviewQueue, null, 2), "utf8");
  console.log(`\nГотово. Компаний: ${Object.keys(output).length}. В очереди на проверку: ${reviewQueue.length}.`);
}

main().catch((e) => {
  console.error("Критическая ошибка:", e);
  process.exit(1);
});
