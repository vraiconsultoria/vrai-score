// Vrai Score — Atualização automática de dados (v2, Yahoo Finance)
// ------------------------------------------------------------
// Roda no GitHub Actions a cada dia útil, após o fechamento da B3.
//
// Fontes canônicas:
//   • Preço, 52s-min, valor de mercado, P/L, P/VP, DY, ROE, EV/EBITDA:
//     Yahoo Finance (via biblioteca yahoo-finance2). Tickers B3 usam sufixo ".SA".
//   • ROIC, Dívida Líquida/EBITDA, Margem Líquida: Fundamentus (scraping).
//   • Dividendos 5 anos: permanecem do snapshot manual (próxima entrega).
//
// Por que Yahoo e não brapi?
//   brapi mudou para plano pago nos fundamentais. Yahoo é gratuito, estável e
//   amplamente usado. O "crumb" / cookie necessário é resolvido pela biblioteca.
//
// Robustez:
//   • Se um ticker falhar em qualquer fonte, os dados antigos daquele campo
//     são preservados. O site nunca fica vazio.
//   • meta.fechamento_referencia grava a data BRT para auditoria.

const fs = require('fs');
const path = require('path');

// yahoo-finance2 é ESM-only nas versões recentes — carregamos via import() dinâmico.
let yahooFinance = null;
async function loadYahoo() {
  if (yahooFinance) return yahooFinance;
  const mod = await import('yahoo-finance2');
  yahooFinance = mod.default;
  // Tenta silenciar avisos da biblioteca; se a API mudou, ignora.
  try {
    if (typeof yahooFinance.suppressNotices === 'function') {
      yahooFinance.suppressNotices(['yahooSurvey', 'ripHistorical']);
    }
  } catch {}
  return yahooFinance;
}

// ---------- helpers ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseBR(str) {
  if (str == null) return null;
  const s = String(str).trim();
  if (!s || s === '-' || s === 'N/A') return null;
  const clean = s.replace(/\./g, '').replace(',', '.').replace('%', '').trim();
  const n = parseFloat(clean);
  return isNaN(n) ? null : n;
}

function todayBRT() {
  const brt = new Date(Date.now() - 3 * 3600 * 1000);
  return brt.toISOString().slice(0, 10);
}

// ---------- Yahoo Finance ----------
async function fetchYahoo(ticker) {
  const yf = await loadYahoo();
  const symbol = `${ticker}.SA`;
  try {
    const r = await yf.quoteSummary(symbol, {
      modules: [
        'price',
        'summaryDetail',
        'defaultKeyStatistics',
        'financialData',
        'incomeStatementHistory',
        'balanceSheetHistory',
      ],
    });
    const price = r.price || {};
    const sd = r.summaryDetail || {};
    const ks = r.defaultKeyStatistics || {};
    const fd = r.financialData || {};
    const isHist = (r.incomeStatementHistory && r.incomeStatementHistory.incomeStatementHistory) || [];
    const bsHist = (r.balanceSheetHistory && r.balanceSheetHistory.balanceSheetStatements) || [];
    const lucroAbs = isHist[0] && isHist[0].netIncome ? isHist[0].netIncome : null;
    const plAbs = bsHist[0] && bsHist[0].totalStockholderEquity ? bsHist[0].totalStockholderEquity : null;
    return {
      preco: price.regularMarketPrice ?? sd.regularMarketPreviousClose ?? null,
      preco_minimo_52s: sd.fiftyTwoWeekLow ?? null,
      valor_mercado_bi: price.marketCap ? Number((price.marketCap / 1e9).toFixed(3)) : null,
      p_l: sd.trailingPE ?? null,
      p_vp: ks.priceToBook ?? null,
      dy: sd.dividendYield ?? sd.trailingAnnualDividendYield ?? null, // já fracional
      roe: fd.returnOnEquity ?? null,                                  // já fracional
      ev_ebitda: ks.enterpriseToEbitda ?? null,
      payout: sd.payoutRatio ?? null,                                  // já fracional
      lucro_bi: lucroAbs != null ? Number((lucroAbs / 1e9).toFixed(3)) : null,
      patrimonio_liquido_bi: plAbs != null ? Number((plAbs / 1e9).toFixed(3)) : null,
    };
  } catch (e) {
    return { _erro: e.message };
  }
}

// ---------- Fundamentus ----------
async function fetchFundamentus(ticker) {
  const cheerio = await import('cheerio');
  try {
    const res = await fetch(`https://www.fundamentus.com.br/detalhes.php?papel=${ticker}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (vrai-score-bot/2.0; +https://vraiconsultoria.github.io/vrai-score)',
        'Accept-Language': 'pt-BR,pt;q=0.9',
      },
    });
    if (!res.ok) return {};
    const html = await res.text();
    const $ = cheerio.load(html);

    const byLabel = label => {
      const td = $(`td.label:contains("${label}")`).first();
      return td.length ? td.next('td.data').text().trim() : null;
    };
    const pct = str => {
      const n = parseBR(str);
      return n == null ? null : n / 100;
    };

    return {
      roic: pct(byLabel('ROIC')),
      div_liq_ebitda: parseBR(byLabel('Dív. Líq. / EBITDA')),
      marg_liquida: pct(byLabel('Marg. Líquida')),
      crescimento_receita_5a: pct(byLabel('Cres. Rec (5a)')),
    };
  } catch {
    return {};
  }
}

// ---------- main ----------
async function main() {
  const DATA_PATH = path.join(__dirname, '..', 'data', 'stocks.json');
  const current = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const tickers = [...new Set(current.stocks.map(s => s.ativo))];

  console.log(`→ ${tickers.length} tickers a atualizar`);

  // Yahoo Finance — com throttle gentil (pode fazer em paralelo, mas mantemos
  // sequencial para não dar flag de abuso).
  console.log(`→ Yahoo Finance (sequencial, ~${Math.ceil(tickers.length * 0.4)}s)`);
  const yMap = new Map();
  let yOk = 0, yFail = 0;
  for (const t of tickers) {
    const y = await fetchYahoo(t);
    if (y && !y._erro && y.preco != null) { yMap.set(t, y); yOk++; }
    else { yFail++; if (y._erro) console.warn(`  ${t}: ${y._erro}`); }
    await sleep(300);
  }
  console.log(`✓ Yahoo: ${yOk} ok, ${yFail} sem dados`);

  // Fundamentus — scrape por ticker
  console.log(`→ Fundamentus (~${Math.ceil(tickers.length * 0.5)}s)`);
  const fMap = new Map();
  let fOk = 0, fFail = 0;
  for (const t of tickers) {
    const f = await fetchFundamentus(t);
    if (f && (f.roic != null || f.div_liq_ebitda != null)) { fMap.set(t, f); fOk++; }
    else { fFail++; }
    await sleep(400);
  }
  console.log(`✓ Fundamentus: ${fOk} ok, ${fFail} sem dados`);

  // Merge
  let changed = 0;
  const updated = current.stocks.map(s => {
    const y = yMap.get(s.ativo) || {};
    const f = fMap.get(s.ativo) || {};
    const merged = { ...s };

    const set = (key, val) => {
      if (val == null || (typeof val === 'number' && isNaN(val))) return;
      // Arredonda números "feios" de API para 4 casas para o JSON ficar limpo.
      const v = typeof val === 'number' ? Number(val.toFixed(6)) : val;
      if (merged[key] !== v) changed++;
      merged[key] = v;
    };

    set('preco', y.preco);
    set('preco_minimo_52s', y.preco_minimo_52s);
    set('valor_mercado_bi', y.valor_mercado_bi);
    set('p_l', y.p_l);
    set('p_vp', y.p_vp);
    set('dy', y.dy);
    set('roe', y.roe);
    set('ev_ebitda', y.ev_ebitda);
    set('payout', y.payout);
    set('lucro_bi', y.lucro_bi);
    set('patrimonio_liquido_bi', y.patrimonio_liquido_bi);
    set('roic', f.roic);
    set('div_liq_ebitda', f.div_liq_ebitda);
    set('marg_liquida', f.marg_liquida);

    return merged;
  });

  const payload = {
    meta: {
      ...current.meta,
      gerado_em: new Date().toISOString(),
      fechamento_referencia: todayBRT(),
      total_ativos: updated.length,
      fonte: 'Yahoo Finance (preço, P/L, P/VP, DY, ROE, EV/EBITDA, Payout, Lucro, PL) + Fundamentus (ROIC, DL/EBITDA, margem) — auto',
      versao: '2.1.0',
      aviso: 'Preços do último fechamento disponível no Yahoo Finance. Histórico de dividendos 5 anos ainda é snapshot manual.',
    },
    stocks: updated,
  };

  fs.writeFileSync(DATA_PATH, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`✓ Gravado ${DATA_PATH} — ${changed} campos alterados`);
}

main().catch(e => { console.error(e); process.exit(1); });
