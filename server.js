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

const BLING_CLIENT_ID     = process.env.BLING_CLIENT_ID     || 'dbbfe20eaf3be5e064af5fd8c806c550885d1aa9';
const BLING_CLIENT_SECRET = process.env.BLING_CLIENT_SECRET || '78d4b62b4a9a2b1b0ee95705d2d20f08cf910c0e974e249428a58aac3878';
const BLING_REDIRECT_URI  = process.env.BLING_REDIRECT_URI  || 'https://orto-producao-production.up.railway.app/auth/bling/callback';

// Token Bling em memória (persiste no db.json também)
let blingToken = { access_token:'', refresh_token:'', expires_at:0 };

// ── JSONBin helpers ───────────────────────────────────────────────────────────
function dbVazio() {
  return { pedidos:[], rastreios:[], estoque:[], sobras:[], movHist:{}, custos:{}, blingToken:{} };
}

function jsonbinRequest(method, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const options = {
      hostname: 'api.jsonbin.io',
      path: `/v3/b/${BIN_ID}`,
      method,
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
  catch(e) { return dbVazio(); }
}

async function salvarDB(db) {
  if (!USE_JSONBIN) { fs.writeFileSync(DB_FILE, JSON.stringify(db,null,2),'utf8'); return true; }
  try {
    const resp = await jsonbinRequest('PUT', db);
    // JSONBin retorna {record, metadata} em sucesso; {message} em erro
    if (resp.message || resp.error) {
      console.error('❌ salvarDB FALHOU:', JSON.stringify(resp).slice(0,300));
      const sizeKB = Math.round(JSON.stringify(db).length / 1024);
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
      limite_jsonbin_free: '100 KB por bin (plano gratuito)',
      status: sizeKB > 90 ? '⚠️ PRÓXIMO DO LIMITE — pedidos podem não salvar!' : '✅ OK',
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
// Custos padrão (mesmos valores do index.html)
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
  cab_perola:{solteiro:120,casal:150,queen:180,king:220},
  base_normal:{solteiro:280,casal:320,queen:380,king:450},
  base_bau:{solteiro:380,casal:430,queen:500,king:580},
  frete:{ARW:80,'GUILHERME SC':120,'GUILHERME SP':150,'WALDECI-SP':150,
         JOEL:100,RODOLFO:100,JHONATAN:100,LUIZ:100,TOME:100,'ORTO PREMIUM':0}
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
function isColchaoItem(desc) {
  const d = desc.toUpperCase();
  return (d.includes('COLCHÃO') || d.includes('COLCHAO')) &&
    !d.includes('CABECEIRA') && !d.includes('BASE') &&
    !d.includes('BOX') && !d.includes('TRAVESSEIRO') &&
    !d.includes('PULSEIRA') && !d.includes('RECAMIER');
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
  const txt = itens.toUpperCase();
  const isPres = /PRESIDENTIAL\s*MOLAS/i.test(itens);
  const sizes = [
    {r:/193\s*X\s*203/i, v:'King 193x203'},
    {r:/158\s*X\s*198/i, v:'Queen 158x198'},
    {r:/138\s*X\s*188/i, v:'Casal 138x188'},
    {r:/128\s*X\s*188/i, v:'Viúva 128x188'},
    {r:/088\s*X\s*188/i, v:'Solteiro 088x188'},
    {r:/88\s*X\s*188/i,  v:'Solteiro 088x188'},
  ];
  let modelo = '';
  for (const s of sizes) { if (s.r.test(itens)) { modelo = (isPres?'Presidential Molas ':'')+s.v; break; } }
  if (!modelo) modelo = itens.slice(0,80);

  // Kit
  const kitsR = [
    {r:/ELEGANCE\s+CROMOTERAPIA/i, v:'Elegance Cromoterapia'},
    {r:/ELEGANCE\s+SINGLE/i,       v:'Elegance Single'},
    {r:/CROMOTERAPIA/i,            v:'Cromoterapia'},
    {r:/SINGLE/i,             v:'Single'},
  ];
  let kit = '';
  for (const k of kitsR) { if (k.r.test(itens)) { kit = k.v; break; } }

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

  // Freteiro por cidade/estado
  const c = cidade.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
  const arw = ['curitiba','sao jose dos pinhais','colombo','araucaria','almirante tamandare','campo largo','pinhais','piraquara','fazenda rio grande'];
  let freteiro = '';
  if (arw.some(x => c.includes(x))) freteiro = 'ARW';
  else if (estado === 'SC') freteiro = 'GUILHERME SC';
  else if (estado === 'SP') freteiro = 'GUILHERME SP';
  else if (estado === 'RS') freteiro = 'WALDECI-SP';
  else if (['PONTA GROSSA','CASTRO','TELEMACO BORBA','TIBAGI','CARAMBEÍ'].some(x => c.includes(x.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'')))) freteiro = 'JOEL';

  // Forma de pagamento
  const obsUp = (obsRaw).toUpperCase();
  let formaPagto = 'pix';
  if (/12X|12\s*VEZES/i.test(obsUp+itens)) formaPagto = 'credito12';
  else if (/10X|10\s*VEZES/i.test(obsUp+itens)) formaPagto = 'credito10';
  else if (/6X|6\s*VEZES/i.test(obsUp+itens)) formaPagto = 'credito6';
  else if (/3X|3\s*VEZES/i.test(obsUp+itens)) formaPagto = 'credito3';

  // Calcular custos
  // Detectar colchões individuais no pedido
  const itensBrutos = p.itens || [];
  const colchoesItens = itensBrutos.filter(i => isColchaoItem(i.descricao || ''));

  // Função que monta um objeto de pedido para um colchão específico
  const montarPedido = (textoColchao, valorCol, sufixo) => {
    const tam = tamSrv(textoColchao);
    const kitC = (() => {
      const kitsR = [
        {r:/ELEGANCE\s+CROMOTERAPIA/i, v:'Elegance Cromoterapia'},
        {r:/ELEGANCE\s+SINGLE/i,       v:'Elegance Single'},
        {r:/CROMOTERAPIA/i,            v:'Cromoterapia'},
        {r:/SINGLE/i,             v:'Single'},
      ];
      for (const k of kitsR) if (k.r.test(textoColchao)) return k.v;
      return kit;
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
    for (const s of sizes2) if (s.r.test(textoColchao)) { modeloC = s.v; break; }
    if (!modeloC) modeloC = textoColchao.slice(0,60);

    // Cor do colchão específico
    const mCorC = textoColchao.match(/COR\s*:\s*([A-ZÁÀÂÃÉÊÍÓÔÕÚÜÇ]+)/i);
    const coresNorm2 = {PRETO:'Preto',CINZA:'Cinza',BEGE:'Bege',MARROM:'Marrom',TABACO:'Tabaco',BRANCO:'Branco',CAFE:'Café',NUDE:'Nude'};
    const corC = mCorC ? (coresNorm2[mCorC[1].toUpperCase()] || mCorC[1]) : (corFinal || '');

    // Itens agregados associados a este colchão (base, cabeceira do mesmo tamanho)
    const tamKey = tam === 'king' ? 'KING' : tam === 'queen' ? 'QUEEN' : tam === 'casal' ? 'CASAL' : 'SOLTEIRO';
    const t2c = [];
    itensBrutos.forEach(i => {
      const d = (i.descricao || '').toUpperCase();
      if (!d.includes(tamKey) && !d.includes('TRAVESSEIRO') && !d.includes('PULSEIRA')) return;
      if (d.includes('BOX') && d.includes('BAÚ') || d.includes('BAU')) { if (!t2c.includes('BASE BOX BAÚ') && d.includes(tamKey)) t2c.push('BASE BOX BAÚ'); }
      else if (d.includes('BOX') || d.includes('BASE')) { if (!t2c.includes('BASE BOX') && d.includes(tamKey)) t2c.push('BASE BOX'); }
      if (d.includes('CABECEIRA') && d.includes(tamKey)) { if (!t2c.includes('CABECEIRA')) t2c.push('CABECEIRA'); }
      if (d.includes('TRAVESSEIRO')) { if (!t2c.includes('TRAVESSEIROS')) t2c.push('TRAVESSEIROS'); }
      if (d.includes('PULSEIRA')) { if (!t2c.includes('PULSEIRA')) t2c.push('PULSEIRA'); }
    });

    const custoC = calcCustoSrv(textoColchao, kitC, tam);
    let custoAgrC = (/TRAVESSEIRO/i.test(t2c.join(' ')) ? 2 : 0) * C_SRV.travesseiro;
    if (t2c.includes('BASE BOX BAÚ') && C_SRV.base_bau[tam]) custoAgrC += C_SRV.base_bau[tam];
    else if (t2c.includes('BASE BOX') && C_SRV.base_normal[tam]) custoAgrC += C_SRV.base_normal[tam];
    if (t2c.includes('CABECEIRA') && C_SRV.cab_perola[tam]) custoAgrC += C_SRV.cab_perola[tam];
    custoAgrC = Math.round(custoAgrC);

    const custoFreteC = colchoesItens.length > 1 ? 0 : (C_SRV.frete[freteiro] || 0); // frete só no primeiro se múltiplos
    const custoTotalC = custoC + custoAgrC + custoFreteC;
    const taxaMap = {credito12:0.0599,credito10:0.0499,credito6:0.0369,credito3:0.0249,pix:0};
    const taxaValorC = Math.round(valorCol * (taxaMap[formaPagto] || 0));

    return {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2,6) + numPedido + sufixo,
      pedidoNum: numPedido,
      nome: cliente,
      modelo: modeloC,
      kit: kitC,
      cor: corC,
      terceiro: t2c.join(' + '),
      freteiro,
      costureiro: 'ORTO PREMIUM',
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
      const jaExiste = db.pedidos.find(x => x.pedidoNum === numPedido);
      if (jaExiste) { atualizados++; continue; }

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
    res.json({ ok:true, novos, atualizados, total: data.data.length });
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
    if (body.pedidos   !== undefined) db.pedidos   = body.pedidos;
    if (body.rastreios !== undefined) db.rastreios = body.rastreios;
    if (body.estoque   !== undefined) db.estoque   = body.estoque;
    if (body.sobras    !== undefined) db.sobras    = body.sobras;
    if (body.movHist   !== undefined) db.movHist   = body.movHist;
    if (body.custos    !== undefined) db.custos    = body.custos;
    await salvarDB(db);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
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
      if (db.pedidos.find(x => x.pedidoNum === numPedido)) continue;

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
        if (db.pedidos.find(x => x.pedidoNum === numPedido)) continue;
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
