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

/**
 * Ищет ИМЕННО блок с позициями физ/юр лиц — по наличию колонок "clgroup" и
 * "ticker", а не первый попавшийся блок с columns/data. В ответе ISS может
 * быть несколько блоков (метаданные, диагностика и т.п.), и слепой выбор
 * первого — ровно то, что привело к пустому результату в прошлый раз
 * (нашёлся посторонний блок из 1 строки вместо реальных данных).
 */
function findDataBlock(json) {
  const blockNames = Object.keys(json);
  for (const key of blockNames) {
    const block = json[key];
    if (block && Array.isArray(block.columns) && Array.isArray(block.data)) {
      if (block.columns.includes("clgroup") && block.columns.includes("ticker")) {
        return { block, blockName: key, blockNames };
      }
    }
  }
  return { block: null, blockName: null, blockNames };
}

async function fetchFutoiForDate(dateStr) {
  const url = `https://iss.moex.com/iss/analyticalproducts/futoi/securities.json?date=${dateStr}&iss.meta=off`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; MOEXScreenerBot/1.0)" } });
  if (!res.ok) throw new Error(`FUTOI HTTP ${res.status}`);
  const json = await res.json();
  const { block, blockName, blockNames } = findDataBlock(json);
  const diag = { blockNames, selectedBlock: blockName, selectedBlockColumns: block ? block.columns : null };
  if (!block || !block.data.length) return { parsed: null, diag };
  const idx = block.columns.reduce((m, c, i) => { m[c] = i; return m; }, {});
  return { parsed: { idx, rows: block.data }, diag };
}

/**
 * Пробует сегодня, затем до 6 дней назад — на случай выходных/праздников,
 * когда за сегодня данных ещё/уже нет. Возвращает не только результат, но и
 * диагностику — иначе "пусто по всем компаниям" неотличимо от "код рабочий,
 * а сам источник ничего не прислал".
 */
async function fetchFuturesOI(tickerMap, secids) {
  const attempts = [];
  for (let daysBack = 0; daysBack <= 6; daysBack++) {
    const d = new Date();
    d.setDate(d.getDate() - daysBack);
    const dateStr = d.toISOString().slice(0, 10);
    let parsed = null;
    let error = null;
    let diag = null;
    try {
      const r = await fetchFutoiForDate(dateStr);
      parsed = r.parsed;
      diag = r.diag;
    } catch (e) {
      error = e.message;
    }
    attempts.push({ dateStr, rowsReceived: parsed ? parsed.rows.length : 0, error, ...diag });
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
      note: "Ни один из последних 7 дней не вернул блок с колонками clgroup/ticker. Смотрите attempts[].blockNames и selectedBlockColumns — если selectedBlock везде null, значит нужного блока действительно нет в ответе ни разу (возможна гео-блокировка); если selectedBlock не null, но matchedSecids=0 — не совпадают коды в FUTURES_TICKER_MAP.",
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
