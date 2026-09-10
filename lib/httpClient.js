/**
 * lib/httpClient.js
 * ---------------------------------------------------------------------------
 * Оборачивает fetch автоматическими повторами при транзиентных сетевых
 * ошибках (ECONNRESET, таймаут, обрыв соединения и т.п.) — без этого любой
 * единичный сетевой глюк роняет весь прогон целиком, хотя следующая попытка
 * через пару секунд почти всегда проходит нормально (см. реальный случай:
 * TypeError: fetch failed / cause: ECONNRESET на самом первом запросе).
 *
 * Ретраим ТОЛЬКО сетевые сбои (обрыв соединения, DNS, таймаут) — не HTTP-
 * статусы вроде 404/500, это решает вызывающий код сам. fetch() при сетевой
 * ошибке бросает исключение до получения Response, поэтому различать легко:
 * если исключение — это сеть, если Response вернулся — это уже не наша забота.
 */
const { fetch: undiciFetch } = require("undici");

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await undiciFetch(url, options);
    } catch (e) {
      lastError = e;
      const isLastAttempt = attempt === MAX_RETRIES;
      const causeCode = e && e.cause && e.cause.code;
      console.warn(`  ! сетевая ошибка (попытка ${attempt}/${MAX_RETRIES})${causeCode ? " [" + causeCode + "]" : ""}: ${e.message} — ${url}`);
      if (isLastAttempt) break;
      await sleep(RETRY_DELAY_MS * attempt); // 2с, 4с — растущая пауза
    }
  }
  throw lastError;
}

module.exports = { fetch: fetchWithRetry };
