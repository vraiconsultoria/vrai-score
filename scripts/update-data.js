// Vrai Score — Atualização automática de dados (v2.2)
// ------------------------------------------------------------
// Roda no GitHub Actions a cada dia útil, após o fechamento da B3.
//
// Fonte primária: Fundamentus (scraping). Traz a cotação de fechamento e TODOS
// os fundamentos já calculados de forma coerente entre si (o P/L exibido bate
// com a cotação exibida). Página em ISO-8859-1 — decodificada como latin1.
//
// Fallback de preço: Yahoo Finance chart v8
//   (https://query1.finance.yahoo.com/v8/finance/chart/TICKER.SA). Esse endpoint
//   NÃO exige "crumb"/cookie e funciona no GitHub Actions.
//
// Por que mudou da v2.1?
//   A v2.1 usava a biblioteca yahoo-finance2 (quoteSummary), que exige um
//   crumb/cookie e retorna 401 no GitHub Actions. Resultado: o workflow ficava
//   verde mas só a data mudava — os preços/fundamentos nunca eram atualizados.
//   Fundamentus é gratuito, sem autenticação e específico da B3.
//
// Robustez:
//   • Se um campo vier vazio em determinada ação (ex.: ROIC/EV-EBITDA/Margem em
//     bancos), o valor antigo daquele campo é preservado. O site nunca fica vazio.
//   • meta.fechamento_referencia grava a data BRT para auditoria.

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

// ---------- helpers ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));

// "9,57" -> 9.57 | "444.603.000.000" -> 444603000000 | "8,5%" -> 8.5 | "-" -> null
function parseBR(str) {
  if (str == null) return null;
  const s = String(str).trim();
  if (!s || s === '-' || s === 'N/A') return null;
  const clean = s.replace(/\./g, '').replace(',', '.').replace('%', '').trim();
  const n = parseFloat(clean);
  return isNaN(n) ? null : n;
}

// Normaliza rótulos para casar sem depender de acento/caixa/espaços.
const norm = s => String(s).toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

function todayBRT() {
  const brt = new Date(Date.now() - 3 * 3600 * 1000);
  return brt.toISOString().slice(0, 10);
}

// ---------- Yahoo Finance (fallback de preço, sem auth) ----------
async function fetchYahooPrice(ticker) {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}.SA?interval=1d&range=5d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!res.ok) return {};
    const j = await res.json();
    const m = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
    if (!m) return {};
    return {
      preco: m.regularMarketPrice ?? m.chartPreviousClose ?? null,
      preco_minimo_52s: m.fiftyTwoWeekLow ?? null,
    };
  } catch {
    return {};
  }
}

// ---------- Fundamentus (fonte primária) ----------
async function fetchFundamentus(ticker) {
  try {
    const res = await fetch(`https://www.fundamentus.com.br/detalhes.php?papel=${ticker}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (vrai-score-bot/2.2; +https://vraiconsultoria.github.io/vrai-score)',
        'Accept-Language': 'pt-BR,pt;q=0.9',
      },
    });
    if (!res.ok) return {};
    // Fundamentus serve ISO-8859-1 (latin1). Decodificar como UTF-8 quebra os
    // acentos dos rótulos (Cotação, Líquido...) e o casamento falha em silêncio.
    const buf = await res.arrayBuffer();
    const html = new TextDecoder('iso-8859-1').decode(buf);
    const $ = cheerio.load(html);

    // Mapa rótulo-normalizado -> valor. Primeira ocorrência vence: nas
    // demonstrações, a coluna "12 meses" vem antes da coluna "trimestre".
    const map = new Map();
    $('td.label').each((_, el) => {
      const label = norm($(el).find('span.txt').text() || $(el).text());
      if (!label || map.has(label)) return;
      const val = ($(el).next('td.data').find('span.txt').text()
        || $(el).next('td.data').text()).trim();
      map.set(label, val);
    });
    const raw = label => (map.has(norm(label)) ? map.get(norm(label)) : null);
    const num = label => parseBR(raw(label));
    const pct = label => { const n = num(label); return n == null ? null : n / 100; };

    const cotacao = num('Cotação');
    const lpa = num('LPA');
    const dy = pct('Div. Yield');

    // Payout aproximado = (DY × Cotação) / LPA. Sanidade: 0 < p < 3.
    let payout = null;
    if (dy != null && cotacao != null && lpa) {
      const p = (dy * cotacao) / lpa;
      if (p > 0 && p < 3) payout = p;
    }

    // Dív. Líquida / EBITDA — Fundamentus não traz direto, mas dá pra derivar:
    //   EBITDA = ValorFirma ÷ (EV/EBITDA)  =>  DL/EBITDA = DívLíq × (EV/EBITDA) ÷ ValorFirma
    // Em bancos esses campos vêm "-", então o resultado fica null (preserva antigo).
    let divLiqEbitda = null;
    const divLiq = num('Dív. Líquida');
    const evEbitda = num('EV / EBITDA');
    const valorFirma = num('Valor da firma');
    if (divLiq != null && evEbitda != null && valorFirma) {
      const v = (divLiq * evEbitda) / valorFirma;
      if (isFinite(v)) divLiqEbitda = v;
    }

    // Margem líquida = 0% em bancos é artefato do Fundamentus → trata como sem dado.
    let margLiq = pct('Marg. Líquida');
    if (margLiq === 0) margLiq = null;

    const valorMerc = num('Valor de mercado');
    const lucro = num('Lucro Líquido');   // primeira ocorrência = 12 meses
    const plLiq = num('Patrim. Líq');

    return {
      preco: cotacao,
      preco_minimo_52s: num('Min 52 sem'),
      valor_mercado_bi: valorMerc != null ? Number((valorMerc / 1e9).toFixed(3)) : null,
      p_l: num('P/L'),
      p_vp: num('P/VP'),
      dy,                                   // já fracional
      roe: pct('ROE'),                      // já fracional
      roic: pct('ROIC'),                    // já fracional (null em bancos)
      ev_ebitda: evEbitda,
      marg_liquida: margLiq,                // já fracional
      payout,                               // já fracional
      div_liq_ebitda: divLiqEbitda,
      lucro_bi: lucro != null ? Number((lucro / 1e9).toFixed(3)) : null,
      patrimonio_liquido_bi: plLiq != null ? Number((plLiq / 1e9).toFixed(3)) : null,
    };
  } catch (e) {
    return { _erro: e.message };
  }
}

// ---------- main ----------
async function main() {
  const DATA_PATH = path.join(__dirname, '..', 'data', 'stocks.json');
  const current = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const tickers = [...new Set(current.stocks.map(s => s.ativo))];

  console.log(`→ ${tickers.length} tickers (Fundamentus + fallback de preço no Yahoo)`);

  const fMap = new Map();
  let ok = 0, fail = 0, yfb = 0;
  for (const t of tickers) {
    let f = await fetchFundamentus(t);
    if (f._erro) { console.warn(`  ${t}: erro Fundamentus — ${f._erro}`); f = {}; }
    // Fallback de preço apenas se o Fundamentus não trouxe cotação.
    if (f.preco == null) {
      const y = await fetchYahooPrice(t);
      if (y.preco != null) { f.preco = y.preco; yfb++; }
      if (f.preco_minimo_52s == null && y.preco_minimo_52s != null) f.preco_minimo_52s = y.preco_minimo_52s;
      await sleep(200);
    }
    if (f.preco != null) { fMap.set(t, f); ok++; }
    else { fail++; console.warn(`  ${t}: sem preço em nenhuma fonte`); }
    await sleep(400);
  }
  console.log(`✓ ${ok} ok, ${fail} sem preço (${yfb} usaram fallback Yahoo)`);

  // Merge — preserva o valor antigo sempre que o novo vier null/NaN.
  let changed = 0;
  const updated = current.stocks.map(s => {
    const f = fMap.get(s.ativo) || {};
    const merged = { ...s };
    const set = (key, val) => {
      if (val == null || (typeof val === 'number' && isNaN(val))) return;
      const v = typeof val === 'number' ? Number(val.toFixed(6)) : val;
      if (merged[key] !== v) changed++;
      merged[key] = v;
    };
    set('preco', f.preco);
    set('preco_minimo_52s', f.preco_minimo_52s);
    set('valor_mercado_bi', f.valor_mercado_bi);
    set('p_l', f.p_l);
    set('p_vp', f.p_vp);
    set('dy', f.dy);
    set('roe', f.roe);
    set('roic', f.roic);
    set('ev_ebitda', f.ev_ebitda);
    set('marg_liquida', f.marg_liquida);
    set('payout', f.payout);
    set('div_liq_ebitda', f.div_liq_ebitda);
    set('lucro_bi', f.lucro_bi);
    set('patrimonio_liquido_bi', f.patrimonio_liquido_bi);
    return merged;
  });

  const payload = {
    meta: {
      ...current.meta,
      gerado_em: new Date().toISOString(),
      fechamento_referencia: todayBRT(),
      total_ativos: updated.length,
      fonte: 'Fundamentus (cotação de fechamento + fundamentos) com fallback de preço no Yahoo Finance — auto',
      versao: '2.2.0',
      aviso: 'Cotação e fundamentos do último fechamento disponível no Fundamentus. Histórico de dividendos 5 anos ainda é snapshot manual.',
    },
    stocks: updated,
  };

  fs.writeFileSync(DATA_PATH, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`✓ Gravado ${DATA_PATH} — ${changed} campos alterados`);
}

main().catch(e => { console.error(e); process.exit(1); });
