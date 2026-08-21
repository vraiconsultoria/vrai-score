// Vrai Score — Motor de risco (v1.0)
// ------------------------------------------------------------
// Lê o diário produzido pelo build-history.js (.cache/diario.json) e produz
// data/historico/risco.json: o arquivo pequeno que o navegador consome para
// calcular carteira em tempo real.
//
// A ideia central: o navegador NÃO precisa das séries. Com o vetor de retornos
// esperados, o vetor de volatilidades e a matriz de correlação, qualquer
// subconjunto de ativos que o usuário montar tem volatilidade, Sharpe, alpha,
// tracking error e fronteira eficiente calculados na hora, com álgebra de
// matriz pequena. ~40 KB no lugar de ~2 MB de série.
//
// Decisões que valem explicação:
//
// • JANELA COMUM. Estatística comparável exige mesma janela. Ativos com
//   histórico curto entrariam com vol medida noutro regime de mercado, o que
//   contamina a matriz. Usa-se a janela de 5 anos; quem não cobre 80% dela sai
//   da matriz (mas mantém as estatísticas próprias, rotuladas).
//
// • TÍTULO ENTRA POR CLASSE, NÃO POR PAPEL. A série de um papel individual não
//   é estacionária: a volatilidade decai à medida que o vencimento se aproxima
//   (medido: Prefixado 2027 = 3,3% a.a. contra Prefixado 2032 = 10,1% a.a. —
//   mesma classe, só muda a duration). Então o risco vem de uma série sintética
//   por (indexador × bucket), e cada papel herda o risco da sua classe.
//
// • DOIS MODOS. Para quem carrega até o vencimento, a oscilação de marcação a
//   mercado não se realiza: o retorno é contratado. O arquivo entrega os dois
//   (vol_mtm e vol_carrego) e o front decide qual usar. Sem isso, o otimizador
//   olharia um IPCA+ 2050 pagando inflação + 7,28% garantidos e o classificaria
//   como ativo de risco alto (vol de 23% a.a.), recusando alocar.
//
// • RETORNO ESPERADO NÃO É MÉDIA HISTÓRICA. Média passada é notoriamente má
//   estimativa e é a principal fonte de pesos absurdos em Markowitz. Aqui as
//   ações entram com o retorno esperado que o próprio app já calcula
//   (DY + Growth) e os títulos com a taxa contratada. É o que junta as duas
//   metades do projeto: a metodologia de seleção alimenta o otimizador.
//
// • UNIDADE DE CONTA. Para somar prefixado com IPCA+ na mesma conta é preciso
//   uma expectativa de inflação. Ela não é chutada: sai da própria curva, pelo
//   breakeven entre Prefixado e IPCA+ de vencimentos próximos.
//
// • SHRINKAGE. A matriz amostral tem erro de estimativa, e o otimizador
//   amplifica esse erro. A correlação vai encolhida na direção da correlação
//   média (alvo de correlação constante), com intensidade declarada no meta. A
//   matriz crua vai junto, para auditoria.
//
// Uso:
//   node scripts/build-risk.js               # janela padrão de 5 anos
//   node scripts/build-risk.js --anos=3

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const DIR_HIST = path.join(RAIZ, 'data', 'historico');
const CACHE = path.join(RAIZ, '.cache', 'diario.json');

const args = process.argv.slice(2);
const opt = k => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : null; };
const JANELA_ANOS = Number(opt('anos') || 5);
const PREGOES_ANO = 252;
const COBERTURA_MIN = 0.8;      // fração da janela que o ativo precisa cobrir
const SHRINK = 0.15;            // intensidade do encolhimento da correlação
const IBOV = '^BVSP';

const arred = (v, c = 6) => (v == null || !isFinite(v) ? null : Number(v.toFixed(c)));

// ---------- estatística ----------
function retornos(niveis) {
  const r = [];
  for (let i = 1; i < niveis.length; i++) {
    const a = niveis[i - 1], b = niveis[i];
    r.push(a == null || b == null || a <= 0 ? null : b / a - 1);
  }
  return r;
}

const validos = r => r.filter(x => x != null);
const media = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

function desvio(a) {
  if (a.length < 2) return null;
  const m = media(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

// Retorno anualizado por composição — não pela média aritmética, que
// superestima quando há volatilidade.
function retAnualizado(r) {
  const v = validos(r);
  if (v.length < 30) return null;
  const fator = v.reduce((s, x) => s * (1 + x), 1);
  return fator ** (PREGOES_ANO / v.length) - 1;
}

const volAnualizada = r => { const d = desvio(validos(r)); return d == null ? null : d * Math.sqrt(PREGOES_ANO); };

// Pares em que AMBAS as séries têm retorno — evita comparar dias diferentes.
function pares(a, b) {
  const x = [], y = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] != null && b[i] != null) { x.push(a[i]); y.push(b[i]); }
  }
  return [x, y];
}

function covariancia(a, b) {
  const [x, y] = pares(a, b);
  if (x.length < 30) return null;
  const mx = media(x), my = media(y);
  let s = 0;
  for (let i = 0; i < x.length; i++) s += (x[i] - mx) * (y[i] - my);
  return s / (x.length - 1);
}

function correlacao(a, b) {
  const c = covariancia(a, b);
  if (c == null) return null;
  const [x, y] = pares(a, b);
  const dx = desvio(x), dy = desvio(y);
  return dx && dy ? c / (dx * dy) : null;
}

// Máximo drawdown sobre a série de níveis — a perda de pico a vale que o
// investidor teria atravessado. Para Buy and Hold diz mais que volatilidade.
function maxDrawdown(niveis) {
  let pico = null, pior = 0;
  for (const v of niveis) {
    if (v == null) continue;
    if (pico == null || v > pico) pico = v;
    const dd = v / pico - 1;
    if (dd < pior) pior = dd;
  }
  return pior;
}

// ---------- main ----------
function main() {
  if (!fs.existsSync(CACHE)) {
    console.error('✗ .cache/diario.json não encontrado. Rode antes: node scripts/build-history.js');
    process.exit(1);
  }
  const cache = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  const tesouro = JSON.parse(fs.readFileSync(path.join(DIR_HIST, 'tesouro.json'), 'utf8'));
  const indicadores = JSON.parse(fs.readFileSync(path.join(DIR_HIST, 'indicadores.json'), 'utf8'));
  const stocks = JSON.parse(fs.readFileSync(path.join(RAIZ, 'data', 'stocks.json'), 'utf8'));

  // Retorno esperado das ações = o que o próprio app calcula (DY + Growth).
  const esperadoAcao = {};
  for (const s of stocks.stocks) if (esperadoAcao[s.ativo] == null) esperadoAcao[s.ativo] = s.retorno;

  // --- janela comum ---
  const nJanela = Math.round(JANELA_ANOS * PREGOES_ANO);
  const datas = cache.datas.slice(-nJanela);
  const corte = cache.datas.length - datas.length;
  const fatia = k => cache.series[k].slice(corte);

  console.log(`→ janela de ${JANELA_ANOS} anos: ${datas[0]} a ${datas[datas.length - 1]} (${datas.length} pregões)\n`);

  // --- separa ações, títulos e benchmarks ---
  const chaves = Object.keys(cache.series);
  const acoes = chaves.filter(k => !k.startsWith('TD:') && !['^BVSP', 'XFIX11', 'CDI'].includes(k));
  const td = chaves.filter(k => k.startsWith('TD:'));

  // --- livre de risco: CDI da própria janela ---
  const cdiNiveis = fatia('CDI');
  const rCDI = retornos(cdiNiveis);
  const rf = retAnualizado(rCDI);
  // CDI corrente anualizado — o Rf prospectivo, que é o que importa para
  // decidir alocação daqui pra frente. Vem do indicadores.json, que guarda a
  // taxa CRUA do BCB. Não tentar reconstruí-la a partir do índice alinhado: o
  // CDI é publicado em dias bancários e o índice é reamostrado no calendário da
  // B3, então dias sobram ou faltam e a anualização de janela curta erra feio
  // (medido: 15,5% contra os 13,9% reais). Sobre a JANELA longa a distorção se
  // dilui, então rf continua vindo da série.
  const cdiHoje = indicadores.cdi.taxa_anual;
  console.log(`· CDI na janela: ${(100 * rf).toFixed(2)}% a.a. | hoje: ${(100 * cdiHoje).toFixed(2)}% a.a.`);

  // --- mercado: Ibovespa ---
  const rIbov = retornos(fatia(IBOV));
  const retIbov = retAnualizado(rIbov);
  const volIbov = volAnualizada(rIbov);
  console.log(`· Ibovespa na janela: ${(100 * retIbov).toFixed(2)}% a.a., vol ${(100 * volIbov).toFixed(2)}%\n`);

  // --- breakeven de inflação, tirado da própria curva ---
  const breakeven = calcularBreakeven(tesouro.titulos);
  console.log(`· Inflação implícita (breakeven Prefixado × IPCA+): ${(100 * breakeven.taxa).toFixed(2)}% a.a.`
    + ` [${breakeven.pares.map(p => `${p.anos}a:${(100 * p.be).toFixed(2)}%`).join(', ')}]\n`);

  // --- classes sintéticas de título (indexador × bucket) ---
  const classes = montarClasses(tesouro.titulos, td, fatia);
  console.log(`· ${Object.keys(classes).length} classes de título:`);
  for (const [id, c] of Object.entries(classes)) {
    console.log(`    ${id.padEnd(14)} ${String(c.membros).padStart(2)} papéis, vol ${(100 * c.vol).toFixed(2)}% a.a.`);
  }

  // --- estatísticas por ativo ---
  const ativos = {};
  const retornosPorId = {};
  let foraDaMatriz = [];

  for (const t of acoes) {
    const niveis = fatia(t);
    const r = retornos(niveis);
    const cobertura = validos(r).length / r.length;
    const st = estatisticas(r, niveis, rIbov, rf, retIbov);
    ativos[t] = {
      tipo: 'acao',
      ...st,
      cobertura: arred(cobertura, 3),
      ret_esperado: arred(esperadoAcao[t], 6),
      na_matriz: cobertura >= COBERTURA_MIN,
    };
    if (cobertura >= COBERTURA_MIN) retornosPorId[t] = r;
    else foraDaMatriz.push(t);
  }

  for (const [id, c] of Object.entries(classes)) {
    const st = estatisticas(c.retornos, c.niveis, rIbov, rf, retIbov);
    ativos[id] = { tipo: 'classe_titulo', ...st, membros: c.membros, cobertura: 1, na_matriz: true };
    retornosPorId[id] = c.retornos;
  }

  // --- matriz de correlação + encolhimento ---
  const ids = Object.keys(retornosPorId);
  const n = ids.length;
  const corr = Array.from({ length: n }, () => new Array(n).fill(0));
  let somaFora = 0, contaFora = 0;
  for (let i = 0; i < n; i++) {
    corr[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const c = correlacao(retornosPorId[ids[i]], retornosPorId[ids[j]]) ?? 0;
      corr[i][j] = corr[j][i] = c;
      somaFora += c; contaFora++;
    }
  }
  const corrMedia = contaFora ? somaFora / contaFora : 0;
  const corrShrink = corr.map((linha, i) => linha.map((c, j) =>
    arred(i === j ? 1 : (1 - SHRINK) * c + SHRINK * corrMedia, 4)));

  console.log(`\n· Matriz ${n}×${n} | correlação média ${corrMedia.toFixed(3)}`
    + ` | encolhida ${(100 * SHRINK).toFixed(0)}% na direção da média`);
  if (foraDaMatriz.length) console.log(`  fora da matriz (histórico curto): ${foraDaMatriz.join(', ')}`);

  // --- retorno esperado dos títulos, em termos nominais ---
  const titulos = tesouro.titulos.map(t => {
    const classe = `${t.indexador}_${t.bucket}`;
    const taxa = t.taxa_compra == null ? null : t.taxa_compra / 100;
    let nominal = null;
    if (taxa != null) {
      if (t.indexador === 'PRE') nominal = taxa;
      else if (t.indexador === 'SELIC') nominal = cdiHoje + taxa;         // ágio/deságio sobre a Selic
      else nominal = (1 + taxa) * (1 + breakeven.taxa) - 1;               // IPCA+ e IGPM+
    }
    return {
      ...t,
      classe_risco: ativos[classe] ? classe : null,
      ret_esperado_nominal: arred(nominal, 6),
      // Em IPCA+ a taxa contratada JÁ É o retorno real. Nos demais é preciso
      // deflacionar o nominal — inclusive no Selic, onde a "taxa" do papel é
      // apenas o ágio sobre a Selic, não um retorno real.
      ret_esperado_real: arred(t.indexador === 'IPCA' ? taxa
        : nominal == null ? null : (1 + nominal) / (1 + breakeven.taxa) - 1, 6),
      // O breakeven sai de Prefixado × IPCA+. Aplicá-lo ao IGP-M é aproximação:
      // os dois índices divergem bastante (o IGP-M pesa atacado e câmbio).
      ...(t.indexador === 'IGPM' ? { aviso: 'nominal estimado com inflação implícita de IPCA, não de IGP-M' } : {}),
      // Modo "carrego até o vencimento": a oscilação de mercado não se realiza.
      // Não é zero absoluto — sobra a incerteza de reinvestimento de cupom e,
      // no prefixado, a inflação — mas é ordem de grandeza menor que a MTM.
      vol_carrego: t.indexador === 'PRE' ? arred(breakeven.dispersao, 4) : 0,
      vol_mtm: ativos[classe] ? ativos[classe].vol : t.vol_mtm,
    };
  });

  // --- benchmarks ---
  const benchmarks = {
    '^BVSP': estatisticas(rIbov, fatia(IBOV), rIbov, rf, retIbov),
    'XFIX11': estatisticas(retornos(fatia('XFIX11')), fatia('XFIX11'), rIbov, rf, retIbov),
    'CDI': estatisticas(rCDI, cdiNiveis, rIbov, rf, retIbov),
  };

  const saida = {
    meta: {
      gerado_em: new Date().toISOString(),
      janela_anos: JANELA_ANOS,
      inicio: datas[0],
      fim: datas[datas.length - 1],
      pregoes: datas.length,
      pregoes_ano: PREGOES_ANO,
      rf_janela: arred(rf, 6),
      rf_hoje: arred(cdiHoje, 6),
      inflacao_implicita: arred(breakeven.taxa, 6),
      breakeven_pares: breakeven.pares,
      correlacao_media: arred(corrMedia, 4),
      shrinkage: SHRINK,
      cobertura_minima: COBERTURA_MIN,
      fora_da_matriz: foraDaMatriz,
      sem_historico: cache.meta.sem_historico || [],
      avisos: [
        'alpha, beta e tracking error são medidos contra o Ibovespa. Numa carteira com renda fixa, comparar só ao Ibov não faz sentido: monte um benchmark composto na mesma proporção da alocação.',
        'Tracking error alto não é defeito numa carteira de dividendos — é o objetivo. O Ibovespa é concentrado em outra coisa.',
        'vol_mtm vale para quem pode vender antes do vencimento. Quem carrega até o fim recebe o contratado: use vol_carrego.',
        'ret_esperado das ações é DY + Growth (metodologia do próprio app), não média histórica.',
        'A matriz vai encolhida na direção da correlação média para conter erro de estimativa. A crua está em correlacao_amostral.',
        ...(retIbov < rf ? ['ATENÇÃO nesta janela: o Ibovespa rendeu MENOS que o CDI, ou seja, o prêmio de risco de mercado foi negativo. Com prêmio negativo, o alpha de Jensen premia beta BAIXO e pune beta alto — o sinal se inverte em relação à leitura habitual. Interpretar com a janela à vista.'] : []),
      ],
      premio_risco_janela: arred(retIbov - rf, 6),
    },
    ids,
    ativos,
    titulos,
    benchmarks,
    correlacao: corrShrink,
    correlacao_amostral: corr.map(l => l.map(c => arred(c, 4))),
  };

  const p = path.join(DIR_HIST, 'risco.json');
  fs.writeFileSync(p, JSON.stringify(saida), 'utf8');
  console.log(`\n✓ data/historico/risco.json — ${(fs.statSync(p).size / 1024).toFixed(0)} KB`);
}

// Estatísticas de um ativo contra o mercado e o livre de risco.
function estatisticas(r, niveis, rIbov, rf, retIbov) {
  const ret = retAnualizado(r);
  const vol = volAnualizada(r);
  const cov = covariancia(r, rIbov);
  const varIbov = desvio(validos(rIbov)) ** 2;
  const beta = cov == null || !varIbov ? null : cov / varIbov;

  // Tracking error: desvio da DIFERENÇA diária contra o índice, anualizado.
  const dif = [];
  for (let i = 0; i < r.length; i++) {
    if (r[i] != null && rIbov[i] != null) dif.push(r[i] - rIbov[i]);
  }
  const te = dif.length > 30 ? desvio(dif) * Math.sqrt(PREGOES_ANO) : null;

  return {
    ret_hist: arred(ret, 6),
    vol: arred(vol, 6),
    beta: arred(beta, 4),
    // Alpha de Jensen: quanto o ativo entregou ALÉM do que o beta dele já
    // explicaria. Rp − [Rf + β(Rm − Rf)].
    alpha: arred(ret == null || beta == null ? null : ret - (rf + beta * (retIbov - rf)), 6),
    sharpe: arred(ret == null || !vol ? null : (ret - rf) / vol, 4),
    tracking_error: arred(te, 6),
    corr_ibov: arred(correlacao(r, rIbov), 4),
    max_drawdown: arred(maxDrawdown(niveis), 4),
  };
}

// Inflação implícita: entre um Prefixado e um IPCA+ de vencimentos próximos,
// (1+pre)/(1+real)−1 é a inflação que iguala os dois. Sai da curva, não de
// palpite. A dispersão entre os pares serve de medida grosseira da incerteza.
function calcularBreakeven(titulos) {
  const pre = titulos.filter(t => t.indexador === 'PRE' && !t.juros_semestrais && t.taxa_compra);
  const ipca = titulos.filter(t => t.indexador === 'IPCA' && !t.juros_semestrais
    && !t.fluxo_programado && t.taxa_compra);
  const pares = [];
  for (const p of pre) {
    let melhor = null, dist = Infinity;
    for (const i of ipca) {
      const d = Math.abs(i.anos_ate_vencimento - p.anos_ate_vencimento);
      if (d < dist) { dist = d; melhor = i; }
    }
    if (melhor && dist <= 2) {
      pares.push({
        anos: Math.round(p.anos_ate_vencimento),
        be: arred((1 + p.taxa_compra / 100) / (1 + melhor.taxa_compra / 100) - 1, 6),
      });
    }
  }
  if (!pares.length) return { taxa: 0.045, pares: [], dispersao: 0.01 };
  const vals = pares.map(p => p.be);
  const m = vals.reduce((s, x) => s + x, 0) / vals.length;
  const d = vals.length > 1
    ? Math.sqrt(vals.reduce((s, x) => s + (x - m) ** 2, 0) / (vals.length - 1)) : 0.01;
  return { taxa: m, pares, dispersao: d };
}

// Série sintética por (indexador × bucket): média dos retornos diários dos
// papéis da classe. Estacionária o suficiente para entrar na matriz, ao
// contrário da série de um papel isolado.
function montarClasses(titulos, chavesTD, fatia) {
  const grupos = {};
  for (const t of titulos) {
    const id = `${t.indexador}_${t.bucket}`;
    const chave = `TD:${t.id}`;
    if (!chavesTD.includes(chave)) continue;
    (grupos[id] = grupos[id] || []).push(chave);
  }

  const out = {};
  for (const [id, chaves] of Object.entries(grupos)) {
    const rs = chaves.map(c => retornos(fatia(c)));
    const n = rs[0].length;
    const medios = [];
    for (let i = 0; i < n; i++) {
      const vs = rs.map(r => r[i]).filter(x => x != null);
      medios.push(vs.length ? vs.reduce((s, x) => s + x, 0) / vs.length : null);
    }
    // Reconstrói um nível base 100 para poder medir drawdown.
    const niveis = [100];
    for (const r of medios) niveis.push(r == null ? niveis[niveis.length - 1] : niveis[niveis.length - 1] * (1 + r));
    out[id] = { retornos: medios, niveis, membros: chaves.length, vol: volAnualizada(medios) };
  }
  return out;
}

main();
