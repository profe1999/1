const cheerio = require("cheerio");
const { fetch } = require("./httpClient.js");

/**
 * lib/scrapeSmartlab.js
 * ---------------------------------------------------------------------------
 * Источник: https://smart-lab.ru/q/{TICKER}/f/y/{MSFO|RSBU}/
 * Каждая строка таблицы — один показатель, ссылка в первой ячейке ведёт на
 * /q/{TICKER}/{MSFO|RSBU}/{field_id}/ — это и есть машинное имя показателя.
 * Берём последнее непустое значение в строке (обычно это LTM — последние
 * 12 месяцев, самые свежие данные; если LTM пуст — последний доступный год).
 *
 * ВАЖНО: внизу страниц smart-lab указано, что источник и правообладатель
 * биржевых данных — Московская биржа, и их дальнейшее распространение
 * ограничено без письменного согласия биржи. Это факт с сайта-источника,
 * не наша юридическая оценка (мы не даём юридических консультаций) — стоит
 * учитывать при публичном использовании собранных данных.
 */

const FIELD_ID_RE = /\/q\/[^/]+\/(?:MSFO|RSBU)\/([a-z0-9_]+)\/?$/i;

function parseSmartlabNumber(raw) {
  if (raw === undefined || raw === null) return null;
  let s = String(raw).trim();
  if (!s || s === "-" || s === "—") return null;
  s = s.replace(/%/g, "").replace(/[\s\u00A0]/g, "");
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

async function fetchSmartlabTable(ticker, reportType) {
  const url = `https://smart-lab.ru/q/${ticker}/f/y/${reportType}/`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept-Language": "ru-RU,ru;q=0.9"
    }
  });
  if (!res.ok) throw new Error(`smart-lab HTTP ${res.status} для ${url}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const fields = {};
  $("table tr").each((_, tr) => {
    const $tr = $(tr);
    const link = $tr.find("a").filter((_, a) => FIELD_ID_RE.test($(a).attr("href") || "")).first();
    if (!link || !link.length) return;
    const m = link.attr("href").match(FIELD_ID_RE);
    if (!m) return;
    const fieldId = m[1];

    const cellTexts = [];
    $tr.find("td").each((__, td) => {
      const text = $(td).text().trim();
      if (text) cellTexts.push(text);
    });
    if (!cellTexts.length) return;

    let latest = null;
    for (let i = cellTexts.length - 1; i >= 0; i--) {
      const n = parseSmartlabNumber(cellTexts[i]);
      if (n !== null) { latest = n; break; }
    }
    fields[fieldId] = latest;
  });

  return fields;
}

async function fetchCompanyFundamentals(ticker, preferredReportType) {
  const order = preferredReportType === "RSBU" ? ["RSBU", "MSFO"] : ["MSFO", "RSBU"];
  let lastError = null;
  for (const reportType of order) {
    try {
      const fields = await fetchSmartlabTable(ticker, reportType);
      if (Object.keys(fields).length > 0) return { fields, reportType };
    } catch (e) {
      lastError = e;
    }
  }
  if (lastError) throw lastError;
  return { fields: {}, reportType: null };
}

module.exports = { fetchCompanyFundamentals, parseSmartlabNumber };
