// Vrai Score — Atualização automática de dados (v2, rascunho)
// Puxa preço/P/L/P/VP/DY/ROE da brapi.dev e Payout/DL-EBITDA/P/L-Rec do Fundamentus.
// Executa dentro do GitHub Actions pelo workflow update-data.yml.
//
// NOTA: este é um esboço. Será finalizado e testado na v2 da sessão seguinte.

const fs = require('fs');
const path = require('path');

async function fetchBrapi(tickers) {
  const fetch = (await import('node-fetch')).default;
  const url = `https://brapi.dev/api/quote/${tickers.join(',')}?fundamental=true`;
  const headers = process.env.BRAPI_TOKEN ? { Authorization: `Bearer ${process.env.BRAPI_TOKEN}` } : {};
  const res = await fetch(url, { headers });
  const data = await res.json();
  return data.results || [];
}

async function fetchFundamentus(ticker) {
  const fetch = (await import('node-fetch')).default;
  const cheerio = await import('cheerio');
  const res = await fetch(`https://www.fundamentus.com.br/detalhes.php?papel=${ticker}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  // TODO: extrair Payout, DL/EBITDA, P/L Recorrente, histórico de dividendos
  return {};
}

async function main() {
  const DATA_PATH = path.join(__dirname, '..', 'data', 'stocks.json');
  const current = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const tickers = [...new Set(current.stocks.map(s => s.ativo))];

  console.log(`Atualizando ${tickers.length} tickers...`);
  const brapiData = await fetchBrapi(tickers);
  const brapiMap = new Map(brapiData.map(q => [q.symbol, q]));

  const updated = current.stocks.map(s => {
    const q = brapiMap.get(s.ativo);
    if (!q) return s;
    return {
      ...s,
      preco: q.regularMarketPrice ?? s.preco,
      preco_minimo_52s: q.fiftyTwoWeekLow ?? s.preco_minimo_52s,
      valor_mercado_bi: q.marketCap ? q.marketCap / 1e9 : s.valor_mercado_bi,
      p_l: q.priceEarnings ?? s.p_l,
      roe: q.returnOnEquity ? q.returnOnEquity / 100 : s.roe,
      // TODO: merge com Fundamentus para Payout, DL/EBITDA, P/L Recorrente
    };
  });

  const payload = {
    meta: {
      ...current.meta,
      gerado_em: new Date().toISOString(),
      total_ativos: updated.length,
      fonte: 'brapi.dev + Fundamentus (auto-atualizado)',
    },
    stocks: updated,
  };

  fs.writeFileSync(DATA_PATH, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`Atualizado: ${DATA_PATH}`);
}

main().catch(e => { console.error(e); process.exit(1); });
