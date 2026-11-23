// =====================================================================
// jl.js — lançamentos e conferência do Controle de Produção JL Vestuário
// Usa AS MESMAS fórmulas do index.html. Roda em dois lugares:
//   node ferramentas/jl.js <comando> [args]                 (nuvem / qualquer PC com node)
//   osascript -l JavaScript ferramentas/jl.js <comando> [args]   (Mac sem node)
//
// Comandos:
//   resumo | auditoria | codigo R0035 | costureira Mariani | json <doc>
//   simular <arquivo.json>   -> mostra o que vai acontecer, NÃO grava
//   gravar  <arquivo.json>   -> grava (backup + histórico + trava de conflito, tudo atômico)
//   backups                  -> lista os últimos backups
//   desfazer <backupId>      -> volta producao/perdas para o backup (com trava de conflito)
//
// arquivo.json: {"op":"retornoCostura","params":{...},"mensagem":"texto original do Gabriel"}
// Ops: envioCorte, retornoCorte, envioCostura, retornoCostura, revisao, pagamento, corrigirValor
// =====================================================================

var PROJ = 'controle-cfe01';
var KEY = 'AIzaSyBE02mRJjInJHMizSQK236W4Rb-nv2aLMw'; // chave pública do app (já está no index.html)
var DOCS = 'projects/' + PROJ + '/databases/(default)/documents';
var API = 'https://firestore.googleapis.com/v1/' + DOCS;
var COL = 'controle_producao_dados';
var COL_BACKUP = 'controle_producao_backups';
var COL_LOG = 'controle_producao_log';
var TA = ['P', 'M', 'G', 'GG'], TI = ['2', '4', '6', '8', '10', '12', '14', '16'];

// ---------------- ambiente (node ou JXA) ----------------
var IS_NODE = (typeof process !== 'undefined' && typeof require === 'function');
var IO = IS_NODE ? (function () {
  var cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
  return {
    read: function (p) { return fs.readFileSync(p, 'utf8'); },
    write: function (p, s) { fs.writeFileSync(p, s, 'utf8'); },
    tmp: function () { return path.join(os.tmpdir(), 'jl_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.json'); },
    sh: function (args) { return cp.execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
  };
})() : (function () {
  ObjC.import('Foundation');
  var app = Application.currentApplication(); app.includeStandardAdditions = true;
  function q(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
  return {
    read: function (p) { return ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(p, 4, null)); },
    write: function (p, s) { $.NSString.alloc.initWithUTF8String(s).writeToFileAtomicallyEncodingError(p, true, 4, null); },
    tmp: function () { return ObjC.unwrap($.NSTemporaryDirectory()) + 'jl_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.json'; },
    sh: function (args) { return app.doShellScript('curl ' + args.map(q).join(' '), { alteringLineEndings: false }); }
  };
})();

function http(method, url, body) {
  var args = ['-sS', '-X', method, '-H', 'Content-Type: application/json', '-w', '\n%{http_code}'];
  var f = null;
  if (body !== undefined) { f = IO.tmp(); IO.write(f, JSON.stringify(body)); args.push('--data-binary', '@' + f); }
  args.push(url);
  var out = IO.sh(args);
  var i = out.lastIndexOf('\n');
  var code = Number(out.slice(i + 1)), txt = out.slice(0, i);
  var json = null; try { json = JSON.parse(txt); } catch (e) { }
  return { code: code, json: json, text: txt };
}
function lerDoc(k) {
  var r = http('GET', API + '/' + COL + '/' + k + '?key=' + KEY);
  if (r.code === 404) return { value: [], updateTime: null, existe: false };
  if (r.code !== 200) throw new Error('Falha ao ler ' + k + ' (' + r.code + '): ' + r.text.slice(0, 300));
  return { value: JSON.parse(r.json.fields.value.stringValue), updateTime: r.json.updateTime, existe: true };
}
function lerTudo() {
  var s = {}, t = {};
  ['producao', 'perdas', 'config', 'fornecedores', 'insumosExtras'].forEach(function (k) { var d = lerDoc(k); s[k] = d.value; t[k] = d.updateTime; });
  return { estado: s, versoes: t };
}

// ---------------- utilidades (iguais ao app) ----------------
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function hojeBR() { return new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10); } // Brasília (sem horário de verão)
function tamsDoLote(p) { return (p && p.sistemaTamanho === 'infantil') ? TI : TA; }
function somaTam(o, t) { if (!o) return 0; return (t || TA).reduce(function (s, x) { return s + Number(o[x] || 0); }, 0); }
function tamStr(o, t) { if (!o) return '-'; var s = t.filter(function (x) { return Number(o[x]) > 0; }).map(function (x) { return x + ':' + o[x]; }).join(' '); return s || '0'; }
function num(v) { return v == null ? '-' : (Math.round(v * 100) / 100).toString().replace('.', ','); }
function rs(v) { return v == null ? '-' : 'R$ ' + (Math.round(v * 100) / 100).toFixed(2).replace('.', ','); }
function clone(x) { return JSON.parse(JSON.stringify(x)); }
function normTam(sistema, tam) {
  // aceita {"4":52} ou {"P":10}; valida tamanhos do sistema
  var lista = sistema === 'infantil' ? TI : TA, out = {};
  lista.forEach(function (t) { out[t] = 0; });
  Object.keys(tam || {}).forEach(function (k) {
    var kk = String(k).toUpperCase();
    if (lista.indexOf(kk) < 0) throw new Error('Tamanho "' + k + '" não existe no sistema ' + sistema + ' (' + lista.join(', ') + ')');
    out[kk] = Number(tam[k]) || 0;
  });
  return out;
}

function Ctx(estado) {
  var S = estado;
  var c = {
    S: S,
    proximoCodigo: function () {
      var m = 0; S.producao.forEach(function (p) { if (p.codigoRevisao) { var n = parseInt(String(p.codigoRevisao).replace(/\D/g, '')) || 0; if (n > m) m = n; } });
      return 'R' + String(m + 1).padStart(4, '0');
    },
    findRate: function (nome, produto) {
      var f = S.config.find(function (x) { return x.nome === nome; }); if (!f) return null;
      var r = f.rates.find(function (x) { return x.produto.toLowerCase() === String(produto).toLowerCase(); });
      return r ? r.valor : null;
    },
    // preços por faixa de tamanho, ex.: "Moletom Canguru Infantil 2 ao 8"
    faixas: function (nome, produto) {
      var f = S.config.find(function (x) { return x.nome === nome; }); if (!f) return [];
      var base = String(produto).toLowerCase().trim();
      return f.rates.map(function (r) {
        var m = r.produto.match(/^(.*\S)\s+(\d+)\s+ao\s+(\d+)\s*$/i);
        if (!m || m[1].toLowerCase() !== base) return null;
        return { produto: r.produto, de: Number(m[2]), ate: Number(m[3]), valor: r.valor };
      }).filter(Boolean);
    },
    custoInsumosExtrasPorPeca: function () { return S.insumosExtras.reduce(function (s, i) { return s + Number(i.valorUnitario || 0) * Number(i.quantidadePorPeca || 0); }, 0); },
    media: function (produto, campo, cond) {
      var l = S.producao.filter(function (x) { return x.etapa === 'corte' && x.produto === produto && cond(x); });
      if (!l.length) return 0; return l.reduce(function (s, x) { return s + Number(x[campo] || 0); }, 0) / l.length;
    },
    custoMedioMP: function (p) { return c.media(p, 'custoMateriaPrimaPorPeca', function (x) { return x.custoMateriaPrimaPorPeca != null; }); },
    precoMedioTec: function (p) { return c.media(p, 'precoKgTecido', function (x) { return Number(x.precoKgTecido) > 0; }); },
    precoMedioRib: function (p) { return c.media(p, 'precoKgRibana', function (x) { return Number(x.precoKgRibana) > 0; }); },
    laborCorteMedio: function (p) { return c.media(p, 'valorUnit', function (x) { return Number(x.valorUnit) > 0; }); },
    proporcaoTec: function (produto) {
      var l = S.producao.filter(function (x) { return x.etapa === 'corte' && x.produto === produto && (Number(x.pesoBobinas) + Number(x.pesoRibana)) > 0; });
      if (!l.length) return 1;
      var t = l.reduce(function (s, x) { return s + Number(x.pesoBobinas || 0); }, 0), tot = l.reduce(function (s, x) { return s + Number(x.pesoBobinas || 0) + Number(x.pesoRibana || 0); }, 0);
      return tot > 0 ? t / tot : 1;
    },
    perdaNaoRetorno: function (p, qtd) {
      var mp = p.custoCorteHerdado != null ? p.custoCorteHerdado : c.custoMedioMP(p.produto);
      var lab = p.custoLaborCorteHerdado != null ? p.custoLaborCorteHerdado : c.laborCorteMedio(p.produto);
      return { valorMateriaPrima: mp * qtd, valorCorte: lab * qtd, valorTotal: mp * qtd + lab * qtd };
    },
    perdaRevisao: function (p, naoAprov, peso) {
      var lab = p.custoLaborCorteHerdado != null ? p.custoLaborCorteHerdado : c.laborCorteMedio(p.produto);
      var pt = p.precoKgTecidoHerdado != null ? p.precoKgTecidoHerdado : c.precoMedioTec(p.produto);
      var pr = p.precoKgRibanaHerdado != null ? p.precoKgRibanaHerdado : c.precoMedioRib(p.produto);
      var prop = p.proporcaoTecidoHerdada != null ? p.proporcaoTecidoHerdada : c.proporcaoTec(p.produto);
      var tk = peso * prop, rk = peso * (1 - prop), vt = tk * pt, vr = rk * pr, vc = naoAprov * lab, vi = naoAprov * c.custoInsumosExtrasPorPeca();
      return { tecidoKgPerdido: tk, ribanaKgPerdido: rk, valorTecido: vt, valorRibana: vr, valorCorte: vc, valorInsumos: vi, valorTotal: vt + vr + vc + vi };
    },
    corte: function (codigo, statusQuer) {
      var l = S.producao.filter(function (p) { return p.etapa === 'corte' && p.codigoRevisao === String(codigo).toUpperCase() && (!statusQuer || statusQuer(p)); });
      if (!l.length) throw new Error('Não achei corte ' + codigo + ' nesse estado.');
      if (l.length > 1) throw new Error('Mais de um corte com ' + codigo + '; informe o id.');
      return l[0];
    },
    porId: function (id) { var p = S.producao.find(function (x) { return x.id === id; }); if (!p) throw new Error('id ' + id + ' não existe'); return p; }
  };
  return c;
}

// ---------------- operações ----------------
// Cada operação recebe (ctx, params) e devolve {linhas:[], avisos:[], docs:['producao','perdas']}
var OPS = {};

// Envio para o cortador: {funcionario, data?, cores:[{cor, fornecedor, precoTecido?, precoRibana?, numeroPedido,
//   bobinas:[{produto, sistema:'adulto'|'infantil', peso, pesoRibana, meta, tamanhos:['4','6'] , valorUnit?}]}]}
OPS.envioCorte = function (c, a) {
  var S = c.S, L = [], W = [], data = a.data || hojeBR();
  var cad = S.config.find(function (x) { return x.nome === a.funcionario; });
  if (!cad) throw new Error('Cortador "' + a.funcionario + '" não está no Cadastro.');
  if (!a.cores || !a.cores.length) throw new Error('Informe ao menos uma cor.');
  a.cores.forEach(function (cr) {
    if (!cr.cor) throw new Error('Cor sem nome.');
    var forn = cr.fornecedor ? S.fornecedores.find(function (f) { return f.nome === cr.fornecedor; }) : null;
    if (cr.fornecedor && !forn) throw new Error('Fornecedor "' + cr.fornecedor + '" não está cadastrado.');
    var pt = cr.precoTecido != null ? Number(cr.precoTecido) : (forn ? Number(forn.precoTecidoKg) : 0);
    var pr = cr.precoRibana != null ? Number(cr.precoRibana) : (forn ? Number(forn.precoRibanaKg) : 0);
    if (!(pt > 0)) throw new Error('Cor ' + cr.cor + ': falta preço do tecido.');
    if (!cr.numeroPedido) W.push('Cor ' + cr.cor + ': sem número do pedido.');
    (cr.bobinas || []).forEach(function (b, bi) {
      var sist = b.sistema === 'infantil' ? 'infantil' : 'adulto', lista = sist === 'infantil' ? TI : TA;
      if (!b.produto) throw new Error('Bobina ' + (bi + 1) + ' da cor ' + cr.cor + ' sem produto.');
      if (sist === 'infantil' && !/infantil/i.test(b.produto)) throw new Error('Produto "' + b.produto + '" com tamanhos infantis: use o nome com "Infantil".');
      if (!(Number(b.peso) > 0)) throw new Error('Bobina ' + (bi + 1) + ' (' + cr.cor + '): falta peso do tecido.');
      if (!(Number(b.meta) > 0)) W.push('Bobina ' + (bi + 1) + ' (' + cr.cor + '): sem meta de rendimento.');
      var tams = (b.tamanhos || []).map(function (t) { return String(t).toUpperCase(); });
      tams.forEach(function (t) { if (lista.indexOf(t) < 0) throw new Error('Tamanho ' + t + ' não existe em ' + sist); });
      if (!tams.length) throw new Error('Bobina ' + (bi + 1) + ' (' + cr.cor + '): informe os tamanhos.');
      var vu = b.valorUnit != null ? Number(b.valorUnit) : c.findRate(a.funcionario, b.produto);
      if (vu == null) { vu = 0; W.push('Sem preço de corte para "' + b.produto + '" na tabela de ' + a.funcionario + ' → R$ 0.'); }
      var n = { id: uid(), dataEnvio: data, etapa: 'corte', funcionario: a.funcionario, produto: b.produto.trim(), valorUnit: vu,
        quantidadeEnviada: 0, quantidadeRetornada: null, dataRetorno: null, valorTotal: 0,
        quantidadeAproveitavel: null, quantidadeNaoAproveitavel: 0, valorCredito: 0, creditoAplicado: false,
        paga: false, dataPagamento: null, status: 'enviado', sistemaTamanho: sist };
      n.envioGrupoId = n.id; n.cor = cr.cor.trim(); n.pesoBobinas = Number(b.peso); n.pesoRibana = Number(b.pesoRibana || 0);
      n.fornecedorTecido = cr.fornecedor || ''; n.fornecedorRibana = cr.fornecedor || ''; n.numeroLoteFornecedor = String(cr.numeroPedido || '').trim();
      n.metaRendimentoBobina = Number(b.meta || 0); n.precoKgTecido = pt; n.precoKgRibana = pr;
      n.consumoTecidoPorPeca = null; n.consumoRibanaPorPeca = null; n.custoTecidoPorPeca = null; n.custoRibanaPorPeca = null; n.custoMateriaPrimaPorPeca = null;
      n.tamanhosSolicitados = {}; lista.forEach(function (t) { n.tamanhosSolicitados[t] = tams.indexOf(t) >= 0; });
      n.codigoRevisao = c.proximoCodigo();
      S.producao.push(n);
      L.push(n.codigoRevisao + ' · corte ' + a.funcionario + ' · ' + n.produto + ' · ' + n.cor + ' · ' + num(n.pesoBobinas) + 'kg tecido + ' + num(n.pesoRibana) + 'kg ribana · tam ' + tams.join('/') + ' · meta ' + (n.metaRendimentoBobina || '-') + ' · tecido ' + rs(pt) + '/kg · corte ' + rs(vu) + '/pç');
    });
  });
  return { linhas: L, avisos: W, docs: ['producao'] };
};

// Retorno do corte: {codigo | id, tamanhos:{"P":60,...}, data?, pago?:true, dataPagamento?, enviarPara?:"Mariani"}
OPS.retornoCorte = function (c, a) {
  var S = c.S, L = [], W = [];
  var p = a.id ? c.porId(a.id) : c.corte(a.codigo, function (x) { return x.status === 'enviado'; });
  if (p.etapa !== 'corte' || p.status !== 'enviado') throw new Error((p.codigoRevisao || p.id) + ' não é um corte aguardando retorno.');
  var tams = tamsDoLote(p), tam = normTam(p.sistemaTamanho, a.tamanhos), qtd = somaTam(tam, tams);
  if (qtd <= 0) throw new Error('Informe ao menos uma peça.');
  var sol = p.tamanhosSolicitados || {};
  tams.forEach(function (t) { if (tam[t] > 0 && sol[t] === false) W.push('Tamanho ' + t + ' não estava pedido nesse corte.'); });
  var dataRet = a.data || hojeBR(), pago = a.pago !== false;
  p.tamanhosCortados = tam; p.quantidadeRetornada = qtd; p.dataRetorno = dataRet;
  p.valorTotal = qtd * Number(p.valorUnit || 0); p.status = 'retornado'; p.paga = pago; p.dataPagamento = pago ? (a.dataPagamento || dataRet) : null;
  p.consumoTecidoPorPeca = Number(p.pesoBobinas || 0) / qtd; p.consumoRibanaPorPeca = Number(p.pesoRibana || 0) / qtd;
  p.custoTecidoPorPeca = p.consumoTecidoPorPeca * Number(p.precoKgTecido || 0); p.custoRibanaPorPeca = p.consumoRibanaPorPeca * Number(p.precoKgRibana || 0);
  p.custoInsumosExtrasPorPeca = c.custoInsumosExtrasPorPeca();
  p.custoMateriaPrimaPorPeca = p.custoTecidoPorPeca + p.custoRibanaPorPeca + p.custoInsumosExtrasPorPeca;
  p.custoCompletoPorPeca = p.custoMateriaPrimaPorPeca + Number(p.valorUnit || 0);
  p.rendimentoObtido = qtd; p.diferencaRendimento = Number(p.metaRendimentoBobina || 0) > 0 ? qtd - Number(p.metaRendimentoBobina) : null;
  L.push(p.codigoRevisao + ' · retorno do corte (' + p.funcionario + ') · ' + p.produto + ' ' + (p.cor || '') + ' · rendeu ' + qtd + ' (' + tamStr(tam, tams) + ')' +
    (p.diferencaRendimento != null ? ' · meta ' + p.metaRendimentoBobina + ' → ' + (p.diferencaRendimento >= 0 ? '+' : '') + p.diferencaRendimento : '') +
    ' · tecido+ribana+insumos ' + rs(p.custoMateriaPrimaPorPeca) + '/pç · corte a pagar ' + rs(p.valorTotal) + (pago ? ' (pago)' : ' (a pagar)'));
  if (p.diferencaRendimento != null && p.diferencaRendimento < 0) W.push('Rendimento ' + (-p.diferencaRendimento) + ' peças ABAIXO da meta.');
  var r = { linhas: L, avisos: W, docs: ['producao'] };
  if (a.enviarPara) { var e = OPS.envioCostura(c, { funcionario: a.enviarPara, id: p.id, data: a.dataEnvioCostura || dataRet, valorUnit: a.valorUnitCostura }); r.linhas = r.linhas.concat(e.linhas); r.avisos = r.avisos.concat(e.avisos); }
  return r;
};

// Envio para costureira a partir de um corte: {funcionario, codigo | id (do corte), tamanhos?, produto?, valorUnit?, data?, insumos?:{insumoId:qtd}, forcar?}
OPS.envioCostura = function (c, a) {
  var S = c.S, L = [], W = [];
  var cad = S.config.find(function (x) { return x.nome === a.funcionario; });
  if (!cad) throw new Error('Costureira "' + a.funcionario + '" não está no Cadastro.');
  var o = a.id ? c.porId(a.id) : c.corte(a.codigo, function (x) { return x.status !== 'enviado'; });
  if (o.etapa !== 'corte' || o.status === 'enviado') throw new Error((o.codigoRevisao || o.id) + ': o corte ainda não retornou.');
  var ja = S.producao.filter(function (x) { return x.loteCorteOrigemId === o.id; });
  if (ja.length && !a.forcar) throw new Error(o.codigoRevisao + ' já foi enviado para costura (' + ja.map(function (x) { return x.funcionario; }).filter(function (v, i, s) { return s.indexOf(v) === i; }).join(', ') + '). Não vou duplicar.');
  var tams = tamsDoLote(o), tam = a.tamanhos ? normTam(o.sistemaTamanho, a.tamanhos) : clone(o.tamanhosCortados || {});
  tams.forEach(function (t) { if (Number(tam[t] || 0) > Number((o.tamanhosCortados || {})[t] || 0)) throw new Error('Tamanho ' + t + ': enviando ' + tam[t] + ' mas o corte rendeu ' + ((o.tamanhosCortados || {})[t] || 0) + '.'); });
  var produto = a.produto || o.produto, data = a.data || hojeBR();
  // grupos de preço: preço único ou por faixa de tamanho
  var grupos = [];
  var vu = a.valorUnit != null ? Number(a.valorUnit) : c.findRate(a.funcionario, produto);
  if (vu != null) grupos.push({ produto: produto, valor: vu, tams: tams });
  else {
    var fx = c.faixas(a.funcionario, produto);
    if (!fx.length) throw new Error('Não achei preço de "' + produto + '" na tabela de ' + a.funcionario + ' (' + cad.rates.map(function (r) { return r.produto; }).join('; ') + '). Informe valorUnit.');
    fx.forEach(function (f) { grupos.push({ produto: f.produto, valor: f.valor, tams: tams.filter(function (t) { var n = Number(t); return n >= f.de && n <= f.ate; }) }); });
    var cobertos = [].concat.apply([], grupos.map(function (g) { return g.tams; }));
    tams.forEach(function (t) { if (Number(tam[t] || 0) > 0 && cobertos.indexOf(t) < 0) throw new Error('Tamanho ' + t + ' sem faixa de preço na tabela de ' + a.funcionario + '.'); });
  }
  var pesoTec = Number(o.pesoBobinas || 0), pesoRib = Number(o.pesoRibana || 0), insumosUsados = false;
  grupos.forEach(function (g) {
    var te = {}; tams.forEach(function (t) { te[t] = g.tams.indexOf(t) >= 0 ? Number(tam[t] || 0) : 0; });
    var q = somaTam(te, tams); if (q <= 0) return;
    var n = { id: uid(), dataEnvio: data, etapa: 'costura', funcionario: a.funcionario, produto: g.produto, valorUnit: g.valor,
      quantidadeEnviada: q, quantidadeRetornada: null, dataRetorno: null, valorTotal: 0,
      quantidadeAproveitavel: null, quantidadeNaoAproveitavel: 0, valorCredito: 0, creditoAplicado: false,
      paga: false, dataPagamento: null, status: 'enviado', sistemaTamanho: o.sistemaTamanho };
    n.envioGrupoId = n.id; n.tamanhosEnviados = te; n.quantidadeEnviadaOriginal = q; n.loteCorteOrigemId = o.id;
    n.custoCorteHerdado = o.custoMateriaPrimaPorPeca != null ? o.custoMateriaPrimaPorPeca : null;
    n.precoKgTecidoHerdado = o.precoKgTecido != null ? o.precoKgTecido : null;
    n.precoKgRibanaHerdado = o.precoKgRibana != null ? o.precoKgRibana : null;
    n.custoLaborCorteHerdado = o.valorUnit != null ? o.valorUnit : null;
    n.proporcaoTecidoHerdada = (pesoTec + pesoRib) > 0 ? pesoTec / (pesoTec + pesoRib) : null;
    n.codigoRevisao = o.codigoRevisao || c.proximoCodigo();
    n.insumosEnviados = (!insumosUsados && a.insumos) ? clone(a.insumos) : {}; insumosUsados = true;
    S.producao.push(n);
    L.push(n.codigoRevisao + ' · envio p/ ' + a.funcionario + ' · ' + n.produto + ' ' + (o.cor || '') + ' · ' + q + ' pç (' + tamStr(te, tams) + ') · ' + rs(g.valor) + '/pç');
  });
  if (!L.length) throw new Error('Nenhuma peça para enviar.');
  return { linhas: L, avisos: W, docs: ['producao'] };
};

// Retorno da costureira (igual ao "Retorno por Costureira" do app, FIFO do envio mais antigo):
// {funcionario, codigo?, tamanhos:{"4":52}, perdas?:{"6":2}, pesoNaoCosturado?, data?, pago?:true, dataPagamento?}
OPS.retornoCostura = function (c, a) {
  var S = c.S, L = [], W = [], novas = [];
  var lotes = S.producao.filter(function (p) { return p.funcionario === a.funcionario && p.etapa === 'costura' && p.status === 'enviado' && (!a.codigo || p.codigoRevisao === String(a.codigo).toUpperCase()); });
  if (!lotes.length) throw new Error(a.funcionario + ' não tem peças em mãos' + (a.codigo ? ' do ' + a.codigo : '') + '.');
  var usados = {}; lotes.forEach(function (p) { tamsDoLote(p).forEach(function (t) { usados[t] = 1; }); });
  var tams = TA.concat(TI).filter(function (t) { return usados[t]; });
  function norm(o) { var r = {}; tams.forEach(function (t) { r[t] = 0; }); Object.keys(o || {}).forEach(function (k) { var kk = String(k).toUpperCase(); if (tams.indexOf(kk) < 0) throw new Error('Tamanho ' + k + ' não está em mãos de ' + a.funcionario + (a.codigo ? ' no ' + a.codigo : '') + ' (em mãos: ' + tams.join(', ') + ').'); r[kk] = Number(o[k]) || 0; }); return r; }
  var ret = norm(a.tamanhos), perd = norm(a.perdas);
  var tot = {}; tams.forEach(function (t) { tot[t] = 0; }); lotes.forEach(function (p) { tams.forEach(function (t) { tot[t] += Number((p.tamanhosEnviados || {})[t] || 0); }); });
  tams.forEach(function (t) { if (ret[t] + perd[t] > tot[t]) throw new Error('Tamanho ' + t + ': ' + (ret[t] + perd[t]) + ' informado(s), mas ' + a.funcionario + ' só tem ' + tot[t] + ' em mãos' + (a.codigo ? ' do ' + a.codigo : '') + '.'); });
  var qtdRet = somaTam(ret, tams);
  if (qtdRet <= 0 && somaTam(perd, tams) <= 0) throw new Error('Informe ao menos uma peça retornada ou perdida.');
  var dataRet = a.data || hojeBR(), pago = a.pago !== false, dataPag = pago ? (a.dataPagamento || dataRet) : null, pesoNao = Number(a.pesoNaoCosturado || 0);
  lotes.sort(function (x, y) { return (x.dataEnvio || '').localeCompare(y.dataEnvio || ''); });
  var rR = clone(ret), rP = clone(perd), remover = [], perdaTot = 0, valorPagar = 0;
  lotes.forEach(function (lote) {
    var pend = lote.tamanhosEnviados || {}, tR = {}, tP = {}, tS = {};
    tams.forEach(function (t) { var d = Number(pend[t] || 0), u = Math.min(d, rR[t] || 0); rR[t] -= u; var s = d - u, up = Math.min(s, rP[t] || 0); rP[t] -= up; tR[t] = u; tP[t] = up; tS[t] = s - up; });
    var qR = somaTam(tR, tams), qP = somaTam(tP, tams), qS = somaTam(tS, tams);
    if (qP > 0) { var k = c.perdaNaoRetorno(lote, qP); S.perdas.push({ id: uid(), loteId: lote.id, data: dataRet, produto: lote.produto, quantidade: qP, valorMateriaPrima: k.valorMateriaPrima, valorCorte: k.valorCorte, motivo: 'Peça não retornou (perda)', valor: k.valorTotal, funcionario: a.funcionario }); perdaTot += qP; L.push(lote.codigoRevisao + ' · PERDA ' + qP + ' pç (' + tamStr(tP, tams) + ') ' + lote.produto + ' · prejuízo ' + rs(k.valorTotal)); }
    if (qR === 0 && qS === 0) { remover.push(lote.id); return; }
    if (qR > 0 && qS === 0) {
      lote.tamanhosRetornados = tR; lote.quantidadeRetornada = qR; lote.dataRetorno = dataRet; lote.status = 'retornado';
      lote.codigoRevisao = lote.codigoRevisao || c.proximoCodigo(); lote.valorTotal = qR * Number(lote.valorUnit || 0); lote.paga = pago; lote.dataPagamento = dataPag;
      valorPagar += lote.valorTotal; L.push(lote.codigoRevisao + ' · voltou ' + qR + ' pç (' + tamStr(tR, tams) + ') ' + lote.produto + ' · ' + rs(lote.valorTotal) + ' · lote fechado');
    } else if (qR > 0 && qS > 0) {
      var r = clone(lote); r.id = uid(); r.tamanhosEnviados = clone(tR); r.tamanhosRetornados = clone(tR); r.quantidadeEnviada = qR; r.quantidadeRetornada = qR;
      r.dataRetorno = dataRet; r.status = 'retornado'; r.codigoRevisao = r.codigoRevisao || c.proximoCodigo(); r.paga = pago; r.dataPagamento = dataPag; r.valorTotal = qR * Number(lote.valorUnit || 0);
      novas.push(r); lote.tamanhosEnviados = tS; lote.quantidadeEnviada = qS;
      valorPagar += r.valorTotal; L.push(r.codigoRevisao + ' · voltou ' + qR + ' pç (' + tamStr(tR, tams) + ') ' + lote.produto + ' · ' + rs(r.valorTotal) + ' · ainda faltam ' + qS + ' (' + tamStr(tS, tams) + ')');
    } else { lote.tamanhosEnviados = tS; lote.quantidadeEnviada = qS; }
    if (!(Number(lote.valorUnit) > 0) && qR > 0) W.push(lote.codigoRevisao + ': valor da costura está R$ 0 → rode corrigirValor.');
  });
  novas.forEach(function (r) { S.producao.push(r); });
  if (remover.length) S.producao = S.producao.filter(function (p) { return remover.indexOf(p.id) < 0; });
  if (pesoNao > 0) { var pk = c.precoMedioTec(lotes[0].produto); S.perdas.push({ id: uid(), data: dataRet, produto: lotes[0].produto, quantidade: null, pesoKg: pesoNao, motivo: 'Tecido não aproveitado (costura)', valor: pesoNao * pk, funcionario: a.funcionario }); L.push('Tecido sem costurar ' + num(pesoNao) + 'kg · ' + rs(pesoNao * pk)); }
  L.push('Total ' + a.funcionario + ': voltou ' + qtdRet + ' pç' + (perdaTot ? ', perda ' + perdaTot : '') + ' · costura ' + rs(valorPagar) + (pago ? ' (pago na retirada)' : ' (a pagar)'));
  return { linhas: L, avisos: W, docs: (perdaTot || pesoNao) ? ['producao', 'perdas'] : ['producao'] };
};

// Revisão: {id | (codigo + funcionario?), aproveitaveis, pesoDescartado?}   (se houver vários retornos no código, use id)
OPS.revisao = function (c, a) {
  var S = c.S, L = [], W = [], p;
  if (a.id) p = c.porId(a.id);
  else {
    var l = S.producao.filter(function (x) { return x.etapa === 'costura' && x.status === 'retornado' && x.codigoRevisao === String(a.codigo).toUpperCase() && (!a.funcionario || x.funcionario === a.funcionario); });
    if (!l.length) throw new Error('Nada aguardando revisão em ' + a.codigo + '.');
    if (l.length > 1) throw new Error(a.codigo + ' tem ' + l.length + ' retornos aguardando revisão; diga qual: ' + l.map(function (x) { return x.id + ' (' + x.quantidadeRetornada + ' pç de ' + x.dataRetorno + ')'; }).join('; '));
    p = l[0];
  }
  if (p.status !== 'retornado') throw new Error((p.codigoRevisao || p.id) + ' não está aguardando revisão (status ' + p.status + ').');
  var aprov = Number(a.aproveitaveis);
  if (!(aprov >= 0) || aprov > p.quantidadeRetornada) throw new Error('Aproveitáveis deve ser entre 0 e ' + p.quantidadeRetornada + '.');
  var nao = Math.max(0, p.quantidadeRetornada - aprov), peso = Number(a.pesoDescartado || 0);
  p.quantidadeAproveitavel = aprov; p.quantidadeNaoAproveitavel = nao; p.valorCredito = nao * Number(p.valorUnit || 0); p.creditoAplicado = false; p.status = 'revisado'; p.pesoDescartado = peso;
  var docs = ['producao'];
  if (nao > 0) {
    var k = c.perdaRevisao(p, nao, peso); p.valorPrejuizoTotal = k.valorTotal;
    S.perdas.push({ id: uid(), loteId: p.id, data: hojeBR(), produto: p.produto, quantidade: nao, pesoKg: peso, tecidoKg: k.tecidoKgPerdido, ribanaKg: k.ribanaKgPerdido, valorTecido: k.valorTecido, valorRibana: k.valorRibana, valorCorte: k.valorCorte, valorInsumos: k.valorInsumos, motivo: 'Peça sem aproveitamento (revisão)', valor: k.valorTotal, funcionario: p.funcionario });
    docs.push('perdas');
    if (!peso) W.push('Peso das descartadas não informado: completar depois.');
  } else p.valorPrejuizoTotal = 0;
  L.push(p.codigoRevisao + ' · revisão ' + p.funcionario + ' · prestou ' + aprov + '/' + p.quantidadeRetornada + (nao ? ' · ' + nao + ' descartada(s) · crédito ' + rs(p.valorCredito) + ' · prejuízo ' + rs(p.valorPrejuizoTotal) : ''));
  return { linhas: L, avisos: W, docs: docs };
};

// Pagamento (igual ao "Marcar como pago"): {funcionario, data?, aplicarCredito?:true}
OPS.pagamento = function (c, a) {
  var S = c.S, L = [];
  var lotes = S.producao.filter(function (p) { return p.status !== 'enviado' && (p.funcionario || 'Sem nome') === a.funcionario && !p.paga; });
  var creds = S.producao.filter(function (p) { return p.status === 'revisado' && (p.funcionario || 'Sem nome') === a.funcionario && !p.creditoAplicado; });
  if (!lotes.length) throw new Error('Nada pendente para ' + a.funcionario + '.');
  var pend = lotes.reduce(function (s, p) { return s + Number(p.valorTotal || 0); }, 0), cred = creds.reduce(function (s, p) { return s + Number(p.valorCredito || 0); }, 0);
  var apl = a.aplicarCredito !== false, data = a.data || hojeBR();
  lotes.forEach(function (p) { p.paga = true; p.dataPagamento = data; });
  if (apl) creds.forEach(function (p) { p.creditoAplicado = true; });
  var zerados = lotes.filter(function (p) { return !(Number(p.valorUnit) > 0); });
  L.push('Pagamento ' + a.funcionario + ' em ' + data + ': ' + lotes.length + ' lançamento(s) · ' + rs(pend) + (apl && cred ? ' − crédito ' + rs(cred) + ' = ' + rs(pend - cred) : ''));
  return { linhas: L, avisos: zerados.length ? [zerados.length + ' lançamento(s) com valor R$ 0 entrando nesse pagamento: corrija antes.'] : [], docs: ['producao'] };
};

// Corrigir valor da costura/corte: {ids:[...] | (codigo + funcionario), valorUnit?}  sem valorUnit = tabela do Cadastro (por faixa se houver)
//   lote fechado: valorTotal = soma(tamanho × preço) ; lote em mãos (enviado) com faixas: divide em um registro por faixa
OPS.corrigirValor = function (c, a) {
  var S = c.S, L = [], W = [];
  var alvo = a.ids ? a.ids.map(function (i) { return c.porId(i); }) : S.producao.filter(function (p) { return p.codigoRevisao === String(a.codigo).toUpperCase() && p.funcionario === a.funcionario; });
  if (!alvo.length) throw new Error('Nenhum lançamento encontrado.');
  alvo.forEach(function (p) {
    var tams = tamsDoLote(p), preco;
    if (a.valorUnit != null) preco = function () { return Number(a.valorUnit); };
    else {
      var ex = c.findRate(p.funcionario, p.produto);
      if (ex != null) preco = function () { return ex; };
      else {
        var fx = c.faixas(p.funcionario, p.produto);
        if (!fx.length) throw new Error((p.codigoRevisao || p.id) + ': sem preço na tabela para "' + p.produto + '". Informe valorUnit.');
        preco = function (t) { var f = fx.find(function (f) { return Number(t) >= f.de && Number(t) <= f.ate; }); if (!f) throw new Error('Tamanho ' + t + ' sem faixa de preço.'); return f.valor; };
        if (p.status === 'enviado') {
          // divide em registros por faixa (cada um com seu preço), mantendo código e origem
          var antes = p.valorUnit, base = clone(p), first = true;
          fx.forEach(function (f) {
            var te = {}; tams.forEach(function (t) { var n = Number(t); te[t] = (n >= f.de && n <= f.ate) ? Number((base.tamanhosEnviados || {})[t] || 0) : 0; });
            var q = somaTam(te, tams); if (q <= 0) return;
            var r = first ? p : clone(base); if (!first) { r.id = uid(); r.envioGrupoId = r.id; S.producao.push(r); }
            r.produto = f.produto; r.valorUnit = f.valor; r.tamanhosEnviados = te; r.quantidadeEnviada = q; r.quantidadeEnviadaOriginal = q; first = false;
            L.push((r.codigoRevisao || '') + ' · ' + r.funcionario + ' em mãos ' + q + ' pç (' + tamStr(te, tams) + ') → ' + f.produto + ' ' + rs(f.valor) + '/pç (antes ' + rs(antes) + ')');
          });
          return;
        }
      }
    }
    if (p.status === 'enviado') { var v0 = preco(tams[0]); L.push((p.codigoRevisao || '') + ' · ' + p.funcionario + ' em mãos: ' + rs(p.valorUnit) + ' → ' + rs(v0) + '/pç'); p.valorUnit = v0; return; }
    var tr = p.etapa === 'corte' ? p.tamanhosCortados : p.tamanhosRetornados, q = Number(p.quantidadeRetornada || 0);
    var total = 0; tams.forEach(function (t) { total += Number((tr || {})[t] || 0) * (Number((tr || {})[t] || 0) ? preco(t) : 0); });
    if (!tr || somaTam(tr, tams) !== q) { var v = preco(tams.filter(function (t) { return Number((tr || {})[t]) > 0; })[0] || tams[0]); total = q * v; W.push((p.codigoRevisao || p.id) + ': tamanhos não batem com a quantidade, usei preço único ' + rs(v) + '.'); }
    var antesT = p.valorTotal, antesU = p.valorUnit;
    p.valorUnit = q ? total / q : p.valorUnit; p.valorTotal = total; p.valorCredito = Number(p.quantidadeNaoAproveitavel || 0) * p.valorUnit;
    L.push((p.codigoRevisao || '') + ' · ' + p.funcionario + ' ' + q + ' pç de ' + p.dataRetorno + ': ' + rs(antesU) + '/pç ' + rs(antesT) + ' → ' + rs(p.valorUnit) + '/pç ' + rs(total) + (p.paga ? ' (já marcado pago)' : ''));
  });
  return { linhas: L, avisos: W, docs: ['producao'] };
};

// Teste de gravação: regrava producao idêntica (não muda nenhum dado). {versaoFalsa?:true} testa a trava de conflito.
OPS.teste = function (c, a) { return { linhas: ['Teste de gravação: nenhum dado alterado.'], avisos: [], docs: ['producao'], versaoFalsa: !!a.versaoFalsa }; };

// ---------------- gravação atômica ----------------
function valorCampo(s) { return { stringValue: s }; }
function gravar(op, params, mensagem, r, base) {
  var agora = new Date(), id = agora.toISOString().replace(/[-:.TZ]/g, '').slice(0, 17) + '_' + Math.random().toString(36).slice(2, 6);
  var writes = [], fb = { criadoEm: { timestampValue: agora.toISOString() }, op: valorCampo(op) };
  r.docs.forEach(function (k) {
    writes.push({ update: { name: DOCS + '/' + COL + '/' + k, fields: { value: valorCampo(JSON.stringify(base.estado[k])) } },
      currentDocument: r.versaoFalsa ? { updateTime: '2020-01-01T00:00:00.000000Z' } : (base.versoes[k] ? { updateTime: base.versoes[k] } : { exists: false }) });
    fb[k] = valorCampo(JSON.stringify(base.original[k]));
  });
  writes.push({ update: { name: DOCS + '/' + COL_BACKUP + '/' + id, fields: fb }, currentDocument: { exists: false } });
  writes.push({ update: { name: DOCS + '/' + COL_LOG + '/' + id, fields: {
    criadoEm: { timestampValue: agora.toISOString() }, op: valorCampo(op), params: valorCampo(JSON.stringify(params)),
    mensagem: valorCampo(mensagem || ''), resumo: valorCampo(r.linhas.join('\n')), avisos: valorCampo(r.avisos.join('\n')), backupId: valorCampo(id), origem: valorCampo('Claude')
  } }, currentDocument: { exists: false } });
  var res = http('POST', API + ':commit?key=' + KEY, { writes: writes });
  if (res.code === 409 || res.code === 400 && /FAILED_PRECONDITION|updateTime/i.test(res.text) || /FAILED_PRECONDITION/.test(res.text))
    throw new Error('CONFLITO: os dados mudaram entre a leitura e a gravação (alguém salvou pelo app). Nada foi gravado. Rode de novo.');
  if (res.code !== 200) throw new Error('Falha ao gravar (' + res.code + '): ' + res.text.slice(0, 400));
  return id;
}

function executar(arquivo, gravarDeVerdade) {
  var job = JSON.parse(IO.read(arquivo));
  if (!OPS[job.op]) throw new Error('Operação desconhecida: ' + job.op + ' (use ' + Object.keys(OPS).join(', ') + ')');
  var base = lerTudo(); base.original = clone(base.estado);
  var c = Ctx(base.estado);
  var r = OPS[job.op](c, job.params || {});
  base.estado.producao = c.S.producao; base.estado.perdas = c.S.perdas;
  var out = [(gravarDeVerdade ? 'GRAVADO' : 'SIMULAÇÃO (nada gravado)') + ' · ' + job.op];
  out = out.concat(r.linhas.map(function (l) { return '  ' + l; }));
  if (r.avisos.length) out.push('Avisos:'), out = out.concat(r.avisos.map(function (l) { return '  ⚠ ' + l; }));
  if (gravarDeVerdade) { var id = gravar(job.op, job.params, job.mensagem, r, base); out.push('Backup/histórico: ' + id + '  (para desfazer: desfazer ' + id + ')'); }
  return out.join('\n');
}

function listarBackups() {
  var r = http('GET', API + '/' + COL_LOG + '?key=' + KEY + '&pageSize=300');
  if (r.code !== 200) return 'Sem histórico ainda.';
  var d = (r.json.documents || []).map(function (x) { var f = x.fields; return { id: x.name.split('/').pop(), quando: f.criadoEm.timestampValue, op: f.op.stringValue, msg: (f.mensagem || {}).stringValue || '', resumo: (f.resumo || {}).stringValue || '' }; });
  d.sort(function (a, b) { return a.quando < b.quando ? 1 : -1; });
  return d.slice(0, 20).map(function (x) { return x.id + ' · ' + x.quando + ' · ' + x.op + ' · "' + x.msg.slice(0, 80) + '"\n    ' + x.resumo.split('\n')[0]; }).join('\n') || 'Sem histórico ainda.';
}
function desfazer(id) {
  var r = http('GET', API + '/' + COL_BACKUP + '/' + id + '?key=' + KEY);
  if (r.code !== 200) throw new Error('Backup ' + id + ' não encontrado.');
  var f = r.json.fields, writes = [], docs = ['producao', 'perdas'].filter(function (k) { return f[k]; });
  var atual = {}; docs.forEach(function (k) { atual[k] = lerDoc(k); });
  docs.forEach(function (k) { writes.push({ update: { name: DOCS + '/' + COL + '/' + k, fields: { value: { stringValue: f[k].stringValue } } }, currentDocument: { updateTime: atual[k].updateTime } }); });
  var agora = new Date(), nid = agora.toISOString().replace(/[-:.TZ]/g, '').slice(0, 17) + '_undo';
  var fb = { criadoEm: { timestampValue: agora.toISOString() }, op: { stringValue: 'desfazer ' + id } };
  docs.forEach(function (k) { fb[k] = { stringValue: JSON.stringify(atual[k].value) }; });
  writes.push({ update: { name: DOCS + '/' + COL_BACKUP + '/' + nid, fields: fb }, currentDocument: { exists: false } });
  writes.push({ update: { name: DOCS + '/' + COL_LOG + '/' + nid, fields: { criadoEm: { timestampValue: agora.toISOString() }, op: { stringValue: 'desfazer' }, params: { stringValue: id }, mensagem: { stringValue: '' }, resumo: { stringValue: 'Voltou ' + docs.join('+') + ' para o backup ' + id }, backupId: { stringValue: nid }, origem: { stringValue: 'Claude' } } }, currentDocument: { exists: false } });
  var res = http('POST', API + ':commit?key=' + KEY, { writes: writes });
  if (res.code !== 200) throw new Error('Falha ao desfazer (' + res.code + '): ' + res.text.slice(0, 300));
  return 'Desfeito: ' + docs.join(' e ') + ' voltaram para o backup ' + id + '. (Isso também gerou backup ' + nid + ', caso precise refazer.)';
}

// ---------------- consulta e auditoria ----------------
function linha(p) {
  var t = tamsDoLote(p);
  if (p.etapa === 'corte') return '  CORTE ' + p.funcionario + ' · ' + p.produto + ' · ' + (p.cor || '-') + ' · ' + num(p.pesoBobinas) + 'kg tec/' + num(p.pesoRibana) + 'kg rib · meta ' + (p.metaRendimentoBobina || '-') + ' · ' + p.status +
    (p.status !== 'enviado' ? (' · rendeu ' + p.quantidadeRetornada + ' (' + tamStr(p.tamanhosCortados, t) + ')' + (p.diferencaRendimento != null ? (' dif ' + (p.diferencaRendimento >= 0 ? '+' : '') + p.diferencaRendimento) : '') + ' · MP/pç ' + rs(p.custoMateriaPrimaPorPeca)) : ' · pedido ' + tamStr(Object.keys(p.tamanhosSolicitados || {}).reduce(function (o, k) { o[k] = p.tamanhosSolicitados[k] ? '✓' : 0; return o; }, {}), t)) + ' · envio ' + p.dataEnvio + ' · id ' + p.id;
  return '  COSTURA ' + p.funcionario + ' · ' + p.produto + ' · ' + p.status + ' · ' + (p.status === 'enviado' ? ('em mãos ' + p.quantidadeEnviada + ' (' + tamStr(p.tamanhosEnviados, t) + ') desde ' + p.dataEnvio) : ('voltou ' + p.quantidadeRetornada + ' (' + tamStr(p.tamanhosRetornados, t) + ') em ' + p.dataRetorno + (p.status === 'revisado' ? (' · prestou ' + p.quantidadeAproveitavel + '/' + p.quantidadeRetornada) : ''))) + ' · ' + rs(p.valorUnit) + '/pç · total ' + rs(p.valorTotal) + (p.paga ? ' · pago' : ' · NÃO pago') + ' · id ' + p.id;
}
function consulta(modo, arg) {
  var b = lerTudo(), S = b.estado, prod = S.producao, out = [];
  var cods = {}; prod.forEach(function (p) { var k = p.codigoRevisao || '(sem código)'; (cods[k] = cods[k] || []).push(p); });
  if (modo === 'json') return JSON.stringify(lerDoc(arg || 'producao').value, null, 1);
  if (modo === 'codigo') { var l = cods[String(arg).toUpperCase()]; if (!l) return 'Código ' + arg + ' não encontrado.'; return [String(arg).toUpperCase() + ':'].concat(l.map(linha)).join('\n'); }
  if (modo === 'costureira') { return prod.filter(function (p) { return p.funcionario === arg; }).sort(function (a, b) { return (a.codigoRevisao || '').localeCompare(b.codigoRevisao || ''); }).map(function (p) { return p.codigoRevisao + linha(p); }).join('\n') || 'Nada para ' + arg; }
  if (modo === 'resumo') {
    out.push('Banco atualizado em ' + b.versoes.producao);
    out.push('\n== CORTE EM ANDAMENTO ==');
    prod.filter(function (p) { return p.etapa === 'corte' && p.status === 'enviado'; }).forEach(function (p) { out.push(p.codigoRevisao + linha(p)); });
    out.push('\n== CORTADO, AINDA NÃO FOI PARA COSTURA ==');
    prod.filter(function (p) { return p.etapa === 'corte' && p.status !== 'enviado' && !prod.some(function (x) { return x.loteCorteOrigemId === p.id; }); }).forEach(function (p) { out.push(p.codigoRevisao + linha(p)); });
    out.push('\n== EM MÃOS DE CADA COSTUREIRA ==');
    var cs = {}; prod.filter(function (p) { return p.etapa === 'costura' && p.status === 'enviado'; }).forEach(function (p) { (cs[p.funcionario] = cs[p.funcionario] || []).push(p); });
    Object.keys(cs).forEach(function (k) { out.push(k + ': ' + cs[k].reduce(function (s, p) { return s + Number(p.quantidadeEnviada || 0); }, 0) + ' peças'); cs[k].forEach(function (p) { out.push('   ' + p.codigoRevisao + ' ' + p.produto + ' ' + tamStr(p.tamanhosEnviados, tamsDoLote(p)) + ' (desde ' + p.dataEnvio + ', ' + rs(p.valorUnit) + '/pç) id ' + p.id); }); });
    out.push('\n== AGUARDANDO REVISÃO ==');
    prod.filter(function (p) { return p.etapa === 'costura' && p.status === 'retornado'; }).forEach(function (p) { out.push(p.codigoRevisao + linha(p)); });
    out.push('\n== A PAGAR (retornado e não marcado pago) ==');
    var ap = {}; prod.filter(function (p) { return p.status !== 'enviado' && !p.paga; }).forEach(function (p) { ap[p.funcionario] = (ap[p.funcionario] || 0) + Number(p.valorTotal || 0); });
    Object.keys(ap).forEach(function (k) { out.push(k + ': ' + rs(ap[k])); });
    return out.join('\n');
  }
  if (modo === 'auditoria') {
    var n = 0, naoPago = {}; function f(m) { n++; out.push('- ' + m); }
    prod.forEach(function (p) {
      var t = tamsDoLote(p), id = (p.codigoRevisao || '?') + ' ' + p.etapa + ' ' + p.funcionario + ' (' + p.produto + (p.cor ? ' ' + p.cor : '') + ', id ' + p.id + ')';
      if (!(Number(p.valorUnit) > 0)) f(id + ': valor por peça R$ 0 → pagamento sai zerado.');
      if (p.etapa === 'corte' && !(Number(p.pesoBobinas) > 0)) f(id + ': corte sem peso de tecido.');
      if (p.etapa === 'corte' && !(Number(p.precoKgTecido) > 0)) f(id + ': corte sem preço do tecido.');
      if (p.etapa === 'corte' && !(Number(p.metaRendimentoBobina) > 0)) f(id + ': corte sem meta de rendimento.');
      if (p.etapa === 'corte' && p.status !== 'enviado' && somaTam(p.tamanhosCortados, t) !== Number(p.quantidadeRetornada)) f(id + ': soma dos tamanhos cortados ≠ quantidade.');
      if (p.etapa === 'costura' && p.status === 'enviado' && somaTam(p.tamanhosEnviados, t) !== Number(p.quantidadeEnviada)) f(id + ': soma dos tamanhos em mãos ≠ quantidade.');
      if (p.etapa === 'costura' && p.status === 'revisado' && Number(p.quantidadeNaoAproveitavel) > 0 && !(Number(p.pesoDescartado) > 0)) f(id + ': ' + p.quantidadeNaoAproveitavel + ' descartadas sem peso.');
      if (p.etapa === 'costura' && !p.loteCorteOrigemId) f(id + ': costura sem corte de origem (custo usa média).');
      if (p.etapa === 'costura' && p.loteCorteOrigemId && !prod.some(function (x) { return x.id === p.loteCorteOrigemId; })) f(id + ': aponta para um corte que não existe mais.');
      if (/canguru$/i.test(p.produto || '') && p.sistemaTamanho === 'infantil') f(id + ': nome sem "Infantil" mas com tamanhos infantis.');
      if (p.status !== 'enviado' && !p.paga) naoPago[p.funcionario] = (naoPago[p.funcionario] || 0) + 1;
    });
    var orig = {}; prod.forEach(function (p) { if (p.loteCorteOrigemId) (orig[p.loteCorteOrigemId] = orig[p.loteCorteOrigemId] || {})[p.envioGrupoId] = p; });
    Object.keys(orig).forEach(function (k) {
      var cte = prod.find(function (x) { return x.id === k; }); if (!cte) return; var ts = tamsDoLote(cte), env = {};
      Object.keys(orig[k]).forEach(function (g) { var p = orig[k][g], te = p.tamanhosEnviados || {}; var tot = Number(p.quantidadeEnviadaOriginal || 0); env._t = (env._t || 0) + tot; });
      if (env._t > Number(cte.quantidadeRetornada || 0)) f((cte.codigoRevisao || '?') + ': enviado p/ costura ' + env._t + ' pç, mas o corte rendeu ' + cte.quantidadeRetornada + ' (' + tamStr(cte.tamanhosCortados, ts) + ').');
    });
    Object.keys(naoPago).forEach(function (k) { f(k + ': ' + naoPago[k] + ' retorno(s) sem marcar como pago.'); });
    out.unshift(n ? n + ' ponto(s) para conferir:' : 'Nenhum problema encontrado.');
    return out.join('\n');
  }
  return 'Comandos: resumo | auditoria | codigo R0035 | costureira Mariani | json <doc> | simular <arq.json> | gravar <arq.json> | backups | desfazer <id>';
}

function principal(argv) {
  var cmd = argv[0] || 'ajuda';
  try {
    if (cmd === 'simular') return executar(argv[1], false);
    if (cmd === 'gravar') return executar(argv[1], true);
    if (cmd === 'backups') return listarBackups();
    if (cmd === 'desfazer') return desfazer(argv[1]);
    if (cmd === '__teste') return (function () { var b = lerTudo(); b.original = clone(b.estado); var job = JSON.parse(IO.read(argv[1])); var c = Ctx(b.estado); var r = OPS[job.op](c, job.params); return JSON.stringify({ r: r, producao: c.S.producao, perdas: c.S.perdas, original: b.original }); })();
    return consulta(cmd, argv.slice(1).join(' '));
  } catch (e) { return 'ERRO: ' + e.message; }
}

if (IS_NODE) { console.log(principal(process.argv.slice(2))); }
function run(argv) { return principal(argv); } // JXA
