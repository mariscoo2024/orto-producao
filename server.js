const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Configurações ─────────────────────────────────────────────────────────────
const BIN_ID        = process.env.JSONBIN_BIN_ID  || '';
const API_KEY       = process.env.JSONBIN_API_KEY || '';
const USE_JSONBIN   = BIN_ID && API_KEY;
const DB_FILE       = path.join(__dirname, 'db.json');

const BLING_CLIENT_ID     = process.env.BLING_CLIENT_ID;
const BLING_CLIENT_SECRET = process.env.BLING_CLIENT_SECRET;
const BLING_REDIRECT_URI  = process.env.BLING_REDIRECT_URI  || 'https://orto-producao-production.up.railway.app/auth/bling/callback';

// Validação crítica de segurança — nunca deixar segredos no código-fonte
if (!BLING_CLIENT_ID || !BLING_CLIENT_SECRET) {
  console.error('❌ CRÍTICO: BLING_CLIENT_ID e BLING_CLIENT_SECRET devem estar configurados como variáveis de ambiente no Railway. Integração Bling desabilitada.');
}

// Token Bling em memória (persiste no db.json também)
let blingToken = { access_token:'', refresh_token:'', expires_at:0 };

// ── JSONBin helpers ───────────────────────────────────────────────────────────
function dbVazio() {
  return { pedidos:[], rastreios:[], estoque:[], sobras:[], movHist:{}, custos:{}, blingToken:{}, tabelaPrecos:{}, custosModelo:{}, custosFixos:{}, cotacoesFrete:[], cfgFrete:null, pedidosIgnorados:[] };
}

function jsonbinRequest(method, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const options = {
      hostname: 'api.jsonbin.io',
      path: `/v3/b/${BIN_ID}`,
      method,
      timeout: 10000, // 10s — nunca mais deixar o site travando minutos esperando o JSONBin
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': API_KEY,
        'X-Bin-Versioning': 'false',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('timeout', () => {
      req.destroy(new Error('JSONBin não respondeu em 10 segundos'));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function lerDB() {
  if (!USE_JSONBIN) {
    try { return JSON.parse(fs.readFileSync(DB_FILE,'utf8')); } catch(e) { return dbVazio(); }
  }
  try { const r = await jsonbinRequest('GET'); return r.record || dbVazio(); }
  catch(e) {
    console.error('❌ lerDB FALHOU (conexão com JSONBin):', e.message);
    const erro = new Error('Não consegui conectar no banco de dados (JSONBin): ' + e.message);
    erro.isConexaoDB = true;
    throw erro;
  }
}

async function salvarDB(db) {
  if (!USE_JSONBIN) { fs.writeFileSync(DB_FILE, JSON.stringify(db,null,2),'utf8'); return true; }
  const sizeKB = Math.round(JSON.stringify(db).length / 1024);
  if (sizeKB > 800) {
    console.warn(`⚠️ ATENÇÃO: banco de dados está em ${sizeKB} KB — limite do JSONBin é 1024 KB (1MB). Considere migrar para outro banco em breve.`);
  }
  try {
    const resp = await jsonbinRequest('PUT', db);
    // JSONBin retorna {record, metadata} em sucesso; {message} em erro
    if (resp.message || resp.error) {
      console.error('❌ salvarDB FALHOU:', JSON.stringify(resp).slice(0,300));
      console.error(`   Tamanho do DB: ${sizeKB} KB`);
      return false;
    }
    return true;
  } catch(e) {
    console.error('❌ salvarDB ERROR:', e.message);
    return false;
  }
}

// ── Bling OAuth helpers ───────────────────────────────────────────────────────
function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const options = { hostname, path, method:'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function httpsGet(hostname, path, headers, timeoutMs=15000) {
  return new Promise((resolve, reject) => {
    const options = { hostname, path, method:'GET', headers };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

async function refreshBlingToken() {
  if (!blingToken.refresh_token) return false;
  try {
    const creds = Buffer.from(`${BLING_CLIENT_ID}:${BLING_CLIENT_SECRET}`).toString('base64');
    const body = `grant_type=refresh_token&refresh_token=${blingToken.refresh_token}`;
    const data = await httpsPost('www.bling.com.br', '/Api/v3/oauth/token',
      { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body);
    if (data.access_token) {
      blingToken = { access_token: data.access_token, refresh_token: data.refresh_token || blingToken.refresh_token,
        expires_at: Date.now() + (data.expires_in || 3600) * 1000 };
      // Persistir token no banco
      const db = await lerDB();
      db.blingToken = blingToken;
      await salvarDB(db);
      return true;
    }
    return false;
  } catch(e) { console.error('Refresh token falhou:', e.message); return false; }
}

async function getBlingToken() {
  if (blingToken.access_token && Date.now() < blingToken.expires_at - 60000) return blingToken.access_token;
  if (blingToken.refresh_token) {
    const ok = await refreshBlingToken();
    if (ok) return blingToken.access_token;
  }
  return null;
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));

// Servir arquivos estáticos
app.use(express.static(path.join(__dirname)));

// Rota raiz
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Segurança: chave de API ──────────────────────────────────────────────────
// Protege as rotas /api/* (dados, custos, pedidos, DRE) contra acesso sem chave.
// A mesma chave precisa estar cadastrada aqui (variável de ambiente API_SECRET
// no Railway) e no index.html (constante API_KEY, no topo do <script> principal).
const API_SECRET = process.env.API_SECRET || '';
if (!API_SECRET) {
  console.error('❌ CRÍTICO: API_SECRET não configurada nas variáveis de ambiente do Railway. As rotas /api/* estão respondendo SEM proteção — configure API_SECRET o quanto antes.');
}
// Modo de auditoria: NÃO bloqueia, só avisa no log quem mandou chave errada/faltando.
// Ative com a variável AUTH_MODO_AUDITORIA=1 no Railway se o sistema travar e você
// precisar voltar a usar enquanto investigamos a causa. Desative depois de resolver.
const MODO_AUDITORIA = process.env.AUTH_MODO_AUDITORIA === '1';
if (MODO_AUDITORIA) {
  console.warn('⚠️ AUTH_MODO_AUDITORIA ativo — a chave de API está sendo CONFERIDA mas NÃO está bloqueando ninguém. Use só temporariamente.');
}
function checarChaveApi(req, res, next) {
  const chave = req.headers['x-api-key'] || '';
  const ok = API_SECRET && chave === API_SECRET;
  if (!ok) {
    console.warn('⚠️ Chave de API ausente/incorreta em', req.method, req.originalUrl,
      '- recebida:', chave ? (chave.slice(0,6)+'...('+chave.length+' chars)') : '(vazia)',
      '- esperada:', API_SECRET ? (API_SECRET.slice(0,6)+'...('+API_SECRET.length+' chars)') : '(não configurada)');
    if (!MODO_AUDITORIA) {
      return res.status(401).json({ ok: false, erro: 'Não autorizado' });
    }
  }
  next();
}
// Aplica a checagem a TODAS as rotas /api/* definidas mais abaixo (não afeta
// a rota raiz, arquivos estáticos, nem os webhooks do Bling/WhatsApp, que
// precisam continuar públicos porque são chamados de fora, sem essa chave).
app.use('/api', checarChaveApi);

// ── OAuth: iniciar login Bling ────────────────────────────────────────────────
app.get('/auth/bling', (req, res) => {
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const url = `https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${BLING_CLIENT_ID}&redirect_uri=${encodeURIComponent(BLING_REDIRECT_URI)}&state=${state}`;
  res.redirect(url);
});

// ── OAuth: callback do Bling ──────────────────────────────────────────────────
app.get('/auth/bling/callback', async (req, res) => {
  const { code, error, error_description } = req.query;
  console.log('Bling callback recebido:', req.query);
  if (error) return res.send('<h2>Erro do Bling: '+error+'</h2><p>'+( error_description||'')+'</p>');
  if (!code) return res.send('<h2>Parâmetros recebidos:</h2><pre>'+JSON.stringify(req.query,null,2)+'</pre><p>Código não encontrado.</p>');
  try {
    const creds = Buffer.from(`${BLING_CLIENT_ID}:${BLING_CLIENT_SECRET}`).toString('base64');
    const body = `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(BLING_REDIRECT_URI)}`;
    const data = await httpsPost('www.bling.com.br', '/Api/v3/oauth/token',
      { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body);
    if (data.access_token) {
      blingToken = { access_token: data.access_token, refresh_token: data.refresh_token,
        expires_at: Date.now() + (data.expires_in || 3600) * 1000 };
      const db = await lerDB();
      db.blingToken = blingToken;
      await salvarDB(db);
      res.send('<h2>✅ Bling conectado com sucesso!</h2><p>Pode fechar esta aba e voltar ao sistema.</p><script>setTimeout(()=>window.close(),2000)</script>');
    } else {
      res.send('<h2>❌ Erro ao conectar: ' + JSON.stringify(data) + '</h2>');
    }
  } catch(e) { res.send('<h2>Erro: ' + e.message + '</h2>'); }
});

// ── API: debug — listar situações de pedidos do Bling ────────────────────────
app.get('/api/bling/situacoes', async (req, res) => {
  const token = await getBlingToken();
  if (!token) return res.json({erro:'não conectado'});
  try {
    const data = await httpsGet('www.bling.com.br', '/Api/v3/situacoes/modulos/0',
      { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' });
    res.json(data);
  } catch(e) { res.json({erro: e.message}); }
});

// ── API: debug — ver raw de um pedido do Bling ───────────────────────────────
app.get('/api/bling/debug/:num', async (req, res) => {
  const token = await getBlingToken();
  if (!token) return res.json({erro:'não conectado'});
  try {
    // Buscar o pedido pelo número
    const lista = await httpsGet('www.bling.com.br',
      `/Api/v3/pedidos/vendas?numero=${req.params.num}`,
      { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' });
    if (!lista.data?.[0]) return res.json({erro:'não encontrado', lista});
    const det = await httpsGet('www.bling.com.br',
      `/Api/v3/pedidos/vendas/${lista.data[0].id}`,
      { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' });
    res.json(det.data || det);
  } catch(e) { res.json({erro: e.message}); }
});

// ── API: reimportar pedido específico pelo número ────────────────────────────
app.get('/api/bling/reimportar/:num', async (req, res) => {
  const token = await getBlingToken();
  if (!token) return res.json({erro:'não conectado'});
  try {
    const lista = await httpsGet('www.bling.com.br',
      `/Api/v3/pedidos/vendas?numero=${req.params.num}`,
      { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' });
    if (!lista.data?.[0]) return res.json({erro:'pedido não encontrado'});
    const det = await httpsGet('www.bling.com.br',
      `/Api/v3/pedidos/vendas/${lista.data[0].id}`,
      { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' });
    if (!det.data) return res.json({erro:'sem dados'});
    const db = await lerDB();
    const numPedido = String(det.data.numero || det.data.id);
    // Remover versão anterior se existir
    db.pedidos = db.pedidos.filter(x => x.pedidoNum !== numPedido);
    // Buscar endereço
    const etiqPed = det.data.transporte?.etiqueta || {};
    if (!etiqPed.municipio && det.data.contato?.id) {
      try {
        const cont = await httpsGet('www.bling.com.br', `/Api/v3/contatos/${det.data.contato.id}`,
          { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' });
        const endGeral = cont.data?.endereco?.geral;
        if (endGeral) det.data._enderecoContato = endGeral;
      } catch(e) {}
    }
    const parsed = parsearPedidoBling(det.data);
    const lista2 = Array.isArray(parsed) ? parsed : [parsed];
    lista2.forEach(ped => db.pedidos.push(ped));
    await salvarDB(db);
    res.json({ok:true, importados: lista2.length, pedidos: lista2.map(p=>({nome:p.nome,modelo:p.modelo,freteiro:p.freteiro}))});
  } catch(e) { res.json({erro: e.message}); }
});

// ── API: debug — ver raw do CONTATO de um pedido ─────────────────────────────
app.get('/api/bling/debugcontato/:num', async (req, res) => {
  const token = await getBlingToken();
  if (!token) return res.json({erro:'não conectado'});
  try {
    const lista = await httpsGet('www.bling.com.br',
      `/Api/v3/pedidos/vendas?numero=${req.params.num}`,
      { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' });
    if (!lista.data?.[0]) return res.json({erro:'pedido não encontrado'});
    const det = await httpsGet('www.bling.com.br',
      `/Api/v3/pedidos/vendas/${lista.data[0].id}`,
      { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' });
    const contatoId = det.data?.contato?.id;
    if (!contatoId) return res.json({erro:'sem contato id', pedido: det.data});
    const cont = await httpsGet('www.bling.com.br',
      `/Api/v3/contatos/${contatoId}`,
      { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' });
    res.json({ contatoId, contato: cont.data || cont });
  } catch(e) { res.json({erro: e.message}); }
});

// ── API: diagnóstico do banco ────────────────────────────────────────────────
app.get('/api/diagnostico', async (req, res) => {
  try {
    const db = await lerDB();
    const tamanho = JSON.stringify(db).length;
    const sizeKB = Math.round(tamanho / 1024);
    const sizeMB = (tamanho / (1024*1024)).toFixed(2);
    res.json({
      pedidos: db.pedidos?.length || 0,
      estoque: db.estoque?.length || 0,
      sobras: db.sobras?.length || 0,
      tamanho_bytes: tamanho,
      tamanho_kb: sizeKB,
      tamanho_mb: sizeMB,
      limite_jsonbin: '1 MB por bin (plano pago)',
      status: sizeKB > 900 ? '⚠️ PRÓXIMO DO LIMITE — pedidos podem não salvar!' : '✅ OK',
      ultimos_pedidos: (db.pedidos||[]).slice(-5).map(p => ({
        num: p.pedidoNum, nome: p.nome, importadoEm: p.importadoEm
      }))
    });
  } catch(e) { res.status(500).json({erro: e.message}); }
});

// ── API: status do Bling ──────────────────────────────────────────────────────
app.get('/api/bling/status', (req, res) => {
  res.json({
    conectado: !!(blingToken.access_token && Date.now() < blingToken.expires_at),
    expira: blingToken.expires_at ? new Date(blingToken.expires_at).toLocaleString('pt-BR') : null
  });
});

// ── Parser de pedidos Bling (server-side) ─────────────────────────────────────
// IMPORTANTE: Esses valores devem estar SINCRONIZADOS com o objeto CD do index.html
// (cabeçalho da seção custos). Se atualizar lá, atualize aqui também.
const C_SRV = {
  kit_single:220, kit_cromo:275, cola:21, respiros:2, ima:3.50, infra:2.25,
  fetilho:4.50, travesseiro:20,
  eps14:{solteiro:90,casal:99,queen:121,king:151},
  eps10:{solteiro:37,casal:59,queen:71,king:90},
  chapa:{solteiro:15,casal:25,queen:30,king:40},
  d33:{solteiro:103,casal:158,queen:192,king:241},
  d45:{solteiro:102,casal:160,queen:190,king:235},
  d30:{solteiro:85,casal:133,queen:160,king:200},
  d28:{solteiro:49,casal:91,queen:111,king:139},
  perfilado:{solteiro:40,casal:64,queen:77,king:95},
  fundo:{solteiro:21,casal:32,queen:39,king:49},
  lateral:{solteiro:22,casal:24,queen:24,king:24},
  tampo:{solteiro:35,casal:52,queen:59,king:87},
  // Agregados (sincronizados com index.html)
  cab_perola:{solteiro:150,casal:190,queen:210,king:250},
  base_normal:{solteiro:145,casal:175,queen:295,king:320},
  base_bau:{solteiro:495,casal:530,queen:895,king:940},
  frete:{ARW:70,'ARW_LONG':90,'GUILHERME SC':450,'GUILHERME SP':450,'WALDECI-SP':450,
         JOEL:450,RODOLFO:450,JHONATAN:450,LUIZ:450,TOME:450,'ORTO PREMIUM':0}
};

function tamSrv(txt) {
  if (/193.*203|king/i.test(txt)) return 'king';
  if (/158.*198|queen/i.test(txt)) return 'queen';
  if (/138.*188|casal/i.test(txt)) return 'casal';
  if (/128.*188|vi[uú]va/i.test(txt)) return 'casal';
  if (/088.*188|solteiro/i.test(txt)) return 'solteiro';
  return 'casal';
}

function calcCustoSrv(txt, kit, tam) {
  let custo = C_SRV.cola + C_SRV.respiros + C_SRV.infra + C_SRV.fetilho;
  if (/molas|presidential/i.test(txt)) {
    custo += (C_SRV.perfilado[tam]||0) + (C_SRV.fundo[tam]||0) + (C_SRV.lateral[tam]||0) + (C_SRV.tampo[tam]||0);
  } else {
    custo += (C_SRV.eps14[tam]||0) + (C_SRV.chapa[tam]||0) + (C_SRV.fundo[tam]||0) + (C_SRV.lateral[tam]||0) + (C_SRV.tampo[tam]||0);
    if (/d45/i.test(txt)) custo += (C_SRV.d45[tam]||0) - (C_SRV.d33[tam]||0);
    else if (/d30/i.test(txt)) custo += (C_SRV.d30[tam]||0);
    else if (/d28/i.test(txt)) custo += (C_SRV.d28[tam]||0);
    else custo += (C_SRV.d33[tam]||0);
  }
  if (/cromo|cromoterapia/i.test(txt+kit)) { custo += C_SRV.kit_cromo + C_SRV.ima; }
  else if (/single/i.test(txt+kit)) { custo += C_SRV.kit_single; }
  return Math.round(custo);
}

// Detectar se um item é colchão principal
// Mapeamento de IDs de vendedores (preenchido conforme aparecem)
const VENDEDORES = {}; // será populado dinamicamente, ou pode ser preenchido manualmente

async function nomeVendedor(token, vendedorId) {
  if (!vendedorId || vendedorId === 0) return '';
  if (VENDEDORES[vendedorId]) return VENDEDORES[vendedorId];
  try {
    const r = await httpsGet('www.bling.com.br', `/Api/v3/vendedores/${vendedorId}`,
      { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' });
    const nome = r.data?.contato?.nome || r.data?.nome || '';
    if (nome) VENDEDORES[vendedorId] = nome;
    return nome;
  } catch(e) { return ''; }
}

// ── Dedup de importação do Bling — FONTE ÚNICA ──────────────────────────────
// Existem 3 pontos que trazem pedido do Bling pra dentro do sistema (sync manual,
// sync automático a cada 10min, webhook em tempo real). Os 3 tinham essa mesma
// checagem copiada e colada. Consolidado aqui: se um dia mudar a estratégia de
// dedup (por id em vez de número, por exemplo), muda em 1 lugar só, não em 3.
function pedidoExistente(db, numPedido) {
  return db.pedidos.find(x => x.pedidoNum === numPedido);
}
function pedidoIgnorado(db, numPedido) {
  return (db.pedidosIgnorados || []).includes(numPedido);
}

function isColchaoItem(desc) {
  const d = desc.toUpperCase();
  return (d.includes('COLCHÃO') || d.includes('COLCHAO')) &&
    !d.includes('CABECEIRA') && !d.includes('BASE') &&
    !d.includes('BOX') && !d.includes('TRAVESSEIRO') &&
    !d.includes('PULSEIRA') && !d.includes('RECAMIER') &&
    // "Capa Protetora de Colchão" e "Pezinho" contêm a palavra COLCHÃO mas não são
    // o colchão em si — sem essa exclusão, viravam falso-positivo e entravam no
    // pipeline de custo/frete/rateio de um colchão de verdade.
    !d.includes('CAPA') && !d.includes('PROTETOR') && !d.includes('PEZINHO');
}

// Retorna ARRAY de pedidos (1 por colchão no pedido do Bling)
function parsearPedidoBling(p) {
  const numPedido = String(p.numero || p.id);
  const cliente = p.contato?.nome || '';

  // Endereço — API v3 pode estar em transporte.enderecoEntrega ou contato.endereco
  // Endereço: tenta etiqueta do pedido, depois endereço do contato buscado separadamente
  const etiq = p.transporte?.etiqueta || {};
  const endC = p._enderecoContato || p.contato?.endereco || {};
  const cidade = (etiq.municipio || etiq.cidade || endC.municipio || endC.cidade || '').trim();
  const estado = (etiq.uf || etiq.estado || endC.uf || endC.estado || '').trim().toUpperCase();
  const endStr2 = [etiq.endereco || endC.endereco || endC.logradouro,
                   etiq.numero   || endC.numero,
                   etiq.bairro   || endC.bairro]
    .filter(Boolean).join(', ')
    + (cidade ? ' - ' + cidade : '')
    + (estado ? '/' + estado : '')
    + (etiq.cep || endC.cep ? ' - CEP: ' + (etiq.cep || endC.cep) : '');
  const endStr = endStr2;
  const cidadeExib = cidade && estado ? `${cidade}/${estado}` : cidade;
  const valor = parseFloat(p.totalVenda || p.total || 0);

  // Formatar datas yyyy-mm-dd → dd/mm/yyyy
  const fmtData = (s) => {
    if (!s) return '';
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
  };
  const prazo = fmtData(p.dataPrevisao || p.dataPrevista || p.dataSaida || '');
  const compra = fmtData(p.data || p.dataCriacao || p.dataEmissao || '');

  // Itens — descrição dos produtos (já vem completo na API v3)
  const itens = (p.itens || []).map(i => {
    const desc = i.descricao || i.produto?.descricao || '';
    const qtd = parseFloat(i.quantidade || 1);
    return qtd > 1 ? `${desc} x${Math.round(qtd)}` : desc;
  }).join(' + ');

  // Extrair cor dos itens (formato "COR:PRETO" ou "COR: CINZA")
  let corExtraida = '';
  for (const item of (p.itens || [])) {
    const desc = item.descricao || '';
    const mCor = desc.match(/COR\s*:\s*([A-ZÁÀÂÃÉÊÍÓÔÕÚÜÇ]+)/i);
    if (mCor) { corExtraida = mCor[1].trim(); break; }
  }
  // Normalizar cor
  const coresNorm = {PRETO:'Preto',CINZA:'Cinza',BEGE:'Bege',MARROM:'Marrom',
                     TABACO:'Tabaco',BRANCO:'Branco',CAFE:'Café',NUDE:'Nude'};
  const corFinal = coresNorm[corExtraida.toUpperCase()] || corExtraida;

  // Filtrar obs — remover texto padrão de rodapé do Bling
  const obsRaw = p.observacoes || '';
  const obsLimpa = obsRaw
      .replace(/Entregas?:[^\r\n]*/gi, '')
    .replace(/Hor[aá]rio comercial[^\r\n]*/gi, '')
    .replace(/Garantia:[^\r\n]*/gi, '')
    .replace(/Aten[çc][aã]o:[^\r\n]*/gi, '')
    .replace(/N[aã]o realizamos trocas[^\r\n]*/gi, '')
    .replace(/Confira atentamente[^\r\n]*/gi, '')
    .trim();

  // Extrair modelo do texto
  const isBalance = /BALANCE/i.test(itens);
  const isPres = !isBalance && /PRESIDENTIAL/i.test(itens);
  const prefixoLinha = isBalance ? 'Balance ' : isPres ? 'Presidential Molas ' : '';
  const sizes = [
    {r:/193\s*X\s*203/i, v:'King 193x203'},
    {r:/158\s*X\s*198/i, v:'Queen 158x198'},
    {r:/138\s*X\s*188/i, v:'Casal 138x188'},
    {r:/128\s*X\s*188/i, v:'Viúva 128x188'},
    {r:/088\s*X\s*188/i, v:'Solteiro 088x188'},
    {r:/88\s*X\s*188/i,  v:'Solteiro 088x188'},
  ];
  let modelo = '';
  for (const s of sizes) { if (s.r.test(itens)) { modelo = prefixoLinha+s.v; break; } }
  if (!modelo) modelo = prefixoLinha + itens.slice(0,80);

  // Kit — só Cromoterapia / Single / (nada); sem palavra-chave = sem kit, automaticamente
  let kit = '';
  if (/CROMOTERAPIA|CROMO/i.test(itens)) kit = 'Cromoterapia';
  else if (/SINGLE/i.test(itens))        kit = 'Single';

  // Cor — pega o que está entre parênteses
  const corM = itens.match(/\(([A-ZÁÀÂÃÉÊÍÓÔÕÚÜÇ\s]+)\)/);
  let cor = corM ? corM[1].trim() : '';
  const coresValidas = ['CINZA','PRETO','BEGE','MARROM','TABACO','BRANCO','CAFE','NUDE'];
  if (!coresValidas.includes(cor.toUpperCase())) cor = '';
  else cor = cor.charAt(0).toUpperCase() + cor.slice(1).toLowerCase();

  // Terceiros
  const t2 = [];
  if (/BOX\s*BA[ÚU]/i.test(itens)) t2.push('BASE BOX BAÚ');
  else if (/BASE\s*BOX/i.test(itens)) t2.push('BASE BOX');
  if (/CABECEIRA/i.test(itens)) t2.push('CABECEIRA');
  if (/RECAMIER/i.test(itens)) t2.push('RECAMIER');
  if (/TRAVESSEIRO/i.test(itens)) t2.push('TRAVESSEIROS');
  if (/PULSEIRA/i.test(itens)) t2.push('PULSEIRA');

  // ── Freteiro por cidade/estado ────────────────────────────────────────────
  const normC = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const c = normC(cidade);
  const contemCidade = (lista, str) => lista.some(x => str.includes(normC(x)));

  // GUILHERME SC: litoral SC + rota de volta (Palhoça → Rio do Sul → Mafra → Curitiba)
  const cidGuilhermeSc = [
    'florianopolis','sao jose','palhoca','santo amaro da imperatriz','biguacu','governador celso ramos',
    'tijucas','porto belo','bombinhas','itapema','balneario camboriu','camboriu','itajai','navegantes',
    'penha','piçarras','barra velha','sao francisco do sul','araquari','joinville','garuva','itapoa',
    'rio do sul','blumenau','brusque','gaspar','indaial','timbo','pomerode','jaragua do sul',
    'mafra','rio negrinho','sao bento do sul','campo alegre','itaiopolis',
    'tubarao','laguna','imbituba','garopaba','criciuma','araranguá','sombrio'
  ];
  // JHONATAN: cidades específicas SC + RS
  const cidJhonatan = [
    'chapeco','xanxere','joacaba','campos novos','curitibanos','cacador','canoinhas',
    'porto uniao','santo angelo','ijui','passo fundo','cruz alta','santa rosa',
    'erechim','carazinho','frederico westphalen','sananduva','tapejara',
    'espumoso','ibiruba','lagoa vermelha','marau'
  ];
  // RODOLFO: cidades específicas RS
  const cidRodolfo = [
    'porto alegre','canoas','novo hamburgo','caxias do sul','bento goncalves',
    'lajeado','santa maria','pelotas','rio grande','lages','vacaria','carlos barbosa',
    'sao francisco de paula','gramado','canela','nova petropolis','farroupilha',
    'garibaldi','tres coroas','igrejinha','rolante','sapiranga','campo bom',
    'sao leopoldo','esteio','cachoeirinha','gravataí','viamão','guaiba','charqueadas'
  ];
  // JOEL: PR interior
  const cidJoel = ['ponta grossa','castro','telemaco borba','tibagi','carambei'];
  // ARW: região metropolitana de Curitiba
  const cidArw = [
    'curitiba','sao jose dos pinhais','colombo','araucaria','almirante tamandare',
    'campo largo','pinhais','piraquara','fazenda rio grande','contenda','mandirituba',
    'quitandinha','rio negro','mafra','tijucas do sul'
  ];

  let freteiro = '';
  if      (contemCidade(cidArw, c))      freteiro = 'ARW';
  else if (contemCidade(cidGuilhermeSc, c)) freteiro = 'GUILHERME SC';
  else if (contemCidade(cidJhonatan, c)) freteiro = 'JHONATAN';
  else if (contemCidade(cidRodolfo, c))  freteiro = 'RODOLFO';
  else if (estado === 'SC')              freteiro = 'GUILHERME SC';
  else if (estado === 'SP')              freteiro = 'GUILHERME SP';
  else if (estado === 'RS')              freteiro = 'RODOLFO';   // RS default → Rodolfo
  else if (contemCidade(cidJoel, c))     freteiro = 'JOEL';
  else if (estado === 'PR')              freteiro = 'JOEL';       // PR interior não mapeado → Joel

  // Forma de pagamento — lê do array de parcelas do Bling + observação (NÃO dos itens,
  // pois as medidas como "138X188" contêm padrões que enganam o regex de parcelas)
  const obsUp = (obsRaw).toUpperCase();
  // Tenta extrair forma de pagamento das parcelas (Bling API v3)
  const parcelas = Array.isArray(p.parcelas) ? p.parcelas : [];
  let textoParcelas = '';
  for (const par of parcelas) {
    if (par.observacoes) textoParcelas += ' ' + par.observacoes;
    if (par.formaPagamento?.descricao) textoParcelas += ' ' + par.formaPagamento.descricao;
    if (par.forma_pagamento?.descricao) textoParcelas += ' ' + par.forma_pagamento.descricao;
  }
  textoParcelas = textoParcelas.toUpperCase();
  // Texto pra detecção: parcelas + observação (NUNCA inclui itens)
  const textoCompleto = textoParcelas + ' ' + obsUp;

  let formaPagto = 'pix';
  // Quantidade de parcelas: se Bling informar diretamente, usa
  const qtdParcelas = parcelas.length;
  if (qtdParcelas >= 2 && qtdParcelas <= 18) {
    formaPagto = 'x' + qtdParcelas;
  } else {
    // Fallback: detecta no texto. Regex exige que o número NÃO seja precedido por dígito
    // (assim "138X188" não vira 8X, "2.592,04" não vira 2X)
    if (/(?<!\d)18\s*[Xx]|18\s*VEZES/i.test(textoCompleto)) formaPagto = 'x18';
    else if (/(?<!\d)12\s*[Xx]|12\s*VEZES/i.test(textoCompleto)) formaPagto = 'x12';
    else if (/(?<!\d)11\s*[Xx]|11\s*VEZES/i.test(textoCompleto)) formaPagto = 'x11';
    else if (/(?<!\d)10\s*[Xx]|10\s*VEZES/i.test(textoCompleto)) formaPagto = 'x10';
    else if (/(?<!\d)9\s*[Xx]|9\s*VEZES/i.test(textoCompleto)) formaPagto = 'x9';
    else if (/(?<!\d)8\s*[Xx]|8\s*VEZES/i.test(textoCompleto)) formaPagto = 'x8';
    else if (/(?<!\d)7\s*[Xx]|7\s*VEZES/i.test(textoCompleto)) formaPagto = 'x7';
    else if (/(?<!\d)6\s*[Xx]|6\s*VEZES/i.test(textoCompleto)) formaPagto = 'x6';
    else if (/(?<!\d)5\s*[Xx]|5\s*VEZES/i.test(textoCompleto)) formaPagto = 'x5';
    else if (/(?<!\d)4\s*[Xx]|4\s*VEZES/i.test(textoCompleto)) formaPagto = 'x4';
    else if (/(?<!\d)3\s*[Xx]|3\s*VEZES/i.test(textoCompleto)) formaPagto = 'x3';
    else if (/(?<!\d)2\s*[Xx]|2\s*VEZES/i.test(textoCompleto)) formaPagto = 'x2';
    else if (/D[ÉE]BITO/i.test(textoCompleto)) formaPagto = 'debito';
    else if (/CR[ÉE]DITO/i.test(textoCompleto)) formaPagto = 'credito';
  }

  // Calcular custos
  // Detectar colchões individuais no pedido
  const itensBrutos = p.itens || [];
  const colchoesItens = itensBrutos.filter(i => isColchaoItem(i.descricao || ''));

  // ── PEDIDO SÓ DE ACESSÓRIO (travesseiro, pulseira, pezinho, capa protetora...) ──
  // Nenhuma linha do pedido é um colchão de verdade — não faz sentido rodar essas
  // vendas pelo pipeline de custo de colchão (frete automático, rateio de custo fixo,
  // banner de "custo não cadastrado"). São vendas de baixo volume no Mercado Livre,
  // frete por conta do ML, sem objetivo de margem — só giro de conta. Wesley prefere
  // preencher o custo do produto e a taxa do ML manualmente a cadastrar uma tabela de
  // preços fina pra algo que ainda vende pouco (decisão consciente, revisitar se o
  // volume desses itens crescer).
  if (colchoesItens.length === 0) {
    return [{
      id: Date.now().toString(36) + Math.random().toString(36).slice(2,6) + numPedido + '_acc',
      pedidoNum: numPedido,
      itensRaw: itensBrutos.map(i => ({
        desc: (i.descricao || '').replace(/\s*COR\s*:\s*\S+/gi, '').replace(/\s+/g,' ').trim().toUpperCase(),
        qtd: parseFloat(i.quantidade || 1)
      })),
      nome: cliente,
      tipoPedido: 'acessorio',
      modelo: '🎁 ' + (itens.slice(0,80) || 'Acessório'),
      kit: '', cor: '', terceiro: '',
      freteiro: 'MERCADO LIVRE',
      costureiro: 'ORTO PREMIUM',
      vendedor: p._vendedorNome || '',
      status: 'pendente',
      valor, prazo, compra,
      end: endStr, cidadeExib,
      obs: obsLimpa,
      formaPagto: '',
      taxaValor: 0,          // Wesley preenche manualmente (taxa do Mercado Livre)
      custoColchao: 0,       // n/a — não existe colchão neste pedido
      custoAgregados: 0,     // Wesley preenche manualmente (custo do produto)
      custoFrete: 0,         // frete por conta do Mercado Livre
      custoTotal: 0,
      origem: 'bling_api',
      importadoEm: new Date().toISOString()
    }];
  }

  // Função que monta um objeto de pedido para um colchão específico
  const montarPedido = (textoColchao, valorCol, sufixo) => {
    const tam = tamSrv(textoColchao);
    const kitC = (() => {
      // Kit é só Cromoterapia / Single / (nada) — o nome da linha (Elegance/Presidential/
      // Balance) já vem de linhaC mais abaixo, não precisa mais estar aqui.
      // Sem palavra "cromo" nem "single" no pedido = sem kit, automaticamente — nunca é
      // preciso (nem correto) escrever "sem massagem" no pedido pra isso funcionar.
      if (/CROMOTERAPIA|CROMO/i.test(textoColchao)) return 'Cromoterapia';
      if (/SINGLE/i.test(textoColchao))             return 'Single';
      return '';
    })();

    // Tamanho para label do modelo
    const sizes2 = [
      {r:/193\s*X\s*203/i, v:'King 193x203'},
      {r:/158\s*X\s*198/i, v:'Queen 158x198'},
      {r:/138\s*X\s*188/i, v:'Casal 138x188'},
      {r:/128\s*X\s*188/i, v:'Viúva 128x188'},
      {r:/088\s*X\s*188|0,88\s*X\s*188|0\.88\s*X\s*188/i, v:'Solteiro 088x188'},
      {r:/solteiro/i, v:'Solteiro 088x188'},
    ];
    let modeloC = '';
    // Linha do colchão (Elegance / Presidential / Balance) — BALANCE precisa ser checado
    // primeiro, porque a descrição real do Bling costuma ser "... PRESIDENTIAL BALANCE
    // MOLAS", que contém as duas palavras juntas. Checando Presidential primeiro, Balance
    // nunca seria detectado — foi exatamente esse o bug que fazia Balance aparecer sem
    // nenhuma indicação de linha no card do pedido.
    let linhaC = 'Elegance';
    if (/BALANCE/i.test(textoColchao)) linhaC = 'Balance';
    else if (/PRESIDENTIAL/i.test(textoColchao)) linhaC = 'Presidential';
    for (const s of sizes2) if (s.r.test(textoColchao)) { modeloC = linhaC + ' ' + s.v; break; }
    if (!modeloC) modeloC = linhaC + ' ' + textoColchao.slice(0,60);

    // Cor do colchão específico
    const mCorC = textoColchao.match(/COR\s*:\s*([A-ZÁÀÂÃÉÊÍÓÔÕÚÜÇ]+)/i);
    const coresNorm2 = {PRETO:'Preto',CINZA:'Cinza',BEGE:'Bege',MARROM:'Marrom',TABACO:'Tabaco',BRANCO:'Branco',CAFE:'Café',NUDE:'Nude'};
    const corC = mCorC ? (coresNorm2[mCorC[1].toUpperCase()] || mCorC[1]) : (corFinal || '');

    // Itens agregados associados a este colchão (base, cabeceira do mesmo tamanho)
    const tamKey = tam === 'king' ? 'KING' : tam === 'queen' ? 'QUEEN' : tam === 'casal' ? 'CASAL' : 'SOLTEIRO';
    // Mapas de medidas para identificar o tamanho via número também (ex: "138X188" = casal)
    const medidaPorTam = {
      king:    /193\s*X\s*203/i,
      queen:   /158\s*X\s*198/i,
      casal:   /138\s*X\s*188/i,
      solteiro:/088\s*X\s*188|0,88\s*X\s*188|0\.88\s*X\s*188/i
    };
    const t2c = [];
    itensBrutos.forEach(i => {
      const desc = (i.descricao || '').toUpperCase();
      // Item pertence a este colchão se contém o nome do tamanho OU a medida
      const ehDoTam = desc.includes(tamKey) || (medidaPorTam[tam] && medidaPorTam[tam].test(desc));
      const ehTravOuPulseira = desc.includes('TRAVESSEIRO') || desc.includes('PULSEIRA');
      if (!ehDoTam && !ehTravOuPulseira) return;

      // Detecta BAÚ: precisa ser BOX BAÚ (palavra completa, com ou sem acento)
      const ehBau = ehDoTam && /\bBA[ÚU]\b/.test(desc) && /BOX/.test(desc);
      const ehBaseNormal = ehDoTam && !ehBau && (/\bBASE\s+BOX\b/.test(desc) || /\bBOX\b/.test(desc)) && !desc.includes('CABECEIRA');

      if (ehBau && !t2c.includes('BASE BOX BAÚ')) t2c.push('BASE BOX BAÚ');
      else if (ehBaseNormal && !t2c.includes('BASE BOX')) t2c.push('BASE BOX');
      if (ehDoTam && desc.includes('CABECEIRA') && !t2c.includes('CABECEIRA')) t2c.push('CABECEIRA');
      if (desc.includes('TRAVESSEIRO') && !t2c.includes('TRAVESSEIROS')) t2c.push('TRAVESSEIROS');
      if (desc.includes('PULSEIRA') && !t2c.includes('PULSEIRA')) t2c.push('PULSEIRA');
    });

    // Custo colchão = 0 no servidor. O frontend resolve via tabela "Custo por modelo"
    // (cadastrada pelo usuário). Se não encontrar na tabela → alerta vermelho no dashboard.
    const custoC = 0;
    let custoAgrC = (/TRAVESSEIRO/i.test(t2c.join(' ')) ? 2 : 0) * C_SRV.travesseiro;
    if (t2c.includes('BASE BOX BAÚ') && C_SRV.base_bau[tam]) custoAgrC += C_SRV.base_bau[tam];
    else if (t2c.includes('BASE BOX') && C_SRV.base_normal[tam]) custoAgrC += C_SRV.base_normal[tam];
    if (t2c.includes('CABECEIRA') && C_SRV.cab_perola[tam]) custoAgrC += C_SRV.cab_perola[tam];
    custoAgrC = Math.round(custoAgrC);

    // Frete: regra simples e à prova de erro
    // - ARW perto:  R$70
    // - ARW longe:  R$90 (Almirante Tamandaré, Campo Largo, Campo Magro)
    // - ORTO PREMIUM: R$0 (entrega própria)
    // - Qualquer outra coisa (incluindo cidade não mapeada): R$450 obrigatório
    const cidadesArwLong = ['almirante tamandare','campo largo','campo magro'];
    let valorFrete;
    if (freteiro === 'ARW') {
      valorFrete = cidadesArwLong.some(x => c.includes(x)) ? 90 : 70;
    } else if (freteiro === 'ORTO PREMIUM') {
      valorFrete = 0;
    } else {
      valorFrete = 450; // freteiro definido OU sem freteiro: cobra 450 para não dar margem errada
    }
    const custoFreteC = colchoesItens.length > 1 ? 0 : valorFrete; // frete só no primeiro se múltiplos
    const custoTotalC = custoC + custoAgrC + custoFreteC;
    // Taxas PagBank Visa/Master (atualizado Jun/2026)
    const taxaMap = {
      pix:0, debito:0.0099, credito:0.0299,
      x2:0.0409, x3:0.0478, x4:0.0546, x5:0.0614,
      x6:0.0681, x7:0.0767, x8:0.0833, x9:0.0898,
      x10:0.0962, x11:0.1026, x12:0.1090, x18:0.1537,
      // Retrocompatibilidade com pedidos antigos (nomes velhos)
      credito3:0.0478, credito6:0.0681, credito10:0.0962, credito12:0.1090
    };
    const taxaValorC = Math.round(valorCol * (taxaMap[formaPagto] || 0));

    return {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2,6) + numPedido + sufixo,
      pedidoNum: numPedido,
      itensRaw: itensBrutos.map(i => ({
        desc: (i.descricao || '').replace(/\s*COR\s*:\s*\S+/gi, '').replace(/\s+/g,' ').trim().toUpperCase(),
        qtd: parseFloat(i.quantidade || 1)
      })),
      nome: cliente,
      modelo: modeloC,
      kit: kitC,
      cor: corC,
      terceiro: t2c.join(' + '),
      freteiro,
      costureiro: 'ORTO PREMIUM',
      vendedor: p._vendedorNome || '',
      status: 'pendente',
      valor: valorCol,
      prazo,
      compra,
      end: endStr,
      cidadeExib,
      obs: obsLimpa,
      formaPagto,
      taxaValor: taxaValorC,
      custoColchao: custoC,
      custoAgregados: custoAgrC,
      custoFrete: custoFreteC,
      custoTotal: custoTotalC,
      origem: 'bling_api',
      importadoEm: new Date().toISOString()
    };
  };

  // Se tem múltiplos colchões, gerar um pedido por colchão
  if (colchoesItens.length > 1) {
    return colchoesItens.map((item, idx) => {
      const desc = item.descricao || '';
      const valItem = parseFloat(item.valor || 0) || (valor / colchoesItens.length);
      return montarPedido(desc, valItem, '_' + idx);
    });
  }

  // Pedido simples — 1 colchão (comportamento original)
  const textoColchao = colchoesItens[0]?.descricao || itens;
  const resultado = montarPedido(textoColchao, valor, '');

  // Fallback: se o parser não reconheceu o produto, importar mesmo assim com dados brutos
  if (!resultado) {
    return [{
      id: Date.now().toString(36) + Math.random().toString(36).slice(2,5) + numPedido,
      pedidoNum: numPedido,
      nome: cliente,
      modelo: itens.slice(0, 100) || 'Produto não identificado',
      kit: '', cor: '', terceiro: '',
      freteiro,
      costureiro: 'ORTO PREMIUM',
      vendedor: p._vendedorNome || '',
      status: 'pendente',
      valor,
      prazo, compra,
      end: endStr, cidadeExib,
      obs: obsLimpa,
      formaPagto,
      taxaValor: 0,
      custoColchao: 0, custoAgregados: 0, custoFrete: 0, custoTotal: 0,
      origem: 'bling_api',
      importadoEm: new Date().toISOString()
    }];
  }

  return [resultado];
}

// ── API: sincronizar pedidos do Bling ─────────────────────────────────────────
app.get('/api/bling/sync', async (req, res) => {
  const token = await getBlingToken();
  if (!token) return res.status(401).json({ ok:false, erro:'Bling não conectado. Acesse /auth/bling para autorizar.' });

  try {
    // Filtro de data vindo do front
    const dataIni = req.query.dataIni || '';
    const dataFim = req.query.dataFim || '';
    let filtroData = '';
    if (dataIni) filtroData += `&dataInicial=${dataIni}`;
    if (dataFim) filtroData += `&dataFinal=${dataFim}`;

    // Buscar todas as páginas
    let pagina = 1;
    let todosPedidos = [];
    while(true) {
      const data = await httpsGet('www.bling.com.br',
        `/Api/v3/pedidos/vendas?limite=100&pagina=${pagina}&idsSituacoes[]=6&idsSituacoes[]=9&idsSituacoes[]=15&idsSituacoes[]=12&idsSituacoes[]=24&idsSituacoes[]=2&idsSituacoes[]=3&idsSituacoes[]=4&idsSituacoes[]=10${filtroData}`,
        { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' });
      if (!data.data || data.data.length === 0) break;
      todosPedidos = todosPedidos.concat(data.data);
      if (data.data.length < 100) break;
      pagina++;
      if (pagina > 10) break;
    }

    if (!todosPedidos.length) return res.json({ ok:false, erro: 'Nenhum pedido encontrado no Bling' });

    const db = await lerDB();
    let novos = 0, atualizados = 0;

    for (const pedBling of todosPedidos) {
      const numPedido = String(pedBling.numero || pedBling.id);
      const jaExiste = pedidoExistente(db, numPedido);
      if (jaExiste) { atualizados++; continue; }
      if (pedidoIgnorado(db, numPedido)) continue; // excluído por decisão — não reimportar

      // Buscar detalhes do pedido
      const det = await httpsGet('www.bling.com.br', `/Api/v3/pedidos/vendas/${pedBling.id}`,
        { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' });
      if (!det.data) continue;

      const pedData = det.data;

      // Buscar endereço do contato se não veio no pedido
      const etiqPed = pedData.transporte?.etiqueta || {};
      if (!etiqPed.municipio && pedData.contato?.id) {
        try {
          const cont = await httpsGet('www.bling.com.br', `/Api/v3/contatos/${pedData.contato.id}`,
            { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' });
          // API v3: endereço fica em endereco.geral (não diretamente em endereco)
          const endGeral = cont.data?.endereco?.geral || cont.data?.endereco?.cobranca;
          if (endGeral) {
            pedData._enderecoContato = endGeral;
          }
        } catch(e) { /* ignorar erro de contato */ }
      }

      const parsed = parsearPedidoBling(pedData);
      const lista = Array.isArray(parsed) ? parsed : [parsed];
      lista.forEach(ped => db.pedidos.push(ped));
      novos += lista.length;

      // Salvar a cada 10 pedidos
      if (novos % 10 === 0) await salvarDB(db);
    }

    if (novos > 0) await salvarDB(db);
    res.json({ ok:true, novos, atualizados, total: todosPedidos.length });
  } catch(e) {
    res.status(500).json({ ok:false, erro: e.message });
  }
});

// ── API dados / salvar (igual antes) ─────────────────────────────────────────
app.get('/api/dados', async (req, res) => {
  try {
    const db = await lerDB();
    // Restaurar token do banco se em memória estiver vazio
    if (!blingToken.access_token && db.blingToken?.access_token) {
      blingToken = db.blingToken;
    }
    res.json(db);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/salvar', async (req, res) => {
  try {
    const db = await lerDB();
    const body = req.body;

    // ── PROTEÇÃO CONTRA SOBRESCRITA CATASTRÓFICA ──────────────────────────
    // Se o payload tentar reduzir pedidos/estoque drasticamente, bloquear
    if (body.pedidos !== undefined) {
      const atual = (db.pedidos || []).length;
      const novo = (body.pedidos || []).length;
      // Se está reduzindo mais que 80% e havia mais de 5 pedidos, suspeita
      if (atual > 5 && novo < atual * 0.2) {
        console.error(`🚨 BLOQUEADO: tentativa de reduzir pedidos de ${atual} para ${novo}`);
        return res.status(400).json({ ok: false, erro: 'Payload suspeito bloqueado (redução drástica de pedidos)' });
      }
      db.pedidos = body.pedidos;
    }
    if (body.estoque !== undefined) {
      const atual = (db.estoque || []).length;
      const novo = (body.estoque || []).length;
      if (atual > 50 && novo < atual * 0.5) {
        console.error(`🚨 BLOQUEADO: tentativa de reduzir estoque de ${atual} itens para ${novo}`);
        return res.status(400).json({ ok: false, erro: 'Payload suspeito bloqueado (redução drástica de estoque)' });
      }
      // Também bloquear se um payload zerou todas as quantidades de uma vez
      const qtdAtualSoma = (db.estoque || []).reduce((s,x) => s + (x.qtd||0), 0);
      const qtdNovaSoma = (body.estoque || []).reduce((s,x) => s + (x.qtd||0), 0);
      if (qtdAtualSoma > 10 && qtdNovaSoma === 0) {
        console.error(`🚨 BLOQUEADO: tentativa de zerar todas as quantidades de estoque (era ${qtdAtualSoma})`);
        return res.status(400).json({ ok: false, erro: 'Payload zera estoque inteiro - bloqueado' });
      }
      db.estoque = body.estoque;
    }
    if (body.rastreios !== undefined) db.rastreios = body.rastreios;
    if (body.sobras    !== undefined) db.sobras    = body.sobras;
    if (body.movHist   !== undefined) db.movHist   = body.movHist;
    if (body.custos    !== undefined) db.custos    = body.custos;
    if (body.colaboradores !== undefined) db.colaboradores = body.colaboradores;
    if (body.leads !== undefined) db.leads = body.leads;
    if (body.atendentes !== undefined) db.atendentes = body.atendentes;
    if (body.tabelaPrecos !== undefined) db.tabelaPrecos = body.tabelaPrecos;
    if (body.custosModelo !== undefined) db.custosModelo = body.custosModelo;
    if (body.custosFixos !== undefined) db.custosFixos = body.custosFixos;
    if (body.cotacoesFrete !== undefined) db.cotacoesFrete = body.cotacoesFrete;
    if (body.cfgFrete !== undefined) db.cfgFrete = body.cfgFrete;
    // Lista permanente de pedidos excluídos — só cresce, nunca é sobrescrita menor
    // que a atual (mesma lógica de proteção do pedidos/estoque acima), pra excluir
    // não virar reimportação automática no próximo sync/webhook do Bling.
    if (body.pedidosIgnorados !== undefined) {
      const atual = (db.pedidosIgnorados || []).length;
      const novo = (body.pedidosIgnorados || []).length;
      if (atual > 5 && novo < atual * 0.5) {
        console.error(`🚨 BLOQUEADO: tentativa de reduzir pedidosIgnorados de ${atual} para ${novo}`);
        return res.status(400).json({ ok: false, erro: 'Payload suspeito bloqueado (redução de pedidosIgnorados)' });
      }
      db.pedidosIgnorados = body.pedidosIgnorados;
    }
    const ok = await salvarDB(db);
    res.json({ ok });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ══════════════════════════ AGENTE DE COMPROVANTES (DRE) ═══════════════════════
// Fluxo: Wesley anexa foto/PDF do comprovante → IA lê e propõe lançamento
// (descrição, valor, data, categoria) → Wesley confirma ou corrige → entra
// nos "avulsos" do DRE. A imagem NUNCA fica salva no JSONBin (estouraria o
// limite de 1MB rapidamente) — fica em disco local por até 7 dias, só para
// conferência, e depois é apagada automaticamente. Wesley já tira extrato
// bancário mensal para a contadora, então a imagem local é só apoio de
// curto prazo, não é o registro fiscal oficial.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const COMPROVANTES_DIR = path.join(__dirname, 'comprovantes_temp');
const COMPROVANTE_RETENCAO_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias
if (!fs.existsSync(COMPROVANTES_DIR)) fs.mkdirSync(COMPROVANTES_DIR, { recursive: true });
if (!ANTHROPIC_API_KEY) {
  console.error('❌ CRÍTICO: ANTHROPIC_API_KEY não configurada — o agente de comprovantes não vai funcionar até isso ser configurado no Railway.');
}

// Apaga qualquer comprovante salvo há mais de 7 dias. Roda no boot e a cada 6h.
function limparComprovantesAntigos() {
  try {
    const agora = Date.now();
    const arquivos = fs.readdirSync(COMPROVANTES_DIR);
    let apagados = 0;
    arquivos.forEach(nome => {
      const caminho = path.join(COMPROVANTES_DIR, nome);
      const stat = fs.statSync(caminho);
      if (agora - stat.mtimeMs > COMPROVANTE_RETENCAO_MS) {
        fs.unlinkSync(caminho);
        apagados++;
      }
    });
    if (apagados > 0) console.log(`🗑️ Limpeza de comprovantes: ${apagados} arquivo(s) com mais de 7 dias apagado(s).`);
  } catch(e) {
    console.error('❌ Erro na limpeza de comprovantes:', e.message);
  }
}
limparComprovantesAntigos();
setInterval(limparComprovantesAntigos, 6 * 60 * 60 * 1000);

// Categorias fixas do DRE (mesmas do custosFixos) — ajuda a IA a classificar certo
const CATEGORIAS_DRE = ['folha','ads','aluguel1','aluguel2','luz','agua','internet','carro','gasolina','contabilidade','bling','cte','impressora','mercado','imposto','imprevistos'];

// POST /api/comprovante/ler — recebe imagem em base64, salva temporariamente,
// pede pra IA ler e devolve uma PROPOSTA de lançamento (não salva nada no DRE ainda).
app.post('/api/comprovante/ler', async (req, res) => {
  try {
    const { imagemBase64, mediaType } = req.body;
    if (!imagemBase64) return res.status(400).json({ ok:false, erro:'imagemBase64 é obrigatório' });
    if (!ANTHROPIC_API_KEY) return res.status(500).json({ ok:false, erro:'ANTHROPIC_API_KEY não configurada no servidor' });

    // Salva localmente para permitir conferência visual depois (apagado em 7 dias)
    const nomeArquivo = `comp_${Date.now()}_${Math.random().toString(36).slice(2,8)}.${(mediaType||'image/jpeg').includes('png')?'png':'jpg'}`;
    const caminhoArquivo = path.join(COMPROVANTES_DIR, nomeArquivo);
    fs.writeFileSync(caminhoArquivo, Buffer.from(imagemBase64, 'base64'));

    const prompt = `Você está lendo um comprovante de pagamento/gasto de uma fábrica de colchões (Orto Premium). ` +
      `Extraia as informações e responda SOMENTE com um JSON válido, sem markdown, sem texto antes ou depois, no formato exato:\n` +
      `{"descricao": "string curta", "valor": 0.00, "data": "AAAA-MM-DD", "categoriaSugerida": "uma dessas: ${CATEGORIAS_DRE.join(', ')}, ou 'avulso' se não se encaixar", "confianca": "alta|media|baixa", "observacao": "qualquer coisa que Wesley deveria conferir manualmente, ou string vazia"}\n` +
      `Se não conseguir ler algum campo com certeza, coloque confianca baixa ou media e explique em observacao. Nunca invente valor ou data — se não estiver legível, diga isso na observacao.`;

    const respIA = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imagemBase64 } },
            { type: 'text', text: prompt }
          ]
        }]
      })
    });
    const dataIA = await respIA.json();
    if (dataIA.error) {
      console.error('❌ Erro Anthropic API (comprovante):', JSON.stringify(dataIA.error).slice(0,300));
      return res.status(500).json({ ok:false, erro: 'Falha ao ler comprovante: ' + (dataIA.error.message || 'erro desconhecido') });
    }
    const textoResposta = (dataIA.content || []).map(b => b.text || '').join('').trim();
    let proposta;
    try {
      const limpo = textoResposta.replace(/```json|```/g, '').trim();
      proposta = JSON.parse(limpo);
    } catch(e) {
      console.error('❌ IA não devolveu JSON válido:', textoResposta.slice(0,300));
      return res.status(500).json({ ok:false, erro:'A IA não conseguiu estruturar a leitura. Tente uma foto mais nítida.' });
    }

    res.json({ ok:true, proposta, arquivoTemp: nomeArquivo });
  } catch(e) {
    console.error('❌ Erro em /api/comprovante/ler:', e.message);
    res.status(500).json({ ok:false, erro: e.message });
  }
});

// GET /api/comprovante/imagem/:nome — reexibe a imagem temporária (para Wesley
// conferir contra a proposta antes de confirmar). Some sozinha em 7 dias.
app.get('/api/comprovante/imagem/:nome', (req, res) => {
  const nome = req.params.nome;
  // Proteção simples contra path traversal — só aceita o padrão de nome que nós geramos
  if (!/^comp_\d+_[a-z0-9]+\.(jpg|png)$/.test(nome)) {
    return res.status(400).json({ ok:false, erro:'Nome de arquivo inválido' });
  }
  const caminho = path.join(COMPROVANTES_DIR, nome);
  if (!fs.existsSync(caminho)) {
    return res.status(404).json({ ok:false, erro:'Imagem não encontrada (pode já ter passado dos 7 dias de retenção)' });
  }
  res.sendFile(caminho);
});

// POST /api/comprovante/confirmar — Wesley confirmou (com ou sem correção manual).
// Só AQUI o lançamento entra de fato nos avulsos do DRE do mês correspondente.
app.post('/api/comprovante/confirmar', async (req, res) => {
  try {
    const { mes, descricao, valor, data, categoria } = req.body;
    if (!mes || !descricao || valor === undefined || !data) {
      return res.status(400).json({ ok:false, erro:'mes, descricao, valor e data são obrigatórios' });
    }
    const db = await lerDB();
    if (!db.custosFixos) db.custosFixos = {};
    if (!db.custosFixos[mes]) db.custosFixos[mes] = {};
    if (!db.custosFixos[mes].avulsos) db.custosFixos[mes].avulsos = [];
    db.custosFixos[mes].avulsos.push({
      desc: descricao,
      valor: Number(valor),
      data,
      categoria: categoria || 'avulso',
      origemIA: true,
      confirmadoEm: new Date().toISOString()
    });
    const ok = await salvarDB(db);
    res.json({ ok });
  } catch(e) {
    console.error('❌ Erro em /api/comprovante/confirmar:', e.message);
    res.status(500).json({ ok:false, erro: e.message });
  }
});


const WPP_URL = process.env.WPP_URL || 'https://bubbly-curiosity-production-9a4d.up.railway.app';
const WPP_SECRET = process.env.WPP_SECRET || 'ortopremium2026';
const wppTokens = {}; // cache de tokens por sessão (em memória)

async function wppRequest(metodo, caminho, body = null, token = null) {
  const url = WPP_URL + caminho;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const opts = { method: metodo, headers };
  if (body) opts.body = JSON.stringify(body);
  try {
    const resp = await fetch(url, opts);
    const txt = await resp.text();
    try { return { ok: resp.ok, status: resp.status, data: JSON.parse(txt) }; }
    catch(e) { return { ok: resp.ok, status: resp.status, data: txt }; }
  } catch(e) {
    return { ok: false, erro: e.message };
  }
}

async function wppGerarToken(sessao) {
  const r = await wppRequest('POST', `/api/${sessao}/${WPP_SECRET}/generate-token`);
  if (r.ok && r.data?.token) {
    wppTokens[sessao] = r.data.token;
    return r.data.token;
  }
  return null;
}

// DIAGNÓSTICO: testa cada passo, faz polling do QR
app.get('/api/wpp/diagnostico/:nome', async (req, res) => {
  const nome = req.params.nome;
  const resultado = {};

  // 1. Gerar token
  const tokenResp = await wppRequest('POST', `/api/${nome}/${WPP_SECRET}/generate-token`);
  const token = tokenResp.data?.token;
  resultado.passo1_token = token ? 'OK ✅' : 'FALHOU ❌';

  if (token) {
    wppTokens[nome] = token;
    const webhookUrl = (process.env.MEU_DOMINIO || 'https://orto-producao-production.up.railway.app') + '/webhook/whatsapp';

    // 2. Start session
    const startResp = await wppRequest('POST', `/api/${nome}/start-session`, { webhook: webhookUrl, waitQrCode: true }, token);
    resultado.passo2_start = {
      status_sessao: startResp.data?.status,
      qrcode_preenchido: startResp.data?.qrcode ? ('SIM ('+startResp.data.qrcode.length+' chars)') : 'NÃO (null)'
    };

    // 3. Polling: espera e checa status-session 5x
    resultado.passo3_polling = [];
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 2500));
      const st = await wppRequest('GET', `/api/${nome}/status-session`, null, token);
      resultado.passo3_polling.push({
        tentativa: i+1,
        status: st.data?.status,
        qrcode: st.data?.qrcode ? ('SIM ('+st.data.qrcode.length+' chars)') : 'null'
      });
      if (st.data?.qrcode) break;
    }
  }

  res.json(resultado);
});

// Listar sessões
app.get('/api/evolution/instancias', async (req, res) => {
  const r = await wppRequest('GET', `/api/${WPP_SECRET}/show-all-sessions`);
  let instancias = [];
  if (r.ok && Array.isArray(r.data?.response)) {
    for (const nome of r.data.response) {
      const token = wppTokens[nome] || await wppGerarToken(nome);
      const st = await wppRequest('GET', `/api/${nome}/status-session`, null, token);
      instancias.push({
        name: nome, instanceName: nome,
        connectionStatus: st.data?.status === 'CONNECTED' ? 'open' : 'close',
        ownerJid: st.data?.phone || ''
      });
    }
  }
  res.json({ ok: true, data: instancias });
});

// Criar sessão + gerar QR
app.post('/api/evolution/criar-instancia', async (req, res) => {
  const { nome } = req.body;
  if (!nome) return res.status(400).json({ erro: 'Nome da sessão obrigatório' });
  const token = await wppGerarToken(nome);
  if (!token) return res.json({ ok: false, erro: 'Falha ao gerar token' });
  const webhookUrl = (process.env.MEU_DOMINIO || 'https://orto-producao-production.up.railway.app') + '/webhook/whatsapp';
  const r = await wppRequest('POST', `/api/${nome}/start-session`, {
    webhook: webhookUrl, waitQrCode: true
  }, token);
  // O QR vem no campo data.qrcode
  res.json({ ok: r.ok, data: r.data, qrcode: r.data?.qrcode, token });
});

// Pegar QR Code — busca via status-session que também retorna qrcode
app.get('/api/evolution/qrcode/:nome', async (req, res) => {
  const nome = req.params.nome;
  const token = wppTokens[nome] || await wppGerarToken(nome);
  // status-session retorna qrcode enquanto aguarda conexão
  let r = await wppRequest('GET', `/api/${nome}/status-session`, null, token);
  // Se não tem qrcode no status, tenta dar start-session de novo
  if (!r.data?.qrcode) {
    const webhookUrl = (process.env.MEU_DOMINIO || 'https://orto-producao-production.up.railway.app') + '/webhook/whatsapp';
    r = await wppRequest('POST', `/api/${nome}/start-session`, { webhook: webhookUrl, waitQrCode: true }, token);
  }
  res.json({ ok: r.ok, data: r.data, qrcode: r.data?.qrcode });
});

// Status
app.get('/api/evolution/status/:nome', async (req, res) => {
  const nome = req.params.nome;
  const token = wppTokens[nome] || await wppGerarToken(nome);
  const r = await wppRequest('GET', `/api/${nome}/status-session`, null, token);
  const conectado = r.data?.status === 'CONNECTED';
  res.json({ ok: r.ok, data: { state: conectado ? 'open' : 'close', status: r.data?.status } });
});

// Fechar sessão
app.delete('/api/evolution/instancia/:nome', async (req, res) => {
  const nome = req.params.nome;
  const token = wppTokens[nome] || await wppGerarToken(nome);
  const r = await wppRequest('POST', `/api/${nome}/close-session`, {}, token);
  delete wppTokens[nome];
  res.json({ ok: r.ok, data: r.data });
});

// Webhook que recebe mensagens do WhatsApp (formato WPPConnect)
app.post('/webhook/whatsapp', async (req, res) => {
  res.status(200).json({ ok: true }); // responder rápido
  try {
    const evento = req.body;
    if (!evento) return;

    const db = await lerDB();
    if (!db.whatsapp_mensagens) db.whatsapp_mensagens = [];

    // WPPConnect manda event: 'onmessage' para mensagens recebidas
    const ehMensagem = evento.event === 'onmessage' || evento.event === 'onMessage' || evento.body;
    if (ehMensagem) {
      const msg = evento;
      // WPPConnect: from = '5541999...@c.us', fromMe = bool, body = texto, sender.pushname = nome
      const telefone = (msg.from || '').replace('@c.us', '').replace('@s.whatsapp.net', '');
      const fromMe = msg.fromMe || false;
      const texto = msg.body || msg.content || '';
      const tipo = msg.type === 'ptt' || msg.type === 'audio' ? 'audio'
                 : msg.type === 'image' ? 'imagem'
                 : msg.type === 'document' ? 'documento'
                 : 'texto';
      const nomeContato = msg.sender?.pushname || msg.notifyName || msg.sender?.name || '';

      db.whatsapp_mensagens.push({
        id: msg.id || Date.now().toString(36),
        instancia: evento.session || '',
        telefone,
        fromMe,
        texto,
        tipo,
        timestamp: msg.timestamp || Math.floor(Date.now() / 1000),
        nomeContato
      });

      if (db.whatsapp_mensagens.length > 5000) {
        db.whatsapp_mensagens = db.whatsapp_mensagens.slice(-5000);
      }

      // Criar lead automático se cliente novo mandou mensagem
      if (!fromMe && telefone) {
        if (!db.leads) db.leads = [];
        const jaExiste = db.leads.find(l => (l.telefone||'').replace(/\D/g,'') === telefone.replace(/\D/g,''));
        if (!jaExiste) {
          db.leads.push({
            id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
            nome: nomeContato || 'Cliente WhatsApp',
            telefone,
            estagio: 'novo',
            origem: 'WhatsApp direto',
            valor: 0,
            criadoEm: Date.now(),
            instancia: evento.session || '',
            historico: [{
              ts: Date.now(),
              hora: new Date().toLocaleString('pt-BR'),
              tipo: 'criacao',
              texto: 'Lead criado automaticamente via WhatsApp'
            }]
          });
        }
      }

      await salvarDB(db);
    }
  } catch(e) {
    console.error('Erro no webhook WhatsApp:', e.message);
  }
});

// ── WEBHOOK do Bling — recebe notificação instantânea de pedido novo/atualizado
app.post('/webhook/bling', async (req, res) => {
  // Bling envia um array de eventos
  res.status(200).json({ ok: true }); // responder rápido para o Bling não retentar

  try {
    const eventos = Array.isArray(req.body) ? req.body : [req.body];

    for (const evento of eventos) {
      // Aceitar eventos de pedido de venda
      const topico = evento.topico || evento.topic || '';
      if (!topico.toLowerCase().includes('pedido')) continue;

      const dados = evento.dados || evento.data || {};
      const idBling = dados.id || dados.pedidoId;
      if (!idBling) continue;

      const token = await getBlingToken();
      if (!token) continue;

      // Buscar detalhes completos do pedido
      const det = await httpsGet('www.bling.com.br', `/Api/v3/pedidos/vendas/${idBling}`,
        { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' });
      if (!det.data) continue;

      const db = await lerDB();
      const numPedido = String(det.data.numero || det.data.id);

      // Não duplicar
      if (pedidoExistente(db, numPedido)) continue;
      if (pedidoIgnorado(db, numPedido)) continue; // excluído por decisão — não reimportar

      // Buscar endereço do contato
      const etiqPed = det.data.transporte?.etiqueta || {};
      if (!etiqPed.municipio && det.data.contato?.id) {
        try {
          const cont = await httpsGet('www.bling.com.br', `/Api/v3/contatos/${det.data.contato.id}`,
            { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' });
          const endGeral = cont.data?.endereco?.geral || cont.data?.endereco?.cobranca;
          if (endGeral) det.data._enderecoContato = endGeral;
        } catch(e) {}
      }

      const parsed = parsearPedidoBling(det.data);
      const lista = Array.isArray(parsed) ? parsed : [parsed];
      lista.forEach(ped => db.pedidos.push(ped));
      await salvarDB(db);
      console.log(`Webhook: pedido #${numPedido} importado (${lista.length} item(s))`);
    }
  } catch(e) {
    console.error('Webhook erro:', e.message);
  }
});

// Catch-all — serve index.html para qualquer rota não reconhecida (deve ficar no final!)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, async () => {
  console.log(`Orto Premium rodando na porta ${PORT}`);
  console.log(`Banco: ${USE_JSONBIN ? 'JSONBin.io ✅' : 'local ⚠️'}`);
  // Restaurar token salvo no banco ao iniciar
  try {
    const db = await lerDB();
    if (db.blingToken?.access_token) {
      blingToken = db.blingToken;
      console.log('Token Bling restaurado do banco.');
      // Renovar imediatamente se estiver próximo de expirar
      if (Date.now() > blingToken.expires_at - 300000) {
        await refreshBlingToken();
        console.log('Token Bling renovado automaticamente.');
      }
    }
  } catch(e) { console.warn('Erro ao restaurar token:', e.message); }
  // Renovar token a cada 50 minutos automaticamente
  setInterval(async () => {
    if (blingToken.refresh_token) {
      await refreshBlingToken();
      console.log('Token Bling renovado (automático).');
    }
  }, 50 * 60 * 1000);

  // Sincronizar pedidos do Bling automaticamente a cada 10 minutos
  setInterval(async () => {
    if (!blingToken.access_token) return;
    try {
      const token = await getBlingToken();
      if (!token) return;
      // Buscar últimos 30 dias automaticamente
      const dataIni = new Date(Date.now() - 30*24*60*60*1000).toISOString().slice(0,10);
      const db = await lerDB();
      // Buscar todas as páginas
      let pagina = 1;
      let todosPedidos = [];
      while(true) {
        const data = await httpsGet('www.bling.com.br',
          `/Api/v3/pedidos/vendas?limite=100&pagina=${pagina}&idsSituacoes[]=6&idsSituacoes[]=9&idsSituacoes[]=15&idsSituacoes[]=12&idsSituacoes[]=24&idsSituacoes[]=2&idsSituacoes[]=3&idsSituacoes[]=4&idsSituacoes[]=10&dataInicial=${dataIni}`,
          { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' });
        if (!data.data || data.data.length === 0) break;
        todosPedidos = todosPedidos.concat(data.data);
        if (data.data.length < 100) break; // última página
        pagina++;
        if (pagina > 10) break; // segurança: máximo 1000 pedidos
      }
      if (!todosPedidos.length) return;
      let novos = 0;
      for (const pedBling of todosPedidos) {
        const numPedido = String(pedBling.numero || pedBling.id);
        if (pedidoExistente(db, numPedido)) continue;
        if (pedidoIgnorado(db, numPedido)) continue; // excluído por decisão — não reimportar
        const det = await httpsGet('www.bling.com.br', `/Api/v3/pedidos/vendas/${pedBling.id}`,
          { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' });
        if (!det.data) continue;
        const etiqPed = det.data.transporte?.etiqueta || {};
        if (!etiqPed.municipio && det.data.contato?.id) {
          try {
            const cont = await httpsGet('www.bling.com.br', `/Api/v3/contatos/${det.data.contato.id}`,
              { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' });
            const endGeral = cont.data?.endereco?.geral || cont.data?.endereco?.cobranca;
            if (endGeral) det.data._enderecoContato = endGeral;
          } catch(e) {}
        }
        const parsed = parsearPedidoBling(det.data);
        const lista = Array.isArray(parsed) ? parsed : [parsed];
        lista.forEach(ped => db.pedidos.push(ped));
        novos += lista.length;
        if (novos % 10 === 0) await salvarDB(db);
      }
      if (novos > 0) {
        await salvarDB(db);
        console.log(`Auto-sync: ${novos} pedido(s) novo(s) importado(s)`);
      }
    } catch(e) { console.warn('Auto-sync falhou:', e.message); }
  }, 10 * 60 * 1000); // a cada 10 minutos
});
