const { fetch } = require("./httpClient.js");

const BOARD = "TQBR";

/**
 * Полный список торгуемых акций тянется динамически — не хардкодим ~200
 * тикеров, чтобы список не устаревал сам по себе.
 */
async function fetchAllSecurities() {
  const url = `https://iss.moex.com/iss/engines/stock/markets/shares/boards/${BOARD}/securities.json` +
    `?iss.meta=off&iss.only=securities,marketdata` +
    `&securities.columns=SECID,SHORTNAME,ISSUESIZE` +
    `&marketdata.columns=SECID,LAST`;

  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; MOEXScreenerBot/1.0)" } });
  if (!res.ok) throw new Error(`MOEX ISS securities HTTP ${res.status}`);
  const data = await res.json();

  const secCols = data.securities.columns;
  const mdCols = data.marketdata.columns;
  const secIdx = secCols.reduce((m, c, i) => { m[c] = i; return m; }, {});
  const mdIdx = mdCols.reduce((m, c, i) => { m[c] = i; return m; }, {});

  const byId = {};
  data.securities.data.forEach((row) => {
    const secid = row[secIdx.SECID];
    byId[secid] = { secid, shortname: row[secIdx.SHORTNAME], issuesize: row[secIdx.ISSUESIZE], last: null };
  });
  data.marketdata.data.forEach((row) => {
    const secid = row[mdIdx.SECID];
    if (byId[secid]) byId[secid].last = row[mdIdx.LAST];
  });

  // без цены сделок сегодня не было/бумага неликвидна — оставляем в списке
  // (капитализация и производные будут null), но не выкидываем совсем
  return Object.values(byId).map((s) => ({
    ...s,
    marketCap: (s.last && s.issuesize) ? s.last * s.issuesize : null
  }));
}

async function fetchCandles(secid, daysBack = 260) {
  const till = new Date();
  const from = new Date();
  from.setDate(from.getDate() - daysBack);
  const fmt = (d) => d.toISOString().slice(0, 10);

  const url = `https://iss.moex.com/iss/engines/stock/markets/shares/boards/${BOARD}` +
    `/securities/${secid}/candles.json?interval=24&from=${fmt(from)}&till=${fmt(till)}&iss.meta=off`;

  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; MOEXScreenerBot/1.0)" } });
  if (!res.ok) throw new Error(`candles HTTP ${res.status} для ${secid}`);
  const data = await res.json();
  const closeIdx = data.candles.columns.indexOf("close");
  return data.candles.data.map((row) => row[closeIdx]).filter((v) => v != null);
}

function findDataBlock(json) {
  for (const key in json) {
    if (json[key] && Array.isArray(json[key].columns) && Array.isArray(json[key].data)) return json[key];
  }
  return null;
}

async function fetchFutoiForDate(dateStr) {
  const url = `https://iss.moex.com/iss/analyticalproducts/futoi/securities.json?date=${dateStr}&iss.meta=off`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; MOEXScreenerBot/1.0)" } });
  if (!res.ok) throw new Error(`FUTOI HTTP ${res.status}`);
  const json = await res.json();
  const block = findDataBlock(json);
  if (!block || !block.data.length) return null;
  const idx = block.columns.reduce((m, c, i) => { m[c] = i; return m; }, {});
  return { idx, rows: block.data };
}

/**
 * Пробует сегодня, затем до 6 дней назад — на случай выходных/праздников,
 * когда за сегодня данных ещё/уже нет. Возвращает не только результат, но и
 * диагностику — иначе "пусто по всем компаниям" неотличимо от "код рабочий,
 * а сам источник ничего не прислал" (например, из-за гео-ограничения на
 * стороне MOEX — раздел FUTOI, в отличие от обычных котировок, у части
 * пользователей не отдаёт данные за пределами России).
 */
async function fetchFuturesOI(tickerMap, secids) {
  const attempts = [];
  for (let daysBack = 0; daysBack <= 6; daysBack++) {
    const d = new Date();
    d.setDate(d.getDate() - daysBack);
    const dateStr = d.toISOString().slice(0, 10);
    let parsed = null;
    let error = null;
    try {
      parsed = await fetchFutoiForDate(dateStr);
    } catch (e) {
      error = e.message;
    }
    attempts.push({ dateStr, rowsReceived: parsed ? parsed.rows.length : 0, error });
    if (!parsed) continue;

    const { result, distinctCodes } = buildFutoiResult(parsed, tickerMap, secids);
    return {
      result,
      diagnostics: {
        usedDate: dateStr,
        rowsReceived: parsed.rows.length,
        distinctCodesInResponse: distinctCodes.length,
        matchedSecids: Object.keys(result).length,
        attempts
      }
    };
  }
  return {
    result: {},
    diagnostics: {
      usedDate: null,
      note: "Ни один из последних 7 дней не вернул данных FUTOI. Если rowsReceived везде 0 — вероятно, источник не отдаёт данные для IP раннера GitHub Actions (гео-ограничение на стороне MOEX), а не проблема сопоставления кодов.",
      attempts
    }
  };
}

function buildFutoiResult(parsed, tickerMap, secids) {
  const { idx, rows } = parsed;
  const hasLongShort = idx.pos_long !== undefined && idx.pos_short !== undefined;

  const byCode = {};
  rows.forEach((row) => {
    const code = row[idx.ticker];
    const group = (row[idx.clgroup] || "").toLowerCase();
    if (group !== "fiz" && group !== "yur") return;
    if (!byCode[code]) byCode[code] = {};
    byCode[code][group] = {
      pos: idx.pos !== undefined ? row[idx.pos] : null,
      posLong: hasLongShort ? row[idx.pos_long] : null,
      posShort: hasLongShort ? row[idx.pos_short] : null
    };
  });

  const result = {};
  secids.forEach((secid) => {
    const code = tickerMap[secid] || secid;
    const entry = byCode[code];
    if (!entry || !entry.fiz || !entry.yur) return;
    const fizAbs = entry.fiz.posLong !== null && entry.fiz.posShort !== null
      ? entry.fiz.posLong + entry.fiz.posShort : Math.abs(entry.fiz.pos || 0);
    const yurAbs = entry.yur.posLong !== null && entry.yur.posShort !== null
      ? entry.yur.posLong + entry.yur.posShort : Math.abs(entry.yur.pos || 0);
    result[secid] = yurAbs > 0 ? fizAbs / yurAbs : null;
  });
  return { result, distinctCodes: Object.keys(byCode) };
}

module.exports = { fetchAllSecurities, fetchCandles, fetchFuturesOI };
