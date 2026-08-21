// Vrai Score — Coletor de histórico (v1.0)
// ------------------------------------------------------------
// Baixa as séries temporais que faltavam para o app sair da "fotografia" de
// fundamentos e permitir análise de carteira: retorno acumulado, volatilidade,
// beta, correlação e fronteira eficiente.
//
// Três fontes, todas gratuitas e sem autenticação:
//
//   1. AÇÕES — Yahoo Finance chart v8
//      .../chart/TICKER.SA?interval=1d&range=10y&events=div
//      É o MESMO endpoint que o update-data.js já usa como fallback de preço;
//      muda só o range e o events. Traz duas coisas num request só:
//        • adjclose — fechamento ajustado por proventos e desdobramentos, que é
//          a base correta para retorno TOTAL (o close puro subestima quem paga
//          dividendo, justamente as ações que este app seleciona);
//        • events.dividends — o histórico de proventos, pagamento a pagamento.
//
//   2. TÍTULOS PÚBLICOS — CSV do Tesouro Transparente (~14 MB, ~175 mil linhas
//      desde 2004). Uma requisição, sem scraping. Página em ISO-8859-1.
//
//   3. BENCHMARKS — ^BVSP (Yahoo), CDI e IPCA (API SGS do Banco Central) e
//      XFIX11.SA como proxy do IFIX. Atenção: o ^IFIX NÃO existe no Yahoo, e o
//      IFIX.SA retorna série de 1 ponto (inútil). O ETF é o proxy possível, com
//      histórico mais curto e taxa embutida — está sinalizado no meta.
//
// Por que o diário NÃO é commitado:
//   62 ativos × ~2.500 pregões dariam ~1 MB reescritos a cada dia útil, inflando
//   o repositório à toa. O diário vai para .cache/ (ignorado pelo git) e alimenta
//   o cálculo de risco na MESMA execução do workflow. No repositório ficam só os
//   arquivos derivados — pequenos e prontos para o navegador consumir.
//
// Uso:
//   node scripts/build-history.js               # coleta tudo
//   node scripts/build-history.js --so=PETR4    # depura um ticker só
//   node scripts/build-history.js --anos=3      # janela menor (teste rápido)

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const DIR_HIST = path.join(RAIZ, 'data', 'historico');
const DIR_CACHE = path.join(RAIZ, '.cache');

const IBOV = '^BVSP';
const IFIX_PROXY = 'XFIX11.SA';
const URL_TESOURO = 'https://www.tesourotransparente.gov.br/ckan/dataset/'
  + 'df56aa42-484a-4a59-8184-7676580c81e3/resource/'
  + '796d2059-14e9-44e3-80c9-2d9e30b405c1/download/precotaxatesourodireto.csv';

// SGS do Banco Central: 12 = CDI diário (% a.d.), 433 = IPCA mensal (% a.m.).
// A série diária EXIGE dataInicial E dataFinal — sem as duas o BCB devolve uma
// página HTML de erro em vez de JSON, e o parse falha em silêncio.
const SGS_CDI = 12;
const SGS_IPCA = 433;

const args = process.argv.slice(2);
const opt = k => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : null; };
const ANOS = Number(opt('anos') || 10);
const SO_TICKER = opt('so');

// ---------- helpers ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Formato BR (Tesouro/Fundamentus): "9,57" -> 9.57 | "2.215,51" -> 2215.51
function parseBR(str) {
  if (str == null) return null;
  const s = String(str).trim();
  if (!s || s === '-' || s === 'N/A') return null;
  const n = parseFloat(s.replace(/\./g, '').replace(',', '.').replace('%', ''));
  return isNaN(n) ? null : n;
}

// Formato do SGS/BCB: decimal com PONTO ("0.052531"). Passar isso pelo parseBR
// faria o ponto ser lido como separador de milhar — o CDI de 0,052% ao dia
// viraria 52.531% ao dia e o índice explodia. Parser separado de propósito.
function parseISO(str) {
  if (str == null) return null;
  const n = parseFloat(String(str).trim());
  return isNaN(n) ? null : n;
}

// Barras diárias da B3 vêm carimbadas às 13:00 UTC (10:00 BRT), então a data em
// UTC coincide com a data BRT do pregão. Não precisa de ajuste de fuso.
const isoDeTimestamp = ts => new Date(ts * 1000).toISOString().slice(0, 10);

const ddmmyyyy = iso => { const [a, m, d] = iso.split('-'); return `${d}/${m}/${a}`; };
const isoDeBR = br => { const [d, m, a] = br.split('/'); return `${a}-${m}-${d}`; };

const hojeISO = () => new Date().toISOString().slice(0, 10);
function anosAtras(n) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 10);
}

const arred = (v, casas = 6) => (v == null || !isFinite(v) ? null : Number(v.toFixed(casas)));

async function buscar(url, { tentativas = 3, texto = false, binario = false } = {}) {
  let erro;
  for (let i = 0; i < tentativas; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (vrai-score-bot/1.0)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (binario) return await res.arrayBuffer();
      if (texto) return await res.text();
      return await res.json();
    } catch (e) {
      erro = e;
      await sleep(600 * (i + 1));
    }
  }
  throw erro;
}

// ---------- 1. Ações e índices (Yahoo) ----------
async function serieYahoo(simbolo, { comProventos = false } = {}) {
  const ev = comProventos ? '&events=div' : '';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(simbolo)}`
    + `?interval=1d&range=${ANOS}y${ev}`;
  const j = await buscar(url);
  const r = j?.chart?.result?.[0];
  if (!r || !r.timestamp) throw new Error('resposta sem série');

  const ts = r.timestamp;
  const adj = r.indicators?.adjclose?.[0]?.adjclose || [];
  const close = r.indicators?.quote?.[0]?.close || [];

  // adjclose é a base de retorno total. Cai para close quando o Yahoo não
  // publica o ajustado (acontece em índices, que não pagam provento).
  const serie = new Map();
  for (let i = 0; i < ts.length; i++) {
    const v = adj[i] ?? close[i];
    if (v == null) continue;               // pregão sem negócio para o papel
    serie.set(isoDeTimestamp(ts[i]), Number(v));
  }

  const proventos = Object.values(r.events?.dividends || {})
    .map(d => ({ data: isoDeTimestamp(d.date), valor: Number(d.amount) }))
    .filter(d => d.valor > 0)
    .sort((a, b) => a.data.localeCompare(b.data));

  return { serie, proventos };
}

// ---------- 2. Banco Central (CDI e IPCA) ----------
// A série diária de 10 anos estoura o limite do SGS numa tacada só, então é
// buscada em janelas de 4 anos e concatenada.
async function serieSGS(codigo, inicioISO, fimISO) {
  const out = new Map();
  let ini = inicioISO;
  while (ini <= fimISO) {
    const d = new Date(ini);
    d.setFullYear(d.getFullYear() + 4);
    const fim = d.toISOString().slice(0, 10) < fimISO ? d.toISOString().slice(0, 10) : fimISO;
    const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${codigo}/dados?formato=json`
      + `&dataInicial=${ddmmyyyy(ini)}&dataFinal=${ddmmyyyy(fim)}`;
    const j = await buscar(url);
    if (!Array.isArray(j)) throw new Error(`SGS ${codigo}: resposta não é lista (faltou dataFinal?)`);
    for (const p of j) {
      const v = parseISO(p.valor);
      if (v != null) out.set(isoDeBR(p.data), v);
    }
    const prox = new Date(fim);
    prox.setDate(prox.getDate() + 1);
    ini = prox.toISOString().slice(0, 10);
    await sleep(300);
  }
  return out;
}

// Converte série de VARIAÇÃO (% no período) em série de ÍNDICE base 100, para
// ficar comparável com preço de ação no mesmo gráfico.
function indiceDeVariacoes(mapaPct) {
  const datas = [...mapaPct.keys()].sort();
  const out = new Map();
  let acc = 100;
  for (const d of datas) {
    acc *= 1 + mapaPct.get(d) / 100;
    out.set(d, acc);
  }
  return out;
}

// ---------- 3. Tesouro Direto ----------
function classificarTitulo(tipo) {
  const t = tipo.toLowerCase();
  let indexador = 'PRE';
  if (t.includes('selic')) indexador = 'SELIC';
  else if (t.includes('igpm')) indexador = 'IGPM';
  else if (t.includes('ipca') || t.includes('renda+') || t.includes('educa+')) indexador = 'IPCA';
  return {
    indexador,
    juros_semestrais: t.includes('juros semestrais'),
    // Renda+ e Educa+ não pagam tudo no vencimento: têm fase de recebimento
    // mensal (20 e 5 anos). Tratar como fluxo único no vencimento seria errado,
    // então ficam marcados para o front dar o aviso.
    fluxo_programado: t.includes('renda+') ? 'mensal_20_anos'
      : t.includes('educa+') ? 'mensal_5_anos' : null,
  };
}

async function coletarTesouro() {
  const buf = await buscar(URL_TESOURO, { binario: true });
  const txt = new TextDecoder('iso-8859-1').decode(buf);   // CSV servido em latin-1
  const linhas = txt.split('\n');
  const cab = linhas[0].split(';').map(s => s.trim());
  const iTipo = cab.indexOf('Tipo Titulo');
  const iVenc = cab.indexOf('Data Vencimento');
  const iBase = cab.indexOf('Data Base');
  const iTaxa = cab.indexOf('Taxa Compra Manha');
  const iPU = cab.indexOf('PU Base Manha');
  if ([iTipo, iVenc, iBase, iTaxa, iPU].some(i => i < 0)) {
    throw new Error('CSV do Tesouro mudou de layout — colunas esperadas não encontradas');
  }

  const porTitulo = new Map();   // "tipo|venc" -> Map(dataISO -> {taxa, pu})
  let ultimaBase = '';
  for (let i = 1; i < linhas.length; i++) {
    const c = linhas[i].split(';');
    if (c.length <= iPU) continue;
    const chave = `${c[iTipo].trim()}|${c[iVenc].trim()}`;
    const data = isoDeBR(c[iBase].trim());
    const pu = parseBR(c[iPU]);
    if (pu == null) continue;
    if (!porTitulo.has(chave)) porTitulo.set(chave, new Map());
    porTitulo.get(chave).set(data, { taxa: parseBR(c[iTaxa]), pu });
    if (data > ultimaBase) ultimaBase = data;
  }

  // Só os títulos vivos: vencimento posterior à última data-base do arquivo E
  // com cotação nessa data (títulos fora de oferta somem do arquivo).
  const titulos = [];
  const seriesPU = new Map();
  for (const [chave, serie] of porTitulo) {
    const [tipo, vencBR] = chave.split('|');
    const venc = isoDeBR(vencBR);
    if (venc <= ultimaBase) continue;
    const hoje = serie.get(ultimaBase);
    if (!hoje) continue;

    const anosVenc = (new Date(venc) - new Date(ultimaBase)) / (365.25 * 864e5);
    titulos.push({
      id: `${tipo} ${vencBR}`,
      tipo,
      vencimento: venc,
      anos_ate_vencimento: arred(anosVenc, 2),
      taxa_compra: hoje.taxa,
      pu: hoje.pu,
      ...classificarTitulo(tipo),
      // Bucket de duration: a covariância de um papel individual não é
      // estacionária (a volatilidade decai à medida que o vencimento chega),
      // então o risco deve vir da CLASSE, não do papel.
      // O corte em 15 anos separa os IPCA+ tradicionais dos Renda+/Educa+, que
      // vão até 2084 — juntar 8 e 58 anos no mesmo bucket misturaria vol de
      // 11% com vol de 50%.
      bucket: anosVenc < 3 ? 'curto' : anosVenc < 8 ? 'medio'
        : anosVenc < 15 ? 'longo' : 'ultralongo',
      vol_mtm: arred(volAnualizada(serie, 504), 4),   // ~2 anos de pregões
    });
    seriesPU.set(`${tipo} ${vencBR}`, new Map([...serie].map(([d, v]) => [d, v.pu])));
  }

  titulos.sort((a, b) => a.tipo.localeCompare(b.tipo) || a.vencimento.localeCompare(b.vencimento));
  return { titulos, seriesPU, ultimaBase };
}

// Volatilidade anualizada dos últimos N pregões. Aceita Map de número ou de
// {pu}. Usada só para o modo "marcação a mercado" — para quem carrega até o
// vencimento, essa oscilação não se realiza.
function volAnualizada(serie, janela = 504) {
  const vals = [...serie.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, v]) => (typeof v === 'object' ? v.pu : v))
    .filter(v => v != null && v > 0)
    .slice(-janela);
  if (vals.length < 30) return null;
  const r = [];
  for (let i = 1; i < vals.length; i++) r.push(vals[i] / vals[i - 1] - 1);
  const m = r.reduce((s, x) => s + x, 0) / r.length;
  const va = r.reduce((s, x) => s + (x - m) ** 2, 0) / r.length;
  return Math.sqrt(va) * Math.sqrt(252);
}

// ---------- alinhamento e agregação ----------
// Calendário mestre = pregões do Ibovespa. Cada ativo é alinhado nele com
// forward-fill (papel que não negociou herda o último preço); antes da primeira
// observação fica null, para não inventar histórico que não existe.
function alinhar(calendario, serie) {
  const out = [];
  let ultimo = null;
  for (const d of calendario) {
    if (serie.has(d)) ultimo = serie.get(d);
    out.push(ultimo == null ? null : arred(ultimo, 4));
  }
  return out;
}

// Último valor observado de cada mês -> série mensal (níveis, não normalizada:
// a normalização fica no navegador, que assim pode rebasear para a janela que o
// usuário escolher).
function mensalizar(serie) {
  const porMes = new Map();
  for (const d of [...serie.keys()].sort()) porMes.set(d.slice(0, 7), serie.get(d));
  return porMes;
}

// ---------- proventos ----------
function resumirProventos(proventos, precoAtual) {
  const porAno = {};
  for (const p of proventos) {
    const a = p.data.slice(0, 4);
    porAno[a] = arred((porAno[a] || 0) + p.valor, 4);
  }
  const anos = Object.keys(porAno).map(Number).sort();
  if (!anos.length) return { por_ano: {}, eventos: 0 };

  // O primeiro e o último ano da janela são PARCIAIS (a janela começa no meio do
  // ano e o ano corrente ainda está correndo), então não entram nas estatísticas
  // — senão qualquer ação parece ter "cortado" o dividendo no ano atual.
  const anoAtual = new Date().getFullYear();
  const completos = anos.filter(a => a > anos[0] && a < anoAtual);

  let semCorte = 0;
  for (let i = 1; i < completos.length; i++) {
    if (porAno[completos[i]] >= porAno[completos[i - 1]]) semCorte++;
  }
  // Média dos últimos 5 anos COMPLETOS — pode ser de menos anos se o papel tem
  // histórico curto, por isso a contagem vai junto (anos_na_media) em vez de
  // deixar o rótulo "5a" mentir.
  const ult5 = completos.slice(-5);
  const media5 = ult5.length ? ult5.reduce((s, a) => s + porAno[a], 0) / ult5.length : null;

  let cagr = null;
  if (completos.length >= 2) {
    const ini = porAno[completos[0]], fim = porAno[completos[completos.length - 1]];
    if (ini > 0 && fim > 0) cagr = (fim / ini) ** (1 / (completos.length - 1)) - 1;
  }

  return {
    por_ano: porAno,
    eventos: proventos.length,
    anos_completos: completos,
    anos_parciais: anos.filter(a => !completos.includes(a)),
    anos_pagando: completos.filter(a => porAno[a] > 0).length,
    anos_sem_corte: semCorte,
    cagr_dividendo: arred(cagr, 4),
    media_5a: arred(media5, 4),
    anos_na_media: ult5.length,
    // Yield on cost de quem comprasse hoje e recebesse a média dos últimos 5
    // anos — a métrica que um Buy and Hold acompanha de fato.
    dy_medio_5a: arred(media5 != null && precoAtual ? media5 / precoAtual : null, 4),
  };
}

// ---------- main ----------
async function main() {
  const t0 = Date.now();
  fs.mkdirSync(DIR_HIST, { recursive: true });
  fs.mkdirSync(DIR_CACHE, { recursive: true });

  const stocks = JSON.parse(fs.readFileSync(path.join(RAIZ, 'data', 'stocks.json'), 'utf8'));
  let tickers = [...new Set(stocks.stocks.map(s => s.ativo))];
  if (SO_TICKER) tickers = tickers.filter(t => t === SO_TICKER);
  const precoDe = Object.fromEntries(stocks.stocks.map(s => [s.ativo, s.preco]));

  console.log(`→ janela de ${ANOS} anos | ${tickers.length} ações + benchmarks + Tesouro\n`);

  // --- benchmarks primeiro: o Ibovespa define o calendário mestre ---
  console.log('· Ibovespa (^BVSP)');
  const ibov = await serieYahoo(IBOV);
  const calendario = [...ibov.serie.keys()].sort();
  console.log(`  ${calendario.length} pregões, de ${calendario[0]} a ${calendario[calendario.length - 1]}`);

  console.log('· IFIX (proxy XFIX11.SA)');
  let ifix = { serie: new Map() };
  try { ifix = await serieYahoo(IFIX_PROXY); } catch (e) { console.warn(`  ⚠ falhou: ${e.message}`); }
  console.log(`  ${ifix.serie.size} pregões`);

  const inicio = calendario[0], fim = hojeISO();
  console.log('· CDI (BCB SGS 12)');
  const cdiPct = await serieSGS(SGS_CDI, inicio, fim);
  const cdi = indiceDeVariacoes(cdiPct);
  console.log(`  ${cdi.size} dias`);

  console.log('· IPCA (BCB SGS 433)');
  const ipcaPct = await serieSGS(SGS_IPCA, inicio, fim);
  const ipca = indiceDeVariacoes(ipcaPct);
  console.log(`  ${ipca.size} meses`);

  // --- ações ---
  console.log(`\n· Ações (${tickers.length})`);
  const series = new Map();
  const proventos = {};
  let ok = 0, falhou = [];
  for (const t of tickers) {
    try {
      const { serie, proventos: divs } = await serieYahoo(`${t}.SA`, { comProventos: true });
      series.set(t, serie);
      proventos[t] = resumirProventos(divs, precoDe[t]);
      ok++;
      process.stdout.write(`  ${t}: ${serie.size} pregões, ${divs.length} proventos\n`);
    } catch (e) {
      falhou.push(t);
      console.warn(`  ${t}: ✗ ${e.message}`);
    }
    await sleep(400);
  }
  console.log(`  ✓ ${ok} ok, ${falhou.length} falhas${falhou.length ? ': ' + falhou.join(', ') : ''}`);

  // --- tesouro ---
  console.log('\n· Tesouro Direto (CSV do Tesouro Transparente)');
  const { titulos, seriesPU, ultimaBase } = await coletarTesouro();
  console.log(`  ${titulos.length} títulos vivos, data-base ${ultimaBase}`);

  // ---------- saídas ----------
  const meta = {
    gerado_em: new Date().toISOString(),
    janela_anos: ANOS,
    inicio: calendario[0],
    fim: calendario[calendario.length - 1],
    // Declarado de propósito: um ativo sem série não pode entrar em risco,
    // correlação ou fronteira, e o front precisa dizer isso ao usuário em vez de
    // simplesmente omitir o papel. NEOE3, por exemplo, existe no Fundamentus
    // (fundamentos seguem atualizando) mas não tem série no Yahoo.
    sem_historico: falhou,
    fontes: {
      acoes: 'Yahoo Finance chart v8 (adjclose = retorno total, events=div)',
      benchmarks: 'Yahoo ^BVSP; BCB SGS 12 (CDI) e 433 (IPCA)',
      ifix: `proxy ${IFIX_PROXY} — o ^IFIX não existe no Yahoo; ETF tem histórico mais curto e taxa embutida`,
      tesouro: 'Tesouro Transparente (CSV oficial)',
    },
    avisos: [
      'Séries de ação usam fechamento AJUSTADO: já embutem proventos reinvestidos e desdobramentos.',
      'CDI e IPCA são índices base 100 na data inicial, para ficarem comparáveis a preço.',
      'vol_mtm dos títulos é marcação a mercado (últimos ~2 anos). Para quem carrega até o vencimento essa oscilação não se realiza — usar o retorno contratado.',
    ],
  };

  // 1) mensal.json — tudo comparável no mesmo eixo, para os gráficos
  const mesesSet = new Set();
  const mensais = new Map();
  for (const [k, s] of [...series, ['^BVSP', ibov.serie], ['XFIX11', ifix.serie], ['CDI', cdi], ['IPCA', ipca]]) {
    const m = mensalizar(s);
    mensais.set(k, m);
    for (const mes of m.keys()) mesesSet.add(mes);
  }
  const meses = [...mesesSet].sort();
  const seriesMensais = {};
  for (const [k, m] of mensais) {
    let ultimo = null;
    seriesMensais[k] = meses.map(mes => {
      if (m.has(mes)) ultimo = m.get(mes);
      return ultimo == null ? null : arred(ultimo, 4);
    });
  }
  escrever('mensal.json', { meta, meses, series: seriesMensais });

  // 2) proventos.json — o histórico de pagamento que o ranking precisa
  escrever('proventos.json', { meta, ativos: proventos });

  // 2b) indicadores.json — taxas correntes direto da FONTE, sem passar pelo
  // alinhamento no calendário da B3. Reconstruir a taxa de hoje a partir do
  // índice alinhado dá errado: o CDI é publicado em dias bancários e o índice
  // é reamostrado em pregões, então dias sobram ou faltam e a anualização de
  // janela curta erra por 10% ou mais. Aqui fica o número cru.
  const dataCDI = [...cdiPct.keys()].sort().pop();
  const cdiDiario = cdiPct.get(dataCDI);
  const mesesIPCA = [...ipcaPct.keys()].sort().slice(-12);
  const ipca12m = mesesIPCA.reduce((s, m) => s * (1 + ipcaPct.get(m) / 100), 1) - 1;
  escrever('indicadores.json', {
    meta: { ...meta, fonte: 'BCB SGS 12 (CDI a.d.) e 433 (IPCA a.m.)' },
    cdi: {
      data: dataCDI,
      taxa_diaria: cdiDiario,
      taxa_anual: arred((1 + cdiDiario / 100) ** 252 - 1, 6),
    },
    ipca: {
      ultimo_mes: mesesIPCA[mesesIPCA.length - 1],
      acumulado_12m: arred(ipca12m, 6),
      meses_no_acumulado: mesesIPCA.length,
    },
  });

  // 3) tesouro.json — títulos vivos + série mensal de PU
  const mesesTD = new Set();
  const mensaisTD = new Map();
  for (const [id, s] of seriesPU) {
    const m = mensalizar(s);
    mensaisTD.set(id, m);
    for (const mes of m.keys()) mesesTD.add(mes);
  }
  const mesesTDArr = [...mesesTD].sort().filter(m => m >= meses[0]);
  const seriesTD = {};
  for (const [id, m] of mensaisTD) {
    let ultimo = null;
    seriesTD[id] = mesesTDArr.map(mes => {
      if (m.has(mes)) ultimo = m.get(mes);
      return ultimo == null ? null : arred(ultimo, 2);
    });
  }
  escrever('tesouro.json', { meta: { ...meta, data_base: ultimaBase }, titulos, meses: mesesTDArr, series: seriesTD });

  // 4) .cache/diario.json — insumo do cálculo de risco, NÃO commitado
  const diario = {};
  for (const [k, s] of series) diario[k] = alinhar(calendario, s);
  diario['^BVSP'] = alinhar(calendario, ibov.serie);
  diario['XFIX11'] = alinhar(calendario, ifix.serie);
  diario['CDI'] = alinhar(calendario, cdi);
  for (const [id, s] of seriesPU) diario[`TD:${id}`] = alinhar(calendario, s);
  const cacheFile = path.join(DIR_CACHE, 'diario.json');
  fs.writeFileSync(cacheFile, JSON.stringify({ meta, datas: calendario, series: diario }), 'utf8');
  console.log(`\n  .cache/diario.json — ${(fs.statSync(cacheFile).size / 1048576).toFixed(1)} MB (não vai para o git)`);

  console.log(`\n✓ concluído em ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (falhou.length) console.log(`⚠ sem série: ${falhou.join(', ')}`);
}

function escrever(nome, obj) {
  const p = path.join(DIR_HIST, nome);
  fs.writeFileSync(p, JSON.stringify(obj), 'utf8');
  console.log(`  data/historico/${nome} — ${(fs.statSync(p).size / 1024).toFixed(0)} KB`);
}

main().catch(e => { console.error(e); process.exit(1); });
