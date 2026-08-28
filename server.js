// ============================================================
// RECOMENDALEADS BOT — Servidor de automação via Z-API
// VERSÃO 2 — Persistência em Firestore (não perde dados em redeploy)
// ============================================================
// Este servidor recebe mensagens do WhatsApp via webhook da Z-API
// e conduz o roteiro de neurovendas do Método Poder da Recomendação.

const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const multer = require('multer');
const nodemailer = require('nodemailer');

const app = express();
// Atrás do proxy do Render: faz req.protocol refletir https (X-Forwarded-Proto),
// pra que urlBase() gere webhooks com https (exigido pela Z-API).
app.set('trust proxy', true);
// Guarda o corpo bruto (rawBody) — necessário para validar a assinatura do
// webhook do Stripe, que exige o payload exatamente como recebido.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
// CORS restrito: só origens conhecidas (o painel é servido do mesmo domínio,
// então requisições same-origin nem passam por CORS). Configurável por env
// CORS_ORIGINS (lista separada por vírgula).
const CORS_ORIGINS = (process.env.CORS_ORIGINS ||
  'https://www.recomendaleads.com.br,https://recomendaleads.com.br')
  .split(',').map(s => s.trim()).filter(Boolean);
if (process.env.APP_BASE_URL) CORS_ORIGINS.push(process.env.APP_BASE_URL.trim());
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && CORS_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Key, X-Cadastro-Key');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Rate limiting simples em memória (sem dependência externa). Suficiente para
// frear brute force/abuso em endpoints sensíveis numa instância única.
const rateBuckets = new Map();
setInterval(() => {
  const agora = Date.now();
  for (const [k, b] of rateBuckets) if (agora > b.reset) rateBuckets.delete(k);
}, 10 * 60 * 1000).unref?.();
function rateLimit({ windowMs, max, prefix }) {
  return (req, res, next) => {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
    const key = `${prefix}:${ip}`;
    const agora = Date.now();
    let b = rateBuckets.get(key);
    if (!b || agora > b.reset) { b = { count: 0, reset: agora + windowMs }; rateBuckets.set(key, b); }
    b.count++;
    if (b.count > max) {
      res.set('Retry-After', String(Math.ceil((b.reset - agora) / 1000)));
      return res.status(429).json({ ok: false, erro: 'Muitas tentativas. Aguarde alguns instantes e tente de novo.' });
    }
    next();
  };
}
const limiteLogin = rateLimit({ windowMs: 5 * 60 * 1000, max: 10, prefix: 'login' });
const limiteAdmin = rateLimit({ windowMs: 5 * 60 * 1000, max: 20, prefix: 'admin' });

// ============================================================
// CONFIGURAÇÃO — STRIPE (assinaturas)
// ============================================================
// Chaves vêm do ambiente (Render). Em teste use sk_test_... / whsec_... .
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripe = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;
// Dias de tolerância após o vencimento antes de bloquear o painel.
const CARENCIA_DIAS = 7;

// Planos: mesmo produto em 3 ciclos. Valores em centavos (BRL).
// - mensal: assinatura recorrente no cartão (auto-renova)
// - semestral/anual: pagamento único que libera N meses de acesso
const PLANOS = {
  mensal: {
    nome: 'Mensal', tipo: 'assinatura', meses: 1,
    valorCentavos: 39700, intervalo: 'month', intervaloQtd: 1,
    metodos: ['card'],
    descricao: 'R$ 397/mês no cartão, renovação automática'
  },
  semestral: {
    nome: 'Semestral', tipo: 'unico', meses: 6,
    valorCentavos: 208200, // 6 x 347,00
    metodos: ['card'], // site automático: SÓ cartão de crédito
    metodosVendedor: ['card', 'pix', 'boleto'], // vendedor (?boleto=1): cartão + pix + boleto
    descricao: 'R$ 347/mês — R$ 2.082 cobrados de uma vez (6 meses)'
  },
  anual: {
    nome: 'Anual', tipo: 'unico', meses: 12,
    valorCentavos: 356400, // 12 x 297,00
    metodos: ['card'], // site automático: SÓ cartão de crédito
    metodosVendedor: ['card', 'pix', 'boleto'], // vendedor (?boleto=1): cartão + pix + boleto
    descricao: 'R$ 297/mês — R$ 3.564 cobrados de uma vez (12 meses)'
  }
};

// Calcula o status efetivo da assinatura e se a empresa tem acesso agora.
// Empresas SEM o campo `assinatura` (ex.: PDN e clientes antigos) NÃO são
// bloqueadas — ficam grandfathered até o admin atribuir uma cobrança.
function billingStatus(empresa) {
  const a = (empresa && empresa.assinatura) || null;
  if (!a || !a.status) return { status: 'sem_assinatura', acesso: true, acessoAte: null };
  const agora = Date.now();
  const ate = a.acessoAte ? new Date(a.acessoAte).getTime() : 0;
  if (ate >= agora) {
    const st = a.status === 'trial' ? 'trial' : 'ativa';
    return { status: st, acesso: true, acessoAte: a.acessoAte, ciclo: a.ciclo || null };
  }
  // acesso expirado
  const diasAtraso = Math.floor((agora - ate) / 86400000);
  if (a.status !== 'cancelada' && diasAtraso <= CARENCIA_DIAS) {
    return { status: 'atrasada', acesso: true, acessoAte: a.acessoAte, ciclo: a.ciclo || null, diasAtraso, carenciaDias: CARENCIA_DIAS };
  }
  return { status: 'bloqueada', acesso: false, acessoAte: a.acessoAte, ciclo: a.ciclo || null, diasAtraso };
}

// Acha a empresa dona de um customer do Stripe (eventos de webhook).
async function acharEmpresaPorStripeCustomer(customerId) {
  if (!customerId) return null;
  const snap = await EMPRESAS_COL().where('assinatura.stripeCustomerId', '==', customerId).limit(1).get();
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() };
}

// ============================================================
// CONFIGURAÇÃO — Z-API
// ============================================================
const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID || 'COLOQUE_SEU_ID_AQUI';
const ZAPI_TOKEN = process.env.ZAPI_TOKEN || 'COLOQUE_SEU_TOKEN_AQUI';
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || 'COLOQUE_SEU_CLIENT_TOKEN_AQUI';
const ZAPI_BASE_URL = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}`;

// ============================================================
// MULTI-TENANT — contexto da empresa ativa por requisição
// ============================================================
// Cada requisição (webhook) ou execução de agendamento roda dentro de um
// "contexto" que sabe qual empresa está ativa e quais credenciais Z-API usar.
// Assim os envios saem pelo WhatsApp da empresa certa, sem precisar passar a
// empresa em cada chamada. Se não houver contexto (ou a empresa não tiver
// Z-API própria cadastrada), tudo cai no Z-API global — exatamente o
// comportamento de hoje. Isso mantém a PDN funcionando sem mudança nenhuma.
const { AsyncLocalStorage } = require('async_hooks');
const tenantContext = new AsyncLocalStorage();

const ZAPI_GLOBAL = {
  instanceId: ZAPI_INSTANCE_ID,
  token: ZAPI_TOKEN,
  clientToken: ZAPI_CLIENT_TOKEN
};

// Credenciais Z-API próprias da empresa, com fallback pro global.
function zapiDaEmpresa(empresa) {
  if (empresa && empresa.zapiInstanceId && empresa.zapiToken) {
    return {
      instanceId: empresa.zapiInstanceId,
      token: empresa.zapiToken,
      clientToken: empresa.zapiClientToken || ''
    };
  }
  return ZAPI_GLOBAL;
}

// Z-API do contexto atual (empresa ativa), ou global se não houver contexto.
function zapiAtual() {
  const ctx = tenantContext.getStore();
  return (ctx && ctx.zapi) ? ctx.zapi : ZAPI_GLOBAL;
}

// Tipo de WhatsApp da empresa no contexto: 'oficial' (Meta) ou 'zapi'.
function tipoWppAtual() {
  const ctx = tenantContext.getStore();
  if (ctx && ctx.empresa && ctx.empresa.whatsappTipo) return ctx.empresa.whatsappTipo;
  if (ctx && ctx.whatsappTipo) return ctx.whatsappTipo;
  return 'zapi';
}

// Converte um data URI (data:...;base64,...) em Buffer; null se não for data URI.
function dataUriParaBuffer(s) {
  const m = typeof s === 'string' && s.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  return { mimetype: m[1], buffer: Buffer.from(m[2], 'base64') };
}

function zapiBaseUrl(cfg) {
  return `https://api.z-api.io/instances/${cfg.instanceId}/token/${cfg.token}`;
}

// ============================================================
// CONFIGURAÇÃO — WhatsApp API Oficial (Meta Cloud API)
// ============================================================
// Modo 'oficial': a empresa cadastra as credenciais da própria conta na Meta
// (Phone Number ID + token permanente + verify token do webhook). Fica tudo
// atrás do whatsappTipo, sem afetar Z-API.
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';

// Credenciais oficiais da empresa (null se não cadastradas).
function oficialDaEmpresa(empresa) {
  if (empresa && empresa.oficialPhoneId && empresa.oficialToken) {
    return {
      phoneId: empresa.oficialPhoneId,
      token: empresa.oficialToken,
      verifyToken: empresa.oficialVerifyToken || '',
      wabaId: empresa.oficialWabaId || ''
    };
  }
  return null;
}

// Credenciais oficiais do contexto atual (empresa ativa). Deriva do `empresa`
// do contexto quando `oficial` não foi passado explicitamente — assim TODO
// fluxo que roda com contexto de empresa (webhook, follow-up, agendamento,
// envios manuais) resolve as credenciais oficiais sem precisar alterar cada
// ponto que monta o contexto.
function oficialAtual() {
  const ctx = tenantContext.getStore();
  if (ctx && ctx.oficial) return ctx.oficial;
  if (ctx && ctx.empresa) return oficialDaEmpresa(ctx.empresa);
  return null;
}

function metaMessagesUrl(cfg) {
  return `https://graph.facebook.com/${META_GRAPH_VERSION}/${cfg.phoneId}/messages`;
}
function metaHeaders(cfg) {
  return { 'Authorization': `Bearer ${cfg.token}`, 'Content-Type': 'application/json' };
}
// A Meta espera o número só com dígitos (ex.: 5511999998888), sem "+".
function soDigitos(telefone) {
  return String(telefone || '').replace(/\D/g, '');
}

// Descobre o número REAL da conta oficial direto na Meta (display_phone_number
// do Phone Number ID). É a fonte da verdade no modo 'oficial' — não depende de
// número que sobrou de sessão Z-API antiga. Cacheia em memória por phoneId.
const _numeroOficialCache = {};
async function getNumeroOficial(oficial) {
  if (!oficial || !oficial.phoneId || !oficial.token) return null;
  const cache = _numeroOficialCache[oficial.phoneId];
  if (cache && (Date.now() - cache.em) < 60 * 60 * 1000 && cache.numero) return cache.numero;
  try {
    const resp = await axios.get(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/${oficial.phoneId}`,
      { params: { fields: 'display_phone_number' }, headers: { Authorization: `Bearer ${oficial.token}` }, timeout: 6000 }
    );
    const numero = soDigitos((resp.data && resp.data.display_phone_number) || '');
    if (numero) {
      _numeroOficialCache[oficial.phoneId] = { numero, em: Date.now() };
      return numero;
    }
  } catch (e) {
    console.warn('[NUM-OFICIAL] falha ao buscar display_phone_number:', e.response ? JSON.stringify(e.response.data).slice(0, 180) : e.message);
  }
  return null;
}

// empresaId do contexto atual, ou a PDN como padrão (comportamento de hoje).
function empresaIdAtual() {
  const ctx = tenantContext.getStore();
  return (ctx && ctx.empresaId) ? ctx.empresaId : EMPRESA_ID_PDN;
}

// ============================================================
// CONFIGURAÇÃO — Firebase Admin / Firestore
// ============================================================
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (err) {
  console.error('ERRO: FIREBASE_SERVICE_CCOUNT não está configurada corretamente.', err.message);
}

if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: 'recomendaleads-8063e.firebasestorage.app'
  });
}

const db = admin.apps.length ? admin.firestore() : null;

const EMPRESA_DOC = () => db.collection('config').doc('empresa');
// Chave do LINK FIXO de autocadastro do cliente. Link único e permanente
// (/cliente/cadastro?c=CHAVE); a chave existe só pra robô não achar a página.
// Pode ser trocada no painel a qualquer momento.
const CADASTRO_CLIENTE_DOC = () => db.collection('config').doc('cadastro_cliente');
// Senha padrão do autocadastro (o cliente é obrigado a trocar no 1º login).
const SENHA_PADRAO_AUTOCADASTRO = '123mudar';
async function getChaveCadastroCliente() {
  const d = await CADASTRO_CLIENTE_DOC().get();
  if (d.exists && d.data() && d.data().chave) return d.data().chave;
  const chave = crypto.randomBytes(9).toString('base64url');
  await CADASTRO_CLIENTE_DOC().set({ chave, criadoEm: new Date().toISOString() }, { merge: true });
  return chave;
}
const SESSOES_COL = () => db.collection('sessoes');
const LEADS_COL = () => db.collection('leads');
const SESSOES_RECOMENDADO_COL = () => db.collection('sessoes_recomendado');
const AGENDAMENTOS_COL = () => db.collection('agendamentos');
const DISPAROS_COL = () => db.collection('disparos_massa');
const MENSAGENS_PROCESSADAS_COL = () => db.collection('mensagens_processadas');
const NUMEROS_PAUSADOS_COL = () => db.collection('numeros_pausados');
// Caixa de entrada: cada mensagem trocada + um resumo por conversa
const MENSAGENS_CHAT_COL = () => db.collection('mensagens_chat');
const CONVERSAS_COL = () => db.collection('conversas');
// Pipeline do CLIENTE (recomendador): acompanha quem iniciou (leu o QR), deu o nome
// e recomendou. Separado dos leads (recomendados) pra não mexer em métricas/export.
const CLIENTES_PIPELINE_COL = () => db.collection('clientes_pipeline');

// Cria/atualiza o card do cliente no pipeline (só avança de estágio, nunca volta).
// etapa: 'iniciou' -> 'deu_nome' -> 'recomendou'.
const _RANK_CLI_ETAPA = { iniciou: 1, deu_nome: 2, recomendou: 3, recebeu_premio: 4 };
async function upsertClientePipeline(telefone, nome, etapa, contatos) {
  if (!db || !telefone) return;
  try {
    const empresaId = empresaIdAtual();
    const docId = `${empresaId}__${soDigitosTel(telefone)}`;
    const ref = CLIENTES_PIPELINE_COL().doc(docId);
    const snap = await ref.get();
    const agora = new Date().toISOString();
    const atual = snap.exists ? snap.data() : null;
    // Nunca retrocede o estágio (ex.: uma nova recomendação não volta pra 'iniciou').
    const rankNovo = _RANK_CLI_ETAPA[etapa] || 1;
    const rankAtual = atual ? (_RANK_CLI_ETAPA[atual.etapa] || 0) : 0;
    const etapaFinal = rankNovo >= rankAtual ? etapa : atual.etapa;
    const payload = {
      empresaId,
      telefone: soDigitosTel(telefone),
      nome: (nome && nome.trim()) ? nome.trim() : (atual && atual.nome) || null,
      etapa: etapaFinal,
      criadoEm: (atual && atual.criadoEm) || agora,
      atualizadoEm: agora
    };
    // Guarda a lista COMPLETA de amigos recomendados (nome+telefone) — pra o CRM mostrar
    // todos, inclusive os que ainda não foram disparados (ainda na fila anti-ban).
    if (Array.isArray(contatos) && contatos.length) {
      const mapa = {};
      (atual && Array.isArray(atual.recomendados) ? atual.recomendados : []).forEach(r => { const t = soDigitosTel(r.telefone); if (t) mapa[t] = { nome: r.nome || '', telefone: t }; });
      contatos.forEach(c => { const t = soDigitosTel(c.telefone); if (t) mapa[t] = { nome: c.nome || (mapa[t] && mapa[t].nome) || '', telefone: t }; });
      payload.recomendados = Object.values(mapa);
    }
    await ref.set(payload, { merge: true });
  } catch (e) { console.error('upsertClientePipeline:', e.message); }
}

// Grava uma mensagem (recebida ou enviada) no histórico da conversa e atualiza
// o resumo da conversa. Usado para a caixa de entrada do WhatsApp.
async function registrarMensagem({ empresaId, telefone, nome, direcao, texto, tipo, midiaUrl, contatosArray, messageId, campanhaId }) {
  if (!db || !telefone) return;
  const agora = new Date().toISOString();
  try {
    await MENSAGENS_CHAT_COL().add({
      empresaId: empresaId || EMPRESA_ID_PDN,
      chaveConversa: `${empresaId || EMPRESA_ID_PDN}__${telefone}`,
      telefone,
      direcao, // 'in' (recebida) ou 'out' (enviada)
      texto: texto || '',
      tipo: tipo || 'texto', // 'texto' | 'imagem' | 'audio' | 'video' | 'documento'
      midiaUrl: midiaUrl || null, // URL pra renderizar a mídia no painel (imagem/áudio/vídeo/doc)
      // Contato(s) da agenda compartilhados com a gente — guarda nome+telefone de
      // cada um pra a caixa de entrada mostrar igual o WhatsApp mostra (não só o
      // rótulo genérico "Contato compartilhado").
      contatosArray: (contatosArray && contatosArray.length) ? contatosArray : null,
      // ID que a Meta devolve no envio (wamid) — usado pra casar com o webhook de
      // status (sent/delivered/read) e desenhar o risquinho de confirmação, igual
      // o WhatsApp. Só existe pra mensagens NOSSAS mandadas via API Oficial.
      messageId: messageId || null,
      status: (direcao === 'out' && messageId) ? 'enviado' : null,
      // Marca de qual disparo em massa esta mensagem veio (ver DISPAROS_COL) —
      // usado só pro relatório da campanha, cruzando com o status acima.
      campanhaId: campanhaId || null,
      criadoEm: agora
    });
    const resumo = {
      empresaId: empresaId || EMPRESA_ID_PDN,
      telefone,
      ultimaMensagem: (texto || '').slice(0, 140),
      ultimaEm: agora,
      ultimaDirecao: direcao
    };
    if (nome) resumo.nome = nome;
    if (direcao === 'in') {
      resumo.naoLidas = admin.firestore.FieldValue.increment(1);
      // Carimba quando o contato falou com a gente por ÚLTIMO — é o que abre/renova
      // a janela de 24h da API Oficial (mensagens NOSSAS não contam). Usado por
      // dentroJanela24h() pra decidir texto livre vs template nos follow-ups.
      resumo.ultimaInboundEm = agora;
    }
    // Rede de lojas: carimba ofertaId quando já resolvido no contexto da requisição
    // (best-effort — nunca sobrescreve com null/undefined um valor já gravado antes).
    try {
      const ctx = tenantContext.getStore();
      if (ctx && ctx.empresa && ctx.empresa.ofertaId) resumo.ofertaId = ctx.empresa.ofertaId;
    } catch (e) {}
    await CONVERSAS_COL().doc(`${empresaId || EMPRESA_ID_PDN}__${telefone}`).set(resumo, { merge: true });
  } catch (err) {
    console.error('Erro ao registrar mensagem no chat:', err.message);
  }
}

// Apaga TODAS as mensagens da conversa (caixa de entrada) de um número, mantendo
// os demais dados (leads, etc.). Usado no reset de teste (stop1).
async function apagarConversaChat(empresaId, telefone) {
  const eid = empresaId || EMPRESA_ID_PDN;
  const chave = `${eid}__${telefone}`;
  try {
    const snap = await MENSAGENS_CHAT_COL().where('chaveConversa', '==', chave).get();
    let batch = db.batch(); let n = 0;
    for (const d of snap.docs) {
      batch.delete(d.ref);
      if (++n % 450 === 0) { await batch.commit(); batch = db.batch(); }
    }
    if (n % 450 !== 0 || n === 0) await batch.commit();
    await CONVERSAS_COL().doc(chave).delete();
  } catch (e) { console.error('[STOP1] erro ao apagar conversa:', e.message); }
}

// Reset TOTAL de um contato: apaga sessões (cliente e recomendado), cancela
// agendamentos pendentes e limpa a conversa — a pessoa fica como se nunca
// tivesse falado (mantém os leads no CRM). Roda dentro do contexto da empresa
// (usa empresaIdAtual). Usado pelo comando "stop1" e pelo botão Resetar da
// aba Conversas.
async function resetarContato(alvo) {
  try { await SESSOES_COL().doc(chaveSessao(alvo)).delete(); } catch (e) {}
  try { await SESSOES_RECOMENDADO_COL().doc(chaveSessao(alvo)).delete(); } catch (e) {}
  await despausarNumero(alvo);
  try {
    const snap = await AGENDAMENTOS_COL().where('status', '==', 'pendente').get();
    const batch = db.batch();
    snap.forEach(doc => {
      const d = doc.data();
      const telefoneAgendamento = d.dados?.contato?.telefone || d.dados?.telefone || null;
      const mesmaEmpresa = (d.empresaId || EMPRESA_ID_PDN) === empresaIdAtual();
      if (telefoneAgendamento === alvo && mesmaEmpresa) batch.update(doc.ref, { status: 'cancelado' });
    });
    await batch.commit();
  } catch (err) {
    console.error('Erro ao cancelar agendamentos no reset:', err.message);
  }
  await apagarConversaChat(empresaIdAtual(), alvo);
}

// Chave de documento isolada por empresa: "empresaId__telefone".
// Garante que sessões e pausas de uma empresa não colidam com as de outra
// quando o mesmo número fala com empresas diferentes.
// IMPORTANTE: a PDN mantém a chave ANTIGA (só o telefone, sem prefixo) para
// não orfanar sessões em andamento nem números já pausados no deploy. Só os
// novos clientes (multi-tenant) ganham o prefixo da empresa.
function chaveSessao(telefone) {
  const empresaId = empresaIdAtual();
  if (empresaId === EMPRESA_ID_PDN) return telefone;
  return `${empresaId}__${telefone}`;
}

async function numeroEstaPausado(telefone) {
  const snap = await NUMEROS_PAUSADOS_COL().doc(chaveSessao(telefone)).get();
  return snap.exists;
}

async function pausarNumero(telefone) {
  await NUMEROS_PAUSADOS_COL().doc(chaveSessao(telefone)).set({ pausadoEm: new Date().toISOString() });
}

async function despausarNumero(telefone) {
  await NUMEROS_PAUSADOS_COL().doc(chaveSessao(telefone)).delete();
}

// ---- Descadastro (opt-out): a pessoa não quer mais receber mensagens ----
// Anti-ban: dar uma saída fácil desvia a DENÚNCIA (maior gatilho de ban).
const DESCADASTROS_COL = () => db.collection('descadastros');
function ehOptOut(texto) {
  const t = (texto || '').toLowerCase().trim();
  return /^sair$/.test(t)
    || /n[ãa]o quero (mais )?(receber|mensagens|as mensagens)/.test(t)
    || /n[ãa]o me (mande|manda|mandem|envie|envia)/.test(t)
    || /me (tira|tire|remove|remova|retira|retire)/.test(t)
    || /parar de receber|descadastr|remover meu n[úu]mero|sair da lista|n[ãa]o quero mais nada/.test(t);
}
async function estaDescadastrado(telefone) {
  try { const s = await DESCADASTROS_COL().doc(chaveSessao(telefone)).get(); return s.exists; }
  catch (e) { return false; }
}
async function processarOptOut(telefone, empresa) {
  try { await DESCADASTROS_COL().doc(chaveSessao(telefone)).set({ em: new Date().toISOString() }); } catch (e) {}
  await pausarNumero(telefone);
  try { await SESSOES_RECOMENDADO_COL().doc(chaveSessao(telefone)).delete(); } catch (e) {}
  try { await SESSOES_COL().doc(chaveSessao(telefone)).delete(); } catch (e) {}
  try {
    const snap = await AGENDAMENTOS_COL().where('status', '==', 'pendente').get();
    const batch = db.batch();
    snap.forEach(doc => {
      const d = doc.data();
      const tel = d.dados?.contato?.telefone || d.dados?.telefone || null;
      if (tel === telefone && (d.empresaId || EMPRESA_ID_PDN) === empresaIdAtual()) batch.update(doc.ref, { status: 'cancelado' });
    });
    await batch.commit();
  } catch (e) { console.error('optout cancelar agendamentos:', e.message); }
  await sendText(telefone, (empresa && empresa.mensagemOptOut) || EMPRESA_PADRAO.mensagemOptOut);
  console.log(`[OPT-OUT] ${telefone} descadastrado (opt-out)`);
}

const EMPRESAS_COL = () => db.collection('empresas_login');
// Usuários de login (multiusuário por empresa). Cada doc:
//   { empresaId, nome, email, senhaHash, papel: 'gestor'|'atendente',
//     senhaProvisoria, ativo, criadoEm }
const USUARIOS_COL = () => db.collection('usuarios');
// Controle de envios da Agenda de Marketing (recorrência por recomendador).
// Doc id: `${empresaId}__${telefone}` → { ultimoEnvioEm, proximoEm }
const MARKETING_ENVIOS_COL = () => db.collection('marketing_envios');
// Avisos do dono para todos os clientes (histórico — "Mensagens do sistema").
const AVISOS_COL = () => db.collection('avisos');
// Comissões de vendedores (20% de cada pagamento de assinatura).
const COMISSOES_COL = () => db.collection('comissoes');
const COMISSAO_PCT = 20;
// Contas de vendedor (login próprio no /admin, com acesso limitado).
const VENDEDORES_COL = () => db.collection('vendedores');
// Contas de administrador (login fácil e-mail+senha; acesso total, igual à chave mestra).
const ADMINS_COL = () => db.collection('admins');
// Vouchers emitidos (controle de uso único): cada presente entregue ganha um
// código numérico exclusivo por empresa, com validade e marcação de uso.
const VOUCHERS_EMITIDOS_COL = () => db.collection('vouchers_emitidos');
// Pré-pago: extrato de créditos (recarga via Pix, lançada pelo admin) e débitos
// (cada mensagem oficial enviada). Doc: { empresaId, tipo:'credito'|'debito',
//   valorCentavos, saldoDepois, motivo, categoria, em, por }.
const TRANSACOES_COL = () => db.collection('transacoes_prepago');

const PALAVRAS_POSITIVAS = [
  'sim', 'pode', 'posso', 'claro', 'ok', 'okay', 'okk', 'manda', 'pode falar', 'pode sim', 'com certeza sim', 'ta bom', 'tá bom', 'tabom',
  'oi', 'olá', 'ola', 'opa', 'eai', 'e ai', 'e aí', 'iae', 'salve',
  'com certeza', 'certeza', 'isso', 'isso ai', 'isso aí', 'aham', 'uhum', 'ahã', 'beleza', 'blz', 'vai', 'fala', 'fale',
  'diga', 'diz', 'segue', 'continua', 'quero', 'quero sim', 'demorou',
  'bora', 'simbora', 'vamos', 'aceito', 'boa', 'show', 'massa', 'perfeito',
  'estou', 'estou bem', 'estou aqui', 'estou sim', 'estou ouvindo', 'tudo bem', 'tudo bom', 'td bem', 'td bom',
  'bom dia', 'boa tarde', 'boa noite', 'pode mandar', 'pode vir', 'manda ver', 'conta', 'me conta',
  'presente', 'sou eu', 'dale', 'obvio', 'óbvio', 'yes', 'sip'
];

// Frase(s) que o cliente envia para ATIVAR o presente. Configurável por empresa
// (pode ter várias, separadas por vírgula, ponto-e-vírgula ou quebra de linha).
function frasesGatilhoPresente(empresa) {
  const raw = (empresa && empresa.gatilhoPresente) || EMPRESA_PADRAO.gatilhoPresente || 'quero meu presente';
  return String(raw).split(/[\n,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
}
function ehGatilhoPresente(texto, empresa) {
  if (!texto) return false;
  const t = texto.toLowerCase().trim();
  return frasesGatilhoPresente(empresa).some(f => t.includes(f));
}

// Igual ehGatilhoPresente, mas TAMBÉM aceita a frase própria de qualquer OFERTA
// ativa (rede de lojas — cada loja pode ter sua própria frase-gatilho). Sem
// isso, a checagem só olhava pra frase do topo (a oferta padrão) e uma loja
// com frase diferente nunca disparava nada, mesmo já configurada — era essa a
// peça que faltava pro roteamento por oferta funcionar de ponta a ponta
// (resolverOfertaSilenciosa/aplicarOferta/menu de desambiguação já existiam,
// só nunca eram alcançados porque o gatilho inicial não reconhecia a frase).
function ehGatilhoPresenteQualquerOferta(texto, empresa) {
  if (ehGatilhoPresente(texto, empresa)) return true;
  if (!empresa || !empresa.ofertasHabilitado || !empresa.ofertas) return false;
  return Object.values(empresa.ofertas).some(o => o && o.ativa && ehGatilhoPresente(texto, o));
}

// Detecta a intenção do cliente de RECOMENDAR mais pessoas depois que já
// terminou (ex: "quero indicar mais", "quero recomendar meu amigo"). Por
// palavras-chave (determinístico, sem IA). Exige mencionar indicar/recomendar
// + uma palavra de intenção, pra não confundir com perguntas soltas.
function querRecomendarMais(texto) {
  if (!texto) return false;
  const t = texto.toLowerCase();
  // ESTRITO: exige uma FRASE de intenção real (verbo + indicar/recomendar juntos,
  // ou indicar/recomendar + mais/outro/amigo). Assim não dispara só porque o texto
  // menciona "recomendaleads" (o nome do produto) ou usa "posso/quero" solto.
  return /\b(quero|gostaria de|gostaria|posso|vou|desejo|preciso)\s+(indicar|recomendar)\b/.test(t)
    || /\b(indicar|recomendar)\s+(mais|outr[oa]s?|de novo|novamente|um amigo|uma pessoa|mais gente|mais amigos|mais pessoas|outra pessoa)\b/.test(t)
    || /\bmais\s+(indica|recomenda)/.test(t);
}

// ============================================================
// DEMONSTRAÇÃO POR NICHO — mesma empresa (PDN), "peles" diferentes por área.
// O cliente entra por um link com um código (#demo-barbearia etc). O robô veste
// a config daquele nicho (textos/imagens próprios) por toda a conversa, no MESMO
// número. Não muda a empresa/roteamento — é só uma sobreposição de apresentação.
// ============================================================
// Cada nicho tem um nome e um conjunto PADRÃO de textos (ponto de partida). Na
// Etapa 2 esses textos ficam editáveis no painel e sobrescrevem estes defaults.
// Cada nicho é AUTOSSUFICIENTE no demo: além da saudação, tem o PRÊMIO de exemplo
// próprio (sem imagem/link) e a mensagem final — pra NADA vazar da config real da
// empresa (ex.: o presente/mentoria do dono). `aplicarNicho` sobrepõe estes campos.
const NICHOS_DEMO = {
  barbearia: {
    nome: 'Barbearia',
    mensagemAgradecimento: 'Olá! 💈 Bem-vindo(a) à demonstração do RecomendaLeads para *Barbearias*. Obrigado por testar! Vou te mostrar como seus clientes recomendam amigos e todos ganham. 🙏',
    faixasBonus: [{ quantidade: 1, premio: '🎁 *Exemplo de presente:* um combo Corte + Barba de cortesia no seu retorno! 💈', arquivo: null, link: null, texto: '_(É só um exemplo — na sua barbearia você define o prêmio real: desconto, brinde, combo...)_' }],
    premioRecomendado: 'um Corte + Barba com desconto especial, cortesia de quem te indicou 💈',
    arquivoRecomendado: null, linkRecomendado: null,
    mensagemValidarAmigo: 'Viu como é simples? 😉 É exatamente assim que sua barbearia transforma um cliente em vários. Quer ativar isso no seu negócio?'
  },
  cabeleireiro: {
    nome: 'Cabeleireiro',
    mensagemAgradecimento: 'Olá! 💇 Bem-vindo(a) à demonstração do RecomendaLeads para *Cabeleireiros e Salões*. Obrigado por testar! Vou te mostrar como seus clientes recomendam amigos e todos ganham. 🙏',
    faixasBonus: [{ quantidade: 1, premio: '🎁 *Exemplo de presente:* uma escova ou hidratação de cortesia! 💇', arquivo: null, link: null, texto: '_(É só um exemplo — no seu salão você escolhe o prêmio: desconto, tratamento, brinde...)_' }],
    premioRecomendado: 'um serviço com desconto especial, cortesia de quem te indicou 💇',
    arquivoRecomendado: null, linkRecomendado: null,
    mensagemValidarAmigo: 'Viu como é simples? 😉 É assim que seu salão faz cada cliente trazer amigas novas. Quer ativar no seu negócio?'
  },
  dentista: {
    nome: 'Dentista',
    mensagemAgradecimento: 'Olá! 🦷 Bem-vindo(a) à demonstração do RecomendaLeads para *Dentistas e Clínicas Odontológicas*. Obrigado por testar! Vou te mostrar como seus pacientes recomendam amigos e todos ganham. 🙏',
    faixasBonus: [{ quantidade: 1, premio: '🎁 *Exemplo de presente:* uma limpeza (profilaxia) de cortesia! 🦷', arquivo: null, link: null, texto: '_(É só um exemplo — na sua clínica você define o prêmio: avaliação, desconto, clareamento...)_' }],
    premioRecomendado: 'uma avaliação com condição especial, cortesia de quem te indicou 🦷',
    arquivoRecomendado: null, linkRecomendado: null,
    mensagemValidarAmigo: 'Viu como é simples? 😉 É assim que sua clínica transforma pacientes em novas indicações. Quer ativar no seu consultório?'
  },
  estetica: {
    nome: 'Clínica de Estética',
    mensagemAgradecimento: 'Olá! ✨ Bem-vindo(a) à demonstração do RecomendaLeads para *Clínicas de Estética*. Obrigado por testar! Vou te mostrar como suas clientes recomendam amigas e todas ganham. 🙏',
    faixasBonus: [{ quantidade: 1, premio: '🎁 *Exemplo de presente:* uma sessão de limpeza de pele de cortesia! ✨', arquivo: null, link: null, texto: '_(É só um exemplo — na sua clínica você escolhe o prêmio: sessão, desconto, kit...)_' }],
    premioRecomendado: 'uma sessão com condição especial, cortesia de quem te indicou ✨',
    arquivoRecomendado: null, linkRecomendado: null,
    mensagemValidarAmigo: 'Viu como é simples? 😉 É assim que sua clínica faz cada cliente trazer amigas. Quer ativar no seu negócio?'
  }
};

// Gera um "slug" (código do link) a partir do nome do mercado.
// Ex: "Pet Shop" -> "pet-shop". Só letras/números/hífen, sem acento.
function slugNicho(nome) {
  return String(nome || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// Código OPACO do nicho (não revela o mercado no texto do link). Determinístico
// a partir do slug — o mesmo cálculo roda no painel (frontend) pra montar o link.
function codigoNicho(slug) {
  let h = 0;
  const s = String(slug || '');
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
  return h.toString(36).slice(0, 4).padStart(4, '0');
}

// Detecta o nicho no texto de entrada. Aceita 2 formatos, sempre com "#" literal
// (o link cru colado vem com "%23" e é ignorado, evitando iniciar 2x):
//  - opaco (novo): "#a3f9" — NÃO revela o mercado;
//  - explícito (antigo, compatível): "#demo-barbearia".
// O nicho vale se for embutido (NICHOS_DEMO) ou criado pelo dono (empresa.nichos).
function detectarNichoDemo(texto, empresa) {
  if (!texto) return null;
  const t = String(texto).toLowerCase();
  const slugs = [...new Set([...Object.keys(NICHOS_DEMO), ...Object.keys((empresa && empresa.nichos) || {})])];
  // Formato explícito antigo: #demo-<slug>
  const m1 = t.match(/#demo[-_\s]?([a-z0-9-]+)/);
  if (m1) { const slug = m1[1].replace(/-+$/, ''); if (slugs.includes(slug)) return slug; }
  // Formato opaco novo: #<código de 4 chars>
  const m2 = t.match(/#([a-z0-9]{4})\b/);
  if (m2) { const code = m2[1]; for (const s of slugs) { if (codigoNicho(s) === code) return s; } }
  return null;
}

// Sobrepõe a config do nicho sobre a base da empresa: primeiro os defaults
// embutidos (NICHOS_DEMO), depois o que o dono personalizou no painel
// (empresa.nichos[nicho]). Assim já há diferença visível antes de personalizar.
function aplicarNicho(empresa, nicho) {
  if (!empresa || !nicho) return empresa;
  const def = NICHOS_DEMO[nicho] || {};
  const over = (empresa.nichos && empresa.nichos[nicho]) || {};
  const merged = { ...empresa, ...def, ...over, id: empresa.id, nichos: empresa.nichos };
  // No DEMO só existe o 1º prêmio — nunca pede "quer liberar o próximo prêmio".
  if (Array.isArray(merged.faixasBonus) && merged.faixasBonus.length > 1) {
    merged.faixasBonus = merged.faixasBonus.slice(0, 1);
  }
  return merged;
}

// Sobrepõe os campos PRODUTO (mensagens, prêmios, Kanban, templates) da oferta
// resolvida sobre a config em uso — mesmo padrão de aplicarNicho, mas por
// ofertaId (rede de lojas: cada loja é uma oferta dentro da mesma empresa).
function aplicarOferta(empresa, ofertaId) {
  if (!empresa || !ofertaId || !empresa.ofertas || !empresa.ofertas[ofertaId]) return empresa;
  const oferta = empresa.ofertas[ofertaId];
  const camposProduto = {};
  for (const k of CAMPOS_PRODUTO_OFERTA) {
    if (oferta[k] !== undefined) {
      camposProduto[k] = oferta[k];
    } else if (EMPRESA_PADRAO[k] !== undefined) {
      // Campo que essa oferta ainda não personalizou: cai no exemplo GENÉRICO do
      // sistema, não no valor que `empresa` já carrega (que é o texto REAL da
      // oferta Padrão/matriz em uso agora). Sem isso, uma oferta nova "vazava"
      // prêmio/mensagem de outra oferta da mesma empresa — ex.: o robô oferecendo
      // o prêmio da Padrão pra quem ativou a oferta da Alef.
      camposProduto[k] = EMPRESA_PADRAO[k];
    } else {
      // Sem default genérico pra esse campo (ex.: oficialTemplate* — só existe no
      // topo). Fica vazio de propósito: nunca usar o template/config de OUTRA
      // oferta por engano.
      camposProduto[k] = null;
    }
  }
  // ofertaId fica carimbado no próprio objeto — assim quem já recebe `empresa`
  // (criarLead, iniciarConversaRecomendado, registrarMensagem via contexto) acha
  // o valor sem precisar de mais um parâmetro novo em cada função.
  return { ...empresa, ...camposProduto, id: empresa.id, ofertas: empresa.ofertas, ofertaId };
}

// Resolve a oferta (loja) de um contato SEM perguntar nada — só quando é óbvio:
// (1) a sessão já sabe, (2) o texto bate com a frase-gatilho de alguma oferta
// ativa (ex.: "quero meu bônus" = loja 2), (3) só existe 1 oferta ativa. Com 2+
// ofertas ativas e nenhum sinal, devolve null — fica pra Fase 2b (menu).
function resolverOfertaSilenciosa(empresa, texto, ofertaIdConhecida) {
  if (ofertaIdConhecida) return ofertaIdConhecida;
  if (!empresa || !empresa.ofertasHabilitado || !empresa.ofertas) return null;
  const ativas = Object.entries(empresa.ofertas).filter(([, o]) => o && o.ativa);
  if (!ativas.length) return null;
  if (texto) {
    const t = String(texto).toLowerCase();
    // Pega TODOS os gatilhos que batem, não só o primeiro — quando um gatilho é
    // pedaço de outro (ex.: "quero o presente" dentro de "quero o presente
    // agora"), o primeiro da lista vencia por sorte de ordem, mesmo quando outra
    // oferta tinha o gatilho mais específico e batia igual. Desempate: o gatilho
    // MAIS LONGO (mais específico) ganha.
    const candidatos = ativas.filter(([, o]) => o.gatilhoPresente && t.includes(String(o.gatilhoPresente).toLowerCase()));
    if (candidatos.length) {
      candidatos.sort((a, b) => String(b[1].gatilhoPresente).length - String(a[1].gatilhoPresente).length);
      return candidatos[0][0];
    }
  }
  // NÃO auto-seleciona a oferta quando só existe 1 alternativa ativa e a frase
  // não bateu com o gatilho específico dela — Padrão continua sendo uma opção
  // válida mesmo com só 1 loja extra cadastrada (não é "sem ambiguidade": são
  // sempre 2 destinos possíveis, Padrão ou a loja). Regressão real: desde que
  // isso existia, criar UMA oferta extra ativa já bastava pra roubar TODO
  // contato novo que mandasse a frase geral — mesmo sem citar a loja.
  return null;
}

function respostaEhPositiva(texto) {
  if (!texto) return false;
  const normalizado = texto.toLowerCase().trim();
  return PALAVRAS_POSITIVAS.some(palavra => normalizado.includes(palavra));
}

const PALAVRAS_NEGATIVAS = [
  'não quero', 'nao quero', 'não tenho interesse', 'nao tenho interesse',
  'para de mandar', 'me tira', 'não conheço', 'nao conheco',
  'quem é você', 'quem e voce', 'não me interessa', 'nao me interessa',
  'bloquear', 'spam', 'para', 'chega', 'não', 'nao'
];

function respostaEhNegativa(texto) {
  if (!texto) return false;
  const normalizado = texto.toLowerCase().trim();
  // Só considera negativo se for exatamente "não"/"nao" sozinho,
  // ou se contiver frases explicitamente negativas
  if (normalizado === 'não' || normalizado === 'nao') return true;
  return ['não quero', 'nao quero', 'não tenho interesse', 'nao tenho interesse',
    'para de mandar', 'me tira', 'não conheço', 'nao conheco',
    'não me interessa', 'nao me interessa', 'bloquear', 'spam'
  ].some(frase => normalizado.includes(frase));
}

// Sem fallback fraco: se a env var não estiver configurada, quebra alto no
// boot (visível no log do Render) em vez de rodar em produção com um segredo
// previsível que qualquer um lendo o código consegue forjar.
if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET não configurado (env var obrigatória)');
if (!process.env.ADMIN_SECRET) throw new Error('ADMIN_SECRET não configurado (env var obrigatória)');
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

// ============================================================
// CONFIGURAÇÃO — API Claude (interpretação de respostas do recomendado)
// ============================================================
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

const EMPRESA_ID_PDN = 'MFMcfVJfqv35dA9MotLK';

// ============================================================
// SEED — configuração padrão da empresa
// ============================================================
const EMPRESA_PADRAO = {
  nome: 'Empresa Demo',
  mensagemAgradecimento: 'Olá! Muito obrigado(a) por ser nosso cliente e confiar no nosso trabalho. 🙏',
  vendedores: ['Carla Mendes', 'Roberto Lima', 'Juliana Alves'],
  faixasBonus: [
    { quantidade: 5, premio: 'Cupom de 10% de desconto na próxima compra', arquivo: null, link: null, texto: null },
    { quantidade: 10, premio: 'Brinde exclusivo + 15% de desconto', arquivo: null, link: null, texto: null },
    { quantidade: 15, premio: 'Vale-presente de R$ 50', arquivo: null, link: null, texto: null },
    { quantidade: 20, premio: 'Status de Embaixador + kit especial', arquivo: null, link: null, texto: null }
  ],
  premioRecomendado: 'Desconto de 10% na primeira compra, cortesia de quem te recomendou',
  arquivoRecomendado: null,
  // Controle de voucher (uso único): quando ligado, cada presente entregue
  // ganha um código numérico exclusivo com validade. O dono confere/marca como
  // usado na tela /resgatar-voucher, evitando reuso do mesmo voucher.
  voucherControle: false,
  voucherValidadeDias: 30,
  linkRecomendado: null,
  textoRecomendado: null,
  // Presente precisa de agendamento? true = serviço/visita (fluxo de menu + agendar).
  // false = entrega direta (físico/ebook): entrega e só manda a mensagem de fechamento.
  presentePrecisaAgendamento: true,
  mensagemFechamentoEntrega: 'Prontinho, seu presente é seu! 🎁 Aproveite bastante 😊 Qualquer dúvida, é só me chamar aqui.',
  // Presente Recomendado com venda — enviado ao RECOMENDADOR quando o amigo
  // que ele indicou COMPRA (card arrastado para a coluna "Comprou" no CRM).
  premioVenda: 'Um presente especial por recomendar alguém que comprou com a gente',
  arquivoVenda: null,
  linkVenda: null,
  textoVenda: null,
  mensagemVenda: 'Boa notícia, {recomendador}! 🎉 {recomendado}, que você recomendou, fechou com a gente — e por isso preparamos um presente pra você: {premio}. Passa aqui pra retirar! 🎁',
  // Agenda de Marketing — mensagem recorrente automática enviada ao
  // RECOMENDADOR (cliente que indicou) a cada N dias, contados da entrada dele.
  marketingAtivo: false,
  marketingIntervaloDias: 45,
  marketingMensagem: 'Oi {recomendador}! 😊 Aqui é da {empresa}. Passando pra matar a saudade e lembrar que temos novidades esperando por você. Bora conversar? 💬',
  marketingPremio: '',
  marketingArquivo: null,
  marketingLink: null,
  marketingTexto: null,
  ctaRecomendado: 'Que tal aproveitar e passar pra retirar o seu? 😊',
  mensagemInicialRecomendado: 'Olá {nomeRecomendado}, tudo bem? 😊 Aqui é {vendedor}, da {empresa}. O(a) {recomendador} recomendou você para receber um presente que separamos 🎁 Posso te explicar rapidinho?',
  // Anti-ban: variações da 1ª mensagem ao recomendado. O robô SORTEIA entre as
  // preenchidas (evita mensagem idêntica pra todo mundo = cara de spam). Vazias = ignoradas.
  mensagemInicialRecomendado2: '',
  mensagemInicialRecomendado3: '',
  mensagemAguardandoConfirmacao: 'Prometo que é rapidinho e sem compromisso 😊 Posso te mostrar o que prepararam pra você? 🎁',
  // Modo direto: quando o recomendado responder ao template, o robô NÃO roda o
  // fluxo do presente — manda 1 mensagem curta, avisa o vendedor e passa a conversa
  // pro humano (cai em Conversas). Default OFF (segue o fluxo automático de sempre).
  recomendadoAtendimentoHumano: false,
  recomendadoHumanoMensagem: 'Que bom, {nomeRecomendado}! 😊 Já já um consultor da {empresa} te chama por aqui pra liberar o seu presente. Só um instante 🙌',
  // Quando o modo direto transfere pro atendente:
  // 'antes'  = não roda o fluxo do presente, transfere na hora (comportamento
  //            original, sempre foi assim).
  // 'depois' = entrega o presente normal primeiro (voucher/link/texto de sempre),
  //            e só DEPOIS transfere — deixando a pessoa já com o presente na
  //            mão quando o atendente assumir.
  recomendadoAtendimentoHumanoQuando: 'antes',
  // Pergunta única que o robô faz DEPOIS de entregar o presente, antes de
  // transferir (só no modo 'depois') — a resposta já fica visível pro
  // atendente na conversa. Vazio = transfere direto, sem perguntar nada.
  recomendadoPerguntaChave: null,
  mensagemAntesPresente: '🎉 Boa notícia! Você ganhou {premio}. Aqui está o seu presente 👇',
  gatilhoPresente: 'quero meu presente',
  // Modo de recomendação (ver [[modelo-inbound-recomendacao]]):
  //  'basic'  = o robô dispara pros amigos (atual, padrão).
  //  'full'   = inbound: cliente compartilha link, o amigo é quem chama a gente (ban≈0).
  // No modo API Oficial (whatsappTipo='oficial') o fluxo roda sempre como 'full'.
  modoRecomendacao: 'basic',
  // Basic com CONFIRMAÇÃO: no modo basic, segura o disparo pros amigos até o
  // cliente confirmar que avisou (menos denúncia = menos ban). Lembretes de
  // confirmação com cadência editável (quantos, tempo e texto de cada).
  basicConfirmarAntesDisparo: false,
  basicConfirmMensagem: 'Falta só um passo pra eu chamar seus amigos! 🙌 Dá um alô rápido avisando que a {empresa} vai entrar em contato com eles.\n\n1️⃣ Já avisei → pode chamar eles\n2️⃣ Ainda não avisei\n3️⃣ Me manda um textinho pronto pra eu encaminhar\n\n👇 _Digita o número aqui_ 👇',
  // Opção 3 do menu: texto pronto que o robô manda pro cliente ENCAMINHAR pros amigos (avisar antes).
  basicTextoPronto: 'Oi! 😊 Acabei de te recomendar pra {empresa} e você vai ganhar um presente 🎁 Eles vão te mandar uma mensagem por aqui — é só responder que garante o seu!',
  // Frase que vai LOGO DEPOIS do textinho (opção 3), pra o cliente já saber o próximo
  // passo (responder 1) sem ter que esperar o 1º lembrete.
  basicTextoProntoConfirma: 'Encaminha este textinho acima pros seus amigos 💜\nAssim que enviar, me avisa aqui tá? 😊',
  // Opção 2 do menu: resposta quando o cliente diz que ainda NÃO avisou (segue aguardando).
  basicAindaNao: 'Tranquilo, {cliente}! 😊 Sem pressa. Assim que avisar seus amigos, é só me responder *1* (ou "pode mandar") que eu chamo eles na hora 🎁',
  basicConfirmacaoCadencia: [
    { esperaMin: 120, texto: 'Oi {cliente}! 😊 Conseguiu avisar seus amigos? Quando estiver tudo certo, responde *1* (já avisei) que eu chamo eles 🎁' },
    { esperaMin: 1440, texto: 'Oi {cliente}! Seus amigos ainda estão te esperando 🎁 Avisa eles e responde *1* (já avisei).' },
    { esperaMin: 4320, texto: 'Oi {cliente}! Última lembrança 🙌 É só avisar os amigos e responder *1* (já avisei) que eu libero os presentes deles.' }
  ],
  basicSemConfirmacao: 'nao_envia', // 'nao_envia' (seguro) | 'envia' (dispara mesmo sem confirmar, após a cadência)
  // Intervalo (min) entre entregar o presente e perguntar se quer o próximo prêmio.
  // Evita encavalar essa pergunta com o aviso de "avise seus amigos" (o cliente
  // respondia "ok" e o robô achava que era "sim" pra próxima faixa).
  intervaloProximaFaixaMin: 1,
  // Espera (min) depois do "muito obrigado" antes de mandar o menu "avisar os amigos"
  // (1/2/3), pra dar tempo do cliente realmente avisar as amigas que recomendou.
  avisarConfirmDelayMin: 2,
  // Número de WhatsApp da empresa (só dígitos) — usado pra montar o link que o
  // cliente encaminha no modo Full (o amigo toca e chama ESTE número).
  numeroWhatsapp: '',
  // Textos do modo Full (editáveis; padrão abaixo):
  fullMensagemAvisoInicial: 'Antes de começar, deixa eu te explicar 😊 Pra ganhar seu presente são *2 passinhos rápidos* 🎁\n\n1️⃣ Você me manda os contatos dos amigos\n2️⃣ Eu te mando uma mensagem pronta pra você encaminhar pra eles\n\nAssim que completar, seu presente é liberado na hora! Bora? 🚀',
  fullMensagemPasso2: 'Show, {nomeRecomendado}! 🙌 Falta só o *passo 2*: encaminhe a mensagem abaixo para os amigos que você recomendou. Assim que enviar, me manda um *"enviei"* aqui que eu libero seu presente 🎁',
  fullMensagemEncaminhar: 'Oi! 😊 Eu te recomendei pra {empresa} e você ganhou um presente 🎁 É só tocar no link aqui pra resgatar o seu:',
  // Cadência de cobrança do "enviei" no Full: se o cliente não confirmar que
  // encaminhou, o robô insiste (você define quantos, o tempo e o texto de cada).
  fullConfirmacaoCadencia: [
    { esperaMin: 120, texto: 'Oi {cliente}! 😊 Conseguiu encaminhar a mensagem pros amigos? Assim que enviar, me responde *"enviei"* que eu solto seu presente 🎁' },
    { esperaMin: 1440, texto: 'Oi {cliente}! Seu presente está reservado 🎁 É só encaminhar a mensagem pros amigos e me responder *"enviei"*.' },
    { esperaMin: 4320, texto: 'Oi {cliente}! Última lembrança 🙌 Encaminha a mensagem pros amigos e me responde *"enviei"* que eu libero seu presente na hora.' }
  ],

  // ===== Conversa do CLIENTE (quem recomenda) — editável =====
  mensagemPedeNome: 'Pra começar, qual é o seu nome?',
  // Follow-up — Sem resposta (Cliente): quando o cliente nunca responde ao
  // "qual é o seu nome?", o robô insiste (via API Oficial, categoria utilidade).
  // Vazio = não manda nenhum (opt-in, precisa ser configurado no CRM).
  cadenciaFollowupClienteInicial: [],
  // Follow-up — Sem resposta (Cliente): quando o cliente já deu o nome mas
  // trava em "coletando_contatos" (pedimos as indicações e ele some sem
  // mandar nenhuma). Mesma lógica opt-in — vazio não manda nada.
  cadenciaFollowupClienteContatos: [],
  mensagemPedeVendedor: 'Prazer, {nome}! E me diz, quem te atendeu hoje?',
  mensagemPedeContatos: 'Show! Agora me envie o contato dos seus amigos para você receber {premio}.',
  mensagemColeta: 'Me envie {quantidade} recomendações e já garanta seu presente.\n\nVocê pode mandar o contato direto da sua agenda. Então, qual é a primeira pessoa que vem na sua mente?\nLembrando que ela também vai ganhar um presente nosso 🎁',
  // Aviso enviado ao recomendador logo após receber o presente, pedindo que
  // ele avise os amigos recomendados. Editável no painel ("Validar com o amigo").
  // Vazio = não envia.
  mensagemValidarAmigo: 'Só uma coisa importante: avise seus amigos que vamos entrar em contato com eles em breve, combinado? Assim eles já esperam nossa mensagem 😉',

  // ===== Follow-up do RECOMENDADOR (cliente que indicou) =====
  // Lembretes automáticos pedindo que ele avise os amigos. Menu numerado
  // (1 já avisei / 2 ainda não / 3 me manda um texto pronto). Editável no painel.
  followupRecomendadorAtivo: false,
  // Espera de cada lembrete (em minutos), contada do fim da recomendação.
  // Padrão: 1 dia, 3 dias, 7 dias.
  cadenciaFollowupRecomendador: [{ esperaMin: 1440 }, { esperaMin: 4320 }, { esperaMin: 10080 }],
  followupRecomendadorMensagem: 'Oi {cliente}! 😊 Passando pra lembrar: você já avisou seus amigos que a {empresa} vai entrar em contato com eles?\n\n1️⃣ Sim, já avisei\n2️⃣ Ainda não\n3️⃣ Me manda um textinho pronto pra eu enviar\n\n👇 _Digita o número aqui_ 👇',
  followupJaAvisei: 'Perfeito, muito obrigado(a)! 🙌 Isso ajuda bastante — assim seus amigos já esperam a nossa mensagem.',
  followupAindaNao: 'Sem problema! 😉 Quando puder, dá um alô pra eles avisando. Assim eles recebem nosso contato numa boa. Obrigado(a)!',
  followupTextoPronto: 'Oi! 😊 Acabei de te recomendar pra {empresa} e você vai ganhar um presente 🎁 Eles vão te chamar aqui no WhatsApp, pode responder tranquilo!',
  // Textos do 2º e 3º lembretes (opcionais). Vazio = repete o texto do 1º.
  followupRecomendadorMensagem2: 'Oi {cliente}! 😊 Só passando de novo: conseguiu avisar seus amigos que a {empresa} vai chamar eles?\n\n1️⃣ Sim, já avisei\n2️⃣ Ainda não\n3️⃣ Me manda um textinho pronto pra eu enviar\n\n👇 _Digita o número aqui_ 👇',
  followupRecomendadorMensagem3: 'Oi {cliente}! 😊 Última passadinha aqui 🙌 Já deu aquele alô pros amigos que você recomendou?\n\n1️⃣ Sim, já avisei\n2️⃣ Ainda não\n3️⃣ Me manda um textinho pronto pra eu enviar\n\n👇 _Digita o número aqui_ 👇',

  // ===== Atendimento pós-fluxo: responde dúvidas do cliente com as infos do
  // negócio (endereço, horário, site...). Usa IA (Claude) com as infos abaixo. =====
  infoAtendimentoAtivo: false,
  infoEndereco: '',
  infoHorario: '',
  infoSite: '',
  infoInstagram: '',
  infoTelefone: '',
  infoEmail: '',
  infoOutras: '',

  // Follow-up — Sem resposta (Recomendado): amigo indicado que nunca respondeu.
  // Editável no CRM em "Follow-up — Sem resposta" → Recomendado. Vazio = não manda nenhum.
  cadenciaFollowupRecomendado: [
    { esperaMin: 1440, texto: 'Olá! 😊 Passei só pra lembrar que o presente recomendado pra você continua disponível 🎁 Posso te explicar?' }
  ],
  tempoEsperaConversaoMin: 60,
  tempoFollowupMin: 30,
  // Anti-ban: intervalo ALEATÓRIO (minutos) entre um recomendado e o próximo,
  // pra não disparar todos juntos (rajada). Cada envio sai espaçado e embaralhado.
  recomendadoGapMinMin: 3,
  recomendadoGapMaxMin: 8,
  // Humanização: mostra "digitando..." antes de cada mensagem e dá um respiro
  // entre mensagens seguidas (parece gente, ajuda anti-ban). NÃO muda o texto
  // nem a cadência dos lembretes. false = desliga.
  humanizarDigitacao: true,
  humanizarMaxSeg: 4,

  // ===== Fluxo pós-presente (todos editáveis no painel, na sequência) =====
  // Opt-out (descadastro) — anti-ban: saída fácil desvia a denúncia.
  mensagemOptOut: 'Tudo bem! 🙏 Não vou mais te enviar mensagens. Se um dia mudar de ideia, é só chamar aqui. Obrigado(a)!',
  // Mensagem de CONEXÃO enviada logo após o presente, ANTES do menu — dá um
  // respiro e engaja (a pessoa responde) antes de perguntar o que ela quer fazer.
  // Vazio = pula (manda o menu direto, como antes).
  posMensagemConexao: 'E aí, gostou? 😍',
  menuAposReacaoMin: 1, // se a pessoa não responder, manda o menu depois de X min
  posMenuPrincipal: `🎉 *Prontinho!*\n\nEspero que você goste do presente 😊\nO(a) {recomendador} vai ficar feliz de saber que você recebeu.\n\nAgora é só escolher o que prefere 👇\n\n🟢 *1* — Quero usar meu presente\n🟡 *2* — Vou usar depois\n⚪ *3* — Tenho uma dúvida\n🚫 *0* — Não quero receber mensagens\n\n👇 _Digita o número aqui_ 👇`,
  posLinkAgendamento: 'Perfeito! 😊 É só escolher o melhor horário pra você aqui:',
  posPerguntaPeriodo: `Perfeito! 😊 Vamos combinar sua visita.\n\nQual período fica melhor pra você?\n\n*1* — Manhã ☀️\n*2* — Tarde 🌤️\n*3* — Noite 🌙\n\n👇 _Digita o número aqui_ 👇`,
  posPerguntaDia: 'Ótimo! Agora escolha o melhor dia 📅',
  // Dias da semana que a empresa NÃO atende (0=domingo, 1=segunda ... 6=sábado).
  // Esses dias não aparecem na lista de agendamento. Padrão: atende todos.
  diasFechados: [],
  posConfirmacaoAgendamento: `🎉 *Tudo certo!*\n\nSua visita foi reservada:\n📅 {dia} — período da {periodo}\n\nNossa equipe vai confirmar com você pertinho do dia. Vai ser um prazer te receber! 😊`,
  posConfirmacaoCheck: 'Oi {nomeRecomendado}! 😊 Conseguiu confirmar seu agendamento? Se ficou alguma dúvida, é só me chamar aqui 👍',
  posMenuDepois: `Sem problemas! 😊 Seu presente continua reservado pra você.\n\nComo prefere fazer?\n\n🟢 *1* — Deixar uma data reservada\n🟡 *2* — Receber um lembrete depois\n🚫 *0* — Não quero receber mensagens\n\n👇 _Digita o número aqui_ 👇`,
  posLembrete: 'Perfeito! 😊 Vamos te lembrar no momento certo de aproveitar seu presente. Até breve! 👋',
  posMenuDuvidas: `Claro! Sobre o que você gostaria de saber?\n\n*1* — Como funciona o presente?\n*2* — Qual a validade?\n*3* — Onde fica a empresa?\n*4* — Horários de atendimento\n*5* — Falar com um atendente\n🚫 *0* — Não quero receber mensagens\n\n👇 _Digita o número aqui_ 👇`,
  faqComoFunciona: 'Seu presente é: {premio}. É só apresentar essa mensagem quando vier nos visitar 😊',
  faqValidade: 'É por tempo limitado, então recomendo aproveitar logo! 😉 Qualquer detalhe, nossa equipe te ajuda.',
  enderecoEmpresa: '',
  horariosEmpresa: '',
  posAtendente: 'Claro! 😊 Já estou chamando um atendente pra falar com você por aqui. É só aguardar um pouquinho.',
  // Número (só dígitos, com DDD) que RECEBE o aviso quando alguém pede atendimento
  // humano. Vazio = não avisa por WhatsApp (o alerta visual no painel sempre acontece).
  numeroAtendente: '',
  linkAgendamento: '',

  etapasKanban: [
    { id: 'recebeu_mensagem', nome: 'Recebeu Mensagem' },
    { id: 'recebeu_premio', nome: 'Recebeu o Prêmio' },
    { id: 'agendou', nome: 'Agendou' },
    { id: 'comprou', nome: 'Comprou' },
    { id: 'nao_respondeu', nome: 'Não respondeu' },
    { id: 'nao_tem_interesse', nome: 'Não tem interesse' }
  ],

  // Colunas FIXAS do funil do CLIENTE (recomendador), no início do Kanban.
  // Só o "nome" (rótulo exibido) é editável no painel — os ids são fixos porque
  // o código usa eles pra saber em qual etapa cada cliente está (iniciou/deu_nome/
  // recomendou/recebeu_premio); por isso não entram no editor de "Etapas do
  // Pipeline" (que permite criar/excluir/reordenar) e vivem numa lista separada.
  etapasKanbanCliente: [
    { id: 'cli_iniciou', nome: '🚪 Iniciou (leu o QR)' },
    { id: 'cli_deu_nome', nome: '✍️ Deu o nome' },
    { id: 'cli_recomendou', nome: '✅ Recomendou' },
    { id: 'cli_recebeu_premio', nome: '🎁 Recebeu o Prêmio' }
  ],

  // Script de vendas — roteiro por fase da negociação, pro atendente ler/copiar
  // enquanto conversa no WhatsApp (painel lateral em Conversas). Vazio até o gestor
  // preencher; sem exemplo pré-pronto pra não confundir com script de outra empresa.
  scriptVendas: [],

  // Rede de lojas: pergunta mandada quando 2+ ofertas estão ativas e ninguém
  // resolveu ainda qual loja é o contato (nenhuma frase-gatilho específica bateu).
  // É sobre a empresa toda (não uma oferta), por isso fica aqui e não dentro de
  // uma oferta — {opcoes} é substituído pela lista numerada das lojas ativas.
  mensagemEscolhaOferta: 'Antes de continuar, me diz qual loja você prefere:\n{opcoes}\n\nResponda só com o número 😉'
};

// ============================================================
// MÚLTIPLAS OFERTAS. Uma empresa pode ter mais de um lançamento/evento rodando
// no mesmo número de WhatsApp/login, cada um com mensagens, prêmios, templates,
// Kanban e frase-gatilho 100% independentes. A oferta marcada como
// `ofertaAtivaPadrao` fica sempre espelhada nos campos de topo de `configuracao`
// (getEmpresaById NÃO muda) — é ela que o robô usa quando a mensagem não bate
// com a frase-gatilho de nenhuma outra oferta ativa. As demais ofertas (dentro
// de `configuracao.ofertas`) já respondem normalmente se estiverem `ativa` e
// com a própria frase configurada — ver ehGatilhoPresenteQualquerOferta,
// resolverOfertaSilenciosa e o menu de desambiguação em tratarWebhook (quando
// 2+ ofertas estão ativas e a mensagem não bate com frase nenhuma).
// ============================================================

// Campos de OPERAÇÃO/CONEXÃO da empresa — nunca entram dentro de uma oferta,
// continuam soltos em `configuracao` de topo (compartilhados entre ofertas).
const CAMPOS_OPERACAO_EMPRESA = new Set([
  'nome', 'vendedores', 'numeroWhatsapp', 'numeroAtendente', 'linkAgendamento',
  'diasFechados', 'enderecoEmpresa', 'horariosEmpresa',
  'infoAtendimentoAtivo', 'infoEndereco', 'infoHorario', 'infoSite', 'infoInstagram',
  'infoTelefone', 'infoEmail', 'infoOutras',
  'recomendadoGapMinMin', 'recomendadoGapMaxMin', 'humanizarDigitacao', 'humanizarMaxSeg',
  'intervaloProximaFaixaMin', 'avisarConfirmDelayMin', 'menuAposReacaoMin',
  'modoRecomendacao', 'nichos', 'numeroConectado', 'numeroDemo', 'mensagemEscolhaOferta'
]);
// Campos de PRODUTO — tudo que descreve o lançamento em si (mensagens, prêmios,
// cadências, Kanban, script de vendas, templates da Meta). Vive dentro de cada oferta.
const CAMPOS_PRODUTO_OFERTA = new Set([
  ...Object.keys(EMPRESA_PADRAO).filter(k => !CAMPOS_OPERACAO_EMPRESA.has(k)),
  'oficialTemplateRecomendado', 'oficialTemplateInsistencia',
  'oficialTemplateFollowupCliente', 'oficialTemplateConvite',
  'oficialTemplateVenda', 'oficialTemplateMarketing', 'oficialTemplateClienteInicial',
  'oficialTemplateClienteContatos'
]);
// Gera um id de oferta a partir do nome (reaproveita o slugify de nichos) + sufixo
// aleatório curto — evita colisão sem precisar de contador/corrida entre criações.
function gerarIdOferta(nome) {
  const base = slugNicho(nome) || 'oferta';
  return `${base.slice(0, 30)}-${Math.random().toString(36).slice(2, 6)}`;
}
// Mescla uma oferta com os defaults do EMPRESA_PADRAO — mesmo padrão de merge
// que getEmpresaById já usa hoje, só que escopado a uma oferta específica.
function mesclarOfertaComPadrao(oferta) {
  return { ...EMPRESA_PADRAO, ...(oferta || {}) };
}

// Configuração especial para empresa de teste — faixa 1 com apenas 1 recomendação
const EMPRESA_TESTE_CONFIG = {
  ...EMPRESA_PADRAO,
  nome: 'PDN Teste',
  faixasBonus: [
    { quantidade: 1, premio: 'Prêmio de teste — 1 recomendação', arquivo: null, link: null, texto: null }
  ],
  tempoEsperaConversaoMin: 1
};

// Busca uma empresa pelo id, devolvendo a config (padrão + personalizações)
// já com o id e as credenciais Z-API próprias anexadas. Retorna null se não
// existir.
async function getEmpresaById(empresaId) {
  const snap = await EMPRESAS_COL().doc(empresaId).get();
  if (!snap.exists) return null;
  const data = snap.data();
  const cfg = data.configuracao
    ? { ...EMPRESA_PADRAO, ...data.configuracao }
    : { ...EMPRESA_PADRAO, nome: data.nome };
  return {
    ...cfg,
    id: snap.id,
    whatsappTipo: data.whatsappTipo || 'zapi',
    zapiInstanceId: data.zapiInstanceId || null,
    zapiToken: data.zapiToken || null,
    zapiClientToken: data.zapiClientToken || null,
    oficialPhoneId: data.oficialPhoneId || null,
    oficialToken: data.oficialToken || null,
    oficialVerifyToken: data.oficialVerifyToken || null,
    oficialWabaId: data.oficialWabaId || null,
    // App Secret do app da Meta DESTA empresa — cada empresa pode ter seu próprio
    // app (Phone Number ID/Token/WABA diferentes), então o App Secret também
    // precisa ser por empresa, nunca uma env var global (ver assinaturaMetaValida).
    oficialAppSecret: data.oficialAppSecret || null,
    // Templates oficiais: preferem o valor salvo na `configuracao` (editável no CRM,
    // junto de cada mensagem) e caem pro campo de topo (salvo no painel novo) — assim
    // dá pra configurar nos DOIS lugares sem quebrar quem já salvou no painel novo.
    oficialTemplateRecomendado: cfg.oficialTemplateRecomendado || data.oficialTemplateRecomendado || null,
    // Templates oficiais por tipo de mensagem (vazio = usa texto livre, só entrega em 24h).
    oficialTemplateInsistencia: cfg.oficialTemplateInsistencia || data.oficialTemplateInsistencia || null,
    oficialTemplateFollowupCliente: cfg.oficialTemplateFollowupCliente || data.oficialTemplateFollowupCliente || null,
    oficialTemplateConvite: cfg.oficialTemplateConvite || data.oficialTemplateConvite || null,
    oficialTemplateClienteInicial: cfg.oficialTemplateClienteInicial || data.oficialTemplateClienteInicial || null,
    oficialTemplateClienteContatos: cfg.oficialTemplateClienteContatos || data.oficialTemplateClienteContatos || null,
    // Pré-pago (só cobra quando prepagoAtivo = true).
    prepagoAtivo: !!data.prepagoAtivo,
    saldoCentavos: data.saldoCentavos || 0,
    precoMktCentavos: data.precoMktCentavos != null ? data.precoMktCentavos : PRECO_MKT_PADRAO,
    precoUtilCentavos: data.precoUtilCentavos != null ? data.precoUtilCentavos : PRECO_UTIL_PADRAO,
    // Múltiplas ofertas: sem isso o robô (que só enxerga o objeto devolvido aqui,
    // não o doc bruto) não tem como saber se deve rotear por oferta.
    ofertasHabilitado: !!data.ofertasHabilitado
  };
}

async function getEmpresa() {
  // Se há uma empresa ativa no contexto (multi-tenant), usa ela.
  const ctx = tenantContext.getStore();
  if (ctx && ctx.empresa) return ctx.empresa;

  // Fallback: PDN (comportamento de hoje, sem contexto).
  const snap = await EMPRESAS_COL().doc(EMPRESA_ID_PDN).get();
  if (snap.exists && snap.data().configuracao) {
    return { ...EMPRESA_PADRAO, ...snap.data().configuracao };
  }
  const snapDemo = await EMPRESA_DOC().get();
  if (!snapDemo.exists) {
    await EMPRESA_DOC().set(EMPRESA_PADRAO);
    return { ...EMPRESA_PADRAO };
  }
  return snapDemo.data();
}

async function getSessao(telefone) {
  const snap = await SESSOES_COL().doc(chaveSessao(telefone)).get();
  if (!snap.exists) {
    const novaSessao = {
      etapa: 'aguardando_nome',
      clienteNome: null,
      vendedorNome: null,
      contatos: [],
      criadoEm: new Date().toISOString()
    };
    await SESSOES_COL().doc(chaveSessao(telefone)).set(novaSessao);
    return novaSessao;
  }
  return snap.data();
}

async function saveSessao(telefone, sessao) {
  await SESSOES_COL().doc(chaveSessao(telefone)).set(sessao, { merge: true });
}

async function resetSessao(telefone) {
  await SESSOES_COL().doc(chaveSessao(telefone)).delete();
}

// ============================================================
// CRM KANBAN — leads recomendados (coleção "leads")
// ============================================================

async function criarLead({ nomeRecomendado, telefoneRecomendado, nomeRecomendador, telefoneRecomendador, vendedor, empresaId }) {
  const empresa = await getEmpresa();
  const etapas = (empresa.etapasKanban && empresa.etapasKanban.length > 0)
    ? empresa.etapasKanban
    : EMPRESA_PADRAO.etapasKanban;
  const etapaInicial = etapas[0].id;

  const lead = {
    nomeRecomendado: nomeRecomendado || 'Contato sem nome',
    telefoneRecomendado: telefoneRecomendado || null,
    nomeRecomendador: nomeRecomendador || null,
    telefoneRecomendador: telefoneRecomendador || null,
    vendedor: vendedor || null,
    empresaId: empresaId || null,
    // Rede de lojas: de qual oferta (loja) é este lead — resolvido no fluxo
    // (webhook) e carimbado em `empresa.ofertaId` via aplicarOferta(). Null pra
    // quem não usa múltiplas ofertas, sem mudar nada do comportamento de hoje.
    ofertaId: empresa.ofertaId || null,
    etapa: etapaInicial,
    bonusPago: false,
    criadoEm: new Date().toISOString(),
    historico: [{ etapa: etapaInicial, em: new Date().toISOString() }]
  };
  const ref = await LEADS_COL().add(lead);
  return { id: ref.id, ...lead };
}

async function getLeadsPorEmpresa(empresaId) {
  const snap = await LEADS_COL().where('empresaId', '==', empresaId).orderBy('criadoEm', 'desc').get();
  const leads = [];
  snap.forEach(doc => leads.push({ id: doc.id, ...doc.data() }));
  return leads;
}

async function atualizarLead(id, dados) {
  const ref = LEADS_COL().doc(id);
  const snap = await ref.get();
  if (!snap.exists) return null;

  const atual = snap.data();
  const atualizado = { ...atual, ...dados };

  if (dados.etapa && dados.etapa !== atual.etapa) {
    atualizado.historico = [...(atual.historico || []), { etapa: dados.etapa, em: new Date().toISOString() }];
  }

  await ref.set(atualizado, { merge: true });
  return { id, ...atualizado };
}

// ============================================================
// HELPERS DE ENVIO — Z-API
// ============================================================

function zapiHeaders(cfg) {
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.clientToken && cfg.clientToken !== 'COLOQUE_SEU_CLIENT_TOKEN_AQUI') {
    headers['Client-Token'] = cfg.clientToken;
  }
  return headers;
}

// Upload de mídia (data URI) pra Meta Cloud API — devolve o media id.
async function metaUploadMedia(cfg, buffer, mimetype, filename) {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', buffer, { filename: filename || 'arquivo', contentType: mimetype });
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${cfg.phoneId}/media`;
  const resp = await axios.post(url, form, {
    headers: { ...form.getHeaders(), 'Authorization': `Bearer ${cfg.token}` }
  });
  return resp.data && resp.data.id;
}

// Caminho INVERSO: baixa uma mídia que o CLIENTE mandou pra gente (foto, áudio,
// vídeo, documento) e sobe pro nosso Storage — pra guardar um link permanente
// (o link que a Meta dá expira em minutos) e o painel conseguir exibir depois.
async function baixarMidiaMetaEUpload(cfg, mediaId, empresaId) {
  try {
    const info = await axios.get(`https://graph.facebook.com/${META_GRAPH_VERSION}/${mediaId}`, {
      headers: { Authorization: `Bearer ${cfg.token}` }, timeout: 8000
    });
    const { url: urlTemporaria, mime_type } = info.data || {};
    if (!urlTemporaria) return null;
    const resp = await axios.get(urlTemporaria, {
      headers: { Authorization: `Bearer ${cfg.token}` }, responseType: 'arraybuffer', timeout: 15000
    });
    const ext = (mime_type || '').split('/')[1]?.split(';')[0] || 'bin';
    const nomeArquivo = `conversas-recebidas/${empresaId}/${Date.now()}_${mediaId}.${ext}`;
    const bucket = admin.storage().bucket();
    const fileRef = bucket.file(nomeArquivo);
    await fileRef.save(Buffer.from(resp.data), { metadata: { contentType: mime_type || 'application/octet-stream' } });
    const [urlPermanente] = await fileRef.getSignedUrl({ action: 'read', expires: '01-01-2125' });
    return { url: urlPermanente, mimetype: mime_type };
  } catch (e) {
    console.warn('[MIDIA-RECEBIDA] falha ao baixar da Meta:', e.response ? JSON.stringify(e.response.data).slice(0, 160) : e.message);
    return null;
  }
}

// Mesma ideia, mas pro canal Z-API: ali a mídia que o cliente manda já chega com
// uma URL direta no corpo do webhook (não precisa de um passo de "resolver o
// media id" como na Meta) — mas baixamos e subimos pro nosso Storage do mesmo
// jeito, pra ter um link permanente (a URL que a Z-API dá não é garantida pra
// sempre) e o painel conseguir exibir. Antes disso essas mensagens eram
// registradas só como o rótulo genérico ("🎤 Áudio"), sem link nenhum.
async function baixarMidiaZapiEUpload(urlOrigem, empresaId, mimetypeSugerido) {
  try {
    if (!urlOrigem) return null;
    const resp = await axios.get(urlOrigem, { responseType: 'arraybuffer', timeout: 15000 });
    const mimetype = resp.headers['content-type'] || mimetypeSugerido || 'application/octet-stream';
    const ext = (mimetype || '').split('/')[1]?.split(';')[0] || 'bin';
    const nomeArquivo = `conversas-recebidas/${empresaId}/${Date.now()}_zapi.${ext}`;
    const bucket = admin.storage().bucket();
    const fileRef = bucket.file(nomeArquivo);
    await fileRef.save(Buffer.from(resp.data), { metadata: { contentType: mimetype } });
    const [urlPermanente] = await fileRef.getSignedUrl({ action: 'read', expires: '01-01-2125' });
    return { url: urlPermanente, mimetype };
  } catch (e) {
    console.warn('[MIDIA-RECEBIDA] falha ao baixar da Z-API:', e.response ? JSON.stringify(e.response.data).slice(0, 160) : e.message);
    return null;
  }
}

// Ritmo humano por telefone: guarda até quando a janela do último envio vai,
// pra ESPAÇAR mensagens seguidas (não chegar tudo junto = cara de robô/rajada).
const _ritmoEnvio = {};
// Calcula os delays (em SEGUNDOS) que a Z-API usa pra mostrar "digitando..."
// (delayTyping) e pra segurar a vez de mensagens seguidas (delayMessage).
// NÃO altera o texto nem a cadência — é puro tempo. Tudo offloadado pra Z-API.
function delaysHumanos(phone, message) {
  const ctx = tenantContext.getStore();
  const empresa = ctx && ctx.empresa;
  if (empresa && empresa.humanizarDigitacao === false) return null; // desligado
  const maxSeg = Math.max(1, (empresa && empresa.humanizarMaxSeg) || 4);
  const len = (message || '').length;
  // "digitando..." proporcional ao tamanho do texto, com teto + pequena variação
  let typingSeg = Math.min(maxSeg, Math.max(1, Math.round(1 + len / 45)));
  if (Math.random() < 0.5) typingSeg = Math.min(15, typingSeg + 1);
  const agora = Date.now();
  const inicio = Math.max(agora, _ritmoEnvio[phone] || 0);
  const delayMessageSeg = Math.min(15, Math.max(0, Math.round((inicio - agora) / 1000)));
  // reserva a janela deste envio, pro próximo sair depois (respiro entre mensagens)
  _ritmoEnvio[phone] = inicio + typingSeg * 1000 + 700 + Math.floor(Math.random() * 800);
  // limpeza leve pra não crescer pra sempre
  if (Object.keys(_ritmoEnvio).length > 800) {
    for (const k in _ritmoEnvio) { if (_ritmoEnvio[k] < agora) delete _ritmoEnvio[k]; }
  }
  return { delayTyping: typingSeg, delayMessage: delayMessageSeg };
}

// Cache de números já resolvidos (não bater no Z-API a cada envio).
const _numeroCanonicoCache = new Map();

// Buffer em memória dos últimos callbacks de STATUS/ENTREGA da Z-API (webhook "Ao
// enviar" / DeliveryCallback). Guarda por messageId pra o "Teste de entrega" mostrar
// na tela o motivo REAL de não entregar (campo error), sem precisar ler log.
const _statusCallbacks = new Map(); // messageIdUPPER -> { recebidoEm, body }
function guardarStatusCallback(body) {
  const mid = body.messageId || body.id || (Array.isArray(body.ids) && body.ids[0]);
  if (!mid) return;
  _statusCallbacks.set(String(mid).toUpperCase(), { recebidoEm: Date.now(), body });
  if (_statusCallbacks.size > 300) { const k = _statusCallbacks.keys().next().value; _statusCallbacks.delete(k); }
}

// Resolve o número CANÔNICO do WhatsApp via Z-API — corrige o "9º dígito" do Brasil.
// Chats NOVOS (recomendados) usam o número que o CLIENTE digitou/compartilhou, que pode
// não bater com o formato registrado no WhatsApp (com/sem o 9). Nesse caso a Z-API aceita
// (200) mas NÃO entrega. Aqui perguntamos ao WhatsApp qual é o número certo antes de enviar.
// Best-effort: se a consulta falhar, devolve os dígitos originais (comportamento de antes).
async function resolverNumeroZapi(cfg, phone) {
  const digitos = soDigitos(phone);
  if (!digitos) return digitos;
  if (_numeroCanonicoCache.has(digitos)) return _numeroCanonicoCache.get(digitos);
  const base = zapiBaseUrl(cfg);
  const headers = zapiHeaders(cfg);
  for (const rota of [`/phone-exists/${digitos}`, `/contacts/iswhatsapp/${digitos}`]) {
    try {
      const resp = await axios.get(`${base}${rota}`, { headers, timeout: 8000 });
      const d = resp.data || {};
      const canonico = soDigitos(d.outputPhone || d.phone || '');
      if (canonico) {
        _numeroCanonicoCache.set(digitos, canonico);
        if (canonico !== digitos) console.log(`[9dig] corrigido ${digitos} -> ${canonico}`);
        return canonico;
      }
    } catch (e) { /* tenta a próxima rota ou cai no fallback */ }
  }
  return digitos; // não cacheia falha -> tenta resolver de novo no próximo envio
}

// Extrai o wamid (ID da mensagem) que a Meta devolve em toda resposta de envio
// bem-sucedido — precisa disso pra casar com o webhook de status depois.
function idMensagemMeta(respostaAxios) {
  try { return (respostaAxios.data.messages && respostaAxios.data.messages[0].id) || null; }
  catch (e) { return null; }
}

async function sendText(phone, message) {
  if (tipoWppAtual() === 'oficial') {
    try {
      const cfg = oficialAtual();
      const r = await axios.post(metaMessagesUrl(cfg), {
        messaging_product: 'whatsapp', to: soDigitos(phone), type: 'text',
        text: { preview_url: true, body: message }
      }, { headers: metaHeaders(cfg) });
      console.log(`[ENVIADO/oficial] para ${phone}: ${message.slice(0, 60)}...`);
      registrarMensagem({ empresaId: empresaIdAtual(), telefone: phone, direcao: 'out', texto: message, messageId: idMensagemMeta(r) });
      return { ok: true, via: 'oficial' };
    } catch (err) { const e = err.response?.data ? JSON.stringify(err.response.data) : err.message; console.error('Erro ao enviar texto (Oficial):', e); return { ok: false, via: 'oficial', erro: e }; }
  }
  try {
    const cfg = zapiAtual();
    const destino = await resolverNumeroZapi(cfg, phone);
    const body = { phone: destino, message };
    // Humanização (delayTyping/delayMessage) DESLIGADA temporariamente: suspeita de que
    // a Z-API está aceitando mas NÃO entregando mensagens com delay. Envio direto, igual
    // ao que funciona (aviso do atendente). Reativar depois de confirmar a causa.
    // const d = delaysHumanos(phone, message);
    // if (d) { body.delayTyping = d.delayTyping; if (d.delayMessage > 0) body.delayMessage = d.delayMessage; }
    const respZ = await axios.post(`${zapiBaseUrl(cfg)}/send-text`, body, { headers: zapiHeaders(cfg) });
    console.log(`[ENVIADO via instância ${cfg.instanceId}] empresa=${empresaIdAtual()} para ${destino}${destino !== soDigitos(phone) ? ` (era ${soDigitos(phone)})` : ''}: ${message.slice(0, 40)}... resp=${JSON.stringify(respZ.data || {}).slice(0, 200)}`);
    registrarMensagem({ empresaId: empresaIdAtual(), telefone: phone, direcao: 'out', texto: message });
    return { ok: true, via: 'zapi' };
  } catch (err) {
    const e = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('Erro ao enviar texto:', e);
    return { ok: false, via: 'zapi', erro: e };
  }
}

// Envia uma mensagem SEM registrar no inbox (Conversas) — usado pra avisos internos
// (ex.: alertar o atendente), pra não criar uma "conversa" com o número do atendente.
async function enviarSemLog(phone, message) {
  try {
    if (tipoWppAtual() === 'oficial') {
      const cfg = oficialAtual();
      await axios.post(metaMessagesUrl(cfg), { messaging_product: 'whatsapp', to: soDigitos(phone), type: 'text', text: { body: message } }, { headers: metaHeaders(cfg) });
      return true;
    }
    const cfg = zapiAtual();
    await axios.post(`${zapiBaseUrl(cfg)}/send-text`, { phone, message }, { headers: zapiHeaders(cfg) });
    return true;
  } catch (e) { console.error('enviarSemLog:', e.response?.data ? JSON.stringify(e.response.data) : e.message); return false; }
}

// Número que recebe o aviso: 1º o ATENDENTE OFICIAL cadastrado na Equipe (com telefone);
// se não houver, cai no número digitado no CRM (numeroAtendente).
async function getNumeroAvisoAtendente(empresa) {
  const eid = (empresa && empresa.id) || empresaIdAtual();
  try {
    const snap = await USUARIOS_COL().where('empresaId', '==', eid).get();
    const oficial = snap.docs.map(d => d.data()).find(u => u.atendenteOficial && u.telefone);
    if (oficial && oficial.telefone) return soDigitosTel(oficial.telefone);
  } catch (e) { /* best-effort */ }
  return soDigitosTel(empresa && empresa.numeroAtendente);
}

// Quando alguém pede atendimento humano: marca a conversa (aviso visual no painel)
// e dispara um WhatsApp pro atendente OFICIAL (ou número do CRM, se não houver oficial).
async function avisarAtendente(telefone, nomePessoa, empresa) {
  try {
    await CONVERSAS_COL().doc(`${empresaIdAtual()}__${telefone}`)
      .set({ precisaAtendente: true, precisaAtendenteEm: new Date().toISOString() }, { merge: true });
  } catch (e) { /* best-effort */ }
  const numAt = await getNumeroAvisoAtendente(empresa);
  if (numAt) {
    const nome = (nomePessoa || '').split(' ')[0] || 'Um cliente';
    const base = process.env.APP_BASE_URL || 'https://www.recomendaleads.com.br';
    const link = `${base}/conversas?tel=${encodeURIComponent(soDigitosTel(telefone))}`;
    const msg = `🔔 *Atendimento humano solicitado*\n\n${nome} pediu pra falar com um atendente${empresa.nome ? ` na ${empresa.nome}` : ''}.\n\n👉 Responda pelo sistema (abre direto na conversa):\n${link}`;
    await enviarSemLog(numAt, msg);
  }
}

// ============================================================
// REVEZAMENTO DE ATENDIMENTO — distribui o "modo direto" (recomendado que
// escolhe ir direto pro humano, sem passar pelo fluxo automático) entre os
// atendentes ONLINE, em carrossel. Se ninguém responder (assumir) em 1 min,
// escala pro próximo online — até esgotar as tentativas.
// ============================================================

// Atendentes "online" agora: telefone cadastrado, status = 'online' (o próprio
// atendente escolhe em Conversas: Online/Pausa/Offline), e com heartbeat recente
// (o painel manda a cada 30s enquanto a aba fica aberta).
async function usuariosOnlineRevezamento(empresaId) {
  const snap = await USUARIOS_COL().where('empresaId', '==', empresaId).get();
  const agora = Date.now();
  const lista = [];
  snap.forEach(d => {
    const u = d.data();
    if (u.ativo === false) return;
    if (!u.telefone) return;
    if ((u.statusAtendimento || 'online') !== 'online') return; // em Pausa/Offline
    if (!u.ultimaAtividadeEm) return;                 // nunca deu heartbeat (painel fechado)
    const idadeMs = agora - new Date(u.ultimaAtividadeEm).getTime();
    if (idadeMs > 90 * 1000) return;                  // heartbeat velho = considera offline
    lista.push({ id: d.id, nome: u.nome, telefone: u.telefone });
  });
  lista.sort((a, b) => a.id.localeCompare(b.id)); // ordem estável pro carrossel
  return lista;
}

// Escolhe o próximo do carrossel, pulando quem já tentou nesta escalada
// (excluirIds). Null = ninguém online agora (cai no fallback do atendente oficial).
async function escolherProximoAtendenteRevezamento(empresaId, excluirIds) {
  const online = await usuariosOnlineRevezamento(empresaId);
  if (!online.length) return null;
  let pool = online.filter(u => !(excluirIds || []).includes(u.id));
  if (!pool.length) pool = online; // já tentou todo mundo — reinicia o ciclo
  const empDoc = await EMPRESAS_COL().doc(empresaId).get();
  const lastId = empDoc.exists ? empDoc.data().ultimoAtendenteRevezamentoId : null;
  const idx = pool.findIndex(u => u.id === lastId);
  const escolhido = pool[(idx + 1) % pool.length];
  await EMPRESAS_COL().doc(empresaId).set({ ultimoAtendenteRevezamentoId: escolhido.id }, { merge: true });
  return escolhido;
}

// Avisa o atendente escolhido (WhatsApp + marca a conversa pro alerta piscar/tocar
// no painel). Se ninguém assumir em 1 min, agenda escalar pro próximo online.
const MAX_TENTATIVAS_REVEZAMENTO = 6; // ~6 min de tentativas antes de desistir
async function avisarAtendenteRevezamento(telefone, nomePessoa, empresa, excluirIds, tentativa) {
  excluirIds = excluirIds || [];
  tentativa = tentativa || 1;
  const escolhido = await escolherProximoAtendenteRevezamento(empresa.id, excluirIds);
  try {
    await CONVERSAS_COL().doc(`${empresa.id}__${telefone}`).set({
      precisaAtendente: true, precisaAtendenteEm: new Date().toISOString(),
      atendenteAtribuidoId: escolhido ? escolhido.id : null,
      atendenteAtribuidoNome: escolhido ? escolhido.nome : null
    }, { merge: true });
  } catch (e) { /* best-effort */ }
  const numAt = escolhido ? escolhido.telefone : await getNumeroAvisoAtendente(empresa);
  if (numAt) {
    const nome = (nomePessoa || '').split(' ')[0] || 'Um cliente';
    const base = process.env.APP_BASE_URL || 'https://www.recomendaleads.com.br';
    const link = `${base}/conversas?tel=${encodeURIComponent(soDigitosTel(telefone))}`;
    const prefixo = tentativa > 1 ? '🔔 *Lembrete — atendimento ainda sem resposta*' : '🔔 *Atendimento humano solicitado*';
    const msg = `${prefixo}\n\n${nome} pediu pra falar direto com um consultor${empresa.nome ? ` na ${empresa.nome}` : ''}.\n\n👉 Responda pelo sistema (abre direto na conversa):\n${link}`;
    await enviarSemLog(numAt, msg);
  }
  console.log(`[REVEZAMENTO] tentativa ${tentativa} — ${telefone} → ${escolhido ? escolhido.nome : '(sem ninguém online — fallback atendente oficial)'}`);
  if (tentativa < MAX_TENTATIVAS_REVEZAMENTO) {
    const novosExcluidos = escolhido ? [...excluirIds, escolhido.id] : excluirIds;
    try {
      await criarAgendamento({
        tipo: 'escalar_aviso_atendente',
        executarEm: new Date(Date.now() + 60000).toISOString(),
        dados: { telefone, nomePessoa, excluirIds: novosExcluidos, tentativa: tentativa + 1 }
      });
    } catch (e) { console.error('agendar escalar_aviso_atendente:', e.message); }
  }
}

// Detecta pedido de atendente humano por frase natural, em qualquer momento.
function pedeAtendente(texto) {
  const t = (texto || '').toLowerCase().trim();
  if (!t) return false;
  if (/n[ãa]o (quero|precisa)/.test(t)) return false; // "não quero atendente"
  return /\batendente\b|recepcionista|\bhumano\b|falar com (uma |um |a )?(pessoa|algu[ée]m|atendente|recepcionista|humano|gente)|algu[ée]m (pode )?me (ajud|atend)|quero falar com (uma |um )?(pessoa|algu[ée]m|gente)|atendimento humano|me transfere|chama (um|uma) (atendente|pessoa)/.test(t);
}

// Transfere a conversa pra um humano: pausa o bot, avisa o atendente (visual + WhatsApp)
// e manda a mensagem de "já estou chamando um atendente". Serve pra qualquer fluxo.
async function transferirParaAtendente(telefone, nome, empresa) {
  await pausarNumero(telefone);
  await CONVERSAS_COL().doc(`${empresaIdAtual()}__${telefone}`).set({ botPausado: true }, { merge: true }).catch(() => {});
  await avisarAtendente(telefone, nome, empresa);
  const prim = (nome || '').split(' ')[0] || 'você';
  await sendText(telefone, substituirVariaveis(empresa.posAtendente || EMPRESA_PADRAO.posAtendente, { nomeRecomendado: prim, recomendado: prim, empresa: empresa.nome }));
}

// URL de verdade (não data:) pra guardar e renderizar a mídia no painel — data
// URI (base64) não entra no Firestore (ficaria enorme), só link real.
function urlParaRegistro(s) {
  return (typeof s === 'string' && !s.startsWith('data:')) ? s : null;
}

async function sendImage(phone, imageUrl, caption) {
  if (tipoWppAtual() === 'oficial') {
    try {
      const cfg = oficialAtual();
      const d = dataUriParaBuffer(imageUrl);
      let image;
      if (d) { const id = await metaUploadMedia(cfg, d.buffer, d.mimetype, 'imagem'); image = { id, caption: caption || '' }; }
      else { image = { link: imageUrl, caption: caption || '' }; }
      const r = await axios.post(metaMessagesUrl(cfg), {
        messaging_product: 'whatsapp', to: soDigitos(phone), type: 'image', image
      }, { headers: metaHeaders(cfg) });
      console.log(`[IMAGEM ENVIADA/oficial] para ${phone}`);
      registrarMensagem({ empresaId: empresaIdAtual(), telefone: phone, direcao: 'out', texto: caption || '📷 Imagem', tipo: 'imagem', midiaUrl: urlParaRegistro(imageUrl), messageId: idMensagemMeta(r) });
    } catch (err) { console.error('Erro ao enviar imagem (Oficial):', err.response?.data || err.message); }
    return;
  }
  try {
    const cfg = zapiAtual();
    await axios.post(`${zapiBaseUrl(cfg)}/send-image`, {
      phone, image: imageUrl, caption: caption || ''
    }, { headers: zapiHeaders(cfg) });
    console.log(`[IMAGEM ENVIADA] para ${phone}`);
    registrarMensagem({ empresaId: empresaIdAtual(), telefone: phone, direcao: 'out', texto: caption || '📷 Imagem', tipo: 'imagem', midiaUrl: urlParaRegistro(imageUrl) });
  } catch (err) {
    console.error('Erro ao enviar imagem:', err.response?.data || err.message);
  }
}

async function sendDocument(phone, base64OrUrl, fileName, extension) {
  if (tipoWppAtual() === 'oficial') {
    try {
      const cfg = oficialAtual();
      const nomeArq = `${fileName || 'arquivo'}${extension ? '.' + extension : ''}`;
      const d = dataUriParaBuffer(base64OrUrl);
      let document;
      if (d) { const id = await metaUploadMedia(cfg, d.buffer, d.mimetype, nomeArq); document = { id, filename: nomeArq }; }
      else { document = { link: base64OrUrl, filename: nomeArq }; }
      const r = await axios.post(metaMessagesUrl(cfg), {
        messaging_product: 'whatsapp', to: soDigitos(phone), type: 'document', document
      }, { headers: metaHeaders(cfg) });
      console.log(`[DOCUMENTO ENVIADO/oficial] para ${phone}: ${nomeArq}`);
      registrarMensagem({ empresaId: empresaIdAtual(), telefone: phone, direcao: 'out', texto: `📎 ${fileName || 'Documento'}`, tipo: 'documento', midiaUrl: urlParaRegistro(base64OrUrl), messageId: idMensagemMeta(r) });
    } catch (err) { console.error('Erro ao enviar documento (Oficial):', err.response?.data || err.message); }
    return;
  }
  try {
    const cfg = zapiAtual();
    await axios.post(`${zapiBaseUrl(cfg)}/send-document/${extension}`, {
      phone, document: base64OrUrl, fileName
    }, { headers: zapiHeaders(cfg) });
    console.log(`[DOCUMENTO ENVIADO] para ${phone}: ${fileName}`);
    registrarMensagem({ empresaId: empresaIdAtual(), telefone: phone, direcao: 'out', texto: `📎 ${fileName || 'Documento'}`, tipo: 'documento', midiaUrl: urlParaRegistro(base64OrUrl) });
  } catch (err) {
    console.error('Erro ao enviar documento:', err.response?.data || err.message);
  }
}

// Áudio (mensagem de voz — ptt) e vídeo. Mesmo padrão de sendImage/sendDocument,
// cobrindo os 2 canais (Oficial/Z-API).
async function sendAudio(phone, audioUrl) {
  if (tipoWppAtual() === 'oficial') {
    try {
      const cfg = oficialAtual();
      const d = dataUriParaBuffer(audioUrl);
      let audio;
      if (d) { const id = await metaUploadMedia(cfg, d.buffer, d.mimetype || 'audio/ogg', 'audio'); audio = { id }; }
      else { audio = { link: audioUrl }; }
      const r = await axios.post(metaMessagesUrl(cfg), {
        messaging_product: 'whatsapp', to: soDigitos(phone), type: 'audio', audio
      }, { headers: metaHeaders(cfg) });
      console.log(`[AUDIO ENVIADO/oficial] para ${phone}`);
      registrarMensagem({ empresaId: empresaIdAtual(), telefone: phone, direcao: 'out', texto: '🎤 Áudio', tipo: 'audio', midiaUrl: urlParaRegistro(audioUrl), messageId: idMensagemMeta(r) });
    } catch (err) { console.error('Erro ao enviar áudio (Oficial):', err.response?.data || err.message); }
    return;
  }
  try {
    const cfg = zapiAtual();
    await axios.post(`${zapiBaseUrl(cfg)}/send-audio`, { phone, audio: audioUrl }, { headers: zapiHeaders(cfg) });
    console.log(`[AUDIO ENVIADO] para ${phone}`);
    registrarMensagem({ empresaId: empresaIdAtual(), telefone: phone, direcao: 'out', texto: '🎤 Áudio', tipo: 'audio', midiaUrl: urlParaRegistro(audioUrl) });
  } catch (err) {
    console.error('Erro ao enviar áudio:', err.response?.data || err.message);
  }
}

async function sendVideo(phone, videoUrl, caption) {
  if (tipoWppAtual() === 'oficial') {
    try {
      const cfg = oficialAtual();
      const d = dataUriParaBuffer(videoUrl);
      let video;
      if (d) { const id = await metaUploadMedia(cfg, d.buffer, d.mimetype || 'video/mp4', 'video'); video = { id, caption: caption || '' }; }
      else { video = { link: videoUrl, caption: caption || '' }; }
      const r = await axios.post(metaMessagesUrl(cfg), {
        messaging_product: 'whatsapp', to: soDigitos(phone), type: 'video', video
      }, { headers: metaHeaders(cfg) });
      console.log(`[VIDEO ENVIADO/oficial] para ${phone}`);
      registrarMensagem({ empresaId: empresaIdAtual(), telefone: phone, direcao: 'out', texto: caption || '🎬 Vídeo', tipo: 'video', midiaUrl: urlParaRegistro(videoUrl), messageId: idMensagemMeta(r) });
    } catch (err) { console.error('Erro ao enviar vídeo (Oficial):', err.response?.data || err.message); }
    return;
  }
  try {
    const cfg = zapiAtual();
    await axios.post(`${zapiBaseUrl(cfg)}/send-video`, { phone, video: videoUrl, caption: caption || '' }, { headers: zapiHeaders(cfg) });
    console.log(`[VIDEO ENVIADO] para ${phone}`);
    registrarMensagem({ empresaId: empresaIdAtual(), telefone: phone, direcao: 'out', texto: caption || '🎬 Vídeo', tipo: 'video', midiaUrl: urlParaRegistro(videoUrl) });
  } catch (err) {
    console.error('Erro ao enviar vídeo:', err.response?.data || err.message);
  }
}

// Envia um template APROVADO na Meta. Obrigatório pra INICIAR conversa com quem
// não te falou nas últimas 24h (ex.: o recomendado). Só existe no modo oficial.
// bodyParams: strings que preenchem {{1}}, {{2}}... do corpo do template.
// Retorna true se enviou por template; false se não estava em modo oficial (o
// chamador então segue com o envio de texto normal — Z-API).
async function sendTemplate(phone, templateName, bodyParams = [], lang = 'pt_BR', opts = {}) {
  if (tipoWppAtual() !== 'oficial') return false;
  const cfg = oficialAtual();
  const empresaId = empresaIdAtual();
  // Pré-pago: descobre a categoria (marketing/utility) e DEBITA antes de enviar.
  // Sem saldo → bloqueia (não envia). Empresa sem prepagoAtivo passa livre.
  const info = await getTemplateInfo(cfg, templateName);
  const categoria = (info && info.categoria) || 'marketing';
  const cobranca = await cobrarEnvioOficial(empresaId, categoria);
  if (!cobranca.permitido) {
    console.warn(`[PREPAGO] envio BLOQUEADO por saldo insuficiente — empresa=${empresaId} template=${templateName} (precisa ${cobranca.valorCentavos}c, saldo ${cobranca.saldoDepois}c)`);
    return false;
  }
  try {
    const components = bodyParams.length
      ? [{ type: 'body', parameters: bodyParams.map(t => ({ type: 'text', text: String(t) })) }]
      : [];
    const r = await axios.post(metaMessagesUrl(cfg), {
      messaging_product: 'whatsapp', to: soDigitos(phone), type: 'template',
      template: { name: templateName, language: { code: lang }, components }
    }, { headers: metaHeaders(cfg) });
    console.log(`[TEMPLATE ENVIADO/oficial] ${templateName} → ${phone}`);
    registrarMensagem({ empresaId, telefone: phone, direcao: 'out', texto: `[template: ${templateName}]`, messageId: idMensagemMeta(r), campanhaId: opts.campanhaId || null });
    return true;
  } catch (err) {
    console.error('Erro ao enviar template (Oficial):', err.response?.data || err.message);
    // Estorna a cobrança se o envio falhou (não cobra mensagem que não saiu).
    if (cobranca.valorCentavos > 0) {
      try { await creditarSaldo(empresaId, cobranca.valorCentavos, `Estorno — envio falhou (${templateName})`); } catch (e) {}
    }
    return false;
  }
}

// A janela de atendimento de 24h da API Oficial: abre/renova toda vez que o
// CONTATO manda uma mensagem pra gente (mensagens nossas não contam). Dentro
// dela, texto livre entrega normal — não precisa de template aprovado.
async function dentroJanela24h(telefone) {
  try {
    const doc = await CONVERSAS_COL().doc(`${empresaIdAtual()}__${telefone}`).get();
    if (!doc.exists) return false;
    const ultimaInboundEm = doc.data().ultimaInboundEm;
    if (!ultimaInboundEm) return false;
    return (Date.now() - new Date(ultimaInboundEm).getTime()) < 24 * 60 * 60 * 1000;
  } catch (e) {
    return false;
  }
}

// Envia como TEMPLATE (se estiver no modo oficial E houver um nome de template
// configurado) — funciona FORA da janela de 24h. Senão, manda texto livre (o
// comportamento de sempre, que só entrega dentro das 24h no oficial). Os `params`
// preenchem {{1}}, {{2}}... na ordem; a quantidade é ajustada ao template.
async function sendTextOuTemplate(telefone, textoLivre, templateName, params) {
  const tpl = templateName && String(templateName).trim();
  const temTextoLivre = (textoLivre || '').trim().length > 0;
  if (tpl && tipoWppAtual() === 'oficial') {
    // Ainda dentro da janela de 24h (o contato falou com a gente recentemente):
    // manda como conversa normal aberta, sem gastar/precisar do template — mais
    // natural e mais barato. O template só entra quando a janela já fechou.
    if (temTextoLivre && await dentroJanela24h(telefone)) {
      return await sendText(telefone, textoLivre);
    }
    let n = await getTemplateVarCount(oficialAtual(), tpl);
    if (n === null || n === undefined) n = (params || []).length;
    const enviou = await sendTemplate(telefone, tpl, (params || []).slice(0, n));
    if (enviou) return true;
    // Se o template falhou (ex.: sem saldo), NÃO cai pro texto livre no oficial —
    // texto livre fora da janela não entrega e ainda confundiria. Devolve false.
    return false;
  }
  // Sem template configurado pra essa mensagem: no oficial, texto livre só entrega
  // se a janela de 24h estiver aberta. Sem isso, ficava tentando e falhando (⚠️)
  // pra TODO mundo que nunca respondeu — que é justamente quem um follow-up
  // "ainda está por aí?" tenta alcançar. Sem janela e sem template = não dá pra
  // mandar nada; melhor pular com log claro do que insistir numa entrega impossível.
  if (tipoWppAtual() === 'oficial' && !(await dentroJanela24h(telefone))) {
    console.log(`[SEM-JANELA] ${telefone}: sem template configurado pra essa mensagem e fora da janela de 24h — não enviado. Configure um template pra essa etapa em Configurações > Follow-up — Sem resposta.`);
    return false;
  }
  return await sendText(telefone, textoLivre);
}

// ============================================================
// HELPER — converte link do Google Drive em link de download direto
// ============================================================

function converterLinkDrive(url) {
  if (!url) return url;
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/id=([a-zA-Z0-9_-]+)/);
  if (match && match[1]) {
    return `https://drive.google.com/uc?export=download&id=${match[1]}`;
  }
  return url;
}

// ============================================================
// HELPER — baixa o arquivo do voucher e devolve em base64
// ============================================================
// Por que isto existe: passar a URL do Google Drive direto pro Z-API
// não funciona — o link "uc?export=download" devolve uma PÁGINA HTML
// de aviso (não os bytes), então a imagem aparecia só como um card.
// Além disso, o link do Drive não tem extensão, então o tipo não dava
// pra adivinhar pela URL. Aqui o bot baixa o conteúdo real e detecta o
// tipo pelo content-type da resposta. Funciona com Drive, Firebase ou
// qualquer link direto.

async function baixarArquivo(url) {
  if (!url) return null;

  // Para links do Google Drive, monta as URLs que realmente servem bytes:
  // tenta o download direto e, se vier a página de aviso (HTML), cai para
  // o endpoint de miniatura, que sempre devolve uma imagem renderizável.
  const driveMatch = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  const candidatos = [];
  if (driveMatch && driveMatch[1]) {
    const id = driveMatch[1];
    candidatos.push(`https://drive.google.com/uc?export=download&id=${id}`);
    candidatos.push(`https://drive.google.com/thumbnail?id=${id}&sz=w2000`);
  } else {
    candidatos.push(url);
  }

  for (const candidato of candidatos) {
    try {
      const resp = await axios.get(candidato, {
        responseType: 'arraybuffer',
        maxRedirects: 5,
        timeout: 15000
      });
      const contentType = (resp.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      // Página de aviso do Drive vem como text/html — tenta o próximo candidato
      if (!contentType || contentType.startsWith('text/html')) continue;
      const base64 = Buffer.from(resp.data).toString('base64');
      return { contentType, base64 };
    } catch (err) {
      console.error(`Erro ao baixar arquivo (${candidato}):`, err.response?.status || err.message);
    }
  }
  return null;
}

// Baixa o voucher e o envia como imagem OU documento conforme o tipo REAL
// do arquivo (e não pela extensão da URL, que o Drive não fornece).
async function enviarVoucher(telefone, arquivoUrl, caption, premioNome) {
  const arquivo = await baixarArquivo(arquivoUrl);

  if (!arquivo) {
    // Não conseguiu baixar (link quebrado ou privado) — manda o link como
    // texto pra pessoa não ficar totalmente sem o voucher.
    console.error('[VOUCHER] Falha ao baixar arquivo, enviando link como texto:', arquivoUrl);
    await sendText(telefone, arquivoUrl);
    return;
  }

  const dataUri = `data:${arquivo.contentType};base64,${arquivo.base64}`;

  if (arquivo.contentType.startsWith('image/')) {
    await sendImage(telefone, dataUri, caption || '');
  } else {
    const extensao = arquivo.contentType.includes('pdf')
      ? 'pdf'
      : (arquivo.contentType.split('/')[1] || 'pdf');
    await sendDocument(telefone, dataUri, `Voucher - ${premioNome || 'presente'}`, extensao);
  }
}

// ============================================================
// PARSER DE VCARD
// ============================================================

function parseVCard(vCardString) {
  const nomeMatch = vCardString.match(/FN:(.*)/);
  const telMatch = vCardString.match(/waid=(\d+)/);
  return {
    nome: nomeMatch ? nomeMatch[1].trim() : 'Contato sem nome',
    telefone: telMatch ? telMatch[1].trim() : null
  };
}

// ============================================================
// IDEMPOTÊNCIA DO WEBHOOK — evita reprocessar a mesma mensagem
// ============================================================

async function jaProcessadaOuMarcar(messageId) {
  if (!messageId) return false;
  const ref = MENSAGENS_PROCESSADAS_COL().doc(messageId);
  const snap = await ref.get();
  if (snap.exists) return true;
  await ref.set({ processadoEm: new Date().toISOString() });
  return false;
}

function mensagemNaoEntendiPorEtapa(etapa, empresa) {
  if (etapa === 'aguardando_nome') {
    return 'Acho que não entendi essa última mensagem 🙂 Pra começar, qual é o seu nome?';
  }
  if (etapa === 'aguardando_vendedor') {
    const listaVendedores = empresa.vendedores.map((v, i) => `${i + 1}️⃣ ${v}`).join('\n');
    return `Não entendi essa última mensagem. Pode me dizer quem te atendeu hoje?\n\n${listaVendedores}\n\nResponda com o número ou o nome.`;
  }
  if (etapa === 'coletando_contatos') {
    return 'Acho que não entendi essa última mensagem 🙂 Pode mandar o contato direto da sua agenda? É só tocar em 📎 → Contato e escolher a pessoa.';
  }
  if (etapa === 'aguardando_autorizacao_proxima_faixa') {
    return 'Não entendi essa última mensagem. Você quer liberar o próximo prêmio? Pode responder com sim ou não.';
  }
  return null;
}

// ============================================================
// LÓGICA PRINCIPAL DO ROTEIRO DE NEUROVENDAS
// ============================================================

// Faixas de prêmio ATIVAS. O dono pode DESLIGAR as faixas extras (2ª em diante)
// pra dar só o 1º prêmio. A 1ª está SEMPRE ativa; as demais valem se ativa !== false.
function faixasAtivas(empresa) {
  const todas = (empresa && empresa.faixasBonus) || [];
  return todas.filter((f, i) => i === 0 || (f && f.ativa !== false));
}

async function iniciarConversa(telefone) {
  const empresa = await getEmpresa();
  const sessao = await getSessao(telefone);
  // Marca esta conversa como CLIENTE (recomendador) — usado pra separar Cliente
  // x Recomendado na aba Conversas. Se o mesmo número já tiver sido marcado
  // como Recomendado antes (raro — normalmente é gente diferente), prevalece
  // o papel mais recente.
  try { await CONVERSAS_COL().doc(`${empresaIdAtual()}__${telefone}`).set({ papel: 'cliente' }, { merge: true }); } catch (e) {}
  // Pipeline do cliente: entrou (leu o QR / mandou o gatilho).
  await upsertClientePipeline(telefone, null, 'iniciou');
  // A tela "Conversa do Cliente" anuncia {premio}/{quantidade} como variáveis
  // válidas em TODA a aba (inclusive nas Boas-vindas) — antes só {empresa} chegava
  // aqui, então quem usava {premio} na 1ª mensagem via o texto cru, sem substituir.
  const faixaBoasVindas = faixasAtivas(empresa)[0];
  const varsBoasVindas = { empresa: empresa.nome, premio: faixaBoasVindas ? faixaBoasVindas.premio : '', quantidade: faixaBoasVindas ? faixaBoasVindas.quantidade : '' };
  await sendText(telefone, substituirVariaveis(empresa.mensagemAgradecimento, varsBoasVindas));
  // Pergunta o nome primeiro; no modo Full, a explicação das 2 fases vem DEPOIS
  // que o cliente responde o nome (ver handler 'aguardando_nome') — mais natural.
  await sendText(telefone, substituirVariaveis(empresa.mensagemPedeNome || EMPRESA_PADRAO.mensagemPedeNome, varsBoasVindas));
  // Follow-up — Sem resposta (Cliente): agenda o 1º lembrete caso o cliente
  // nunca responda ao pedido de nome. Vazio na config = não agenda nada.
  await agendarProximoFollowupCliente(telefone, empresa, sessao.criadoEm, 0);
}

// Inicia a coleta de contatos (usado após o vendedor, OU direto após o nome
// quando a empresa não tem vendedores cadastrados).
async function iniciarColetaContatos(telefone, sessao, empresa) {
  sessao.etapa = 'coletando_contatos';
  sessao.indiceFaixaAtual = 0;
  sessao.contatosFaixaAtual = [];
  const marcaContatos = new Date().toISOString();
  sessao.ultimaAtividadeContatosEm = marcaContatos;
  await saveSessao(telefone, sessao);
  const primeiraFaixa = faixasAtivas(empresa)[0];
  const varsCliente = { nomeRecomendado: (sessao.clienteNome || '').split(' ')[0], empresa: empresa.nome, premio: primeiraFaixa.premio, quantidade: primeiraFaixa.quantidade };
  if (modoRecAtual(empresa) === 'full') {
    await sendText(telefone, substituirVariaveis(empresa.fullMensagemAvisoInicial || EMPRESA_PADRAO.fullMensagemAvisoInicial, varsCliente));
  }
  await sendText(telefone, substituirVariaveis(empresa.mensagemPedeContatos || EMPRESA_PADRAO.mensagemPedeContatos, varsCliente));
  await sendText(telefone, substituirVariaveis(empresa.mensagemColeta || EMPRESA_PADRAO.mensagemColeta, varsCliente));
  // Follow-up — Sem resposta (Cliente): agenda o 1º lembrete caso ele trave
  // aqui sem mandar nenhuma indicação. Vazio na config = não agenda nada.
  await agendarProximoFollowupClienteContatos(telefone, empresa, marcaContatos, 0);
}

// Serializa o processamento por número: se chegam 2 mensagens quase juntas do
// mesmo número (ex.: o cliente clica 2x no mesmo contato), a 2ª ESPERA a 1ª
// terminar e re-lê a sessão já atualizada — evita completar a faixa duas vezes
// e duplicar todas as mensagens (presente, link etc.).
const _filaMensagem = {};
function processarMensagem(telefone, texto, vCard, contatosMultiplos) {
  const anterior = _filaMensagem[telefone] || Promise.resolve();
  const atual = anterior.catch(() => {}).then(() => _processarMensagemInterno(telefone, texto, vCard, contatosMultiplos));
  _filaMensagem[telefone] = atual.finally(() => { if (_filaMensagem[telefone] === atual) delete _filaMensagem[telefone]; });
  return atual;
}

async function _processarMensagemInterno(telefone, texto, vCard, contatosMultiplos) {
  const empresa = await getEmpresa();
  const sessao = await getSessao(telefone);

  if (sessao.etapa === 'aguardando_nome') {
    sessao.clienteNome = (texto || '').trim();
    // Pipeline do cliente: deu o nome.
    await upsertClientePipeline(telefone, sessao.clienteNome, 'deu_nome');

    const temVendedores = empresa.vendedores && empresa.vendedores.length > 0;
    const perguntaVend = (empresa.mensagemPedeVendedor || '').trim();
    // Pula "quem te atendeu?" quando não há vendedores OU a frase está VAZIA (o dono
    // escolheu não perguntar — ex.: só tem recepcionista). Nesse caso o robô usa o
    // 1º vendedor cadastrado pra se apresentar ao recomendado. Se a frase estiver
    // preenchida, pergunta normalmente (com a lista de vendedores).
    if (!temVendedores || !perguntaVend) {
      sessao.vendedorNome = temVendedores ? empresa.vendedores[0] : null;
      await iniciarColetaContatos(telefone, sessao, empresa);
      return;
    }

    sessao.etapa = 'aguardando_vendedor';
    await saveSessao(telefone, sessao);

    const listaVendedores = empresa.vendedores.map((v, i) => `${i + 1}️⃣ ${v}`).join('\n');
    const faixaVend = faixasAtivas(empresa)[0];
    const perguntaVendedor = substituirVariaveis(perguntaVend || EMPRESA_PADRAO.mensagemPedeVendedor, {
      nomeRecomendado: sessao.clienteNome.split(' ')[0], empresa: empresa.nome,
      premio: faixaVend ? faixaVend.premio : '', quantidade: faixaVend ? faixaVend.quantidade : ''
    });
    await sendText(telefone, `${perguntaVendedor}\n\n${listaVendedores}\n\n👇 _Digita o número aqui_ 👇`);
    return;
  }

  if (sessao.etapa === 'aguardando_vendedor') {
    const escolha = (texto || '').trim();
    let vendedor = null;

    const numeroEscolhido = parseInt(escolha);
    if (!isNaN(numeroEscolhido) && empresa.vendedores[numeroEscolhido - 1]) {
      vendedor = empresa.vendedores[numeroEscolhido - 1];
    } else {
      vendedor = empresa.vendedores.find(v => v.toLowerCase().includes(escolha.toLowerCase()));
    }

    if (!vendedor) {
      await sendText(telefone, 'Não encontrei esse vendedor 😊\n\n👇 _Digita o número aqui_ 👇');
      return;
    }

    sessao.vendedorNome = vendedor;
    await iniciarColetaContatos(telefone, sessao, empresa);
    return;
  }

  if (sessao.etapa === 'coletando_contatos') {
    let novosContatos = [];

    if (contatosMultiplos && contatosMultiplos.length > 0) {
      // Exige telefone válido (não só nome) — um contato sem telefone conta na
      // faixa mas nunca é chamado depois (silenciosamente), fazendo parecer que
      // o disparo "sumiu". Loga pra aparecer no log se algum contato vier quebrado.
      novosContatos = contatosMultiplos.filter(c => {
        const ok = c && c.nome && c.telefone && soDigitos(c.telefone).length >= 10;
        if (c && c.nome && !ok) console.warn(`[CONTATO-INVALIDO] "${c.nome}" descartado — telefone ausente/curto: "${c.telefone}"`);
        return ok;
      });
    } else if (vCard) {
      const c = parseVCard(vCard);
      if (c && c.nome) novosContatos = [c];
    } else if (texto) {
      const matchTelefone = texto.match(/\+?\d[\d\s().-]{8,15}\d/);
      const ehUrlOuCodigo = /https?:\/\/|\.com|\.br\//.test(texto);

      if (matchTelefone && !ehUrlOuCodigo) {
        const telefoneCru = matchTelefone[0].replace(/[^\d]/g, '');
        const telefoneValido = telefoneCru.length >= 10 && telefoneCru.length <= 13;
        const tamanhoPlausivel = texto.length <= telefoneCru.length + 60;

        if (telefoneValido && tamanhoPlausivel) {
          const nome = texto.replace(matchTelefone[0], '').replace(/[-,]/g, ' ').trim();
          novosContatos = [{
            nome: nome || 'Contato sem nome',
            telefone: telefoneCru
          }];
        }
      }
    }

    // Dedup por telefone: ignora contato que já foi coletado (cliente mandou o
    // mesmo 2x) e repetidos dentro do próprio lote — senão conta em dobro na faixa.
    if (novosContatos.length > 0) {
      const jaColetados = new Set((sessao.contatos || []).map(c => soDigitos(c && c.telefone)).filter(Boolean));
      novosContatos = novosContatos.filter(c => {
        const tel = soDigitos(c && c.telefone);
        if (tel && jaColetados.has(tel)) return false;
        if (tel) jaColetados.add(tel);
        return true;
      });
    }

    if (novosContatos.length > 0) {
      const faixaAtual = faixasAtivas(empresa)[sessao.indiceFaixaAtual];
      const contatosFaixaAtual = [...(sessao.contatosFaixaAtual || []), ...novosContatos];

      sessao.contatos = [...(sessao.contatos || []), ...novosContatos];

      if (contatosFaixaAtual.length < faixaAtual.quantidade) {
        sessao.contatosFaixaAtual = contatosFaixaAtual;
        // Reancora o follow-up "sem enviar contatos": ele acabou de mandar um,
        // então reinicia a régua a partir daqui — não faz sentido cutucar quem
        // já está respondendo.
        const marcaContatos = new Date().toISOString();
        sessao.ultimaAtividadeContatosEm = marcaContatos;
        await saveSessao(telefone, sessao);
        await agendarProximoFollowupClienteContatos(telefone, empresa, marcaContatos, 0);

        const faltam = faixaAtual.quantidade - contatosFaixaAtual.length;
        const nomesAdicionados = novosContatos.map(c => c.nome).join(', ');
        await sendText(telefone, `Anotado, ${nomesAdicionados}! ✅ Faltam ${faltam} recomendações para você garantir "${faixaAtual.premio}". Quem mais vem na sua mente?`);
      } else {
        const contatosDestaFaixa = contatosFaixaAtual.slice(0, faixaAtual.quantidade);
        const excedente = contatosFaixaAtual.slice(faixaAtual.quantidade);

        sessao.contatosFaixaAtual = [];
        await finalizarFaixa(telefone, sessao, faixaAtual, empresa, contatosDestaFaixa, excedente);
      }
    } else {
      await sendText(telefone, 'Não consegui identificar um contato aí. Pode mandar o contato direto da sua agenda? É só tocar em 📎 → Contato e escolher a pessoa. 🙂');
    }
    return;
  }

  if (sessao.etapa === 'aguardando_intervalo_proxima_faixa') {
    // Janela curta entre entregar o presente e perguntar o próximo prêmio (a
    // pergunta vem por agendamento). Não avança faixa aqui: o "ok"/"combinado"
    // que o cliente manda é resposta à mensagem anterior (avisar os amigos).
    return;
  }

  if (sessao.etapa === 'aguardando_autorizacao_proxima_faixa') {
    if (respostaEhPositiva(texto)) {
      const proximoIndice = sessao.indiceFaixaAtual + 1;
      const proximaFaixa = faixasAtivas(empresa)[proximoIndice];
      const excedentePendente = sessao.excedentePendente || [];

      sessao.indiceFaixaAtual = proximoIndice;
      sessao.contatosFaixaAtual = excedentePendente;
      sessao.excedentePendente = [];
      sessao.etapa = 'coletando_contatos';

      if (excedentePendente.length >= proximaFaixa.quantidade) {
        const contatosDestaFaixa = excedentePendente.slice(0, proximaFaixa.quantidade);
        const novoExcedente = excedentePendente.slice(proximaFaixa.quantidade);
        sessao.contatosFaixaAtual = [];
        await finalizarFaixa(telefone, sessao, proximaFaixa, empresa, contatosDestaFaixa, novoExcedente);
      } else {
        const marcaContatos = new Date().toISOString();
        sessao.ultimaAtividadeContatosEm = marcaContatos;
        await saveSessao(telefone, sessao);
        const faltam = proximaFaixa.quantidade - excedentePendente.length;
        await sendText(telefone, `Show! Faltam ${faltam} recomendações para você garantir "${proximaFaixa.premio}". Quem mais vem na sua mente?`);
        // Nova faixa, mesma trava possível — agenda o follow-up de novo.
        await agendarProximoFollowupClienteContatos(telefone, empresa, marcaContatos, 0);
      }
    } else {
      sessao.excedentePendente = [];
      sessao.etapa = 'finalizado';
      await saveSessao(telefone, sessao);
      await sendText(telefone, 'Sem problemas! Muito obrigado(a) por participar e por confiar na gente 🙏');
      // Basic com confirmação: o cliente parou aqui → pede a confirmação (menu 1/2/3)
      // pra disparar os contatos que ficaram segurados — mas com uma espera pra dar
      // tempo dele avisar as amigas antes (não vir grudado no "muito obrigado").
      if (empresa.basicConfirmarAntesDisparo) await agendarPedirConfirmacaoBasic(telefone, sessao, empresa);
    }
    return;
  }

  // MODO FULL — passo 2: aguardando o cliente confirmar que encaminhou o link.
  if (sessao.etapa === 'aguardando_confirmacao_envio') {
    const t = (texto || '').toLowerCase();
    const confirmou = /envie|enviei|mandei|encaminhei|repassei|pronto|feito|j[áa] mandei|\bsim\b|\bok\b/.test(t);
    if (confirmou) {
      const faixa = sessao.premioPendente || {};
      await sendText(telefone, '🎉 Recebido! Aqui está o seu presente:');
      if (faixa.arquivo) await enviarVoucher(telefone, faixa.arquivo, faixa.premio, faixa.premio);
      else if (faixa.premio) await sendText(telefone, faixa.premio);
      if (faixa.texto) await sendText(telefone, faixa.texto);
      if (faixa.link) await sendText(telefone, faixa.link);
      // Pipeline do cliente: só agora o presente foi entregue de verdade (modo
      // Full segura até essa confirmação) — mesmo carimbo do fluxo normal.
      await upsertClientePipeline(telefone, sessao.clienteNome, 'recebeu_premio');
      sessao.etapa = 'finalizado';
      sessao.premioPendente = null;
      await saveSessao(telefone, sessao);
      await cancelarConfirmacoesEnvioFull(telefone); // confirmou → para de cobrar
      await sendText(telefone, 'Muito obrigado(a) por participar! 🙏 Assim que seus amigos resgatarem, eu te aviso 😊');
    } else {
      await sendText(telefone, 'Assim que você encaminhar a mensagem pros amigos, me manda um *"enviei"* aqui que eu solto seu presente na hora 🎁');
    }
    return;
  }

  if (sessao.etapa === 'finalizado') {
    // Enquanto o cliente está na fase de "avisar os amigos" (a espera de ~2 min ANTES
    // do menu 1/2/3, e o próprio menu aguardando resposta), a IA de atendimento NÃO
    // responde — senão um "belesa"/"ok" solto vira um "oi, como posso ajudar?" doido no
    // meio do fluxo. Ela só entra quando essa confirmação já acabou.
    const naConfirmacaoAvisar = sessao.aguardandoConfirmacaoDisparo || sessao.aguardandoIntervaloConfirmacao;
    // Conversa já terminou. Se o atendimento pós-fluxo estiver ligado, tenta
    // responder dúvidas do cliente (endereço, horário, etc.) com as infos do negócio.
    if (empresa.infoAtendimentoAtivo && texto && !naConfirmacaoAvisar && !ehFechamentoConversa(texto)) {
      let resposta = await responderPerguntaNegocio(texto, empresa);
      // A IA sinaliza com ##TRANSFERIR## quando não consegue responder → chama humano.
      if (resposta && /##TRANSFERIR##/.test(resposta)) {
        resposta = resposta.replace(/##TRANSFERIR##/g, '').trim();
        if (resposta) await sendText(telefone, resposta);
        await transferirParaAtendente(telefone, sessao.clienteNome, empresa);
      } else if (resposta) {
        await sendText(telefone, resposta);
      }
    }
    return;
  }
}

// Modo de recomendação vigente.
// API OFICIAL = SEMPRE direto ('basic'): não há risco de ban (envio compliant via
// template aprovado), então o robô fala com cada amigo direto. O fluxo Full (link
// que o cliente encaminha) NÃO se aplica no oficial — decisão do Alexandre 2026-07-29
// ("só vamos usar a api oficial, não vai existir mais o basic vs full"). A estratégia
// de "confirmar antes de disparar" fica no card "Avisar os amigos" (basicConfirmar...).
// Fora do oficial (Z-API), respeita a escolha Basic/Full do painel.
function modoRecAtual(empresa) {
  if (empresa && empresa.whatsappTipo === 'oficial') return 'basic';
  const m = empresa && empresa.modoRecomendacao;
  return (m === 'full' || m === 'official') ? 'full' : 'basic';
}

// Conta quantas variáveis ({{1}}, {{2}}...) o corpo do template aprovado tem —
// pra mandar EXATAMENTE essa quantidade de parâmetros (a Meta rejeita se sobrar
// ou faltar). Assim o dono pode criar template com 1, 2 ou 3 variáveis à vontade.
// Cacheia por (waba, template) por 1h. Null = não conseguiu descobrir.
// Busca o template aprovado na Meta e devolve { n: nº de variáveis, categoria:
// 'marketing'|'utility'|'authentication' }. Usado pra (1) mandar a qtd certa de
// parâmetros e (2) precificar o disparo no pré-pago. Cacheia por (waba, template) 1h.
const _templateInfoCache = {};
async function getTemplateInfo(oficial, templateName) {
  if (!oficial || !oficial.wabaId || !oficial.token || !templateName) return null;
  const key = oficial.wabaId + '|' + templateName;
  const cache = _templateInfoCache[key];
  if (cache && (Date.now() - cache.em) < 60 * 60 * 1000) return cache.info;
  try {
    const resp = await axios.get(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/${oficial.wabaId}/message_templates`,
      { params: { name: templateName }, headers: { Authorization: `Bearer ${oficial.token}` }, timeout: 6000 }
    );
    const arr = (resp.data && resp.data.data) || [];
    const tpl = arr.find(t => t.name === templateName) || arr[0];
    if (!tpl) return null;
    const body = (tpl.components || []).find(c => String(c.type || '').toUpperCase() === 'BODY');
    const txt = (body && body.text) || '';
    const nums = (txt.match(/\{\{\s*(\d+)\s*\}\}/g) || []).map(m => parseInt(m.replace(/\D/g, ''), 10));
    const n = nums.length ? Math.max(...nums) : 0;
    const categoria = String(tpl.category || 'MARKETING').toLowerCase();
    // Idioma real aprovado na Meta (ex.: "en_US" pro hello_world de exemplo) — o
    // botão de teste mandava sempre 'pt_BR' fixo, então testar um template que
    // não é português (ex.: o hello_world de amostra) sempre dava "does not
    // exist in pt_BR", mesmo o template existindo — só existia noutro idioma.
    const info = { n, categoria, idioma: tpl.language || 'pt_BR' };
    _templateInfoCache[key] = { info, em: Date.now() };
    console.log(`[TEMPLATE-INFO] ${templateName}: ${n} variável(is), categoria=${categoria}`);
    return info;
  } catch (e) {
    console.warn('[TEMPLATE-INFO] falha ao buscar template:', e.response ? JSON.stringify(e.response.data).slice(0, 160) : e.message);
    return null;
  }
}
// Compat: só o nº de variáveis (usado pra fatiar os parâmetros do disparo).
async function getTemplateVarCount(oficial, templateName) {
  const info = await getTemplateInfo(oficial, templateName);
  return info ? info.n : null;
}

// ============================================================
// PRÉ-PAGO — saldo por empresa, débito por mensagem oficial, bloqueio no zero
// ============================================================
// Modelo: o dono (Alexandre) pluga o número oficial DELE pra clientes que ainda
// não têm Meta própria. Cada mensagem paga (template) desconta do saldo pré-pago
// da empresa. Cliente paga Pix → admin lança o saldo → o sistema debita sozinho.
// Só vale pra empresas com `prepagoAtivo` = true (as que têm Meta própria pagam
// direto a Meta e NÃO entram nessa cobrança).
const PRECO_MKT_PADRAO = 35;   // R$0,35 por mensagem de Marketing
const PRECO_UTIL_PADRAO = 5;   // R$0,05 por mensagem de Utility

function precoDaCategoria(empresa, categoria) {
  if (categoria === 'utility') return (empresa && empresa.precoUtilCentavos != null) ? empresa.precoUtilCentavos : PRECO_UTIL_PADRAO;
  // marketing (e qualquer outra) usa o preço de marketing (mais caro, seguro).
  return (empresa && empresa.precoMktCentavos != null) ? empresa.precoMktCentavos : PRECO_MKT_PADRAO;
}

// Debita o custo de UM envio oficial, de forma atômica. Retorna:
//   { permitido, valorCentavos, saldoDepois, semSaldo?, semCobranca?, gratis? }
// - categoria 'servico' (texto livre na janela 24h) = grátis, sempre permitido.
// - empresa sem prepagoAtivo = não cobra, sempre permitido.
// - saldo insuficiente = permitido:false (bloqueia o envio).
async function cobrarEnvioOficial(empresaId, categoria) {
  if (!empresaId || !db) return { permitido: true, valorCentavos: 0, semCobranca: true };
  if (categoria === 'servico') return { permitido: true, valorCentavos: 0, gratis: true };
  const ref = EMPRESAS_COL().doc(empresaId);
  try {
    const resultado = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const d = snap.exists ? snap.data() : {};
      if (!d.prepagoAtivo) return { permitido: true, valorCentavos: 0, semCobranca: true };
      const preco = precoDaCategoria(d, categoria);
      const saldo = d.saldoCentavos || 0;
      if (saldo < preco) return { permitido: false, valorCentavos: preco, saldoDepois: saldo, semSaldo: true };
      const novo = saldo - preco;
      tx.update(ref, { saldoCentavos: novo });
      return { permitido: true, valorCentavos: preco, saldoDepois: novo };
    });
    if (resultado.permitido && resultado.valorCentavos > 0) {
      try {
        await TRANSACOES_COL().add({
          empresaId, tipo: 'debito', valorCentavos: resultado.valorCentavos,
          saldoDepois: resultado.saldoDepois, categoria, motivo: `Mensagem oficial (${categoria})`,
          em: new Date().toISOString()
        });
      } catch (e) { console.warn('[PREPAGO] falha ao logar débito:', e.message); }
    }
    return resultado;
  } catch (e) {
    // Em falha de infra NÃO bloqueia (evita travar envio por erro do Firestore); loga.
    console.error('[PREPAGO] erro na cobrança:', e.message);
    return { permitido: true, valorCentavos: 0, erro: e.message, semCobranca: true };
  }
}

// Credita saldo (recarga via Pix lançada pelo admin, ou ESTORNO de envio que falhou).
async function creditarSaldo(empresaId, valorCentavos, motivo, por) {
  if (!empresaId || !valorCentavos || valorCentavos <= 0 || !db) return null;
  const ref = EMPRESAS_COL().doc(empresaId);
  const novo = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const saldo = (snap.exists && snap.data().saldoCentavos) || 0;
    const n = saldo + valorCentavos;
    tx.update(ref, { saldoCentavos: n });
    return n;
  });
  try {
    await TRANSACOES_COL().add({
      empresaId, tipo: 'credito', valorCentavos, saldoDepois: novo,
      motivo: motivo || 'Recarga', por: por || null, em: new Date().toISOString()
    });
  } catch (e) { console.warn('[PREPAGO] falha ao logar crédito:', e.message); }
  return novo;
}

// Descobre AUTOMATICAMENTE o número do WhatsApp conectado (Z-API) — pra montar o
// link do Full sem pedir na mão (o robô já está ligado num número, o sistema sabe qual).
// Cacheia em memória por empresa. Fallback: número salvo manualmente, se houver.
const _numeroConectadoCache = {};
// Guarda o número CONECTADO informado pelo webhook do Z-API (connectedPhone) —
// escreve no Firestore só quando muda (evita gravar a cada mensagem).
const _ultimoNumConectado = {};
async function salvarNumeroConectado(empresaId, numero) {
  if (!empresaId || !numero || _ultimoNumConectado[empresaId] === numero) return;
  _ultimoNumConectado[empresaId] = numero;
  _numeroConectadoCache[empresaId] = { numero, em: Date.now() };
  try {
    await EMPRESAS_COL().doc(empresaId).set({ configuracao: { numeroConectado: numero } }, { merge: true });
    console.log(`[NUM-CONECTADO] salvo do webhook: ${empresaId} → ${numero}`);
  } catch (e) { console.warn('salvarNumeroConectado:', e.message); }
}

async function getNumeroConectado(empresa) {
  const eid = empresaIdAtual();
  // 0) Modo Oficial: o número REAL é o da conta na Meta (display_phone_number),
  // não o numeroConectado que possa ter sobrado de uma sessão Z-API antiga.
  if (empresa && empresa.whatsappTipo === 'oficial') {
    const numOf = await getNumeroOficial(oficialDaEmpresa(empresa));
    if (numOf) return numOf;
  }
  // 1) Fonte MAIS confiável: número que o webhook do Z-API informou (connectedPhone).
  const doWebhook = String((empresa && empresa.numeroConectado) || '').replace(/\D/g, '') || null;
  if (doWebhook) return doWebhook;
  const cache = _numeroConectadoCache[eid];
  if (cache && (Date.now() - cache.em) < 60 * 1000 && cache.numero) return cache.numero;
  const fallback = String((empresa && empresa.numeroWhatsapp) || '').replace(/\D/g, '') || null;
  let numero = fallback;
  try {
    const cfg = zapiDaEmpresa(empresa);
    if (cfg && cfg.instanceId && cfg.token) {
      const resp = await axios.get(`${zapiBaseUrl(cfg)}/device`, { headers: zapiHeaders(cfg), timeout: 6000 });
      const d = resp.data || {};
      // Z-API pode devolver o número em vários campos, dependendo da versão.
      const p = String(
        d.phone || d.numero || d.number || d.connectedPhone || d.phoneNumber ||
        (d.device && (d.device.phone || d.device.wid)) ||
        (d.value && d.value.phone) || (d.info && d.info.phone) || ''
      ).replace(/\D/g, '');
      console.log(`[NUM-CONECTADO] ${eid} device=${JSON.stringify(d).slice(0,180)} → phone=${p || '(vazio)'} fallback=${fallback}`);
      if (p) numero = p;
    }
  } catch (e) { console.warn(`[NUM-CONECTADO] ${eid} falha no /device:`, e.message, '→ usando fallback', fallback); }
  if (numero) _numeroConectadoCache[eid] = { numero, em: Date.now() };
  return numero;
}

// Link de resgate que o cliente encaminha (modo Full): o amigo toca e chama o
// número da empresa com um código de indicação (#r<código>). Null se não houver número.
function linkResgateFull(numero, telefoneRecomendador) {
  const num = String(numero || '').replace(/\D/g, '');
  if (!num) return null;
  const num55 = num.startsWith('55') ? num : '55' + num;
  const cod = codigoNicho('ref' + String(telefoneRecomendador)); // 4 chars opacos, reusa o hash
  const texto = `Olá! Quero resgatar meu presente 🎁 #r${cod}`;
  return `https://wa.me/${num55}?text=${encodeURIComponent(texto)}`;
}

// Referências do modo Full: código opaco (#r<cod>) → quem indicou. Assim, quando
// o amigo chega pelo link, a gente sabe atribuir a indicação ao cliente certo.
const REFS_COL = () => db.collection('recomendacao_refs');
function detectarResgateFull(texto) {
  if (!texto) return null;
  const m = String(texto).toLowerCase().match(/#r([a-z0-9]{4})\b/);
  return m ? m[1] : null;
}
async function buscarRefFull(code) {
  try {
    const snap = await REFS_COL().doc(`${empresaIdAtual()}__${code}`).get();
    return snap.exists ? snap.data() : null;
  } catch (e) { console.error('buscarRefFull:', e.message); return null; }
}
async function salvarRefFull(code, telefoneRecomendador, sessao) {
  try {
    await REFS_COL().doc(`${empresaIdAtual()}__${code}`).set({
      codigo: code, empresaId: empresaIdAtual(),
      telefoneRecomendador, nomeRecomendador: sessao.clienteNome || '',
      vendedorNome: sessao.vendedorNome || '',
      // Rede de lojas: sem isso, quando o amigo clica no link (chega com
      // "#r<código>", que não bate com frase-gatilho de oferta nenhuma), o
      // sistema não tem como saber de qual loja veio — e ele recebia sempre o
      // conteúdo da oferta Padrão, mesmo tendo sido indicado por alguém de
      // outra loja.
      ofertaId: sessao.ofertaId || null,
      criadoEm: new Date().toISOString()
    }, { merge: true });
  } catch (e) { console.error('salvarRefFull:', e.message); }
}

// Conclusão no modo FULL: NÃO dispara pros amigos e NÃO entrega o presente ainda.
// Manda o link pro cliente encaminhar e segura o presente até ele confirmar "enviei".
async function finalizarFaixaFull(telefone, sessao, faixa, empresa, contatosDestaFaixa) {
  await sendText(telefone, `🎉 Perfeito! Você completou ${contatosDestaFaixa.length} recomendações — falta só o último passo pra liberar seu presente!`);

  // Cria os leads (dado/atribuição no CRM) — mas NÃO dispara pros amigos.
  for (const contato of contatosDestaFaixa) {
    try {
      await criarLead({
        nomeRecomendado: contato.nome, telefoneRecomendado: contato.telefone,
        nomeRecomendador: sessao.clienteNome, telefoneRecomendador: telefone,
        vendedor: sessao.vendedorNome, empresaId: empresaIdAtual()
      });
    } catch (err) { console.error('Erro ao criar lead no CRM (full):', err.message); }
  }

  const primeiroNome = (sessao.clienteNome || '').split(' ')[0];
  const vars = { nomeRecomendado: primeiroNome, recomendador: primeiroNome, empresa: empresa.nome };
  await sendText(telefone, substituirVariaveis(empresa.fullMensagemPasso2 || EMPRESA_PADRAO.fullMensagemPasso2, vars));
  // Guarda a referência (código → quem indicou) pra atribuir quando o amigo chegar.
  await salvarRefFull(codigoNicho('ref' + telefone), telefone, sessao);
  const numeroLink = await getNumeroConectado(empresa); // descobre sozinho o número do robô
  const link = linkResgateFull(numeroLink, telefone);
  const msgEncaminhar = substituirVariaveis(empresa.fullMensagemEncaminhar || EMPRESA_PADRAO.fullMensagemEncaminhar, vars);
  await sendText(telefone, msgEncaminhar + (link ? `\n\n${link}` : ''));

  sessao.etapa = 'aguardando_confirmacao_envio';
  sessao.premioPendente = faixa;
  await saveSessao(telefone, sessao);
  // Começa a cobrar o "enviei" (lembretes editáveis) caso o cliente não confirme.
  try { await agendarConfirmacaoEnvioFull(telefone, empresa, 0); } catch (e) { console.error('agendarConfirmacaoEnvioFull:', e.message); }
}

// Agenda o disparo escalonado (anti-rajada) pros recomendados. Reutilizável:
// chamado na hora (Basic normal) ou depois da confirmação (Basic com confirmação).
async function dispararRecomendados(nomeRecomendador, vendedorNome, contatos, empresa, telefoneRecomendador) {
  // O atraso base + intervalo aleatório entre contatos existem só como anti-ban
  // pro Z-API (automação não-oficial, risco de shadow ban em rajada). Na API
  // Oficial o envio passa pelo canal oficial da Meta, sem esse risco — dispara
  // pra todo mundo imediatamente.
  const ehOficial = empresa.whatsappTipo === 'oficial';
  console.log(`[DISPARO] chamado: ${(contatos || []).length} contato(s) | empresa=${empresa.nome} | tempoEspera=${ehOficial ? 0 : (empresa.tempoEsperaConversaoMin || 0)}min | contatos=${JSON.stringify((contatos || []).map(c => c && c.telefone))}`);
  const baseMs = ehOficial ? 0 : Math.max(0, empresa.tempoEsperaConversaoMin || 0) * 60 * 1000;
  const gapMinMs = ehOficial ? 0 : Math.max(0, (empresa.recomendadoGapMinMin != null ? empresa.recomendadoGapMinMin : 3)) * 60 * 1000;
  const gapMaxMs = ehOficial ? 0 : Math.max(gapMinMs, (empresa.recomendadoGapMaxMin != null ? empresa.recomendadoGapMaxMin : 8) * 60 * 1000);
  let offsetMs = 0;
  for (const contato of (contatos || [])) {
    try {
      // Nunca contata quem se descadastrou (opt-out permanente).
      if (contato.telefone && await estaDescadastrado(contato.telefone)) {
        console.log(`[OPT-OUT] pulando ${contato.telefone} (descadastrado)`);
        continue;
      }
      const executarEm = new Date(Date.now() + baseMs + offsetMs).toISOString();
      if (contato.telefone) {
        const snapPendentes = await AGENDAMENTOS_COL()
          .where('status', '==', 'pendente').where('tipo', '==', 'iniciar_conversa_recomendado').get();
        const batch = db.batch();
        snapPendentes.forEach(doc => { if (doc.data().dados?.contato?.telefone === contato.telefone) batch.update(doc.ref, { status: 'cancelado' }); });
        await batch.commit();
      }
      await criarAgendamento({ tipo: 'iniciar_conversa_recomendado', executarEm, dados: { contato, nomeRecomendador, vendedorNome, telefoneRecomendador } });
      offsetMs += gapMinMs + Math.random() * (gapMaxMs - gapMinMs);
    } catch (err) { console.error('Erro ao agendar recomendado:', err.message); }
  }
}

// ---- Basic com CONFIRMAÇÃO — lembretes e detecção ----
function ehConfirmacaoDisparo(texto) {
  const t = (texto || '').toLowerCase().trim();
  // Negação primeiro: "ainda não avisei", "não pode" etc NÃO é confirmação.
  if (/\bn[ãa]o\b|ainda/.test(t)) return false;
  // "ok" solto NÃO conta (o cliente diz "ok"/"valeu" à toa e disparava sem querer).
  // Ele confirma com o número 1 (tratado à parte) ou "pode mandar"/"já avisei".
  return /pode mandar|pode enviar|pode chamar|pode sim|confirmo|avisei|mandei|enviei|enviado|encaminhei|encaminhado|^pode$|^sim$|^prontinho$|^pronto$|^feito$/.test(t);
}
async function agendarConfirmacaoDisparo(telefone, empresa, indice) {
  const cad = empresa.basicConfirmacaoCadencia || EMPRESA_PADRAO.basicConfirmacaoCadencia || [];
  const item = cad[indice];
  if (!item) return;
  const esperaMinUsado = Math.max(1, parseInt(item.esperaMin, 10) || 120);
  const executarEm = new Date(Date.now() + esperaMinUsado * 60000).toISOString();
  console.log(`[BASIC-CONFIRM] agendando lembrete indice=${indice} pra ${telefone}: esperaMin salvo=${item.esperaMin} (usado=${esperaMinUsado}) executarEm=${executarEm}`);
  await criarAgendamento({ tipo: 'confirmar_disparo', executarEm, dados: { telefone, indice } });
}
async function cancelarConfirmacoesDisparo(telefone) {
  try {
    const snap = await AGENDAMENTOS_COL().where('status', '==', 'pendente').where('tipo', '==', 'confirmar_disparo').get();
    const batch = db.batch(); let n = 0;
    snap.forEach(doc => {
      const d = doc.data();
      if ((d.dados && d.dados.telefone) === telefone && (d.empresaId || EMPRESA_ID_PDN) === empresaIdAtual()) { batch.update(doc.ref, { status: 'cancelado' }); n++; }
    });
    if (n) await batch.commit();
  } catch (e) { console.error('cancelarConfirmacoesDisparo:', e.message); }
}

// Basic com confirmação: envia o menu (1/2/3) e agenda os lembretes de cobrança.
async function pedirConfirmacaoDisparoBasic(telefone, sessao, empresa) {
  sessao.aguardandoConfirmacaoDisparo = true;
  await saveSessao(telefone, sessao);
  const nome = (sessao.clienteNome || '').split(' ')[0] || 'você';
  const varsC = { nomeRecomendado: nome, recomendador: nome, empresa: empresa.nome };
  await sendText(telefone, substituirVariaveis(empresa.basicConfirmMensagem || EMPRESA_PADRAO.basicConfirmMensagem, varsC));
  try { await agendarConfirmacaoDisparo(telefone, empresa, 0); } catch (e) { console.error('agendarConfirmacaoDisparo:', e.message); }
}
// Espera alguns minutos (avisarConfirmDelayMin, padrão 2) depois do "muito obrigado"
// antes de mandar o menu "avisar os amigos" (1/2/3), pra não vir grudado e dar tempo
// do cliente realmente avisar as amigas que recomendou.
async function agendarPedirConfirmacaoBasic(telefone, sessao, empresa) {
  const min = Math.max(1, parseInt(empresa.avisarConfirmDelayMin, 10) || EMPRESA_PADRAO.avisarConfirmDelayMin || 2);
  sessao.aguardandoIntervaloConfirmacao = true;
  await saveSessao(telefone, sessao);
  const executarEm = new Date(Date.now() + min * 60000).toISOString();
  await criarAgendamento({ tipo: 'pedir_confirmacao_basic', executarEm, dados: { telefone } });
}
// Agenda (com intervalo) a pergunta "quer liberar o próximo prêmio?", pra não
// encavalar com a mensagem anterior (o "combinado?" de avisar os amigos).
async function agendarPerguntaProximaFaixa(telefone, empresa) {
  const min = Math.max(1, parseInt(empresa.intervaloProximaFaixaMin, 10) || EMPRESA_PADRAO.intervaloProximaFaixaMin || 1);
  const executarEm = new Date(Date.now() + min * 60000).toISOString();
  await criarAgendamento({ tipo: 'perguntar_proxima_faixa', executarEm, dados: { telefone } });
}

// ---- Full: cobrança do "enviei" (cliente confirmar que encaminhou o link) ----
async function agendarConfirmacaoEnvioFull(telefone, empresa, indice) {
  const cad = empresa.fullConfirmacaoCadencia || EMPRESA_PADRAO.fullConfirmacaoCadencia || [];
  const item = cad[indice];
  if (!item) return;
  const executarEm = new Date(Date.now() + Math.max(1, parseInt(item.esperaMin, 10) || 120) * 60000).toISOString();
  await criarAgendamento({ tipo: 'confirmar_envio_full', executarEm, dados: { telefone, indice } });
}
async function cancelarConfirmacoesEnvioFull(telefone) {
  try {
    const snap = await AGENDAMENTOS_COL().where('status', '==', 'pendente').where('tipo', '==', 'confirmar_envio_full').get();
    const batch = db.batch(); let n = 0;
    snap.forEach(doc => {
      const d = doc.data();
      if ((d.dados && d.dados.telefone) === telefone && (d.empresaId || EMPRESA_ID_PDN) === empresaIdAtual()) { batch.update(doc.ref, { status: 'cancelado' }); n++; }
    });
    if (n) await batch.commit();
  } catch (e) { console.error('cancelarConfirmacoesEnvioFull:', e.message); }
}

async function finalizarFaixa(telefone, sessao, faixa, empresa, contatosDestaFaixa, excedente) {
  // Pipeline do cliente: recomendou (completou uma faixa) — guarda a lista completa
  // de amigos indicados (sessao.contatos) pra o CRM mostrar todos, mesmo os pendentes.
  await upsertClientePipeline(telefone, sessao.clienteNome, 'recomendou', sessao.contatos || contatosDestaFaixa);
  // MODO FULL: caminho próprio (inbound) — segura presente e não dispara pros amigos.
  if (modoRecAtual(empresa) === 'full') {
    await finalizarFaixaFull(telefone, sessao, faixa, empresa, contatosDestaFaixa);
    return;
  }
  await sendText(telefone, `🎉 Perfeito! Você completou ${contatosDestaFaixa.length} recomendações.`);
  await sendText(telefone, `🎁 Aqui está o seu presente:`);

  // Ordem congruente: presente (imagem) → mensagem de orientação → link
  if (faixa.arquivo) {
    await enviarVoucher(telefone, faixa.arquivo, faixa.premio, faixa.premio);
    // A mídia (imagem/PDF) demora pra ser processada e entregue pelo WhatsApp — sem
    // esse respiro o texto de orientação ("clique no link abaixo") CHEGA ANTES da
    // imagem. Espera um pouco pra garantir que a imagem apareça primeiro.
    await new Promise(r => setTimeout(r, 2500));
  } else {
    await sendText(telefone, faixa.premio);
  }

  if (faixa.texto) {
    await sendText(telefone, faixa.texto);
  }

  if (faixa.link) {
    await sendText(telefone, faixa.link);
  }

  // Pipeline do cliente: só avança pra "recebeu o prêmio" AQUI, depois que o
  // voucher/presente já foi mandado de verdade — não lá em cima (onde só marca
  // "recomendou", ao completar a faixa, antes de qualquer coisa ser entregue).
  await upsertClientePipeline(telefone, sessao.clienteNome, 'recebeu_premio');

  const msgValidarAmigo = empresa.mensagemValidarAmigo ?? EMPRESA_PADRAO.mensagemValidarAmigo;
  if (msgValidarAmigo && msgValidarAmigo.trim()) {
    await sendText(telefone, substituirVariaveis(msgValidarAmigo, {
      nomeRecomendado: (sessao.clienteNome || '').split(' ')[0],
      empresa: empresa.nome
    }));
  }

  // OBS: o lead (card no CRM) NÃO é criado aqui. Ele nasce só quando o robô
  // realmente manda a mensagem pro amigo (em iniciarConversaRecomendado), pra o
  // card não aparecer enquanto ainda estamos conversando com o recomendador.

  // Agenda o follow-up do recomendador (só uma vez, no 1º prêmio completado):
  // ele já mandou recomendações, então começa a série de lembretes pra avisar
  // os amigos. Só agenda se o recurso estiver ligado no painel.
  // NÃO roda junto com o Basic+confirmação: os dois pedem "avise seus amigos"
  // e encavalariam as mensagens (o Basic+confirmação já cobra isso com cadência).
  if (empresa.followupRecomendadorAtivo && !sessao.followupRecomendadorAgendado && !empresa.basicConfirmarAntesDisparo) {
    sessao.followupRecomendadorAgendado = true;
    try { await agendarFollowupRecomendador(telefone, empresa, 0); } catch (e) { console.error('agendarFollowupRecomendador:', e.message); }
  }

  // Basic com CONFIRMAÇÃO: acumula os contatos e NÃO dispara agora — segura até
  // o cliente confirmar. Só começa a pedir confirmação quando não há mais faixas.
  const gated = empresa.basicConfirmarAntesDisparo;
  if (gated) {
    sessao.contatosPendentesDisparo = [...(sessao.contatosPendentesDisparo || []), ...contatosDestaFaixa];
  }

  const proximaFaixa = faixasAtivas(empresa)[sessao.indiceFaixaAtual + 1];

  if (!proximaFaixa) {
    sessao.etapa = 'finalizado';
    sessao.faixaFinal = faixa;
    await saveSessao(telefone, sessao);
    await sendText(telefone, 'Muito obrigado(a) por participar e por confiar na gente! 🙏');
    // Basic com confirmação: agora sim pede a confirmação (menu 1/2/3) pra disparar os
    // contatos segurados — mas com uma espera (avisarConfirmDelayMin, padrão 2 min) pra
    // não vir grudado no "muito obrigado" e dar tempo do cliente avisar as amigas.
    if (gated) await agendarPedirConfirmacaoBasic(telefone, sessao, empresa);
  } else {
    // Monta a pergunta do próximo prêmio, mas NÃO envia agora — agenda com intervalo
    // (≥1 min) pra não encavalar com o aviso anterior de avisar os amigos.
    let pergunta;
    if (excedente.length > 0) {
      const palavraContato = excedente.length === 1 ? 'contato' : 'contatos';
      pergunta = `E olha, você já mandou ${excedente.length} ${palavraContato} a mais! Quer completar mais ${proximaFaixa.quantidade - excedente.length} recomendações e ganhar "${proximaFaixa.premio}"?`;
    } else {
      const incremento = proximaFaixa.quantidade - faixa.quantidade;
      pergunta = `Quer liberar o próximo prêmio? São +${incremento} recomendações e o prêmio é "${proximaFaixa.premio}". Quer continuar?`;
    }
    sessao.etapa = 'aguardando_intervalo_proxima_faixa';
    sessao.excedentePendente = excedente;
    sessao.proximaFaixaPergunta = pergunta;
    await saveSessao(telefone, sessao);
    try { await agendarPerguntaProximaFaixa(telefone, empresa); } catch (e) { console.error('agendarPerguntaProximaFaixa:', e.message); }
  }

  // Disparo pros recomendados: no Basic normal, sai agora (escalonado/anti-rajada).
  // No Basic-com-confirmação, NÃO sai agora — só depois do cliente confirmar.
  if (!gated) {
    await dispararRecomendados(sessao.clienteNome, sessao.vendedorNome, contatosDestaFaixa, empresa, telefone);
  }

  console.log(`[FAIXA FINALIZADA] ${sessao.clienteNome} via ${sessao.vendedorNome} — ${contatosDestaFaixa.length} contatos${gated ? ' (segurando p/ confirmação)' : ''}, ${excedente.length} excedentes pendentes`);
}

// ============================================================
// ROTEIRO DO RECOMENDADO — etapas com confirmação e cadência
// ============================================================

function substituirVariaveis(template, variaveis) {
  if (!template) return '';
  const v = variaveis || {};
  // Mapa de variáveis aceitas (case-insensitive) com apelidos amigáveis,
  // pra perdoar variações que o usuário escreva no painel.
  const mapa = {
    nomerecomendado: v.nomeRecomendado, nome: v.nomeRecomendado, recomendado: v.nomeRecomendado, cliente: v.nomeRecomendado,
    recomendador: v.recomendador, amigo: v.recomendador, recomendou: v.recomendador,
    vendedor: v.vendedor, atendente: v.vendedor, consultor: v.vendedor,
    empresa: v.empresa, negocio: v.empresa,
    premio: v.premio, dia: v.dia, periodo: v.periodo, quantidade: v.quantidade
  };
  return template.replace(/\{(\w+)\}/g, (match, chave) => {
    const val = mapa[chave.toLowerCase()];
    return (val != null && val !== '') ? val : match;
  });
}

async function getSessaoRecomendado(telefone) {
  const snap = await SESSOES_RECOMENDADO_COL().doc(chaveSessao(telefone)).get();
  return snap.exists ? snap.data() : null;
}

async function saveSessaoRecomendado(telefone, sessao) {
  await SESSOES_RECOMENDADO_COL().doc(chaveSessao(telefone)).set(sessao, { merge: true });
}

async function encerrarSessaoRecomendado(telefone) {
  await SESSOES_RECOMENDADO_COL().doc(chaveSessao(telefone)).delete();
}

// ============================================================
// SILÊNCIO NOTURNO (22h–08h, horário de Brasília) — nenhum follow-up PROATIVO
// sai nesse período, pra não queimar o lead denunciando mensagem de madrugada.
// Resposta a quem chama a gente primeiro NUNCA passa por aqui (só disparo
// agendado). Regra fixa pra toda empresa (não configurável ainda).
//
// Brasil não tem mais horário de verão desde 2019 — America/Sao_Paulo é sempre
// UTC-3, fixo o ano todo. Dá pra fazer a conta direto, sem lib de timezone: só
// deslocar o timestamp em 3h e ler os campos UTC do resultado.
// ============================================================
const OFFSET_BRASILIA_MS = 3 * 60 * 60 * 1000;
function paraBrasilia(data) { return new Date(data.getTime() - OFFSET_BRASILIA_MS); }
function deBrasiliaParaUTC(dataDeslocada) { return new Date(dataDeslocada.getTime() + OFFSET_BRASILIA_MS); }

// Tipos de agendamento que NÃO mandam mensagem pra um lead/cliente (avisam a
// própria equipe) — não faz sentido segurar isso até de manhã.
const AGENDAMENTOS_SEM_SILENCIO = new Set(['escalar_aviso_atendente']);

// Se `quandoISO` cai dentro do silêncio, empurra pro 08:00 de Brasília seguinte
// (mesmo dia se já passou da meia-noite, dia seguinte se ainda é noite) —
// contando a partir DAQUELE horário: quando esse agendamento disparar às 08:00
// e a cadência calcular o próximo passo, a espera já é medida a partir de lá.
function empurrarParaForaDoSilencio(quandoISO) {
  const b = paraBrasilia(new Date(quandoISO));
  const h = b.getUTCHours();
  if (h < 8) { b.setUTCHours(8, 0, 0, 0); return deBrasiliaParaUTC(b).toISOString(); }
  if (h >= 22) { b.setUTCDate(b.getUTCDate() + 1); b.setUTCHours(8, 0, 0, 0); return deBrasiliaParaUTC(b).toISOString(); }
  return quandoISO;
}

// ============================================================
// AGENDAMENTOS PERSISTIDOS — substituem setTimeout em memória
// ============================================================

async function criarAgendamento({ tipo, executarEm, dados, marcaTempoReferencia }) {
  const executarEmFinal = AGENDAMENTOS_SEM_SILENCIO.has(tipo) ? executarEm : empurrarParaForaDoSilencio(executarEm);
  const ctx = tenantContext.getStore();
  await AGENDAMENTOS_COL().add({
    tipo,
    executarEm: executarEmFinal,
    status: 'pendente',
    // Registra a empresa dona deste agendamento, pra que o follow-up depois
    // seja enviado pelo WhatsApp dela (e não pelo número global).
    empresaId: empresaIdAtual(),
    // Rede de lojas: qual oferta estava "no ar" quando isso foi agendado. Sem
    // isso, quando o job dispara minutos/horas depois — já fora do contexto
    // HTTP original — o executor não tinha como saber, e todo follow-up/
    // disparo agendado saía sempre com o conteúdo da oferta Padrão, nunca da
    // loja certa (ver aplicarOferta() em processarAgendamento).
    ofertaId: (ctx && ctx.empresa && ctx.empresa.ofertaId) || null,
    dados,
    marcaTempoReferencia: marcaTempoReferencia || null,
    criadoEm: new Date().toISOString()
  });
}

async function buscarAgendamentosVencidos() {
  const agora = new Date().toISOString();
  const snap = await AGENDAMENTOS_COL()
    .where('status', '==', 'pendente')
    .where('executarEm', '<=', agora)
    .get();
  const agendamentos = [];
  snap.forEach(doc => agendamentos.push({ id: doc.id, ...doc.data() }));
  return agendamentos;
}

async function marcarAgendamentoConcluido(id) {
  await AGENDAMENTOS_COL().doc(id).update({ status: 'concluido' });
}

async function agendarProximoFollowup(telefone, empresa, marcaTempo, indiceFollowup) {
  const cadencia = empresa.cadenciaFollowupRecomendado || [];
  const proximo = cadencia[indiceFollowup];
  if (!proximo) return;

  const executarEm = new Date(Date.now() + proximo.esperaMin * 60 * 1000).toISOString();
  await criarAgendamento({
    tipo: 'followup_recomendado',
    executarEm,
    marcaTempoReferencia: marcaTempo,
    dados: { telefone, indiceFollowup }
  });
}

// ---- Follow-up — Sem resposta (CLIENTE): nunca respondeu ao "qual é o seu
// nome?". `marcaTempo` é o `criadoEm` da sessão no momento do agendamento —
// só muda se a sessão for resetada (ver guard em processarAgendamentoInterno). ----
async function agendarProximoFollowupCliente(telefone, empresa, marcaTempo, indiceFollowup) {
  const cadencia = empresa.cadenciaFollowupClienteInicial || [];
  const proximo = cadencia[indiceFollowup];
  if (!proximo) return;

  const executarEm = new Date(Date.now() + proximo.esperaMin * 60 * 1000).toISOString();
  await criarAgendamento({
    tipo: 'followup_cliente_inicial',
    executarEm,
    marcaTempoReferencia: marcaTempo,
    dados: { telefone, indiceFollowup }
  });
}

// ---- Follow-up — Sem resposta (CLIENTE): já deu o nome mas trava pedindo as
// indicações ("coletando_contatos") sem mandar nenhuma. `marcaTempo` é
// `ultimaAtividadeContatosEm` — reancorado a cada vez que o cliente manda um
// contato (mesmo que ainda não complete a faixa), pra não cutucar quem já tá
// respondendo. Muda também se a etapa for além (faixa completa) ou resetar. ----
async function agendarProximoFollowupClienteContatos(telefone, empresa, marcaTempo, indiceFollowup) {
  const cadencia = empresa.cadenciaFollowupClienteContatos || [];
  const proximo = cadencia[indiceFollowup];
  if (!proximo) return;

  const executarEm = new Date(Date.now() + proximo.esperaMin * 60 * 1000).toISOString();
  await criarAgendamento({
    tipo: 'followup_cliente_contatos',
    executarEm,
    marcaTempoReferencia: marcaTempo,
    dados: { telefone, indiceFollowup }
  });
}

// ---- Follow-up do RECOMENDADOR (cliente que indicou) ----
// Agenda o lembrete de índice `indice` (0,1,2...) pedindo que ele avise os amigos.
async function agendarFollowupRecomendador(telefone, empresa, indice, extra) {
  const cadencia = empresa.cadenciaFollowupRecomendador || EMPRESA_PADRAO.cadenciaFollowupRecomendador || [];
  const item = cadencia[indice];
  if (!item) return;
  const esperaMin = Math.max(1, parseInt(item.esperaMin, 10) || 1440);
  const executarEm = new Date(Date.now() + esperaMin * 60 * 1000).toISOString();
  await criarAgendamento({
    tipo: 'followup_avisar_amigos',
    executarEm,
    dados: { telefone, indice, ...(extra || {}) }
  });
}

// Cancela lembretes pendentes de "avisar amigos" para um número (quando ele
// responde "já avisei", não faz sentido continuar lembrando).
async function cancelarFollowupsRecomendador(telefone) {
  try {
    const snap = await AGENDAMENTOS_COL()
      .where('status', '==', 'pendente')
      .where('tipo', '==', 'followup_avisar_amigos')
      .get();
    const batch = db.batch();
    let n = 0;
    snap.forEach(doc => {
      const d = doc.data();
      const mesmoTel = (d.dados && d.dados.telefone) === telefone;
      const mesmaEmpresa = (d.empresaId || EMPRESA_ID_PDN) === empresaIdAtual();
      if (mesmoTel && mesmaEmpresa) { batch.update(doc.ref, { status: 'cancelado' }); n++; }
    });
    if (n) await batch.commit();
  } catch (e) { console.error('cancelarFollowupsRecomendador:', e.message); }
}

// Trata a resposta do recomendador ao lembrete (1 já avisei / 2 ainda não /
// 3 me manda um texto pronto). Devolve true se reconheceu e respondeu.
async function tratarRespostaFollowupRecomendador(telefone, texto, sessao) {
  const empresa = await getEmpresa();
  const t = (texto || '').trim().toLowerCase();
  const primeiro = t.charAt(0);
  const primeiroNome = (sessao.clienteNome || '').split(' ')[0] || '';
  const vars = { nomeRecomendado: primeiroNome, recomendador: primeiroNome, empresa: empresa.nome };

  if (primeiro === '1' || t.includes('avisei')) {
    await sendText(telefone, substituirVariaveis(empresa.followupJaAvisei || EMPRESA_PADRAO.followupJaAvisei, vars));
    await saveSessao(telefone, { followupAguardando: false, followupConcluido: true });
    await cancelarFollowupsRecomendador(telefone);
    return true;
  }
  if (primeiro === '3' || t.includes('texto') || t.includes('pronto') || t.includes('modelo')) {
    await sendText(telefone, substituirVariaveis(empresa.followupTextoPronto || EMPRESA_PADRAO.followupTextoPronto, vars));
    await saveSessao(telefone, { followupAguardando: false });
    return true;
  }
  if (primeiro === '2' || t.includes('ainda')) {
    await sendText(telefone, substituirVariaveis(empresa.followupAindaNao || EMPRESA_PADRAO.followupAindaNao, vars));
    await saveSessao(telefone, { followupAguardando: false });
    return true;
  }
  return false;
}

// Anti-ban: sorteia uma das versões preenchidas da 1ª mensagem ao recomendado,
// pra não enviar texto idêntico a todo mundo (evita "impressão digital" de spam).
function escolherSaudacaoRecomendado(empresa) {
  const opcoes = [empresa.mensagemInicialRecomendado, empresa.mensagemInicialRecomendado2, empresa.mensagemInicialRecomendado3]
    .map(s => (s || '').trim()).filter(Boolean);
  if (!opcoes.length) return EMPRESA_PADRAO.mensagemInicialRecomendado;
  return opcoes[Math.floor(Math.random() * opcoes.length)];
}

async function iniciarConversaRecomendado(contato, nomeRecomendador, vendedorNome, empresa, telefoneRecomendador) {
  if (!contato.telefone) {
    console.log(`[AVISO] Contato "${contato.nome}" sem telefone válido — não foi possível iniciar conversa.`);
    return;
  }
  // Opt-out permanente: nunca reinicia conversa com quem se descadastrou.
  if (await estaDescadastrado(contato.telefone)) {
    console.log(`[OPT-OUT] ${contato.telefone} descadastrado — não inicia conversa.`);
    return;
  }
  // Marca esta conversa como RECOMENDADO (amigo indicado) — usado pra separar
  // Cliente x Recomendado na aba Conversas. Se o mesmo número já tiver sido
  // marcado como Cliente antes (raro — normalmente é gente diferente), prevalece
  // o papel mais recente.
  try { await CONVERSAS_COL().doc(`${empresa.id}__${contato.telefone}`).set({ papel: 'recomendado' }, { merge: true }); } catch (e) {}

  const primeiroNomeRecomendado = (contato.nome && contato.nome.trim() && contato.nome !== 'Contato sem nome')
    ? contato.nome.split(' ')[0]
    : 'você';
  const variaveis = {
    nomeRecomendado: primeiroNomeRecomendado,
    recomendado: primeiroNomeRecomendado,
    recomendador: nomeRecomendador.split(' ')[0],
    vendedor: vendedorNome,
    empresa: empresa.nome
  };

  const mensagemInicial = substituirVariaveis(escolherSaudacaoRecomendado(empresa), variaveis);
  // No modo OFICIAL, a primeira mensagem ao recomendado (que nunca te chamou)
  // precisa ser um TEMPLATE aprovado pela Meta. Params na ordem:
  // {{1}}=nome do recomendado, {{2}}=quem recomendou, {{3}}=vendedor.
  // (O nome da empresa entra como texto fixo no template — cada template é de
  //  uma empresa só. Sem vendedor cadastrado, {{3}} cai pro nome da empresa,
  //  mantendo compatível com templates antigos que usavam {{3}}=empresa.)
  // Fora do modo oficial (ou sem template configurado) segue como hoje.
  console.log(`[REC-INICIO] empresa=${empresa.nome} tel=${contato.telefone} tipo=${tipoWppAtual()} template=${empresa.oficialTemplateRecomendado || '(vazio)'}`);
  if (tipoWppAtual() === 'oficial' && empresa.oficialTemplateRecomendado) {
    const nomeVendedor = (vendedorNome && String(vendedorNome).trim()) || empresa.nome;
    // Ordem fixa dos parâmetros: {{1}} recomendado, {{2}} recomendador, {{3}} vendedor.
    const todosParams = [primeiroNomeRecomendado, nomeRecomendador.split(' ')[0], nomeVendedor];
    // Manda só quantas variáveis o template REALMENTE tem (evita erro de contagem
    // na Meta). Se não der pra descobrir, cai no padrão de 3 (comportamento antigo).
    let nVars = await getTemplateVarCount(oficialDaEmpresa(empresa), empresa.oficialTemplateRecomendado);
    if (nVars === null || nVars === undefined) nVars = 3;
    const params = todosParams.slice(0, Math.min(nVars, todosParams.length));
    const enviou = await sendTemplate(contato.telefone, empresa.oficialTemplateRecomendado, params);
    console.log(`[REC-INICIO] sendTemplate "${empresa.oficialTemplateRecomendado}" → ${contato.telefone} = ${enviou ? 'ENVIADO ✅' : 'FALHOU/BLOQUEADO ❌'} params=${JSON.stringify(params)}`);
    if (!enviou) await sendText(contato.telefone, mensagemInicial);
  } else {
    console.log(`[REC-INICIO] NAO-oficial ou SEM template → mandando TEXTO LIVRE pra ${contato.telefone} (fora das 24h isso NAO entrega no oficial)`);
    await sendText(contato.telefone, mensagemInicial);
  }

  const marcaTempo = new Date().toISOString();
  await saveSessaoRecomendado(contato.telefone, {
    etapa: 'aguardando_confirmacao',
    nomeRecomendado: contato.nome,
    telefoneRecomendado: contato.telefone,
    nomeRecomendador: nomeRecomendador,
    vendedorNome: vendedorNome,
    ofertaId: empresa.ofertaId || null,
    ultimaMensagemEm: marcaTempo,
    criadoEm: marcaTempo
  });

  await agendarProximoFollowup(contato.telefone, empresa, marcaTempo, 0);

  // Só AGORA cria o card no CRM (coluna "Recebeu Mensagem") — o amigo recebeu a
  // mensagem de fato. Antes o card nascia quando o cliente completava a faixa, o que
  // fazia o card aparecer enquanto o robô ainda conversava com o recomendador.
  try {
    await criarLead({
      nomeRecomendado: contato.nome,
      telefoneRecomendado: contato.telefone,
      nomeRecomendador: nomeRecomendador,
      telefoneRecomendador: telefoneRecomendador || null,
      vendedor: vendedorNome,
      empresaId: empresaIdAtual()
    });
  } catch (err) { console.error('Erro ao criar lead no CRM (recomendado):', err.message); }

  console.log(`[ROTEIRO RECOMENDADO INICIADO] ${contato.nome} (${contato.telefone})`);
}

// Modo direto (atendimento humano): manda 1 msg curta, avisa o vendedor e
// passa a conversa pro humano assumir em Conversas — usado tanto no modo
// 'antes' (não roda o presente) quanto no 'depois' (presente já entregue).
async function transferirRecomendadoParaAtendente(telefone, sessao, empresa) {
  const varsH = {
    nomeRecomendado: sessao.nomeRecomendado ? sessao.nomeRecomendado.split(' ')[0] : 'você',
    recomendado: sessao.nomeRecomendado ? sessao.nomeRecomendado.split(' ')[0] : 'você',
    recomendador: sessao.nomeRecomendador ? sessao.nomeRecomendador.split(' ')[0] : 'seu amigo',
    vendedor: sessao.vendedorNome || empresa.nome,
    empresa: empresa.nome
  };
  // SEM IA aqui — só o script fixo já definido, direto pro vendedor. Nada de
  // gerar/inventar texto: previsível, sem risco de responder algo fora do lugar.
  const msgH = substituirVariaveis(empresa.recomendadoHumanoMensagem ?? EMPRESA_PADRAO.recomendadoHumanoMensagem, varsH);
  if (msgH && msgH.trim()) await sendText(telefone, msgH);
  await saveSessaoRecomendado(telefone, { etapa: 'atendimento_humano', ultimaMensagemEm: new Date().toISOString() });
  await pausarNumero(telefone);           // robô para nesse contato
  // Revezamento: distribui entre os atendentes ONLINE (carrossel); se ninguém
  // assumir em 1 min, escala pro próximo. Só nesse fluxo (modo direto) — os
  // outros pontos de "pedir atendente" continuam indo pro atendente oficial único.
  await avisarAtendenteRevezamento(telefone, sessao.nomeRecomendado, empresa, [], 1);
  console.log(`[REC-HUMANO] ${telefone} passou pro atendimento humano (${empresa.nome})`);
}

async function enviarPremioRecomendado(telefone, sessao, empresa) {
  // Move o card para "Recebeu o Prêmio" assim que a pessoa aceita o presente.
  await marcarLeadRecebeuPremio(telefone, empresa);

  // Mensagem-ponte: enviada logo após a pessoa responder, antes do presente.
  const ponte = substituirVariaveis(empresa.mensagemAntesPresente ?? EMPRESA_PADRAO.mensagemAntesPresente, { ...variaveisRec(sessao, empresa), premio: empresa.premioRecomendado || 'seu presente' });
  if (ponte && ponte.trim()) await sendText(telefone, ponte);

  if (empresa.arquivoRecomendado) {
    await enviarVoucher(telefone, empresa.arquivoRecomendado, empresa.premioRecomendado || '', empresa.premioRecomendado || 'presente');
    // Respiro pra a imagem chegar ANTES do link/texto (mídia demora a ser entregue).
    await new Promise(r => setTimeout(r, 2500));
  }

  if (empresa.linkRecomendado) {
    await sendText(telefone, empresa.linkRecomendado);
  }

  if (empresa.textoRecomendado && empresa.textoRecomendado.trim()) {
    const orientacao = substituirVariaveis(empresa.textoRecomendado, { ...variaveisRec(sessao, empresa), premio: empresa.premioRecomendado || 'seu presente' });
    await sendText(telefone, orientacao);
  }

  // Modo direto "depois do presente": já entregou tudo acima (voucher/link/
  // texto), agora faz UMA pergunta-chave (se tiver) e transfere pro atendente
  // — tem prioridade sobre "entrega direta"/menu normal, porque a intenção
  // aqui é sempre cair num humano, com ou sem agendamento configurado.
  if (empresa.recomendadoAtendimentoHumano && empresa.recomendadoAtendimentoHumanoQuando === 'depois') {
    const pergunta = empresa.recomendadoPerguntaChave;
    if (pergunta && pergunta.trim()) {
      await sendText(telefone, substituirVariaveis(pergunta, variaveisRec(sessao, empresa)));
      await saveSessaoRecomendado(telefone, { etapa: 'aguardando_pergunta_chave', ultimaMensagemEm: new Date().toISOString() });
    } else {
      await transferirRecomendadoParaAtendente(telefone, sessao, empresa);
    }
    return;
  }

  // Entrega direta (presente físico/ebook): não tem o que agendar. Depois de entregar
  // o presente, só manda uma mensagem de fechamento e encerra (sem menu 1/2/3).
  if (empresa.presentePrecisaAgendamento === false) {
    const fecho = empresa.mensagemFechamentoEntrega ?? EMPRESA_PADRAO.mensagemFechamentoEntrega;
    if (fecho && fecho.trim()) await sendText(telefone, substituirVariaveis(fecho, { ...variaveisRec(sessao, empresa), premio: empresa.premioRecomendado || 'seu presente' }));
    await saveSessaoRecomendado(telefone, { etapa: 'finalizado', ultimaMensagemEm: new Date().toISOString() });
    return;
  }

  // Toque humano: reage ao presente e ESPERA a pessoa responder (ou X min) antes
  // do menu — pra não encavalar o presente com a pergunta de escolha.
  const conexao = empresa.posMensagemConexao ?? EMPRESA_PADRAO.posMensagemConexao;
  if (conexao && conexao.trim()) {
    await sendText(telefone, substituirVariaveis(conexao, variaveisRec(sessao, empresa)));
    await saveSessaoRecomendado(telefone, { etapa: 'aguardando_reacao_presente' });
    try { await agendarMenuAposReacao(telefone, empresa); } catch (e) { console.error('agendarMenuAposReacao:', e.message); }
  } else {
    // Sem mensagem de conexão: manda o menu direto (comportamento antigo).
    await enviarMenuEFollowupRec(telefone, sessao, empresa);
  }
}

// Manda o menu principal do recomendado + agenda o follow-up pós-presente.
async function enviarMenuEFollowupRec(telefone, sessao, empresa) {
  const marcaTempo = new Date().toISOString();
  await enviarMenuPrincipalRec(telefone, sessao, marcaTempo);
  await agendarProximoFollowup(telefone, empresa, marcaTempo, 0);
}

// Agenda o menu pra depois da reação (caso a pessoa não responda ao "gostou?").
async function agendarMenuAposReacao(telefone, empresa) {
  const min = Math.max(1, parseInt(empresa.menuAposReacaoMin, 10) || EMPRESA_PADRAO.menuAposReacaoMin || 1);
  const executarEm = new Date(Date.now() + min * 60000).toISOString();
  await criarAgendamento({ tipo: 'menu_apos_reacao', executarEm, dados: { telefone } });
}
async function cancelarMenuAposReacao(telefone) {
  try {
    const snap = await AGENDAMENTOS_COL().where('status', '==', 'pendente').where('tipo', '==', 'menu_apos_reacao').get();
    const batch = db.batch(); let n = 0;
    snap.forEach(doc => {
      const d = doc.data();
      if ((d.dados && d.dados.telefone) === telefone && (d.empresaId || EMPRESA_ID_PDN) === empresaIdAtual()) { batch.update(doc.ref, { status: 'cancelado' }); n++; }
    });
    if (n) await batch.commit();
  } catch (e) { console.error('cancelarMenuAposReacao:', e.message); }
}

// Presente Recomendado com venda: quando o amigo indicado COMPRA (card movido
// para "Comprou"), envia o presente ao RECOMENDADOR (quem indicou). Deve rodar
// dentro do contexto da empresa (zapi correto).
async function enviarPresenteVendaAoRecomendador(lead, empresa) {
  const tel = lead.telefoneRecomendador;
  if (!tel) {
    console.warn('[VENDA] lead sem telefone do recomendador — presente não enviado');
    return false;
  }
  const vars = {
    recomendador: (lead.nomeRecomendador || '').split(' ')[0] || 'você',
    recomendado: (lead.nomeRecomendado || '').split(' ')[0] || 'seu amigo',
    nomeRecomendado: lead.nomeRecomendado || '',
    nomeRecomendador: lead.nomeRecomendador || '',
    empresa: empresa.nome || '',
    vendedor: lead.vendedor || empresa.nome || '',
    premio: empresa.premioVenda || ''
  };
  const msg = substituirVariaveis(empresa.mensagemVenda ?? EMPRESA_PADRAO.mensagemVenda, vars);
  // A venda pode acontecer dias depois (fora das 24h) → usa template no oficial (se configurado).
  // Params na ordem: {{1}} recomendador · {{2}} recomendado · {{3}} prêmio.
  if (msg && msg.trim()) await sendTextOuTemplate(tel, msg, empresa.oficialTemplateVenda, [vars.recomendador, vars.recomendado, empresa.premioVenda || '']);
  if (empresa.arquivoVenda) {
    await enviarVoucher(tel, empresa.arquivoVenda, empresa.premioVenda || '', empresa.premioVenda || 'presente');
    await new Promise(r => setTimeout(r, 2500)); // imagem chega antes do link/texto
  }
  if (empresa.linkVenda) await sendText(tel, empresa.linkVenda);
  if (empresa.textoVenda && empresa.textoVenda.trim()) {
    await sendText(tel, substituirVariaveis(empresa.textoVenda, vars));
  }
  console.log(`[VENDA] presente enviado ao recomendador ${tel} (indicou ${lead.nomeRecomendado})`);
  return true;
}

async function enviarCtaRecomendado(telefone, sessao, empresa) {
  await sendText(telefone, empresa.ctaRecomendado);
  await saveSessaoRecomendado(telefone, { etapa: 'aguardando_fechamento' });
  console.log(`[ROTEIRO RECOMENDADO - CTA ENVIADO, AGUARDANDO RESPOSTA FINAL] ${sessao.nomeRecomendado} (${telefone})`);
}

// ============================================================
// FLUXO PÓS-PRESENTE — menu por opções (visita / agendar / dúvidas)
// Estilo "responda 1/2/3" (igual à escolha do vendedor). Pronto para
// virar botão clicável quando ativarmos a API oficial do WhatsApp.
// ============================================================

function extrairOpcao(texto) {
  const m = (texto || '').trim().match(/([1-9])/);
  return m ? parseInt(m[1]) : null;
}

const PERIODOS_REC = { 1: 'manhã', 2: 'tarde', 3: 'noite' };

function variaveisRec(sessao, empresa) {
  return {
    nomeRecomendado: sessao && sessao.nomeRecomendado ? sessao.nomeRecomendado.split(' ')[0] : 'você',
    recomendado: sessao && sessao.nomeRecomendado ? sessao.nomeRecomendado.split(' ')[0] : 'você',
    recomendador: sessao && sessao.nomeRecomendador ? sessao.nomeRecomendador.split(' ')[0] : 'seu amigo',
    vendedor: (sessao && sessao.vendedorNome) || (empresa && empresa.nome) || '',
    empresa: (empresa && empresa.nome) || '',
    // Prêmio do recomendado: disponível em TODA mensagem pós-presente (menu,
    // "vou usar depois", dúvidas, lembrete...), pra que {premio} sempre puxe.
    premio: (empresa && empresa.premioRecomendado) || 'seu presente'
  };
}

async function enviarMenuPrincipalRec(telefone, sessao, marca) {
  const empresa = await getEmpresa();
  const texto = substituirVariaveis(empresa.posMenuPrincipal || EMPRESA_PADRAO.posMenuPrincipal, variaveisRec(sessao, empresa));
  await sendText(telefone, texto);
  await saveSessaoRecomendado(telefone, { etapa: 'menu_principal', ultimaMensagemEm: marca || new Date().toISOString() });
}

// Agenda a checagem de confirmação ~3 min após o agendamento. marcaTempoReferencia
// é o ultimaMensagemEm gravado junto com etapa:'finalizado' — se a sessão mudar
// antes do check disparar (reset, novo agendamento, etc.), o guard no executor
// detecta a divergência e não manda a mensagem à toa.
async function agendarCheckConfirmacao(telefone, marcaTempoReferencia) {
  const executarEm = new Date(Date.now() + 3 * 60 * 1000).toISOString();
  await criarAgendamento({ tipo: 'confirmar_agendamento_check', executarEm, marcaTempoReferencia, dados: { telefone } });
}

// Inicia o agendamento: se a empresa configurou um link de agendamento,
// manda o link e encerra; senão, segue o fluxo de período + dia pelo bot.
async function iniciarAgendamentoRec(telefone, empresa, sessao, fluxo) {
  if (empresa.linkAgendamento && empresa.linkAgendamento.trim()) {
    const intro = substituirVariaveis(
      empresa.posLinkAgendamento || EMPRESA_PADRAO.posLinkAgendamento,
      variaveisRec(sessao, empresa)
    );
    await sendText(telefone, intro);
    await sendText(telefone, empresa.linkAgendamento.trim());
    await registrarEscolhaNoLead(telefone, { agendamentoLink: empresa.linkAgendamento.trim(), agendamentoEm: new Date().toISOString() }, empresa, true);
    const marcaFinalizado = new Date().toISOString();
    await saveSessaoRecomendado(telefone, { etapa: 'finalizado', ultimaMensagemEm: marcaFinalizado });
    await agendarCheckConfirmacao(telefone, marcaFinalizado);
    return;
  }
  await enviarPerguntaPeriodoRec(telefone, empresa, fluxo);
}

async function enviarPerguntaPeriodoRec(telefone, empresa, fluxo) {
  const texto = substituirVariaveis((empresa && empresa.posPerguntaPeriodo) || EMPRESA_PADRAO.posPerguntaPeriodo, variaveisRec(null, empresa));
  await sendText(telefone, texto);
  await saveSessaoRecomendado(telefone, { etapa: 'agendar_periodo', fluxoAgendamento: fluxo || 'agora', ultimaMensagemEm: new Date().toISOString() });
}

// Cache da inferência de dias fechados por horário (não chama a IA toda vez —
// só quando o texto do horário muda). empresaId -> { chave, dias }.
const _diasFechadosCache = {};

// Lê o HORÁRIO cadastrado nas Informações do negócio e pede pra IA dizer quais dias
// da semana a empresa NÃO abre (ex.: "Seg a Sáb 9h-18h" → domingo fechado). O resultado
// é somado aos dias marcados na mão (diasFechados). Se não houver horário ou IA, volta [].
async function inferirDiasFechadosPorHorario(empresa) {
  const horario = ((empresa && (empresa.infoHorario || empresa.horariosEmpresa)) || '').trim();
  if (!horario || !ANTHROPIC_API_KEY) return [];
  const eid = (empresa && empresa.id) || empresaIdAtual();
  const chave = horario.toLowerCase();
  const cache = _diasFechadosCache[eid];
  if (cache && cache.chave === chave) return cache.dias;
  try {
    const resp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: ANTHROPIC_MODEL,
      max_tokens: 60,
      temperature: 0,
      system: 'Você recebe o horário de funcionamento de um negócio e responde APENAS um array JSON com os números dos dias da semana em que o negócio está FECHADO (0=domingo, 1=segunda, 2=terça, 3=quarta, 4=quinta, 5=sexta, 6=sábado). Se o horário não deixar claro que um dia está fechado, NÃO inclua esse dia. Se abrir todos os dias, responda []. Responda só o array, sem nenhum outro texto.',
      messages: [{ role: 'user', content: horario }]
    }, { headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, timeout: 6000 });
    const txt = (resp.data?.content?.[0]?.text || '').trim();
    const m = txt.match(/\[[^\]]*\]/);
    let dias = [];
    if (m) { try { dias = JSON.parse(m[0]).map(Number).filter(n => n >= 0 && n <= 6); } catch (_) {} }
    _diasFechadosCache[eid] = { chave, dias };
    return dias;
  } catch (e) {
    console.error('inferirDiasFechadosPorHorario:', e.message);
    return [];
  }
}

function gerarOpcoesDias(empresa, fechadosExtra) {
  const semana = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
  // Dias da semana (0=domingo ... 6=sábado) que a empresa NÃO atende — não entram na lista.
  // Junta os marcados na mão (diasFechados) com os que a IA inferiu do horário (fechadosExtra).
  const fechados = new Set([
    ...(Array.isArray(empresa && empresa.diasFechados) ? empresa.diasFechados.map(Number) : []),
    ...(Array.isArray(fechadosExtra) ? fechadosExtra.map(Number) : [])
  ]);
  if (fechados.size >= 7) fechados.clear(); // marcou todos? ignora, pra não sobrar lista vazia
  const dias = [];
  // Pega os próximos 5 dias que a empresa ATENDE (pula os fechados). Trava: até 30 dias à frente.
  for (let i = 1; dias.length < 5 && i <= 30; i++) {
    const d = new Date(); d.setDate(d.getDate() + i);
    if (fechados.has(d.getDay())) continue;
    dias.push({ idx: dias.length + 1, label: `${semana[d.getDay()]}, ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}` });
  }
  return dias;
}

async function enviarPerguntaDiaRec(telefone) {
  const empresa = await getEmpresa();
  // A IA confere no horário cadastrado quais dias a empresa não abre (ex.: domingo).
  const auto = await inferirDiasFechadosPorHorario(empresa);
  const dias = gerarOpcoesDias(empresa, auto);
  const linhas = dias.map(d => `*${d.idx}* — ${d.label}`).join('\n');
  const header = (empresa.posPerguntaDia || EMPRESA_PADRAO.posPerguntaDia);
  await sendText(telefone, `${header}\n\n${linhas}\n\n👇 _Digita o número aqui_ 👇`);
  await saveSessaoRecomendado(telefone, { etapa: 'agendar_dia', diasOpcoes: dias, ultimaMensagemEm: new Date().toISOString() });
}

// Compara telefones ignorando formatação e DDI (casa pelo final dos dígitos).
function soDigitosTel(t) { return String(t || '').replace(/\D/g, ''); }
function mesmoTelefone(a, b) {
  a = soDigitosTel(a); b = soDigitosTel(b);
  if (!a || !b) return false;
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  return n >= 8 && a.slice(-n) === b.slice(-n);
}

// Acha o lead (recomendado) da empresa atual por telefone, tolerante a formato
// (ex.: com/sem o "55", com parênteses/traços). Primeiro tenta match exato
// (rápido); se não achar, varre os leads da empresa casando por dígitos.
async function acharLeadRecPorTelefone(telefone) {
  let lead = null;
  const considerar = (d) => {
    const x = { id: d.id, ...d.data() };
    if ((x.empresaId || EMPRESA_ID_PDN) === empresaIdAtual()) {
      if (!lead || new Date(x.criadoEm || 0) > new Date(lead.criadoEm || 0)) lead = x;
    }
  };
  const exato = await LEADS_COL().where('telefoneRecomendado', '==', telefone).get();
  exato.forEach(considerar);
  if (lead) return lead;
  // Fallback tolerante a formato.
  const daEmpresa = await LEADS_COL().where('empresaId', '==', empresaIdAtual()).get();
  daEmpresa.forEach(d => {
    const x = { id: d.id, ...d.data() };
    if (mesmoTelefone(x.telefoneRecomendado, telefone)) {
      if (!lead || new Date(x.criadoEm || 0) > new Date(lead.criadoEm || 0)) lead = x;
    }
  });
  return lead;
}

async function registrarEscolhaNoLead(telefone, dados, empresa, moverParaAgendou) {
  try {
    const lead = await acharLeadRecPorTelefone(telefone);
    if (!lead) return;
    const upd = { ...dados };
    if (moverParaAgendou) {
      const etapas = (empresa.etapasKanban && empresa.etapasKanban.length) ? empresa.etapasKanban : EMPRESA_PADRAO.etapasKanban;
      const ag = etapas.find(e => /agend/i.test(e.id) || /agend/i.test(e.nome));
      if (ag) upd.etapa = ag.id;
    }
    await atualizarLead(lead.id, upd);
  } catch (e) { console.error('Erro ao registrar escolha no lead:', e.message); }
}

// Quando o recomendado aceita e recebe o presente, move o card automaticamente
// para a coluna "Recebeu o Prêmio" (a 2ª coluna / logo ao lado da primeira).
// Assim o painel mostra quantos leads de fato leram a mensagem e receberam.
async function marcarLeadRecebeuPremio(telefone, empresa) {
  try {
    const lead = await acharLeadRecPorTelefone(telefone);
    if (!lead) {
      console.warn(`[LEAD AUTO-MOVE] lead não encontrado para o telefone ${telefone} — card não movido`);
      return;
    }

    const etapas = (empresa.etapasKanban && empresa.etapasKanban.length) ? empresa.etapasKanban : EMPRESA_PADRAO.etapasKanban;
    // Coluna alvo: por nome/id (prêmio/bônus/presente) ou, se não houver, a 2ª coluna.
    const alvo = etapas.find(e => /pr[êe]mio|b[ôo]nus|presente/i.test(e.nome || '') || /premio|bonus|presente/i.test(e.id || ''))
      || etapas[1] || etapas[0];
    if (!alvo) return;

    const upd = { bonusPago: true };
    const idxAtual = etapas.findIndex(e => e.id === lead.etapa);
    const idxAlvo = etapas.findIndex(e => e.id === alvo.id);
    // Só avança o card; nunca puxa de volta um lead que já está mais à frente.
    if (idxAlvo > idxAtual) upd.etapa = alvo.id;
    await atualizarLead(lead.id, upd);
    console.log(`[LEAD AUTO-MOVE] ${telefone} → ${alvo.nome} (bônus recebido)`);
  } catch (e) {
    console.error('Erro ao mover lead para "Recebeu o Prêmio":', e.message);
  }
}

async function finalizarAgendamentoRec(telefone, sessao, empresa, periodoLabel, diaLabel) {
  const vars = { ...variaveisRec(sessao, empresa), dia: diaLabel, periodo: periodoLabel };
  await sendText(telefone, substituirVariaveis(empresa.posConfirmacaoAgendamento || EMPRESA_PADRAO.posConfirmacaoAgendamento, vars));
  await registrarEscolhaNoLead(telefone, {
    agendamentoPeriodo: periodoLabel,
    agendamentoDia: diaLabel,
    agendamentoEm: new Date().toISOString()
  }, empresa, true);
  const marcaFinalizado = new Date().toISOString();
  await saveSessaoRecomendado(telefone, { etapa: 'finalizado', ultimaMensagemEm: marcaFinalizado });
  await agendarCheckConfirmacao(telefone, marcaFinalizado);
  console.log(`[RECOMENDADO AGENDOU] ${telefone} — ${diaLabel} (${periodoLabel})`);
}

async function enviarMenuDepoisRec(telefone) {
  const empresa = await getEmpresa();
  await sendText(telefone, substituirVariaveis(empresa.posMenuDepois || EMPRESA_PADRAO.posMenuDepois, variaveisRec(null, empresa)));
  await saveSessaoRecomendado(telefone, { etapa: 'menu_depois', ultimaMensagemEm: new Date().toISOString() });
}

async function enviarMenuDuvidasRec(telefone) {
  const empresa = await getEmpresa();
  await sendText(telefone, substituirVariaveis(empresa.posMenuDuvidas || EMPRESA_PADRAO.posMenuDuvidas, variaveisRec(null, empresa)));
  await saveSessaoRecomendado(telefone, { etapa: 'menu_duvidas', ultimaMensagemEm: new Date().toISOString() });
}

async function responderDuvidaRec(telefone, opcao, empresa) {
  const sessao = await getSessaoRecomendado(telefone);
  const vars = { ...variaveisRec(sessao, empresa), premio: empresa.premioRecomendado || 'seu presente' };
  let resposta;
  if (opcao === 1) resposta = substituirVariaveis(empresa.faqComoFunciona || EMPRESA_PADRAO.faqComoFunciona, vars);
  else if (opcao === 2) resposta = substituirVariaveis(empresa.faqValidade || EMPRESA_PADRAO.faqValidade, vars);
  // Endereço e horário saem de "Informações do negócio" (fonte única). Fallback pros
  // campos antigos (enderecoEmpresa/horariosEmpresa) pra não perder dados já cadastrados.
  else if (opcao === 3) { const end = empresa.infoEndereco || empresa.enderecoEmpresa; resposta = end ? `Estamos em: ${end} 📍` : 'Um atendente já te passa o endereço certinho 😊'; }
  else if (opcao === 4) { const hor = empresa.infoHorario || empresa.horariosEmpresa; resposta = hor ? `Nosso atendimento: ${hor} 🕒` : 'Um atendente já te passa os horários 😊'; }
  else return false;
  await sendText(telefone, resposta);
  await sendText(telefone, `Posso ajudar em mais alguma coisa? 😊\n\n*1* — Como funciona\n*2* — Validade\n*3* — Endereço\n*4* — Horários\n*5* — Falar com atendente\n\nOu responda *0* se estiver tudo certo 👍`);
  await saveSessaoRecomendado(telefone, { etapa: 'menu_duvidas', ultimaMensagemEm: new Date().toISOString() });
  return true;
}

// ============================================================
// INTERPRETAÇÃO DA RESPOSTA DO RECOMENDADO — via API Claude
// ============================================================

async function interpretarRespostaRecomendado(texto, empresa, contextoEtapa) {
  if (!ANTHROPIC_API_KEY) {
    return {
      classificacao: respostaEhPositiva(texto) ? 'positiva' : 'negativa',
      respostaSugerida: null
    };
  }

  const informacoesDisponiveis = [
    `Nome da empresa: ${empresa.nome}`,
    `Prêmio oferecido ao recomendado: ${empresa.premioRecomendado}`,
    `Chamada para ação (CTA): ${empresa.ctaRecomendado}`
  ].join('\n');

  const systemPrompt = `Você ajuda a interpretar respostas de WhatsApp em uma conversa de recomendação comercial (etapa: ${contextoEtapa}).

Informações que você PODE usar para responder perguntas:
${informacoesDisponiveis}

Regras estritas:
- NUNCA invente informações fora do que foi listado acima (preço, endereço, prazo, qualquer dado não fornecido).
- Se a pessoa perguntar algo que você não tem informação, responda de forma breve e natural dizendo que não tem esse detalhe aí, mas que a equipe vai falar mais sobre isso em breve.
- Responda SEMPRE em JSON puro, sem markdown, no formato exato: {"classificacao": "positiva" | "negativa" | "pergunta", "respostaSugerida": "texto curto em português, ou null"}.
- "positiva": a pessoa topou continuar a conversa (ex: sim, pode, claro, ok). respostaSugerida deve ser null. Use esta classificação também quando a etapa for "aguardando resposta final de fechamento, depois do CTA" — nesse caso, gere uma respostaSugerida breve e calorosa de encerramento (ex: "Combinado! Estamos te esperando 😊" ou "Perfeito, qualquer coisa é só chamar!").
- "negativa": SOMENTE quando a pessoa explicitamente não quer continuar (ex: "não quero", "não tenho interesse", "para de me mandar mensagem", "não conheço você", "me tira da lista"). Aqui respostaSugerida é OBRIGATÓRIA: escreva uma despedida breve, gentil e humana. Nunca insista ou pressione.
- "pergunta": quando a pessoa faz uma pergunta, pede mais informações, diz que está ocupada agora mas pode depois (ex: "estou no trabalho", "pode ser outra hora", "qual o assunto?", "quem é você?", "quem te passou meu número?"). respostaSugerida é obrigatória — responda de forma breve e amigável, incentivando a continuar.
- respostaSugerida deve ter no máximo 2 frases curtas, tom natural e amigável, em português do Brasil.`;

  try {
    const resp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: ANTHROPIC_MODEL,
      max_tokens: 200,
      system: systemPrompt,
      messages: [{ role: 'user', content: texto || '' }]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      timeout: 4000
    });

    const textoResposta = resp.data?.content?.[0]?.text || '';
    const parsed = JSON.parse(textoResposta);

    if (!['positiva', 'negativa', 'pergunta'].includes(parsed.classificacao)) {
      throw new Error('Classificação inesperada retornada pela IA');
    }

    return {
      classificacao: parsed.classificacao,
      respostaSugerida: parsed.respostaSugerida || null
    };
  } catch (err) {
    console.error('Erro ao interpretar resposta via IA, usando fallback de palavras-chave:', err.message);
    return {
      classificacao: respostaEhPositiva(texto) ? 'positiva' : 'negativa',
      respostaSugerida: null
    };
  }
}

// ============================================================
// ATENDIMENTO PÓS-FLUXO — responde dúvidas do cliente (endereço, horário, etc.)
// usando SOMENTE as informações que a empresa cadastrou no painel.
// ============================================================
function infosNegocioDisponiveis(empresa) {
  const linhas = [];
  if (empresa.infoEndereco) linhas.push(`Endereço: ${empresa.infoEndereco}`);
  if (empresa.infoHorario) linhas.push(`Horário de funcionamento: ${empresa.infoHorario}`);
  if (empresa.infoSite) linhas.push(`Site: ${empresa.infoSite}`);
  if (empresa.infoInstagram) linhas.push(`Instagram: ${empresa.infoInstagram}`);
  if (empresa.infoTelefone) linhas.push(`Telefone/WhatsApp: ${empresa.infoTelefone}`);
  if (empresa.infoEmail) linhas.push(`E-mail: ${empresa.infoEmail}`);
  if (empresa.infoOutras) linhas.push(`Outras informações: ${empresa.infoOutras}`);
  return linhas.join('\n');
}

// Fallback sem IA (ou se a IA falhar): responde por palavras-chave.
function respostaInfoPorPalavraChave(pergunta, empresa) {
  const t = (pergunta || '').toLowerCase();
  const partes = [];
  if (empresa.infoEndereco && /endere|onde fica|onde voc|onde e|localiza|\blocal\b|como chego|chegar/.test(t)) partes.push(`📍 ${empresa.infoEndereco}`);
  if (empresa.infoHorario && /hor[áa]rio|funciona|aberto|atende|abre|fecha|que dia|que horas|amanh[ãa]|hoje/.test(t)) partes.push(`🕒 ${empresa.infoHorario}`);
  if (empresa.infoSite && /site|website|p[áa]gina|link/.test(t)) partes.push(`🌐 ${empresa.infoSite}`);
  if (empresa.infoInstagram && /insta|@/.test(t)) partes.push(`📸 ${empresa.infoInstagram}`);
  if (empresa.infoTelefone && /telefone|whats|contato|ligar|n[úu]mero/.test(t)) partes.push(`📞 ${empresa.infoTelefone}`);
  if (empresa.infoEmail && /e-?mail/.test(t)) partes.push(`✉️ ${empresa.infoEmail}`);
  return partes.length ? partes.join('\n') : null;
}

// Gera a resposta pra uma pergunta do cliente usando as infos cadastradas.
// Devolve o texto a enviar, ou null se não houver o que responder.
// Depois do fluxo terminado ('finalizado'), um "ok"/"valeu"/"obrigado" solto NÃO deve
// acionar a IA de atendimento — senão ela responde "fico à disposição, como posso ajudar?"
// fora de contexto (a conversa já foi encerrada). Só PERGUNTA de verdade aciona a IA.
function ehFechamentoConversa(texto) {
  let t = (texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  t = t.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return true;              // só emoji / vazio → não responde
  if (t.length > 35) return false;  // texto longo → provável pergunta, deixa a IA responder
  const FECHAMENTOS = new Set([
    'ok', 'okk', 'okey', 'okay', 'oki', 'blz', 'beleza', 'valeu', 'vlw', 'vlws', 'obrigado',
    'obrigada', 'obg', 'obgd', 'brigado', 'brigada', 'ta', 'ta bom', 'ta bem', 'ta certo',
    'tudo bem', 'tudo certo', 'tudo joia', 'perfeito', 'show', 'showw', 'otimo', 'otima', 'massa',
    'combinado', 'fechado', 'fechou', 'isso', 'isso mesmo', 'certo', 'entendi', 'entendido',
    'de nada', 'imagina', 'maravilha', 'top', 'joia', 'uhum', 'aham', 'sim', 'legal', 'bacana',
    'boa', 'bom', 'ok obrigado', 'ok obrigada', 'valeu obrigado', 'muito obrigado', 'muito obrigada',
    'tks', 'thanks', 'obrigadao', 'ss', 'ata', 'ah ta', 'ah bom'
  ]);
  if (FECHAMENTOS.has(t)) return true;
  // Frases curtas formadas SÓ por palavras de fechamento (ex.: "ok valeu", "muito obrigado mesmo").
  const PALAVRAS_OK = new Set([
    'ok', 'okk', 'blz', 'beleza', 'valeu', 'vlw', 'obrigado', 'obrigada', 'obg', 'brigado',
    'brigada', 'ta', 'tudo', 'bem', 'certo', 'perfeito', 'show', 'otimo', 'massa', 'muito', 'sim',
    'isso', 'mesmo', 'entendi', 'de', 'nada', 'imagina', 'maravilha', 'top', 'joia', 'legal',
    'bacana', 'boa', 'bom', 'tks', 'thanks', 'combinado', 'fechado', 'fechou'
  ]);
  const palavras = t.split(' ').filter(Boolean);
  if (palavras.length >= 1 && palavras.length <= 4 && palavras.every(p => PALAVRAS_OK.has(p))) return true;
  return false;
}

async function responderPerguntaNegocio(pergunta, empresa) {
  const infos = infosNegocioDisponiveis(empresa);
  if (!infos) return null; // nada cadastrado — não responde
  if (!ANTHROPIC_API_KEY) return respostaInfoPorPalavraChave(pergunta, empresa);

  const systemPrompt = `Você é o atendente virtual da empresa "${empresa.nome}" no WhatsApp. O cliente já foi atendido e voltou a mandar mensagem. Responda de forma curta, simpática e natural (português do Brasil), usando SOMENTE as informações abaixo.

Informações da empresa:
${infos}

Regras:
- Use SOMENTE os dados acima. NUNCA invente endereço, horário, preço, ou qualquer dado que não esteja listado.
- Se o cliente perguntar algo que NÃO está nas informações (ou pedir algo que exige um humano), responda breve e gentil dizendo que vai *transferir pra uma atendente* que já vai ajudar, e TERMINE sua resposta com o marcador ##TRANSFERIR## (o sistema vai chamar um humano de verdade). Nunca invente.
- Se for só um "oi", agradecimento ou conversa fiada, responda cordialmente e se coloque à disposição (NÃO use ##TRANSFERIR## nesses casos).
- No máximo 2-3 frases curtas. Sem markdown, sem títulos (o marcador ##TRANSFERIR##, quando usado, não conta como markdown).`;

  try {
    const resp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: ANTHROPIC_MODEL,
      max_tokens: 250,
      temperature: 0, // determinístico: mesma pergunta → mesma resposta (sem aleatoriedade)
      system: systemPrompt,
      messages: [{ role: 'user', content: pergunta || '' }]
    }, {
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      timeout: 6000
    });
    const txt = (resp.data?.content?.[0]?.text || '').trim();
    return txt || respostaInfoPorPalavraChave(pergunta, empresa);
  } catch (err) {
    console.error('Erro na IA de atendimento pós-fluxo, usando palavras-chave:', err.message);
    return respostaInfoPorPalavraChave(pergunta, empresa);
  }
}

// Mapeamento de objeções — o bot nunca desiste, sempre leva para o presente
const OBJECOES = [
  {
    gatilhos: ['nao quero', 'não quero', 'nao tenho interesse', 'não tenho interesse', 'sem interesse'],
    resposta: 'Sem problema, eu entendo! 😊 Só não queria que você ficasse sem o presente que o(a) {recomendador} recomendou para você. Posso te enviar? É rapidinho 🎁'
  },
  {
    gatilhos: ['nao conheco', 'não conheço', 'nao sei quem', 'não sei quem', 'quem e voce', 'quem é você', 'quem é vc', 'quem sao voces', 'não conheço vocês'],
    resposta: 'Faz todo sentido! 😊 Sou {vendedor}, da {empresa}, e o(a) {recomendador} lembrou de você pra ganhar um presente nosso. Posso te entregar agora? 🎁'
  },
  {
    gatilhos: ['quem deu meu contato', 'quem passou meu numero', 'quem passou meu número', 'quem te deu', 'como conseguiu meu numero', 'como conseguiu meu número'],
    resposta: 'Boa pergunta, faz sentido perguntar! 😊 Foi o(a) {recomendador} que recomendou você para receber um presente nosso. Posso te explicar o que é? 🎁'
  },
  {
    gatilhos: ['nao autorizei', 'não autorizei', 'nao dei permissao', 'não dei permissão', 'nao permiti', 'não permiti'],
    resposta: 'Entendo perfeitamente, e peço desculpa por chegar assim 🙏 Prometo ser breve: o(a) {recomendador} só queria te presentear. Deixa eu te entregar? 🎁'
  },
  {
    gatilhos: ['estou no trabalho', 'to no trabalho', 'ocupado', 'ocupada', 'agora nao', 'agora não', 'depois', 'pode ser depois', 'nao posso agora', 'não posso agora'],
    resposta: 'Sem stress, vou ser rapidinho! 😊 É só um presente que o(a) {recomendador} separou pra você. Posso te enviar agora mesmo? 🎁'
  },
  {
    gatilhos: ['spam', 'golpe', 'fraude', 'mentira', 'nao acredito', 'não acredito', 'desconfio'],
    resposta: 'Pode desconfiar mesmo, hoje em dia é o certo! 😊 Sou {vendedor}, da {empresa}, e o(a) {recomendador} me pediu pra te entregar um presente. Sem compromisso nenhum 🎁'
  }
];

function verificarObjecao(texto, variaveis) {
  if (!texto) return null;
  const normalizado = texto.toLowerCase().trim();
  for (const objecao of OBJECOES) {
    if (objecao.gatilhos.some(g => normalizado.includes(g))) {
      return substituirVariaveis(objecao.resposta, variaveis);
    }
  }
  return null;
}

async function processarMensagemRecomendado(telefone, texto, empresa) {
  const sessao = await getSessaoRecomendado(telefone);
  if (!sessao) return false;

  // Opção "0 — Não quero receber mensagens" dos menus → descadastra na hora.
  if ((texto || '').trim() === '0') {
    await processarOptOut(telefone, empresa);
    return true;
  }

  // IA DESATIVADA — fluxo 100% por palavras-chave e respostas fixas do CRM.
  // Mais rápido, previsível e sem delay de API.

  // Modo direto "depois do presente": a pessoa acabou de responder a
  // pergunta-chave — a resposta já fica registrada normal na conversa (o
  // atendente vê tudo ao assumir), só falta transferir de verdade.
  if (sessao.etapa === 'aguardando_pergunta_chave') {
    await transferirRecomendadoParaAtendente(telefone, sessao, empresa);
    return true;
  }

  if (sessao.etapa === 'aguardando_confirmacao') {
    // Modo direto "antes do presente" (o padrão de sempre): não roda o fluxo
    // do presente, transfere na hora. "Depois do presente" segue pro fluxo
    // normal aqui e transfere só depois de entregar (ver enviarPremioRecomendado).
    if (empresa.recomendadoAtendimentoHumano && empresa.recomendadoAtendimentoHumanoQuando !== 'depois') {
      await transferirRecomendadoParaAtendente(telefone, sessao, empresa);
      return true;
    }
    const variaveis = {
      nomeRecomendado: sessao.nomeRecomendado ? sessao.nomeRecomendado.split(' ')[0] : 'você',
      recomendado: sessao.nomeRecomendado ? sessao.nomeRecomendado.split(' ')[0] : 'você',
      recomendador: sessao.nomeRecomendador ? sessao.nomeRecomendador.split(' ')[0] : 'seu amigo',
      vendedor: sessao.vendedorNome || empresa.nome,
      empresa: empresa.nome
    };

    const marcaTempo = new Date().toISOString();
    const respostaObjecao = verificarObjecao(texto, variaveis);
    if (respostaObjecao) {
      // Objeção conhecida ("quem é você?", "não conheço"): responde e entrega o presente.
      await sendText(telefone, respostaObjecao);
      await saveSessaoRecomendado(telefone, { ultimaMensagemEm: marcaTempo });
      await enviarPremioRecomendado(telefone, sessao, empresa);
    } else if (respostaEhPositiva(texto)) {
      // Resposta positiva — envia prêmio imediatamente.
      await saveSessaoRecomendado(telefone, { ultimaMensagemEm: marcaTempo });
      await enviarPremioRecomendado(telefone, sessao, empresa);
    } else if (respostaEhNegativa(texto)) {
      // Recusa explícita ("não", "não quero", "para"): faz um convite gentil + follow-up,
      // sem forçar o presente.
      await saveSessaoRecomendado(telefone, { ultimaMensagemEm: marcaTempo });
      await sendText(telefone, substituirVariaveis(empresa.mensagemAguardandoConfirmacao || 'Sem problema 😊 É rapidinho e sem compromisso — posso te mostrar o presente que prepararam pra você? 🎁', variaveis));
      await agendarProximoFollowup(telefone, empresa, marcaTempo, 0);
    } else {
      // Qualquer outra resposta (a pessoa respondeu = está engajada): NÃO fica perguntando,
      // entrega o presente direto. Isso evita o loop de "não entendi".
      await saveSessaoRecomendado(telefone, { ultimaMensagemEm: marcaTempo });
      await enviarPremioRecomendado(telefone, sessao, empresa);
    }
    return true;
  }

  // A pessoa reagiu ao presente ("gostou?") → agora sim manda o menu de opções
  // (e cancela o menu que estava agendado, pra não mandar duas vezes).
  if (sessao.etapa === 'aguardando_reacao_presente') {
    await cancelarMenuAposReacao(telefone);
    await enviarMenuEFollowupRec(telefone, sessao, empresa);
    return true;
  }

  // Compatibilidade com sessões antigas em andamento (pré-menu)
  if (sessao.etapa === 'aguardando_reacao') {
    await enviarMenuPrincipalRec(telefone, sessao);
    return true;
  }
  if (sessao.etapa === 'aguardando_fechamento') {
    await sendText(telefone, empresa.mensagemFechamentoRecomendado || 'Combinado! 🙌 Vai ser um prazer te receber 😊');
    await saveSessaoRecomendado(telefone, { etapa: 'finalizado' });
    return true;
  }

  // ---- MENU PRINCIPAL (pós-presente) ----
  if (sessao.etapa === 'menu_principal') {
    const op = extrairOpcao(texto);
    if (op === 1) await iniciarAgendamentoRec(telefone, empresa, sessao, 'agora');
    else if (op === 2) await enviarMenuDepoisRec(telefone);
    else if (op === 3) await enviarMenuDuvidasRec(telefone);
    else await sendText(telefone, 'É só me responder com o número da opção 😊\n\n🟢 *1* — Quero usar meu presente\n🟡 *2* — Vou usar depois\n⚪ *3* — Tenho uma dúvida');
    return true;
  }

  // ---- "VOU USAR DEPOIS" ----
  if (sessao.etapa === 'menu_depois') {
    const op = extrairOpcao(texto);
    if (op === 1) {
      await iniciarAgendamentoRec(telefone, empresa, sessao, 'depois');
    } else if (op === 2) {
      await sendText(telefone, substituirVariaveis(empresa.posLembrete || EMPRESA_PADRAO.posLembrete, variaveisRec(sessao, empresa)));
      await agendarProximoFollowup(telefone, empresa, new Date().toISOString(), 0);
      await saveSessaoRecomendado(telefone, { etapa: 'finalizado', ultimaMensagemEm: new Date().toISOString() });
    } else {
      await sendText(telefone, 'Responde com *1* (deixar uma data) ou *2* (receber um lembrete depois) 😊');
    }
    return true;
  }

  // ---- AGENDAR: período ----
  if (sessao.etapa === 'agendar_periodo') {
    const op = extrairOpcao(texto);
    if (op >= 1 && op <= 3) {
      await saveSessaoRecomendado(telefone, { periodoEscolhido: PERIODOS_REC[op] });
      await enviarPerguntaDiaRec(telefone);
    } else {
      await sendText(telefone, 'Escolhe o período respondendo o número 😊\n*1* — Manhã   *2* — Tarde   *3* — Noite');
    }
    return true;
  }

  // ---- AGENDAR: dia ----
  if (sessao.etapa === 'agendar_dia') {
    const op = extrairOpcao(texto);
    const dias = sessao.diasOpcoes || gerarOpcoesDias(empresa);
    const dia = dias.find(d => d.idx === op);
    if (dia) {
      await finalizarAgendamentoRec(telefone, sessao, empresa, sessao.periodoEscolhido || 'combinado', dia.label);
    } else {
      await sendText(telefone, 'Me responde com o número do dia que você prefere 😊');
    }
    return true;
  }

  // ---- DÚVIDAS ----
  if (sessao.etapa === 'menu_duvidas') {
    if ((texto || '').trim() === '0') {
      await sendText(telefone, 'Combinado! Qualquer coisa é só chamar aqui 😊 Vai ser um prazer te receber!');
      await saveSessaoRecomendado(telefone, { etapa: 'finalizado' });
      return true;
    }
    const op = extrairOpcao(texto);
    if (op === 5) {
      await pausarNumero(telefone);
      await CONVERSAS_COL().doc(`${empresaIdAtual()}__${telefone}`).set({ botPausado: true }, { merge: true }).catch(() => {});
      await avisarAtendente(telefone, sessao.nomeRecomendado, empresa);
      await sendText(telefone, substituirVariaveis(empresa.posAtendente || EMPRESA_PADRAO.posAtendente, variaveisRec(sessao, empresa)));
      await saveSessaoRecomendado(telefone, { etapa: 'finalizado_atendente' });
      return true;
    }
    const ok = await responderDuvidaRec(telefone, op, empresa);
    if (ok) return true;

    // Não bateu com nenhuma opção do menu (1-5/0) — a pessoa escreveu uma
    // pergunta livre (ex.: "quanto é?", "faz reconstrução?"). Se o atendimento
    // com IA estiver ligado (mesma infra do pós-fluxo do Cliente, usando só as
    // infos cadastradas em "Informações do negócio"), tenta responder antes de
    // só repetir o menu — senão cai no comportamento de sempre.
    if (empresa.infoAtendimentoAtivo && texto) {
      let resposta = await responderPerguntaNegocio(texto, empresa);
      if (resposta && /##TRANSFERIR##/.test(resposta)) {
        resposta = resposta.replace(/##TRANSFERIR##/g, '').trim();
        if (resposta) await sendText(telefone, resposta);
        await pausarNumero(telefone);
        await CONVERSAS_COL().doc(`${empresaIdAtual()}__${telefone}`).set({ botPausado: true }, { merge: true }).catch(() => {});
        await avisarAtendente(telefone, sessao.nomeRecomendado, empresa);
        await sendText(telefone, substituirVariaveis(empresa.posAtendente || EMPRESA_PADRAO.posAtendente, variaveisRec(sessao, empresa)));
        await saveSessaoRecomendado(telefone, { etapa: 'finalizado_atendente' });
        return true;
      }
      if (resposta) {
        await sendText(telefone, resposta);
        await sendText(telefone, `Posso ajudar em mais alguma coisa? 😊\n\n*1* — Como funciona\n*2* — Validade\n*3* — Endereço\n*4* — Horários\n*5* — Falar com atendente\n\nOu responda *0* se estiver tudo certo 👍`);
        return true;
      }
    }
    await sendText(telefone, 'Me responde com o número da dúvida 😊 (1 a 5), ou *0* se estiver tudo certo.');
    return true;
  }

  // Conversa já "finalizada" (ex.: entrega direta sem menu, ou terminou o fluxo
  // normal) — sem isso o robô ficava mudo pra qualquer mensagem depois, mesmo
  // uma pergunta de verdade. Mesmo padrão do lado Cliente (linha ~2105): "ok"/
  // "obrigado" não precisam de resposta (ehFechamentoConversa), mas pergunta
  // de verdade tenta responder com a IA do atendimento pós-fluxo, se ligada.
  if (sessao.etapa === 'finalizado' && empresa.infoAtendimentoAtivo && texto && !ehFechamentoConversa(texto)) {
    let resposta = await responderPerguntaNegocio(texto, empresa);
    if (resposta && /##TRANSFERIR##/.test(resposta)) {
      resposta = resposta.replace(/##TRANSFERIR##/g, '').trim();
      if (resposta) await sendText(telefone, resposta);
      await pausarNumero(telefone);
      await CONVERSAS_COL().doc(`${empresaIdAtual()}__${telefone}`).set({ botPausado: true }, { merge: true }).catch(() => {});
      await avisarAtendente(telefone, sessao.nomeRecomendado, empresa);
      await saveSessaoRecomendado(telefone, { etapa: 'finalizado_atendente' });
    } else if (resposta) {
      await sendText(telefone, resposta);
    }
  }

  return true;
}

// ============================================================
// WEBHOOK — recebe mensagens da Z-API
// ============================================================

async function tratarWebhook(req, res) {
  try {
    if (!db) {
      console.error('Firestore não inicializado — verifique FIREBASE_SERVICE_ACCOUNT');
      return res.sendStatus(500);
    }

    const body = req.body;
    console.log('[WEBHOOK] keys recebidas:', Object.keys(body).join(', '));

    if (body.fromMe) {
      return res.sendStatus(200);
    }

    if (body.isGroup) {
      return res.sendStatus(200);
    }

    const messageId = body.messageId || null;
    if (await jaProcessadaOuMarcar(messageId)) {
      console.log(`[WEBHOOK] Mensagem duplicada ignorada (messageId: ${messageId})`);
      return res.sendStatus(200);
    }

    const telefone = body.phone;
    if (!telefone) {
      return res.sendStatus(200);
    }

    let texto = null;
    let vCard = null;
    let contatosMultiplos = null;

    if (body.text && body.text.message) {
      texto = body.text.message;
    }

    if (body.contactArray && Array.isArray(body.contactArray) && body.contactArray.length > 0) {
      contatosMultiplos = body.contactArray.map(c => {
        // Já vem no formato final {nome, telefone} — caso da API Oficial, onde
        // metaMensagemParaInterno já resolveu o número certo (wa_id/DDI). Reprocessar
        // aqui com os campos do Z-API (phones/waid/vcard) zerava o telefone (null),
        // porque esses campos não existem nesse objeto — bug que fazia o disparo
        // "confirmar" mas não ter pra quem mandar.
        if (c && typeof c.telefone === 'string') {
          return { nome: c.nome || 'Contato sem nome', telefone: c.telefone };
        }
        if (c.vcard || c.vCard) {
          return parseVCard(c.vcard || c.vCard);
        }
        return {
          nome: c.displayName || c.name || c.pushname || 'Contato sem nome',
          telefone: (c.phones && c.phones[0]) || c.phone || c.waid || null
        };
      });
    }

    if (body.contact) {
      vCard = body.contact.vCard || body.contact.vcard || null;
      if (!texto && !vCard && body.contact.displayName) {
        texto = `${body.contact.displayName} - ${body.contact.phones ? body.contact.phones[0] : ''}`;
      }
    }
    if (!vCard && body.vCard) vCard = body.vCard;
    if (!vCard && body.vcard) vCard = body.vcard;

    console.log('[WEBHOOK] texto extraído:', texto);
    console.log('[WEBHOOK] vCard extraído:', vCard);
    console.log('[WEBHOOK] contatosMultiplos extraído:', JSON.stringify(contatosMultiplos));

    // Registra a mensagem recebida no histórico da conversa (caixa de entrada)
    const nomeContato = body.senderName || body.chatName || body.pushname || null;
    // Contato(s) da agenda compartilhados — guarda nome+telefone de cada um pra a
    // caixa de entrada mostrar igual o WhatsApp (não só um rótulo genérico).
    let contatosParaChat = null;
    if (contatosMultiplos && contatosMultiplos.length) contatosParaChat = contatosMultiplos;
    else if (vCard) contatosParaChat = [parseVCard(vCard)];
    let textoChat = texto;
    let midiaTipoChat = null, midiaUrlChat = null;
    if (!textoChat) {
      if (contatosParaChat && contatosParaChat.length === 1) textoChat = `👤 ${contatosParaChat[0].nome || 'Contato compartilhado'}`;
      else if (contatosParaChat && contatosParaChat.length > 1) textoChat = `👤 ${contatosParaChat.length} contatos compartilhados`;
      else if (body.midia) {
        // Mídia recebida via API Oficial (já baixada da Meta e resolvida em
        // metaMensagemParaInterno) — tem URL permanente pro painel exibir.
        const rotulos = { image: '📷 Imagem', audio: '🎤 Áudio', video: '🎬 Vídeo', document: '📎 Documento' };
        midiaTipoChat = { image: 'imagem', audio: 'audio', video: 'video', document: 'documento' }[body.midia.tipo] || 'documento';
        midiaUrlChat = body.midia.url || null;
        textoChat = body.midia.caption || rotulos[body.midia.tipo] || '📎 Anexo';
      }
      else if (body.image || body.audio || body.video || body.document) {
        // Mídia recebida via Z-API — o payload já traz uma URL direta (não precisa
        // resolver media id como na Meta), mas baixamos e subimos pro nosso Storage
        // do mesmo jeito, pra ter link permanente e o painel conseguir exibir/tocar.
        // Antes disso ficava só o rótulo genérico, sem link nenhum — nem imagem nem
        // áudio apareciam de verdade em Conversas.
        const rotulos = { imagem: '📷 Imagem', audio: '🎤 Áudio', video: '🎬 Vídeo', documento: '📎 Documento' };
        let tipo = null, urlOrigem = null, caption = null, mimetype = null;
        if (body.image) { tipo = 'imagem'; urlOrigem = body.image.imageUrl || body.image.url; caption = body.image.caption; mimetype = body.image.mimeType; }
        else if (body.audio) { tipo = 'audio'; urlOrigem = body.audio.audioUrl || body.audio.url; mimetype = body.audio.mimeType; }
        else if (body.video) { tipo = 'video'; urlOrigem = body.video.videoUrl || body.video.url; caption = body.video.caption; mimetype = body.video.mimeType; }
        else if (body.document) { tipo = 'documento'; urlOrigem = body.document.documentUrl || body.document.url; caption = body.document.fileName; mimetype = body.document.mimeType; }
        midiaTipoChat = tipo;
        textoChat = caption || rotulos[tipo] || '📎 Anexo';
        if (urlOrigem) {
          const baixada = await baixarMidiaZapiEUpload(urlOrigem, empresaIdAtual(), mimetype);
          midiaUrlChat = baixada ? baixada.url : null;
        }
      }
    }
    // PRIVACIDADE: só registra a mensagem na caixa de entrada se for uma conversa
    // do BOT (tem sessão, é um gatilho/opt-out, ou já existe conversa do bot).
    // Assim, se o número for usado também no pessoal, as conversas particulares
    // NÃO caem no painel.
    if (textoChat) {
      let ehDoBot = false;
      try {
        const chaveLog = chaveSessao(telefone);
        if ((await SESSOES_COL().doc(chaveLog).get()).exists) ehDoBot = true;
        else if ((await SESSOES_RECOMENDADO_COL().doc(chaveLog).get()).exists) ehDoBot = true;
        else if ((await CONVERSAS_COL().doc(`${empresaIdAtual()}__${telefone}`).get()).exists) ehDoBot = true;
        else {
          const empLog = await getEmpresa();
          ehDoBot = ehGatilhoPresenteQualquerOferta(texto, empLog) || !!detectarNichoDemo(texto, empLog) || !!detectarResgateFull(texto) || ehOptOut(texto);
        }
      } catch (e) { ehDoBot = false; }
      if (ehDoBot) {
        registrarMensagem({ empresaId: empresaIdAtual(), telefone, nome: nomeContato, direcao: 'in', texto: textoChat, tipo: midiaTipoChat, midiaUrl: midiaUrlChat, contatosArray: contatosParaChat });
      }
    }

    // ============================================================
    // COMANDOS DE PAUSA MANUAL — "stop1" / "play1"
    // ============================================================
    // stop1: pausa IMEDIATAMENTE o bot para esse número.
    //   - Cancela qualquer sessão ativa (recomendador e recomendado)
    //   - Cancela agendamentos pendentes para esse número
    //   - Bot só responde novamente se a pessoa mandar "quero meu presente"
    // play1: reativa o bot para esse número (volta ao comportamento normal)
    const textoNormalizado = (texto || '').toLowerCase().trim();

    // ============================================================
    // COMANDOS ADMINISTRATIVOS — stop1 / play1 com número alvo
    // ============================================================
    // Qualquer número pode mandar estes comandos (inclusive o próprio dono
    // do bot). O número alvo é passado junto ao comando:
    //   stop1 5511999998888  → pausa o bot para aquele número
    //   play1 5511999998888  → reativa o bot para aquele número
    // Se nenhum número for passado, o alvo é o próprio remetente
    // (comportamento antigo, mantido para compatibilidade).

    const matchStop = textoNormalizado.match(/^stop1(?:\s+(\d+))?$/);
    const matchPlay = textoNormalizado.match(/^play1(?:\s+(\d+))?$/);

    if (matchStop) {
      const alvo = matchStop[1] || telefone;
      await resetarContato(alvo);
      console.log(`[STOP1] Memória e conversa zeradas para ${alvo} (comando de ${telefone})`);
      // Sem resposta de propósito: a conversa fica limpa para reiniciar do zero.
      return res.sendStatus(200);
    }

    if (matchPlay) {
      const alvo = matchPlay[1] || null;

      if (alvo) {
        // play1 COM número — limpa sessões e agendamentos do número alvo
        await despausarNumero(alvo);
        await resetSessao(alvo);
        await SESSOES_RECOMENDADO_COL().doc(chaveSessao(alvo)).delete();
        try {
          const snap = await AGENDAMENTOS_COL().where('status', '==', 'pendente').get();
          const batch = db.batch();
          snap.forEach(doc => {
            const d = doc.data();
            const tel = d.dados?.contato?.telefone || d.dados?.telefone || null;
            const mesmaEmpresa = (d.empresaId || EMPRESA_ID_PDN) === empresaIdAtual();
            if (tel === alvo && mesmaEmpresa) batch.update(doc.ref, { status: 'cancelado' });
          });
          await batch.commit();
        } catch (err) {
          console.error('Erro ao cancelar agendamentos no play1:', err.message);
        }
        console.log(`[PAUSA MANUAL] Bot reativado e sessões limpas para ${alvo} (comando enviado por ${telefone})`);
      } else {
        // play1 SEM número — só remove da lista de pausados, sem mexer em sessões
        await despausarNumero(telefone);
        console.log(`[PAUSA MANUAL] Bot reativado para ${telefone} (sem reset de sessão)`);
      }
      return res.sendStatus(200);
    }

    // Empresa do contexto (pra ler a frase de ativação configurável).
    const empGatilho = await getEmpresa();

    // OPT-OUT (descadastro): "não quero receber", "sair", etc. — em qualquer
    // momento. Honra na hora e permanente (desvia a denúncia = anti-ban).
    if (ehOptOut(texto)) {
      await processarOptOut(telefone, empGatilho);
      return res.sendStatus(200);
    }

    // Se o número está pausado, só reage ao gatilho de ativação do presente
    const ehGatilhoInicialParaPausa = ehGatilhoPresenteQualquerOferta(texto, empGatilho) || !!detectarNichoDemo(texto, empGatilho);
    if (!ehGatilhoInicialParaPausa && await numeroEstaPausado(telefone)) {
      console.log(`[PAUSA MANUAL] Mensagem ignorada — ${telefone} está pausado`);
      return res.sendStatus(200);
    }

    const ehEventoVazio = !texto && !vCard && !contatosMultiplos;
    if (ehEventoVazio) {
      // Imagem/áudio/vídeo/documento também caem aqui (não têm "texto"). Nesse
      // caso a mensagem de "não entendi, responda em texto" é enganosa — a
      // pessoa JÁ mandou algo, só que o robô não consegue interpretar arquivo.
      const recebeuMidiaSemTexto = !!(body.midia || body.image || body.audio || body.video || body.document);
      const sessaoExistenteSnap = await SESSOES_COL().doc(chaveSessao(telefone)).get();
      if (sessaoExistenteSnap.exists) {
        const sessao = sessaoExistenteSnap.data();
        const empresa = await getEmpresa();
        const msg = recebeuMidiaSemTexto
          ? 'Recebi seu arquivo por aqui, mas ainda não consigo "ler" imagem/áudio 🙂 Pode me contar em texto o que você precisa?'
          : mensagemNaoEntendiPorEtapa(sessao.etapa, empresa);
        if (msg) await sendText(telefone, msg);
      } else {
        const sessaoRecomendado = await getSessaoRecomendado(telefone);
        if (sessaoRecomendado && sessaoRecomendado.etapa !== 'finalizado' && sessaoRecomendado.etapa !== 'finalizado_negativo') {
          await sendText(telefone, recebeuMidiaSemTexto
            ? 'Recebi seu arquivo por aqui, mas ainda não consigo "ler" imagem/áudio 🙂 Pode me contar em texto o que você precisa?'
            : 'Acho que não entendi essa última mensagem 🙂 Pode me responder em texto?');
        }
      }
      return res.sendStatus(200);
    }

    const sessaoExistenteSnap = await SESSOES_COL().doc(chaveSessao(telefone)).get();
    const sessaoExiste = sessaoExistenteSnap.exists;
    const sessaoClienteEtapa = sessaoExiste ? sessaoExistenteSnap.data().etapa : null;
    // Cliente "ativo" = sessão em andamento (não finalizada). Uma sessão de
    // cliente finalizada não deve bloquear o fluxo de recomendado.
    const clienteAtivo = sessaoExiste && sessaoClienteEtapa !== 'finalizado';
    const ehGatilhoInicial = ehGatilhoPresenteQualquerOferta(texto, empGatilho);

    // Um mesmo número pode ter sido cliente/recomendador antes e agora estar
    // recebendo o roteiro como RECOMENDADO. Se a sessão de cliente já está
    // finalizada (ou não existe) e existe uma sessão de recomendado ATIVA,
    // a mensagem pertence ao fluxo de recomendado — não ao de cliente.
    const sessaoRecomendado = clienteAtivo ? null : await getSessaoRecomendado(telefone);
    const recomendadoAtivo = sessaoRecomendado
      && sessaoRecomendado.etapa
      && !['finalizado', 'finalizado_negativo', 'finalizado_atendente'].includes(sessaoRecomendado.etapa);

    // Pedido de ATENDENTE por frase natural ("atendente", "recepcionista", "humano",
    // "alguém pode me ajudar"...), em qualquer momento — desde que haja uma conversa
    // com o robô (cliente ou recomendado). Transfere pro humano na hora.
    if (pedeAtendente(texto) && !ehGatilhoInicial && (sessaoExiste || sessaoRecomendado)) {
      const empresaAt = await getEmpresa();
      const nomePessoa = (sessaoExiste && sessaoExistenteSnap.data().clienteNome)
        || (sessaoRecomendado && sessaoRecomendado.nomeRecomendado) || '';
      await transferirParaAtendente(telefone, nomePessoa, empresaAt);
      return res.sendStatus(200);
    }

    // ---- Demonstração por nicho ----
    // O nicho vem no código do link (novo teste) ou fica guardado na sessão
    // (para o resto da conversa). Se houver nicho, sobrepomos a config dele no
    // contexto — daí todo o fluxo (getEmpresa) já usa os textos/imagens da área.
    const nichoDetectado = detectarNichoDemo(texto, empGatilho);
    const nichoSessaoCliente = sessaoExiste ? sessaoExistenteSnap.data().nicho : null;
    const nichoSessaoRec = sessaoRecomendado ? sessaoRecomendado.nicho : null;
    const nichoEfetivo = nichoDetectado || nichoSessaoCliente || nichoSessaoRec || null;
    if (nichoEfetivo) {
      const ctx = tenantContext.getStore();
      if (ctx) ctx.empresa = aplicarNicho(ctx.empresa, nichoEfetivo);
      console.log(`[NICHO] ${telefone} → ${nichoEfetivo}${nichoDetectado ? ' (novo pelo link)' : ' (sessão)'}`);
    }

    // ---- Rede de lojas: tagueamento silencioso por oferta (Fase 2a) ----
    // Resolve só quando é óbvio (sessão já sabe, frase-gatilho bate, ou só 1
    // oferta ativa) — com 2+ ofertas ambíguas, fica null e segue tudo igual a
    // hoje até a Fase 2b (menu de desambiguação) existir.
    const ofertaIdSessaoCliente = sessaoExiste ? sessaoExistenteSnap.data().ofertaId : null;
    const ofertaIdSessaoRec = sessaoRecomendado ? sessaoRecomendado.ofertaId : null;
    const ofertaEfetivaId = resolverOfertaSilenciosa(empGatilho, texto, ofertaIdSessaoCliente || ofertaIdSessaoRec);
    if (ofertaEfetivaId) {
      const ctx = tenantContext.getStore();
      if (ctx) ctx.empresa = aplicarOferta(ctx.empresa, ofertaEfetivaId);
      // Persiste na sessão certa se ela já existe e ainda não sabia — pra próximas
      // mensagens não recalcularem. Sessão nova (contato 100% inédito) recebe o
      // carimbo mais adiante, quando o fluxo efetivamente cria ela.
      if (sessaoExiste && !ofertaIdSessaoCliente) await saveSessao(telefone, { ofertaId: ofertaEfetivaId });
      if (sessaoRecomendado && !ofertaIdSessaoRec) await saveSessaoRecomendado(telefone, { ofertaId: ofertaEfetivaId });
    }

    // Basic com confirmação: cliente respondeu ao menu (1 já avisei / 2 ainda não /
    // 3 me manda um texto pronto). Trata antes do roteamento normal.
    // Fase de confirmação do disparo (Basic+Segurar): cobre TANTO a janela de espera
    // (aguardandoIntervaloConfirmacao) quanto o menu já enviado (aguardandoConfirmacaoDisparo).
    // Assim o robô NUNCA fica mudo se o cliente responder antes do menu aparecer.
    const _sConf = sessaoExiste ? sessaoExistenteSnap.data() : null;

    // ---- Rede de lojas: resposta ao menu "qual loja você prefere?" (Fase 2b) ----
    // Prioridade máxima — é uma resposta de menu específica, trata antes de
    // qualquer outro roteamento (inclusive antes do menu de confirmação Basic).
    if (_sConf && _sConf.aguardandoEscolhaOferta && !ehOptOut(texto)) {
      const opcoes = _sConf.opcoesOferta || [];
      const idx = parseInt(String(texto || '').trim(), 10) - 1;
      const escolhida = opcoes[idx];
      if (!escolhida) {
        await sendText(telefone, 'Não entendi — responda só com o número da opção 🙂\n' +
          opcoes.map((o, i) => `${i + 1}. ${o.nome}`).join('\n'));
        return res.sendStatus(200);
      }
      const ctxEsc = tenantContext.getStore();
      if (ctxEsc) ctxEsc.empresa = aplicarOferta(ctxEsc.empresa, escolhida.id);
      await resetSessao(telefone);
      await iniciarConversa(telefone);
      await saveSessao(telefone, { ofertaId: escolhida.id });
      return res.sendStatus(200);
    }

    if (_sConf && (_sConf.aguardandoConfirmacaoDisparo || _sConf.aguardandoIntervaloConfirmacao) && !ehGatilhoInicial && !nichoDetectado) {
      const s = _sConf;
      const empresaC = await getEmpresa();
      const t = (texto || '').trim().toLowerCase();
      const primeiro = t.charAt(0);
      const nome1 = (s.clienteNome || '').split(' ')[0] || 'você';
      const varsC = { nomeRecomendado: nome1, recomendador: nome1, empresa: empresaC.nome };
      const menuJaEnviado = !!s.aguardandoConfirmacaoDisparo;

      // 1 / "já avisei" / "pode mandar" → dispara agora (vale até antes do menu aparecer)
      if (primeiro === '1' || ehConfirmacaoDisparo(texto)) {
        await dispararRecomendados(s.clienteNome, s.vendedorNome, s.contatosPendentesDisparo || [], empresaC, telefone);
        await saveSessao(telefone, { aguardandoConfirmacaoDisparo: false, aguardandoIntervaloConfirmacao: false, contatosPendentesDisparo: [] });
        await cancelarConfirmacoesDisparo(telefone);
        await sendText(telefone, 'Perfeito! 🙌 Já estou avisando seus amigos. Muito obrigado(a)!');
        return res.sendStatus(200);
      }

      // O cliente escreveu ANTES do menu de confirmação aparecer (janela de espera):
      // em vez de mandar "sem pressa", ANTECIPA o MENU (a mensagem que o dono
      // configurou). O job agendado não reenvia (checa o flag). Assim ele vê a msg certa.
      if (!menuJaEnviado) {
        await sendText(telefone, substituirVariaveis(empresaC.basicConfirmMensagem || EMPRESA_PADRAO.basicConfirmMensagem, varsC));
        await saveSessao(telefone, { aguardandoConfirmacaoDisparo: true, aguardandoIntervaloConfirmacao: false });
        return res.sendStatus(200);
      }

      // Menu já enviado — trata a resposta:
      // 3 → manda o texto pronto pro cliente encaminhar (continua aguardando)
      if (primeiro === '3' || /textinho|texto pronto|manda o texto|manda um texto|modelo/.test(t)) {
        await sendText(telefone, substituirVariaveis(empresaC.basicTextoPronto || EMPRESA_PADRAO.basicTextoPronto, varsC));
        await sendText(telefone, substituirVariaveis(empresaC.basicTextoProntoConfirma || EMPRESA_PADRAO.basicTextoProntoConfirma, varsC));
        return res.sendStatus(200);
      }
      // 2 / "ainda não avisei" / "não consigo avisá-los" / QUALQUER outra resposta →
      // NÃO fica mudo: tranquiliza com o basicAindaNao (os lembretes seguem e, com
      // "disparar mesmo assim", o disparo acontece de qualquer forma).
      await sendText(telefone, substituirVariaveis(empresaC.basicAindaNao || EMPRESA_PADRAO.basicAindaNao, varsC));
      return res.sendStatus(200);
    }

    // Follow-up do recomendador: se está aguardando resposta ao lembrete
    // (1/2/3), trata aqui — antes do roteamento normal.
    if (sessaoExiste && sessaoExistenteSnap.data().followupAguardando && !ehGatilhoInicial && !nichoDetectado) {
      const tratou = await tratarRespostaFollowupRecomendador(telefone, texto, sessaoExistenteSnap.data());
      if (tratou) return res.sendStatus(200);
    }

    // MODO FULL — o amigo chegou pelo link ("#r<código>"). É INBOUND (ele chamou
    // primeiro), então respondemos e iniciamos o fluxo do recomendado, atribuindo
    // ao cliente que indicou. Só se não houver conversa ativa desse número.
    const codResgate = detectarResgateFull(texto);
    if (codResgate && !clienteAtivo && !recomendadoAtivo) {
      const ref = await buscarRefFull(codResgate);
      if (ref) {
        // Rede de lojas: aplica a oferta de quem indicou (carimbada em
        // salvarRefFull) — sem isso, o amigo sempre recebia o conteúdo da
        // oferta Padrão, mesmo tendo sido indicado por alguém de outra loja.
        let empresaFull = await getEmpresa();
        if (ref.ofertaId) empresaFull = aplicarOferta(empresaFull, ref.ofertaId);
        const contato = { nome: nomeContato || 'você', telefone };
        await iniciarConversaRecomendado(contato, ref.nomeRecomendador || 'seu amigo', ref.vendedorNome || empresaFull.nome, empresaFull);
        console.log(`[FULL RESGATE] ${telefone} chegou pelo link de ${ref.telefoneRecomendador} (cod ${codResgate})`);
        return res.sendStatus(200);
      }
    }

    // Cliente que já terminou (ou sem fluxo ativo) pede pra recomendar mais
    // pessoas → reinicia o processo de recomendação nativo. Não interrompe quem
    // está no meio do fluxo (cliente ou recomendado ativo).
    const querRecomendar = querRecomendarMais(texto) && sessaoExiste && !clienteAtivo && !recomendadoAtivo;

    if (ehGatilhoInicial || nichoDetectado || querRecomendar) {
      // Rede de lojas: ninguém resolveu ainda qual loja é (2+ ofertas ativas,
      // nenhuma frase-gatilho específica bateu) — manda o menu e espera a
      // resposta antes de iniciar qualquer fluxo.
      const ativasMenu = (!ofertaEfetivaId && empGatilho.ofertasHabilitado && empGatilho.ofertas)
        ? Object.entries(empGatilho.ofertas).filter(([, o]) => o && o.ativa) : [];
      if (ativasMenu.length > 1) {
        await resetSessao(telefone);
        const opcoes = ativasMenu.map(([id, o]) => ({ id, nome: o.nomeOferta || id }));
        const listaTexto = opcoes.map((o, i) => `${i + 1}. ${o.nome}`).join('\n');
        const msgEscolha = (empGatilho.mensagemEscolhaOferta || EMPRESA_PADRAO.mensagemEscolhaOferta).replace('{opcoes}', listaTexto);
        await sendText(telefone, msgEscolha);
        await saveSessao(telefone, { aguardandoEscolhaOferta: true, opcoesOferta: opcoes });
        return res.sendStatus(200);
      }
      await resetSessao(telefone);
      await iniciarConversa(telefone);
      if (nichoEfetivo) await saveSessao(telefone, { nicho: nichoEfetivo });
      // Rede de lojas: carimba a oferta na sessão que ACABOU de ser criada aqui.
      // O carimbo lá em cima (perto de resolverOfertaSilenciosa) só cobre sessão
      // JÁ existente — numa conversa nova (o caso mais comum: 1ª mensagem =
      // gatilho), sessaoExiste era false naquele momento e o carimbo não rolava.
      // Sem isso, a 2ª mensagem em diante perdia a oferta (resolverOfertaSilenciosa
      // não tinha mais como saber qual era) e a conversa passava a usar o
      // conteúdo real da oferta Padrão pro resto do fluxo.
      if (ofertaEfetivaId) await saveSessao(telefone, { ofertaId: ofertaEfetivaId });
    } else if (clienteAtivo) {
      await processarMensagem(telefone, texto, vCard, contatosMultiplos);
    } else if (recomendadoAtivo) {
      const empresa = await getEmpresa();
      await processarMensagemRecomendado(telefone, texto, empresa);
    } else if (sessaoExiste) {
      // Sessão de cliente finalizada e sem recomendado ativo — comportamento antigo.
      await processarMensagem(telefone, texto, vCard, contatosMultiplos);
    } else {
      const empresa = await getEmpresa();
      await processarMensagemRecomendado(telefone, texto, empresa);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Erro no webhook:', err);
    res.sendStatus(500);
  }
}

// Resolve a empresa do webhook e processa a mensagem dentro do contexto dela,
// pra que os envios saiam pelo WhatsApp (Z-API) correto.
//   - /webhook            → PDN (compatível com a configuração atual da Z-API)
//   - /webhook/:empresaId → empresa específica (cada instância Z-API aponta
//                            pra sua própria URL)
async function comWebhook(req, res, empresaId) {
  // Callback de STATUS de mensagem (SENT/RECEIVED/READ/DELIVERY) — não é mensagem de
  // cliente; só logamos pra diagnóstico de ENTREGA e respondemos 200. Se um recomendado
  // ficar preso em SENT e nunca chegar em RECEIVED/DELIVERY, é o WhatsApp barrando a
  // entrega (não a nossa saída). Ver [[anti-ban]] / [[modelo-inbound-recomendacao]].
  const b = req.body || {};
  const ehStatus = (b.type && /MessageStatus|DeliveryCallback/i.test(b.type)) ||
    (typeof b.status === 'string' && /^(SENT|RECEIVED|READ|PLAYED|DELIVERY|VIEWED)$/i.test(b.status)
      && !b.text && !b.image && !b.audio
      // NÃO tratar como status se tem QUALQUER conteúdo de mensagem. O Z-API manda
      // `status: RECEIVED` até em mensagem real; o que distingue é ter conteúdo.
      // Contato único vem em `contact`; VÁRIOS contatos (agenda) vêm em `contactArray`
      // — faltava checar o plural, então multi-contato caía aqui e era descartado.
      && !b.contact && !b.contactArray && !b.document && !b.video && !b.location && !b.sticker);
  if (ehStatus) {
    guardarStatusCallback(b);
    console.log(`[ZSTATUS] status=${b.status || b.type} phone=${b.phone || ''} messageId=${b.messageId || b.id || ''} error=${b.error ? JSON.stringify(b.error) : '(sem erro)'} body=${JSON.stringify(b).slice(0, 400)}`);
    return res.sendStatus(200);
  }

  let empresa = null;
  try {
    empresa = empresaId ? await getEmpresaById(empresaId) : await getEmpresa();
  } catch (err) {
    console.error('Erro ao resolver empresa do webhook:', err.message);
  }

  if (empresaId && !empresa) {
    console.warn(`[WEBHOOK] empresaId desconhecido: ${empresaId} — ignorando`);
    return res.sendStatus(200);
  }

  // O Z-API manda o número conectado (connectedPhone) em toda mensagem — guarda
  // pra usar no link de demonstração / Full sem depender do /device (que falha).
  const numConectado = String((req.body && req.body.connectedPhone) || '').replace(/\D/g, '');
  if (numConectado && empresa && empresa.id) { salvarNumeroConectado(empresa.id, numConectado); }

  // Anti-forja: o payload do Z-API traz o instanceId. Se vier e não bater com
  // a instância esperada da empresa, ignoramos (provável requisição forjada).
  // Quando o instanceId não vem, não bloqueamos para não derrubar mensagens
  // legítimas de payloads fora do padrão.
  const instanceEsperada = (zapiDaEmpresa(empresa) || {}).instanceId;
  const instanceRecebida = req.body && req.body.instanceId;
  if (instanceRecebida && instanceEsperada && String(instanceRecebida) !== String(instanceEsperada)) {
    console.warn(`[WEBHOOK] instanceId não confere (recebido: ${instanceRecebida}) — ignorando`);
    return res.sendStatus(200);
  }

  const contexto = {
    empresa,
    empresaId: (empresa && empresa.id) || empresaId || EMPRESA_ID_PDN,
    zapi: zapiDaEmpresa(empresa),
    oficial: oficialDaEmpresa(empresa)
  };

  return tenantContext.run(contexto, () => tratarWebhook(req, res));
}

app.post('/webhook', (req, res) => comWebhook(req, res, null));
app.post('/webhook/:empresaId', (req, res) => comWebhook(req, res, req.params.empresaId));

// ============================================================
// WEBHOOK — WhatsApp API Oficial (Meta Cloud API)
// ============================================================
// A Meta usa formato próprio (entry/changes/messages) e exige verificação por
// GET (hub.challenge). Traduzimos o payload pro MESMO formato interno do fluxo
// Z-API e reaproveitamos toda a lógica (tratarWebhook).

// GET: verificação do webhook na configuração do app na Meta.
app.get('/webhook-oficial/:empresaId', async (req, res) => {
  try {
    const empresa = await getEmpresaById(req.params.empresaId);
    const esperado = empresa && empresa.oficialVerifyToken;
    if (req.query['hub.mode'] === 'subscribe' && esperado && req.query['hub.verify_token'] === esperado) {
      return res.status(200).send(req.query['hub.challenge']);
    }
    return res.sendStatus(403);
  } catch (e) {
    return res.sendStatus(403);
  }
});

// Converte uma mensagem do payload da Meta pro formato interno (estilo Z-API).
async function metaMensagemParaInterno(value, msg, cfg, empresaId) {
  const contato = (value.contacts && value.contacts[0]) || {};
  const nome = (contato.profile && contato.profile.name) || null;
  const base = { phone: msg.from, senderName: nome, messageId: msg.id, fromMe: false, isGroup: false };
  if (msg.type === 'text' && msg.text) {
    base.text = { message: msg.text.body };
  } else if (msg.type === 'interactive' && msg.interactive) {
    const it = msg.interactive;
    base.text = { message: (it.button_reply && (it.button_reply.title || it.button_reply.id))
      || (it.list_reply && (it.list_reply.title || it.list_reply.id)) || '' };
  } else if (msg.type === 'button' && msg.button) {
    base.text = { message: msg.button.text || msg.button.payload || '' };
  } else if (['image', 'audio', 'video', 'document'].includes(msg.type) && msg[msg.type]) {
    // Mídia que o CLIENTE mandou (foto, áudio, vídeo, documento). Baixa da Meta e
    // sobe pro nosso Storage (o link da Meta expira em minutos) pra o painel exibir.
    const m = msg[msg.type];
    const baixada = cfg ? await baixarMidiaMetaEUpload(cfg, m.id, empresaId) : null;
    base.midia = { tipo: msg.type, url: baixada ? baixada.url : null, caption: m.caption || m.filename || '' };
    // Sem texto — o roteamento normal (por `texto`) não trata isso; entra só na
    // caixa de entrada pro atendente ver (ver tratarWebhook, bloco de registro).
  } else if (msg.type === 'contacts' && Array.isArray(msg.contacts)) {
    // O nº vem como o contato foi SALVO na agenda de quem compartilhou (ex: "(11)
    // 91234-5678", sem DDI) — sem corrigir, o disparo vai pra um número incompleto
    // e a Meta não entrega (silenciosamente). Prioriza `wa_id` (o ID canônico do
    // WhatsApp, já com DDI) quando a Meta manda; senão completa o 55 nos números
    // brasileiros de 10/11 dígitos, igual já fazemos em outros pontos do código.
    base.contactArray = msg.contacts.map(c => {
      const p0 = (c.phones && c.phones[0]) || {};
      let tel = soDigitos(p0.wa_id || p0.phone || '');
      if (!p0.wa_id && (tel.length === 10 || tel.length === 11) && !tel.startsWith('55')) tel = '55' + tel;
      return { nome: (c.name && c.name.formatted_name) || '', telefone: tel };
    });
  } else if (msg.type === 'location' && msg.location) {
    const loc = msg.location;
    const link = `https://www.google.com/maps?q=${loc.latitude},${loc.longitude}`;
    base.text = { message: `📍 ${loc.name || 'Localização compartilhada'}${loc.address ? ' — ' + loc.address : ''}\n${link}` };
  } else if (msg.type === 'sticker') {
    base.text = { message: '🌟 Figurinha' };
  } else if (msg.type === 'reaction' && msg.reaction) {
    // Reação a uma mensagem antiga — sem o emoji (removeu a reação) não vale nada
    // registrar, ignora silenciosamente.
    if (!msg.reaction.emoji) return null;
    base.text = { message: `reagiu com ${msg.reaction.emoji}` };
  } else {
    return null; // outros tipos não tratados
  }
  return base;
}

// Risquinho de confirmação: atualiza o status (enviado/entregue/lido/falhou) da
// mensagem NOSSA que a Meta identifica pelo wamid — casa por messageId (gravado
// no envio, ver idMensagemMeta). Nunca REGRIDE o status (ex.: um "delivered"
// que chegue atrasado depois do "read" não deve voltar o risquinho pra trás).
async function atualizarStatusMensagem(messageId, statusMeta, errosMeta) {
  if (!messageId) return;
  const mapa = { sent: 'enviado', delivered: 'entregue', read: 'lido', failed: 'falhou' };
  const status = mapa[statusMeta];
  if (!status) return; // status desconhecido — ignora
  try {
    const snap = await MENSAGENS_CHAT_COL().where('messageId', '==', messageId).limit(1).get();
    if (snap.empty) return;
    const doc = snap.docs[0];
    // 'falhou' fica no mesmo nível de 'enviado': substitui um "enviado" que não
    // foi entregue, mas nunca regride um "entregue"/"lido" que chegou depois
    // (webhook fora de ordem). Sem isso 'falhou' nunca era persistido — ordem[status]
    // caía em 0 (chave ausente) e "enviado"(1) > 0 sempre bloqueava a atualização.
    const ordem = { enviado: 1, falhou: 1, entregue: 2, lido: 3 };
    const atual = doc.data().status;
    if (atual && ordem[atual] > (ordem[status] || 0)) return;
    const upd = { status };
    // Guarda o MOTIVO da falha (a Meta manda em statuses[].errors) — sem isso o
    // painel só mostrava "⚠️ Não entregou", sem dizer por quê, obrigando a
    // caçar nos logs do servidor toda vez que alguém perguntava "por que falhou?".
    if (status === 'falhou' && Array.isArray(errosMeta) && errosMeta[0]) {
      upd.erroEntrega = errosMeta[0].title || errosMeta[0].message || `Erro ${errosMeta[0].code || ''}`.trim();
    }
    await doc.ref.update(upd);
  } catch (e) {
    console.error('[WEBHOOK-OFICIAL] erro ao atualizar status da mensagem:', e.message);
  }
}

// Confere que o POST do webhook realmente veio da Meta (header X-Hub-Signature-256,
// HMAC-SHA256 do corpo bruto com o App Secret) — sem isso, qualquer um que descubra
// a URL do webhook e o phone_number_id (visível no perfil público do WhatsApp)
// conseguiria forjar mensagens.
//
// O App Secret é POR EMPRESA (`empresa.oficialAppSecret`), nunca uma env var
// global — cada empresa pode ter seu próprio app na Meta (Phone Number ID/Token/
// WABA diferentes), então um segredo único nunca bateria pra mais de uma ao
// mesmo tempo.
//
// ⚠️ 2026-08-03: rodou em modo bloqueante com um META_APP_SECRET global por ~1h
// e rejeitou 100% das mensagens reais de TODAS as empresas (exatamente o motivo
// acima). Voltou a ser SÓ DIAGNÓSTICO (nunca bloqueia) até confirmarmos nos logs
// que a assinatura calculada aqui bate com a recebida pra pelo menos uma empresa
// com `oficialAppSecret` configurado. NÃO reative o bloqueio sem antes ver
// "[WEBHOOK-OFICIAL] assinatura OK" nos logs em produção.
function assinaturaMetaValida(req, empresa) {
  const secret = empresa && empresa.oficialAppSecret;
  if (!secret) return true;
  const assinatura = req.headers['x-hub-signature-256'];
  if (!assinatura || !req.rawBody) {
    console.warn(`[WEBHOOK-OFICIAL] sem assinatura ou sem corpo bruto (empresa=${empresa.id}, assinatura=${!!assinatura}, rawBody=${!!req.rawBody})`);
    return true;
  }
  const esperado = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  const bufRecebido = Buffer.from(assinatura);
  const bufEsperado = Buffer.from(esperado);
  const bate = bufRecebido.length === bufEsperado.length && crypto.timingSafeEqual(bufRecebido, bufEsperado);
  if (bate) {
    console.log(`[WEBHOOK-OFICIAL] assinatura OK (empresa=${empresa.id})`);
  } else {
    console.warn(`[WEBHOOK-OFICIAL] assinatura não bate (só log, não bloqueia) — empresa=${empresa.id} recebida=${assinatura.slice(0, 25)}... esperada=${esperado.slice(0, 25)}... tamanhos=${bufRecebido.length}/${bufEsperado.length}`);
  }
  return true;
}

async function comWebhookOficial(req, res, empresaId) {
  res.sendStatus(200); // responde rápido; a Meta reentrega se demorar
  try {
    const empresa = await getEmpresaById(empresaId);
    if (!empresa) { console.warn(`[WEBHOOK-OFICIAL] empresaId desconhecido: ${empresaId}`); return; }
    assinaturaMetaValida(req, empresa); // só loga por enquanto (ver comentário na função)
    const oficialCfg = oficialDaEmpresa(empresa);
    for (const entry of ((req.body && req.body.entry) || [])) {
      for (const change of (entry.changes || [])) {
        const value = change.value || {};
        const phoneIdRecebido = value.metadata && value.metadata.phone_number_id;
        if (empresa.oficialPhoneId && phoneIdRecebido && String(phoneIdRecebido) !== String(empresa.oficialPhoneId)) {
          console.warn(`[WEBHOOK-OFICIAL] phone_number_id não confere (${phoneIdRecebido}) — ignorando`);
          continue;
        }
        for (const msg of (value.messages || [])) {
          const interno = await metaMensagemParaInterno(value, msg, oficialCfg, empresa.id);
          if (!interno) continue;
          const contexto = { empresa, empresaId: empresa.id, zapi: zapiDaEmpresa(empresa), oficial: oficialCfg };
          const fakeRes = { sendStatus() {}, status() { return this; }, json() {}, send() {} };
          await tenantContext.run(contexto, () => tratarWebhook({ body: interno }, fakeRes));
        }
        // Risquinho de confirmação (✓✓): a Meta avisa aqui quando uma mensagem NOSSA
        // foi enviada/entregue/lida (ou falhou) pelo destinatário.
        for (const st of (value.statuses || [])) {
          await atualizarStatusMensagem(st.id, st.status, st.errors);
        }
      }
    }
  } catch (e) {
    console.error('[WEBHOOK-OFICIAL] erro:', e.message);
  }
}

app.post('/webhook-oficial/:empresaId', (req, res) => comWebhookOficial(req, res, req.params.empresaId));

// ============================================================
// WEBHOOK DO STRIPE — eventos de pagamento/assinatura
// ============================================================
async function gravarAssinatura(empresaId, dados) {
  await EMPRESAS_COL().doc(empresaId).set({ assinatura: dados }, { merge: true });
}

// Registra a comissão (20%) do vendedor que fechou a empresa, a cada pagamento.
// empresa.vendedorComissao guarda o ID do vendedor (ou um nome livre, legado).
async function registrarComissao(empresa, valorCentavos, origem) {
  try {
    const ref = empresa && empresa.vendedorComissao;
    if (!ref) return;
    const v = Number(valorCentavos) || 0;
    if (v <= 0) return;
    // Resolve nome e % de comissão do vendedor a partir do ID (se for conta cadastrada).
    let vendedorId = null, vendedorNome = String(ref), pct = COMISSAO_PCT;
    try {
      const vd = await VENDEDORES_COL().doc(String(ref)).get();
      if (vd.exists) {
        vendedorId = vd.id;
        vendedorNome = vd.data().nome || String(ref);
        if (vd.data().comissaoPct != null && Number(vd.data().comissaoPct) >= 0) pct = Number(vd.data().comissaoPct);
      }
    } catch (e) {}
    await COMISSOES_COL().add({
      empresaId: empresa.id,
      empresaNome: empresa.nome || '',
      vendedorId,
      vendedor: vendedorNome,
      valorPagoCentavos: v,
      percentual: pct,
      comissaoCentavos: Math.round(v * pct / 100),
      origem: origem || '',
      pago: false,
      data: new Date().toISOString()
    });
    console.log(`[COMISSAO] ${vendedorNome} (${pct}%): R$${(v * pct / 100 / 100).toFixed(2)} (empresa ${empresa.id})`);
  } catch (e) { console.error('[COMISSAO] erro:', e.message); }
}
function dataMaisMeses(meses) {
  const d = new Date();
  d.setMonth(d.getMonth() + meses);
  return d.toISOString();
}

app.post('/webhook-stripe', async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.sendStatus(200);
  let evento;
  try {
    const sig = req.headers['stripe-signature'];
    evento = stripe.webhooks.constructEvent(req.rawBody, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[STRIPE] assinatura do webhook inválida:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  try {
    const obj = evento.data.object;
    if (evento.type === 'checkout.session.completed') {
      // Cadastro self-service (sem empresa ainda): cria a conta como backup.
      if (obj.metadata && obj.metadata.tipo === 'signup') {
        try {
          const emp = await garantirContaSignup(obj);
          // Pagamento único (semestral/anual): comissão aqui. Mensal: no invoice.paid.
          if (emp && obj.mode === 'payment') await registrarComissao(emp, obj.amount_total, 'venda-avista');
          console.log('[STRIPE] conta de signup garantida via webhook');
        } catch (e) { console.error('[STRIPE] erro ao criar conta de signup:', e.message); }
        return res.sendStatus(200);
      }
      const empresaId = (obj.metadata && obj.metadata.empresaId) || obj.client_reference_id;
      const planoId = obj.metadata && obj.metadata.plano;
      const plano = PLANOS[planoId];
      if (empresaId && plano) {
        const base = {
          stripeCustomerId: obj.customer || null,
          ciclo: planoId,
          status: 'ativa',
          atualizadoEm: new Date().toISOString()
        };
        if (obj.mode === 'payment') {
          // Pagamento único: libera N meses a partir de agora.
          base.acessoAte = dataMaisMeses(plano.meses);
        } else if (obj.mode === 'subscription') {
          base.stripeSubId = obj.subscription || null;
          base.acessoAte = dataMaisMeses(1); // corrigido no invoice.paid
        }
        await gravarAssinatura(empresaId, base);
        // Pagamento único de empresa existente: comissão aqui (assinatura → invoice.paid).
        if (obj.mode === 'payment') {
          const ed = await EMPRESAS_COL().doc(empresaId).get();
          if (ed.exists) await registrarComissao({ id: ed.id, ...ed.data() }, obj.amount_total, 'venda-avista');
        }
        console.log(`[STRIPE] checkout concluído — empresa ${empresaId}, plano ${planoId}`);
      }
    } else if (evento.type === 'invoice.paid') {
      const empresa = await acharEmpresaPorStripeCustomer(obj.customer);
      if (empresa) {
        let acessoAte = dataMaisMeses(1);
        const linha = obj.lines && obj.lines.data && obj.lines.data[0];
        if (linha && linha.period && linha.period.end) acessoAte = new Date(linha.period.end * 1000).toISOString();
        await gravarAssinatura(empresa.id, {
          ...(empresa.assinatura || {}), status: 'ativa', acessoAte, atualizadoEm: new Date().toISOString()
        });
        // Comissão a cada mensalidade paga (inclui a 1ª da assinatura mensal).
        await registrarComissao(empresa, obj.amount_paid, 'mensalidade');
        console.log(`[STRIPE] fatura paga — empresa ${empresa.id}`);
      }
    } else if (evento.type === 'invoice.payment_failed') {
      const empresa = await acharEmpresaPorStripeCustomer(obj.customer);
      if (empresa) {
        await gravarAssinatura(empresa.id, {
          ...(empresa.assinatura || {}), status: 'atrasada', atualizadoEm: new Date().toISOString()
        });
        console.log(`[STRIPE] pagamento falhou — empresa ${empresa.id}`);
      }
    } else if (evento.type === 'customer.subscription.deleted') {
      const empresa = await acharEmpresaPorStripeCustomer(obj.customer);
      if (empresa) {
        await gravarAssinatura(empresa.id, {
          ...(empresa.assinatura || {}), status: 'cancelada', atualizadoEm: new Date().toISOString()
        });
        console.log(`[STRIPE] assinatura cancelada — empresa ${empresa.id}`);
      }
    }
  } catch (err) {
    console.error('[STRIPE] erro ao processar evento:', err.message);
  }
  res.sendStatus(200);
});

// ============================================================
// ROTAS DE ADMINISTRAÇÃO
// ============================================================

app.use('/assets', express.static(path.join(__dirname, 'assets')));

app.get('/previa', (req, res) => {
  res.sendFile(path.join(__dirname, 'landing-nova.html'));
});

app.get('/logos', (req, res) => {
  res.sendFile(path.join(__dirname, 'logos.html'));
});


app.get('/recomendometro', (req, res) => {
  res.sendFile(path.join(__dirname, 'recomendometro.html'));
});

// Captura de lead qualificado do Recomendômetro (público).
app.post('/recomendometro/lead', async (req, res) => {
  try {
    const b = req.body || {};
    const nome = String(b.nome || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    const telefone = String(b.telefone || '').trim();
    if (!nome || (!email && !telefone)) return res.status(400).json({ ok: false, erro: 'Dados incompletos' });
    await db.collection('recomendometro_leads').add({
      nome, email, telefone,
      ramo: b.ramo || '',
      clientesDia: Number(b.vendas) || null,
      ticket: Number(b.ticket) || null,
      diasMes: Number(b.dias) || null,
      temPrograma: b.programa || '',
      vendeIndicacao: b.indicacao || '',
      faturamentoMes: Number(b.receitaMes) || null,
      ganhoMes: Number(b.ganhoMes) || null,
      perda12: Number(b.perda12) || null,
      origem: 'recomendometro',
      criadoEm: new Date().toISOString()
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Lista os leads do Recomendômetro (somente o dono).
app.get('/admin/recomendometro-leads', exigirAdmin, async (req, res) => {
  try {
    const snap = await db.collection('recomendometro_leads').get();
    const leads = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => new Date(b.criadoEm || 0) - new Date(a.criadoEm || 0));
    res.json({ ok: true, leads });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.get('/cabeleireiro', (req, res) => res.sendFile(path.join(__dirname, 'recomendometro-cabeleireiro.html')));

app.get('/estetica', (req, res) => res.sendFile(path.join(__dirname, 'recomendometro-estetica.html')));

app.get('/barbearia', (req, res) => res.sendFile(path.join(__dirname, 'recomendometro-barbearia.html')));

app.get('/dentista', (req, res) => res.sendFile(path.join(__dirname, 'recomendometro-dentista.html')));

// Calculadora de custo de disparo (API Oficial) — página aberta, pra usar na
// hora do orçamento com o cliente (celular/notebook, sem login).
app.get('/calculadora', (req, res) => res.sendFile(path.join(__dirname, 'calculadora.html')));

app.get('/', (req, res) => {
  if (req.hostname === 'dentista.recomendaleads.com.br') return res.sendFile(path.join(__dirname, 'recomendometro-dentista.html'));
  res.sendFile(path.join(__dirname, 'landing-nova.html'));
});

// Design system compartilhado por todas as telas
app.get('/theme.css', (req, res) => {
  res.type('text/css');
  res.sendFile(path.join(__dirname, 'theme.css'));
});

app.get('/configurar-vouchers', (req, res) => {
  res.sendFile(path.join(__dirname, 'configurar-vouchers.html'));
});

app.get('/minha-empresa/configurar', (req, res) => {
  res.sendFile(path.join(__dirname, 'minha-empresa-configurar.html'));
});

app.get('/crm', (req, res) => {
  res.sendFile(path.join(__dirname, 'crm.html'));
});

app.get('/conversas', (req, res) => {
  res.sendFile(path.join(__dirname, 'conversas.html'));
});

// ============================================================
// SISTEMA DE LOGIN
// ============================================================

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

// Contrato de assinatura / Termos de Uso / Política de Privacidade (público).
app.get('/contrato', (req, res) => {
  res.sendFile(path.join(__dirname, 'contrato.html'));
});

app.post('/login', limiteLogin, async (req, res) => {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) {
      return res.status(400).json({ ok: false, erro: 'Informe email e senha' });
    }

    const emailNorm = String(email).trim().toLowerCase();

    // Modelo novo: busca o usuário em `usuarios`. Fallback: empresas_login
    // (legado), caso a migração ainda não tenha rodado para esta conta.
    let usuario = null;
    const snapU = await USUARIOS_COL().where('email', '==', emailNorm).limit(1).get();
    if (!snapU.empty) {
      const d = snapU.docs[0];
      usuario = { id: d.id, ...d.data() };
    } else {
      const snapE = await EMPRESAS_COL().where('email', '==', emailNorm).limit(1).get();
      if (!snapE.empty) {
        const d = snapE.docs[0];
        const e = d.data();
        // Cadastro feito pelo link do cliente e ainda não validado pelo dono: sem acesso.
        usuario = { id: null, empresaId: d.id, nome: e.nome, email: emailNorm, senhaHash: e.senhaHash, papel: 'gestor', senhaProvisoria: !!e.senhaProvisoria, ativo: !e.pendenteAprovacao, pendente: !!e.pendenteAprovacao };
      }
    }

    if (usuario && usuario.pendente) {
      return res.status(403).json({ ok: false, erro: 'Seu cadastro está em análise. Você receberá um e-mail assim que for liberado.' });
    }
    if (!usuario || usuario.ativo === false) {
      return res.status(401).json({ ok: false, erro: 'Email ou senha incorretos' });
    }

    const senhaValida = await bcrypt.compare(senha, usuario.senhaHash || '');
    if (!senhaValida) {
      return res.status(401).json({ ok: false, erro: 'Email ou senha incorretos' });
    }

    // Nome da empresa para exibição (e compatibilidade com o painel atual).
    let nomeEmpresa = usuario.nome;
    let ofertaNome = null;
    try {
      const empDoc = await EMPRESAS_COL().doc(usuario.empresaId).get();
      if (empDoc.exists) {
        const empData = empDoc.data();
        nomeEmpresa = empData.nome || nomeEmpresa;
        // Rede de lojas: usuário preso a uma loja só entra se a matriz liberou o
        // acesso daquela loja (mesma checagem que exigirLoginEmpresa faz depois
        // em toda requisição — aqui é só pra dar um erro claro já no login).
        if (usuario.ofertaId) {
          const ofertasCfg = (empData.configuracao && empData.configuracao.ofertas) || {};
          const minhaOferta = ofertasCfg[usuario.ofertaId];
          if (!minhaOferta || !minhaOferta.acessoLiberado) {
            return res.status(403).json({ ok: false, erro: 'O acesso da sua loja foi suspenso. Fale com a matriz.' });
          }
          ofertaNome = minhaOferta.nomeOferta || usuario.ofertaId;
        }
      }
    } catch (_) {}

    const token = jwt.sign(
      { usuarioId: usuario.id, empresaLoginId: usuario.empresaId, papel: usuario.papel },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.json({
      ok: true,
      token,
      usuario: { nome: usuario.nome, email: usuario.email, papel: usuario.papel },
      empresa: {
        id: usuario.empresaId, nome: nomeEmpresa, email: usuario.email, papel: usuario.papel,
        senhaProvisoria: !!usuario.senhaProvisoria,
        // Rede de lojas: presente só quando o usuário está preso a uma loja.
        ofertaId: usuario.ofertaId || null,
        ofertaNome
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Troca de senha — usada na obrigatoriedade do primeiro acesso (e quando o
// cliente quiser trocar). Remove o flag de senha provisória.
app.post('/minha-senha', exigirLoginEmpresa, async (req, res) => {
  try {
    const { novaSenha } = req.body;
    if (!novaSenha || novaSenha.length < 6) {
      return res.status(400).json({ ok: false, erro: 'A nova senha precisa ter ao menos 6 caracteres' });
    }
    const senhaHash = await bcrypt.hash(novaSenha, 10);
    if (req.usuario && req.usuario.id) {
      // Modelo novo: troca a senha do próprio usuário logado.
      await USUARIOS_COL().doc(req.usuario.id).set(
        { senhaHash, senhaProvisoria: false },
        { merge: true }
      );
    } else {
      // Legado (token antigo, sem usuarioId): mantém o comportamento anterior.
      await EMPRESAS_COL().doc(req.empresaLogin.id).set(
        { senhaHash, senhaProvisoria: false },
        { merge: true }
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ============================================================
// CONTRATO DE ASSINATURA — aceite eletrônico (LGPD/CDC, Arts. 22 e 26.8)
// ============================================================
// Versão vigente do contrato. Ao publicar uma nova versão, troque aqui para
// re-exigir o aceite de todas as empresas.
const CONTRATO_VERSAO = '1.0-2026-06-26';

// Status do aceite da empresa logada.
app.get('/meu-contrato', exigirLoginEmpresa, async (req, res) => {
  try {
    const aceite = req.empresaLogin.contratoAceite || null;
    const aceito = !!(aceite && aceite.versao === CONTRATO_VERSAO);
    res.json({ ok: true, aceito, versaoAtual: CONTRATO_VERSAO, aceite });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Registra o aceite (apenas gestor aceita em nome da empresa). Grava versão,
// data/hora, IP e quem aceitou — prova do aceite eletrônico.
app.post('/meu-contrato/aceitar', exigirLoginEmpresa, exigirGestor, async (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
    const aceite = {
      versao: CONTRATO_VERSAO,
      em: new Date().toISOString(),
      ip,
      porUsuarioId: (req.usuario && req.usuario.id) || null,
      porEmail: (req.usuario && req.usuario.email) || req.empresaLogin.email || ''
    };
    await EMPRESAS_COL().doc(req.empresaLogin.id).set({ contratoAceite: aceite }, { merge: true });
    res.json({ ok: true, aceite });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ============================================================
// ASSINATURA — Stripe (status, checkout)
// ============================================================

// Status da assinatura da empresa logada + planos disponíveis.
app.get('/minha-assinatura', exigirLoginEmpresa, async (req, res) => {
  try {
    const st = billingStatus(req.empresaLogin);
    const planos = Object.entries(PLANOS).map(([id, p]) => ({
      id, nome: p.nome, tipo: p.tipo, meses: p.meses,
      valorCentavos: p.valorCentavos, descricao: p.descricao
    }));
    res.json({ ok: true, assinatura: st, planos, stripeConfigurado: !!stripe });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Aviso global ativo (popup) — visto pelo cliente logado.
// Lista de avisos ativos (Mensagens do sistema), mais recentes primeiro.
app.get('/avisos', exigirLoginEmpresa, async (req, res) => {
  try {
    const snap = await AVISOS_COL().where('ativo', '==', true).get();
    const avisos = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => new Date(b.criadoEm || 0) - new Date(a.criadoEm || 0));
    res.json({ ok: true, avisos });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Aviso mais recente (compatível com o popup atual).
app.get('/aviso', exigirLoginEmpresa, async (req, res) => {
  try {
    const snap = await AVISOS_COL().where('ativo', '==', true).get();
    const avisos = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => new Date(b.criadoEm || 0) - new Date(a.criadoEm || 0));
    res.json({ ok: true, aviso: avisos[0] || null });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Cria a sessão de checkout tentando os métodos pedidos; se algum (pix/boleto)
// não estiver ativado no painel do Stripe, cai pra CARTÃO em vez de quebrar tudo.
async function criarCheckoutSession(params, metodos) {
  const lista = (metodos && metodos.length) ? metodos : ['card'];
  try {
    return await stripe.checkout.sessions.create({ ...params, payment_method_types: lista });
  } catch (err) {
    const msg = (err && err.message) || '';
    if (lista.some(m => m !== 'card') && /payment[_ ]method|is invalid|not activated|ativad/i.test(msg)) {
      console.warn('[STRIPE] método não ativado, caindo pra cartão:', msg);
      return await stripe.checkout.sessions.create({ ...params, payment_method_types: ['card'] });
    }
    throw err;
  }
}

// Cria a sessão de checkout do Stripe para o plano escolhido (apenas gestor).
app.post('/minha-assinatura/checkout', exigirLoginEmpresa, exigirGestor, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ ok: false, erro: 'Pagamento ainda não configurado.' });
    const planoId = String((req.body && req.body.plano) || '').toLowerCase();
    const plano = PLANOS[planoId];
    if (!plano) return res.status(400).json({ ok: false, erro: 'Plano inválido' });

    const empresa = req.empresaLogin;
    // Reaproveita ou cria o customer do Stripe para esta empresa.
    let customerId = empresa.assinatura && empresa.assinatura.stripeCustomerId;
    if (!customerId) {
      const cliente = await stripe.customers.create({
        email: empresa.email || undefined,
        name: empresa.nome || undefined,
        metadata: { empresaId: empresa.id }
      });
      customerId = cliente.id;
      await EMPRESAS_COL().doc(empresa.id).set(
        { assinatura: { ...(empresa.assinatura || {}), stripeCustomerId: customerId } },
        { merge: true }
      );
    }

    const base = urlBase(req);
    const ehAssinatura = plano.tipo === 'assinatura';
    const session = await criarCheckoutSession({
      mode: ehAssinatura ? 'subscription' : 'payment',
      customer: customerId,
      client_reference_id: empresa.id,
      metadata: { empresaId: empresa.id, plano: planoId },
      ...(ehAssinatura ? { subscription_data: { metadata: { empresaId: empresa.id, plano: planoId } } } : {}),
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'brl',
          unit_amount: plano.valorCentavos,
          product_data: { name: `RecomendaLeads — Plano ${plano.nome}` },
          ...(ehAssinatura ? { recurring: { interval: plano.intervalo, interval_count: plano.intervaloQtd } } : {})
        }
      }],
      success_url: `${base}/minha-empresa/configurar?assinatura=ok`,
      cancel_url: `${base}/minha-empresa/configurar?assinatura=cancelado`
    }, ehAssinatura ? ['card'] : plano.metodos);
    res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error('Erro no checkout Stripe:', err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ============================================================
// ONBOARDING SELF-SERVICE (público): /assinar → pagar → /completar
// ============================================================

// Lista pública de planos (para a página /assinar).
app.get('/planos', (req, res) => {
  const planos = Object.entries(PLANOS).map(([id, p]) => ({
    id, nome: p.nome, tipo: p.tipo, meses: p.meses, valorCentavos: p.valorCentavos, descricao: p.descricao
  }));
  res.json({ ok: true, planos });
});

app.get('/assinar', (req, res) => res.sendFile(path.join(__dirname, 'assinar.html')));
app.get('/completar', (req, res) => res.sendFile(path.join(__dirname, 'completar.html')));

// Cadastro público de autoatendimento: o cliente cria a conta (BLOQUEADA) e, na
// sequência, escolhe o plano e paga (o pagamento libera o acesso). Link aberto.
app.get('/cadastro', (req, res) => res.sendFile(path.join(__dirname, 'cadastro.html')));
app.post('/cadastro', async (req, res) => {
  try {
    const b = req.body || {};
    const nomeEmpresa = String(b.nomeFantasia || b.nome || '').trim();
    const emailLogin = String(b.email || '').trim().toLowerCase();
    const senha = String(b.senha || '');
    const telefone = String(b.telefone || '').trim();
    const nomeSocio = String(b.nomeSocio || '').trim();
    const vendedor = String(b.vendedor || '').trim().slice(0, 60);
    if (!nomeEmpresa || !emailLogin || senha.length < 6) {
      return res.status(400).json({ ok: false, erro: 'Preencha o nome da empresa, um e-mail e uma senha de ao menos 6 caracteres.' });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailLogin)) {
      return res.status(400).json({ ok: false, erro: 'E-mail inválido.' });
    }
    const [empExiste, usrExiste] = await Promise.all([
      EMPRESAS_COL().where('email', '==', emailLogin).limit(1).get(),
      USUARIOS_COL().where('email', '==', emailLogin).limit(1).get()
    ]);
    if (!empExiste.empty || !usrExiste.empty) {
      return res.status(409).json({ ok: false, erro: 'Já existe uma conta com esse e-mail. Faça login.' });
    }
    // Conta BLOQUEADA (status 'pendente', sem acessoAte) — o pagamento libera.
    const ref = await EMPRESAS_COL().add({
      nome: nomeEmpresa,
      email: emailLogin,
      cadastro: { nomeFantasia: nomeEmpresa, emailEmpresa: emailLogin, telefoneEmpresa: telefone || null, nomeSocio: nomeSocio || null },
      configuracao: { ...EMPRESA_PADRAO, nome: nomeEmpresa },
      ...(vendedor ? { vendedorComissao: vendedor } : {}),
      assinatura: { status: 'pendente', acessoAte: null, atualizadoEm: new Date().toISOString() },
      criadoEm: new Date().toISOString()
    });
    const senhaHash = await bcrypt.hash(senha, 10);
    const uref = await USUARIOS_COL().add({
      empresaId: ref.id, nome: nomeSocio || nomeEmpresa, email: emailLogin, senhaHash,
      papel: 'gestor', senhaProvisoria: false, ativo: true, criadoEm: new Date().toISOString()
    });
    const token = jwt.sign({ usuarioId: uref.id, empresaLoginId: ref.id, papel: 'gestor' }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ ok: true, token, empresa: { id: ref.id, nome: nomeEmpresa, email: emailLogin, papel: 'gestor', senhaProvisoria: false } });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Checkout público (sem login) — cria a sessão e manda pro Stripe.
app.post('/assinar/checkout', async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ ok: false, erro: 'Pagamento ainda não configurado.' });
    const planoId = String((req.body && req.body.plano) || '').toLowerCase();
    const plano = PLANOS[planoId];
    if (!plano) return res.status(400).json({ ok: false, erro: 'Plano inválido' });
    const vendedor = String((req.body && req.body.vendedor) || '').trim().slice(0, 60);
    const base = urlBase(req);
    const ehAssinatura = plano.tipo === 'assinatura';
    // Boleto só entra quando o VENDEDOR manda o link com ?boleto=1 (não no automático).
    const comBoleto = !!(req.body && req.body.boleto);
    const metodos = ehAssinatura ? ['card'] : ((comBoleto && plano.metodosVendedor) ? plano.metodosVendedor : plano.metodos);
    const meta = { tipo: 'signup', plano: planoId, ...(vendedor ? { vendedor } : {}) };
    const session = await criarCheckoutSession({
      mode: ehAssinatura ? 'subscription' : 'payment',
      metadata: meta,
      ...(ehAssinatura ? { subscription_data: { metadata: meta } } : { customer_creation: 'always' }),
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'brl',
          unit_amount: plano.valorCentavos,
          product_data: { name: `RecomendaLeads — Plano ${plano.nome}` },
          ...(ehAssinatura ? { recurring: { interval: plano.intervalo, interval_count: plano.intervaloQtd } } : {})
        }
      }],
      success_url: `${base}/completar?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/assinar?cancelado=1`
    }, metodos);
    res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error('Erro no checkout público:', err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Cria a conta (empresa) a partir de uma sessão de checkout paga (idempotente).
async function garantirContaSignup(session) {
  const plano = PLANOS[session.metadata && session.metadata.plano];
  if (!plano) return null;
  const existe = await EMPRESAS_COL().where('assinatura.stripeSessionId', '==', session.id).limit(1).get();
  if (!existe.empty) { const d = existe.docs[0]; return { id: d.id, ...d.data() }; }
  const email = ((session.customer_details && session.customer_details.email) || session.customer_email || '').toLowerCase();
  const ref = await EMPRESAS_COL().add({
    nome: 'Nova empresa',
    email,
    cadastroIncompleto: true,
    ...(session.metadata && session.metadata.vendedor ? { vendedorComissao: session.metadata.vendedor } : {}),
    assinatura: {
      stripeSessionId: session.id,
      stripeCustomerId: session.customer || null,
      stripeSubId: session.subscription || null,
      ciclo: session.metadata.plano,
      status: 'ativa',
      acessoAte: dataMaisMeses(plano.tipo === 'assinatura' ? 1 : plano.meses),
      atualizadoEm: new Date().toISOString()
    },
    criadoEm: new Date().toISOString()
  });
  const snap = await ref.get();
  return { id: ref.id, ...snap.data() };
}

// Status pós-pagamento: confirma o pagamento e garante a conta criada.
app.get('/completar/status', async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ ok: false, erro: 'Pagamento não configurado.' });
    const sid = String(req.query.session_id || '');
    if (!sid) return res.status(400).json({ ok: false, erro: 'Sessão ausente' });
    const session = await stripe.checkout.sessions.retrieve(sid);
    if (session.payment_status !== 'paid') return res.json({ ok: true, pronto: false });
    const empresa = await garantirContaSignup(session);
    if (!empresa) return res.status(400).json({ ok: false, erro: 'Sessão inválida' });
    res.json({ ok: true, pronto: true, email: empresa.email || '', jaCompleto: !empresa.cadastroIncompleto });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Finaliza o cadastro: salva dados, cria o usuário gestor, registra o aceite
// do contrato e devolve um token (auto-login).
app.post('/completar', async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ ok: false, erro: 'Pagamento não configurado.' });
    const { session_id, dados, senha, aceiteContrato } = req.body || {};
    if (!senha || String(senha).length < 6) return res.status(400).json({ ok: false, erro: 'A senha precisa ter ao menos 6 caracteres.' });
    if (!aceiteContrato) return res.status(400).json({ ok: false, erro: 'É necessário aceitar o contrato.' });
    const session = await stripe.checkout.sessions.retrieve(String(session_id || ''));
    if (session.payment_status !== 'paid') return res.status(400).json({ ok: false, erro: 'Pagamento não confirmado.' });
    const empresa = await garantirContaSignup(session);
    if (!empresa) return res.status(400).json({ ok: false, erro: 'Sessão inválida' });

    const emailNorm = (empresa.email || '').toLowerCase();
    const jaExiste = await USUARIOS_COL().where('email', '==', emailNorm).limit(1).get();
    if (!jaExiste.empty) return res.status(409).json({ ok: false, erro: 'Esse e-mail já tem conta. Faça login.' });

    const cad = dados || {};
    const nome = (cad.nomeFantasia || cad.razaoSocial || cad.nome || empresa.nome || 'Empresa').trim();
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
    await EMPRESAS_COL().doc(empresa.id).set({
      nome,
      cadastro: cad,
      cadastroIncompleto: false,
      contratoAceite: { versao: CONTRATO_VERSAO, em: new Date().toISOString(), ip, porEmail: emailNorm }
    }, { merge: true });

    const senhaHash = await bcrypt.hash(String(senha), 10);
    const uref = await USUARIOS_COL().add({
      empresaId: empresa.id,
      nome: (cad.nomeSocio || nome),
      email: emailNorm,
      senhaHash,
      papel: 'gestor',
      senhaProvisoria: false,
      ativo: true,
      criadoEm: new Date().toISOString()
    });

    const token = jwt.sign({ usuarioId: uref.id, empresaLoginId: empresa.id, papel: 'gestor' }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ ok: true, token, empresa: { id: empresa.id, nome, email: emailNorm, papel: 'gestor', senhaProvisoria: false } });

    // E-mail de boas-vindas (auto-cadastro pago; senha definida pelo cliente)
    enviarBoasVindasCliente({ nomeEmpresa: nome, emailLogin: emailNorm, senha: null, req })
      .catch(e => console.error('[EMAIL] boas-vindas (completar) falhou:', e.message));
  } catch (err) {
    console.error('Erro ao completar cadastro:', err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ============================================================
// EQUIPE — usuários da empresa (apenas gestor)
// ============================================================

// Conta gestores ativos da empresa sem exigir índice composto no Firestore.
async function contarGestoresAtivos(empresaId) {
  const snap = await USUARIOS_COL().where('empresaId', '==', empresaId).get();
  return snap.docs.filter(d => d.data().papel === 'gestor' && d.data().ativo !== false).length;
}
// Garante que só UM usuário da empresa seja o atendente oficial (desmarca os outros).
async function desmarcarOutrosOficiais(empresaId, exceptoId) {
  const snap = await USUARIOS_COL().where('empresaId', '==', empresaId).get();
  const batch = db.batch(); let n = 0;
  snap.docs.forEach(d => { if (d.id !== exceptoId && d.data().atendenteOficial) { batch.update(d.ref, { atendenteOficial: false }); n++; } });
  if (n) await batch.commit();
}

app.get('/minha-equipe', exigirLoginEmpresa, exigirGestor, async (req, res) => {
  try {
    const snap = await USUARIOS_COL().where('empresaId', '==', req.empresaLogin.id).get();
    const agora = Date.now();
    const ofertasCfg = (req.empresaLogin.configuracao && req.empresaLogin.configuracao.ofertas) || {};
    const meuOfertaId = req.usuario && req.usuario.ofertaId;
    let usuarios = snap.docs.map(d => {
      const u = d.data();
      const statusAtendimento = u.statusAtendimento || 'online';
      const online = !!u.telefone && statusAtendimento === 'online' && !!u.ultimaAtividadeEm
        && (agora - new Date(u.ultimaAtividadeEm).getTime()) <= 90 * 1000;
      return {
        id: d.id,
        nome: u.nome,
        email: u.email,
        papel: u.papel,
        telefone: u.telefone || '',
        ativo: u.ativo !== false,
        statusAtendimento,
        online, // pro revezamento: 🟢 = participa agora do carrossel de atendimento
        souEu: !!(req.usuario && req.usuario.id === d.id),
        // Rede de lojas: ausente/null = usuário matriz (vê tudo).
        ofertaId: u.ofertaId || null,
        ofertaNome: u.ofertaId ? ((ofertasCfg[u.ofertaId] && ofertasCfg[u.ofertaId].nomeOferta) || u.ofertaId) : null
      };
    }).sort((a, b) => (a.nome || '').localeCompare(b.nome || ''));
    // Gestor de loja só enxerga a própria equipe, nunca a rede toda.
    if (meuOfertaId) usuarios = usuarios.filter(u => u.ofertaId === meuOfertaId);
    res.json({ ok: true, usuarios });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Lista enxuta (id + nome) da equipe — pra popular seletor de "transferir
// atendimento"/"quem é o dono deste card". Ao contrário de GET /minha-equipe,
// QUALQUER usuário logado pode chamar (não só gestor), pois todo atendente
// pode transferir e precisa ver os nomes dos colegas pra quem transferir.
app.get('/minha-equipe/lista', exigirLoginEmpresa, async (req, res) => {
  try {
    const snap = await USUARIOS_COL().where('empresaId', '==', req.empresaLogin.id).get();
    const meuOfertaId = req.usuario && req.usuario.ofertaId;
    let usuarios = snap.docs
      .map(d => ({ id: d.id, nome: d.data().nome, ativo: d.data().ativo !== false, ofertaId: d.data().ofertaId || null }))
      .filter(u => u.ativo);
    if (meuOfertaId) usuarios = usuarios.filter(u => u.ofertaId === meuOfertaId);
    usuarios.sort((a, b) => (a.nome || '').localeCompare(b.nome || ''));
    res.json({ ok: true, usuarios: usuarios.map(u => ({ id: u.id, nome: u.nome })) });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Heartbeat de presença (o painel manda a cada 30s enquanto a aba fica aberta) —
// usado pelo revezamento de atendimento pra saber quem está online agora.
app.post('/minha-equipe/heartbeat', exigirLoginEmpresa, async (req, res) => {
  try {
    if (req.usuario && req.usuario.id) {
      await USUARIOS_COL().doc(req.usuario.id).set({ ultimaAtividadeEm: new Date().toISOString() }, { merge: true });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Online / Pausa / Offline — o próprio atendente escolhe (em Conversas). Pausa e
// Offline ficam fora do revezamento mesmo com a aba aberta.
app.post('/minha-equipe/status', exigirLoginEmpresa, async (req, res) => {
  try {
    const status = ['online', 'pausa', 'offline'].includes(req.body && req.body.status) ? req.body.status : 'offline';
    if (req.usuario && req.usuario.id) {
      await USUARIOS_COL().doc(req.usuario.id).set({ statusAtendimento: status, ultimaAtividadeEm: new Date().toISOString() }, { merge: true });
    }
    res.json({ ok: true, status });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Estado do próprio usuário logado — pra restaurar o seletor Online/Pausa/Offline
// ao abrir a página (sem precisar ser gestor).
app.get('/minha-equipe/meu-status', exigirLoginEmpresa, async (req, res) => {
  try {
    let status = 'online';
    if (req.usuario && req.usuario.id) {
      const snap = await USUARIOS_COL().doc(req.usuario.id).get();
      if (snap.exists) status = snap.data().statusAtendimento || 'online';
    }
    // `id` vai junto pro painel saber "quem sou eu" e filtrar o alarme de
    // atendimento só pras conversas atribuídas a mim no rodízio.
    res.json({ ok: true, status, id: (req.usuario && req.usuario.id) || null });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post('/minha-equipe', exigirLoginEmpresa, exigirGestor, async (req, res) => {
  try {
    const { nome, email, senha, papel, telefone, atendenteOficial, ofertaId } = req.body;
    if (!nome || !email || !senha) {
      return res.status(400).json({ ok: false, erro: 'Informe nome, email e senha' });
    }
    if (String(senha).length < 6) {
      return res.status(400).json({ ok: false, erro: 'A senha precisa ter ao menos 6 caracteres' });
    }
    const papelFinal = papel === 'gestor' ? 'gestor' : 'atendente';
    const emailNorm = String(email).trim().toLowerCase();
    const existe = await USUARIOS_COL().where('email', '==', emailNorm).limit(1).get();
    if (!existe.empty) {
      return res.status(409).json({ ok: false, erro: 'Já existe um usuário com esse email' });
    }
    // Rede de lojas: quem cria já preso a uma loja só pode criar dentro da
    // própria (nunca confia no corpo); a matriz pode escolher qualquer loja
    // válida (ou nenhuma, pra criar um usuário de nível matriz).
    const meuOfertaId = req.usuario && req.usuario.ofertaId;
    let ofertaIdFinal = null;
    if (meuOfertaId) {
      if (ofertaId !== undefined && ofertaId && ofertaId !== meuOfertaId) {
        return res.status(403).json({ ok: false, erro: 'Você só pode criar usuários da sua própria loja.' });
      }
      ofertaIdFinal = meuOfertaId;
    } else if (ofertaId) {
      const ofertasCfg = (req.empresaLogin.configuracao && req.empresaLogin.configuracao.ofertas) || {};
      if (!ofertasCfg[ofertaId]) return res.status(400).json({ ok: false, erro: 'Loja não encontrada.' });
      ofertaIdFinal = ofertaId;
    }
    const tel = String(telefone || '').replace(/\D/g, '');
    const senhaHash = await bcrypt.hash(String(senha), 10);
    const ref = await USUARIOS_COL().add({
      empresaId: req.empresaLogin.id,
      nome: String(nome).trim(),
      email: emailNorm,
      senhaHash,
      papel: papelFinal,
      telefone: tel,
      atendenteOficial: !!atendenteOficial,
      ofertaId: ofertaIdFinal,
      senhaProvisoria: true,
      ativo: true,
      criadoEm: new Date().toISOString()
    });
    if (atendenteOficial) await desmarcarOutrosOficiais(req.empresaLogin.id, ref.id);
    res.json({ ok: true, id: ref.id });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.patch('/minha-equipe/:id', exigirLoginEmpresa, exigirGestor, async (req, res) => {
  try {
    const ref = USUARIOS_COL().doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists || doc.data().empresaId !== req.empresaLogin.id) {
      return res.status(404).json({ ok: false, erro: 'Usuário não encontrado' });
    }
    const alvo = doc.data();
    const meuOfertaId = req.usuario && req.usuario.ofertaId;
    // Rede de lojas: gestor de loja só mexe em usuários da própria loja — trata
    // como "não encontrado" pros de fora, mesma resposta do mismatch de empresa.
    if (meuOfertaId && alvo.ofertaId !== meuOfertaId) {
      return res.status(404).json({ ok: false, erro: 'Usuário não encontrado' });
    }
    const { nome, papel, novaSenha, telefone, atendenteOficial, ofertaId } = req.body;
    const update = {};
    if (nome) update.nome = String(nome).trim();
    if (telefone !== undefined) update.telefone = String(telefone || '').replace(/\D/g, '');
    if (atendenteOficial !== undefined) update.atendenteOficial = !!atendenteOficial;
    if (ofertaId !== undefined) {
      if (meuOfertaId) {
        if (ofertaId && ofertaId !== meuOfertaId) {
          return res.status(403).json({ ok: false, erro: 'Você só pode gerenciar usuários da sua própria loja.' });
        }
        update.ofertaId = meuOfertaId;
      } else if (!ofertaId) {
        update.ofertaId = null;
      } else {
        const ofertasCfg = (req.empresaLogin.configuracao && req.empresaLogin.configuracao.ofertas) || {};
        if (!ofertasCfg[ofertaId]) return res.status(400).json({ ok: false, erro: 'Loja não encontrada.' });
        update.ofertaId = ofertaId;
      }
    }
    if (papel === 'gestor' || papel === 'atendente') {
      // Não permitir rebaixar o último gestor da empresa.
      if (alvo.papel === 'gestor' && papel !== 'gestor' && (await contarGestoresAtivos(req.empresaLogin.id)) <= 1) {
        return res.status(409).json({ ok: false, erro: 'A empresa precisa de ao menos um gestor.' });
      }
      update.papel = papel;
    }
    if (novaSenha) {
      if (String(novaSenha).length < 6) {
        return res.status(400).json({ ok: false, erro: 'A senha precisa ter ao menos 6 caracteres' });
      }
      update.senhaHash = await bcrypt.hash(String(novaSenha), 10);
      update.senhaProvisoria = true;
    }
    if (!Object.keys(update).length) {
      return res.status(400).json({ ok: false, erro: 'Nada para atualizar' });
    }
    await ref.set(update, { merge: true });
    // Só um oficial por empresa: se marcou este, desmarca os outros.
    if (update.atendenteOficial) await desmarcarOutrosOficiais(req.empresaLogin.id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Dispara uma mensagem de TESTE pro número do atendente, pra confirmar que chega.
app.post('/minha-atendente/testar', exigirLoginEmpresa, exigirGestor, async (req, res) => {
  try {
    const numero = String((req.body && req.body.numero) || '').replace(/\D/g, '');
    if (numero.length < 10) return res.status(400).json({ ok: false, erro: 'Número inválido — use DDD + número.' });
    const empresa = await getEmpresaById(req.empresaLogin.id);
    const contexto = { empresa, empresaId: req.empresaLogin.id, zapi: zapiDaEmpresa(empresa) };
    const enviado = await tenantContext.run(contexto, async () => {
      return await enviarSemLog(numero, `🔔 *Teste do RecomendaLeads*\n\nSe você recebeu esta mensagem, o *aviso de atendimento está funcionando!* ✅\n\nÉ assim que você vai ser avisado quando um cliente pedir pra falar com um atendente.`);
    });
    if (enviado) return res.json({ ok: true });
    res.status(502).json({ ok: false, erro: 'Não consegui enviar. Confira se o WhatsApp da empresa está conectado e se o número está certo.' });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// DIAGNÓSTICO DE ENTREGA — envia pelo caminho REAL (Z-API send-text) e devolve a
// resposta CRUA da Z-API, a instância usada, se o número tem WhatsApp e o formato
// canônico. Serve pra ver a VERDADE na tela quando "sai do sistema mas não chega".
app.post('/minha-entrega/testar', exigirLoginEmpresa, exigirGestor, async (req, res) => {
  try {
    const numero = String((req.body && req.body.numero) || '').replace(/\D/g, '');
    if (numero.length < 10) return res.status(400).json({ ok: false, erro: 'Número inválido — use DDD + número (com o 55 se quiser).' });
    const empresa = await getEmpresaById(req.empresaLogin.id);

    // Modo API Oficial (Meta): envia pela Cloud API, NÃO pela Z-API. Fora da janela
    // de 24h só template passa — então testa com o template configurado (se houver).
    if (empresa.whatsappTipo === 'oficial') {
      const oficial = oficialDaEmpresa(empresa);
      const out = { canal: 'oficial', numeroOriginal: numero, numeroEnviado: soDigitos(numero), phoneId: oficial && oficial.phoneId };
      if (!oficial) return res.json({ ok: true, resultado: { ...out, aceitou: false, zapiResposta: 'Credenciais oficiais não configuradas (Phone Number ID + Token).' } });
      // Aceita um template específico no body (ex.: testar o template do disparo);
      // senão usa o template do recomendado configurado.
      const tpl = (req.body && req.body.template && String(req.body.template).trim()) || empresa.oficialTemplateRecomendado;
      let payload;
      if (tpl) {
        const info = await getTemplateInfo(oficial, tpl);
        let nVars = info ? info.n : null;
        if (nVars === null || nVars === undefined) nVars = 3;
        // Usa o idioma REAL aprovado na Meta pra esse template — antes mandava
        // sempre 'pt_BR' fixo, então testar um template aprovado noutro idioma
        // (ex.: hello_world, que é en_US) sempre dava "does not exist in
        // pt_BR", mesmo o template existindo (só existia noutro idioma).
        const idioma = (info && info.idioma) || 'pt_BR';
        const exemplo = ['Teste', 'RecomendaLeads', 'Equipe'].slice(0, Math.min(nVars, 3));
        const components = exemplo.length ? [{ type: 'body', parameters: exemplo.map(t => ({ type: 'text', text: t })) }] : [];
        payload = { messaging_product: 'whatsapp', to: soDigitos(numero), type: 'template', template: { name: tpl, language: { code: idioma }, components } };
        out.template = tpl;
        out.idioma = idioma;
      } else {
        payload = { messaging_product: 'whatsapp', to: soDigitos(numero), type: 'text', text: { body: `🧪 Teste RecomendaLeads (API Oficial) — ${new Date().toLocaleTimeString('pt-BR')}` } };
      }
      try {
        const r = await axios.post(metaMessagesUrl(oficial), payload, { headers: metaHeaders(oficial) });
        out.httpStatus = r.status; out.aceitou = true; out.zapiResposta = r.data;
        out.messageId = r.data && r.data.messages && r.data.messages[0] && r.data.messages[0].id;
      } catch (e) {
        out.httpStatus = e.response?.status || 0; out.aceitou = false; out.zapiResposta = e.response?.data || e.message;
      }
      return res.json({ ok: true, resultado: out });
    }

    const contexto = { empresa, empresaId: req.empresaLogin.id, zapi: zapiDaEmpresa(empresa) };
    const resultado = await tenantContext.run(contexto, async () => {
      const cfg = zapiAtual();
      const out = { instanceId: (cfg && cfg.instanceId) || null, numeroOriginal: numero };
      // 1) O número tem WhatsApp? Qual o formato canônico?
      for (const rota of [`/phone-exists/${numero}`, `/contacts/iswhatsapp/${numero}`]) {
        try {
          const chk = await axios.get(`${zapiBaseUrl(cfg)}${rota}`, { headers: zapiHeaders(cfg), timeout: 8000 });
          out.checagem = chk.data; break;
        } catch (e) { out.checagem = { erroChecagem: e.response?.status || e.message }; }
      }
      const canonico = await resolverNumeroZapi(cfg, numero);
      out.numeroEnviado = canonico;
      out.corrigido = canonico !== numero;
      // 2) Envia DE VERDADE e captura a resposta crua da Z-API.
      try {
        const r = await axios.post(`${zapiBaseUrl(cfg)}/send-text`,
          { phone: canonico, message: `🧪 Teste de entrega RecomendaLeads — ${new Date().toLocaleTimeString('pt-BR')}` },
          { headers: zapiHeaders(cfg) });
        out.httpStatus = r.status; out.zapiResposta = r.data; out.aceitou = true;
      } catch (e) {
        out.httpStatus = e.response?.status || 0; out.zapiResposta = e.response?.data || e.message; out.aceitou = false;
      }
      // Espera o callback "Ao enviar" (DeliveryCallback) chegar, pra mostrar na tela o
      // motivo REAL da (não) entrega. Só funciona se o webhook "Ao enviar" estiver
      // configurado na Z-API apontando pro nosso /webhook. Espera até ~10s.
      const mid = String((out.zapiResposta && (out.zapiResposta.messageId || out.zapiResposta.id)) || '').toUpperCase();
      out.messageId = mid;
      if (mid) {
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 1000));
          const cb = _statusCallbacks.get(mid);
          if (cb) { out.deliveryCallback = cb.body; break; }
        }
      }
      return out;
    });
    res.json({ ok: true, resultado });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.delete('/minha-equipe/:id', exigirLoginEmpresa, exigirGestor, async (req, res) => {
  try {
    if (req.usuario && req.usuario.id === req.params.id) {
      return res.status(409).json({ ok: false, erro: 'Você não pode remover a si mesmo.' });
    }
    const ref = USUARIOS_COL().doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists || doc.data().empresaId !== req.empresaLogin.id) {
      return res.status(404).json({ ok: false, erro: 'Usuário não encontrado' });
    }
    const meuOfertaIdDel = req.usuario && req.usuario.ofertaId;
    if (meuOfertaIdDel && doc.data().ofertaId !== meuOfertaIdDel) {
      return res.status(404).json({ ok: false, erro: 'Usuário não encontrado' });
    }
    if (doc.data().papel === 'gestor' && (await contarGestoresAtivos(req.empresaLogin.id)) <= 1) {
      return res.status(409).json({ ok: false, erro: 'A empresa precisa de ao menos um gestor.' });
    }
    await ref.delete();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.get('/admin/criar-empresa', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-criar-empresa.html'));
});

// ============================================================
// MIDDLEWARE DE LOGIN
// ============================================================

async function exigirLoginEmpresa(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
      return res.status(401).json({ ok: false, erro: 'Não autenticado' });
    }

    const payload = jwt.verify(token, JWT_SECRET);
    const empresaId = payload.empresaLoginId || payload.empresaId;
    const doc = await EMPRESAS_COL().doc(empresaId).get();
    if (!doc.exists) {
      return res.status(401).json({ ok: false, erro: 'Empresa não encontrada' });
    }

    req.empresaLogin = { id: doc.id, ...doc.data() };
    // Papel: tokens antigos (pré-multiusuário) não têm usuarioId nem papel —
    // tratamos como gestor para não deslogar ninguém. Quando há usuarioId, a
    // fonte da verdade é o doc do usuário (refletindo trocas de papel na hora).
    req.papel = payload.papel || 'gestor';
    req.usuario = null;
    if (payload.usuarioId) {
      const u = await USUARIOS_COL().doc(payload.usuarioId).get();
      if (!u.exists || u.data().ativo === false) {
        return res.status(401).json({ ok: false, erro: 'Usuário inativo ou removido' });
      }
      const dadosU = u.data();
      if (dadosU.empresaId !== empresaId) {
        return res.status(401).json({ ok: false, erro: 'Sessão inválida' });
      }
      req.usuario = { id: u.id, ...dadosU };
      req.papel = dadosU.papel || req.papel;
      // Rede de lojas: usuário preso a uma oferta (loja) só entra se a matriz
      // liberou o acesso daquela loja especificamente (configuracao.ofertas[id]
      // .acessoLiberado — diferente do ofertasHabilitado, que é o admin da
      // RecomendaLeads liberando a função pra empresa toda).
      if (req.usuario.ofertaId) {
        const ofertasCfg = (req.empresaLogin.configuracao && req.empresaLogin.configuracao.ofertas) || {};
        const minhaOferta = ofertasCfg[req.usuario.ofertaId];
        if (!minhaOferta || !minhaOferta.acessoLiberado) {
          return res.status(401).json({ ok: false, erro: 'O acesso da sua loja foi suspenso. Fale com a matriz.' });
        }
      }
    }
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, erro: 'Sessão inválida ou expirada' });
  }
}

// Exige que o usuário logado seja gestor (acesso total). Use sempre depois de
// exigirLoginEmpresa, que popula req.papel.
function exigirGestor(req, res, next) {
  if (req.papel !== 'gestor') {
    return res.status(403).json({ ok: false, erro: 'Apenas gestores podem fazer esta ação.' });
  }
  next();
}

// Só a conta MATRIZ (PDN Vendas) — usada em recursos que não fazem sentido para
// as contas de clientes, como a "Demonstração por nicho".
function exigirMatriz(req, res, next) {
  if (!req.empresaLogin || req.empresaLogin.id !== EMPRESA_ID_PDN) {
    return res.status(403).json({ ok: false, erro: 'Recurso disponível apenas na conta matriz.' });
  }
  next();
}

// Múltiplas ofertas/lançamentos: função extra, cobrada à parte — só libera pra
// quem o admin marcou `ofertasHabilitado` no cadastro (ver /admin/empresas/:id).
function exigirOfertasHabilitado(req, res, next) {
  if (!req.empresaLogin || !req.empresaLogin.ofertasHabilitado) {
    return res.status(403).json({ ok: false, erro: 'Múltiplas ofertas não está habilitado pra sua conta. Fale com o suporte pra contratar.' });
  }
  next();
}

// Rede de lojas: trava o acesso a uma oferta específica quando o usuário
// logado está preso a uma loja (req.usuario.ofertaId). Usuário matriz
// (ofertaId null/ausente) não é bloqueado — comportamento de hoje, inalterado.
// O alvo pode vir de :id (rota) ou ?oferta= (query, usado por /minha-config).
function exigirEscopoOferta(req, res, next) {
  const meuOfertaId = req.usuario && req.usuario.ofertaId;
  if (!meuOfertaId) return next();
  const alvoId = (req.params && req.params.id) || (req.query && req.query.oferta) || null;
  // Exige presença E igualdade — um usuário de loja chamando /minha-config SEM
  // ?oferta= (ex.: direto na API, pulando o app) não pode cair na config
  // compartilhada só porque "não mandou nada pra comparar".
  if (alvoId !== meuOfertaId) {
    return res.status(403).json({ ok: false, erro: 'Você só tem acesso à sua própria loja.' });
  }
  next();
}

// Rede de lojas: só usuário SEM ofertaId (o nível "matriz" dentro da empresa) —
// pra ações que afetam a rede toda (criar/remover loja). Não confundir com
// exigirMatriz, que é outra coisa (hardcoded pra conta PDN).
function exigirUsuarioSemOferta(req, res, next) {
  if (req.usuario && req.usuario.ofertaId) {
    return res.status(403).json({ ok: false, erro: 'Ação disponível apenas para o usuário da matriz.' });
  }
  next();
}

app.get('/minha-config', exigirLoginEmpresa, exigirEscopoOferta, async (req, res) => {
  try {
    // Mescla com os padrões pra o painel mostrar todos os textos preenchidos
    // (campos não personalizados vêm com o texto padrão, pronto pra editar).
    const configTop = req.empresaLogin.configuracao || { nome: req.empresaLogin.nome };
    let configuracao = { ...EMPRESA_PADRAO, ...configTop };
    // whatsappTipo é campo de TOPO da empresa (não fica dentro de `configuracao`) —
    // o painel precisa dele pra saber que é oficial (ex.: mostrar "Disparo em massa").
    configuracao.whatsappTipo = req.empresaLogin.whatsappTipo || 'zapi';
    // Monitor de entrega (Oficial) — avisa o próprio cliente se a maioria das
    // mensagens está falhando agora (cobrança travada, template pausado etc.).
    configuracao.entregaMonitor = req.empresaLogin.entregaMonitor || null;
    // Templates oficiais: expõe os 4 pro painel/CRM. Prefere o que já está na
    // `configuracao` (salvo no CRM, junto da mensagem); senão cai pro campo de
    // topo (salvo no painel novo). Assim os dois lugares editam o mesmo template.
    ['oficialTemplateRecomendado', 'oficialTemplateInsistencia', 'oficialTemplateFollowupCliente', 'oficialTemplateConvite', 'oficialTemplateClienteInicial', 'oficialTemplateClienteContatos'].forEach(k => {
      if (!configuracao[k]) configuracao[k] = req.empresaLogin[k] || '';
    });
    // Múltiplas ofertas: ?oferta=<id> sobrepõe os campos PRODUTO com os da oferta
    // selecionada (campos de operação continuam vindo do topo, sempre compartilhados).
    // Sem o parâmetro (caso comum hoje), nada muda — mesmo objeto de sempre.
    let ofertaAtiva = null;
    const ofertaId = req.query && req.query.oferta;
    if (req.empresaLogin.ofertasHabilitado && ofertaId && configTop.ofertas && configTop.ofertas[ofertaId]) {
      // Mesma regra que o robô ao vivo usa (aplicarOferta): campo que essa
      // oferta ainda não personalizou cai no exemplo GENÉRICO do sistema, nunca
      // no texto real de OUTRA oferta da mesma empresa — a tela de edição
      // precisa mostrar exatamente o que vai ser enviado, sem vazar conteúdo.
      configuracao = aplicarOferta({ ...configuracao, ofertas: configTop.ofertas }, ofertaId);
      ofertaAtiva = { id: ofertaId, nome: configTop.ofertas[ofertaId].nomeOferta || ofertaId, padrao: ofertaId === configTop.ofertaAtivaPadrao };
    }
    res.json({ ok: true, empresa: configuracao, ehMatriz: req.empresaLogin.id === EMPRESA_ID_PDN, ofertasHabilitado: !!req.empresaLogin.ofertasHabilitado, ofertaAtiva });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post('/minha-config', exigirLoginEmpresa, exigirGestor, exigirEscopoOferta, async (req, res) => {
  try {
    const configuracaoAtual = req.empresaLogin.configuracao || { ...EMPRESA_PADRAO, nome: req.empresaLogin.nome };
    const ofertaId = req.query && req.query.oferta;
    if (req.empresaLogin.ofertasHabilitado && ofertaId && configuracaoAtual.ofertas && configuracaoAtual.ofertas[ofertaId]) {
      // Múltiplas ofertas: separa o corpo — campos de operação vão pro topo
      // (sempre compartilhados), campos de produto só pra oferta selecionada.
      const corpoOperacao = {}, corpoProduto = {};
      for (const k of Object.keys(req.body || {})) {
        if (CAMPOS_PRODUTO_OFERTA.has(k)) corpoProduto[k] = req.body[k];
        else corpoOperacao[k] = req.body[k];
      }
      const novaConfiguracao = { ...configuracaoAtual, ...corpoOperacao };
      novaConfiguracao.ofertas = {
        ...novaConfiguracao.ofertas,
        [ofertaId]: { ...novaConfiguracao.ofertas[ofertaId], ...corpoProduto, atualizadoEm: new Date().toISOString() }
      };
      // Se for a oferta conectada ao WhatsApp, espelha os campos produto no topo
      // também — é o que getEmpresaById lê pro robô ao vivo.
      if (ofertaId === novaConfiguracao.ofertaAtivaPadrao) Object.assign(novaConfiguracao, corpoProduto);
      await EMPRESAS_COL().doc(req.empresaLogin.id).set({ configuracao: novaConfiguracao }, { merge: true });
      return res.json({ ok: true, empresa: { ...EMPRESA_PADRAO, ...novaConfiguracao, ...novaConfiguracao.ofertas[ofertaId] } });
    }
    const novaConfiguracao = { ...configuracaoAtual, ...req.body };

    await EMPRESAS_COL().doc(req.empresaLogin.id).set({ configuracao: novaConfiguracao }, { merge: true });
    res.json({ ok: true, empresa: novaConfiguracao });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ============================================================
// DEMONSTRAÇÃO POR NICHO — edição (Etapa 2)
// Cada nicho guarda seus próprios textos/imagens em configuracao.nichos[nicho].
// O fluxo do bot sobrepõe isso quando o cliente entra pelo link #demo-<nicho>.
// ============================================================
const NICHOS_VALIDOS = ['barbearia', 'cabeleireiro', 'dentista', 'estetica'];
// Campos que o dono pode personalizar por nicho.
const CAMPOS_NICHO = new Set([
  'nome', 'mensagemAgradecimento', 'mensagemPedeNome', 'mensagemPedeVendedor',
  'mensagemPedeContatos', 'mensagemColeta', 'mensagemValidarAmigo',
  'mensagemInicialRecomendado', 'mensagemAntesPresente', 'mensagemAguardandoConfirmacao',
  'mensagemFechamentoRecomendado', 'premioRecomendado', 'arquivoRecomendado',
  'linkRecomendado', 'textoRecomendado', 'faixasBonus',
  // Fluxo completo pós-presente (pra o demo ficar 1:1 com o cliente real).
  'posMensagemConexao', 'posMenuPrincipal', 'linkAgendamento', 'posLinkAgendamento',
  'posPerguntaPeriodo', 'posPerguntaDia', 'posConfirmacaoAgendamento', 'posConfirmacaoCheck',
  'posMenuDepois', 'posLembrete', 'posMenuDuvidas', 'faqComoFunciona', 'faqValidade', 'posAtendente'
]);

// Monta a lista de mercados: os embutidos (NICHOS_DEMO) + os criados pelo dono
// (config.nichos que não são embutidos). Cada item tem slug, nome e se é fixo.
function listaNichos(config) {
  const nichos = (config && config.nichos) || {};
  const slugs = [...new Set([...Object.keys(NICHOS_DEMO), ...Object.keys(nichos)])];
  return slugs.map(slug => ({
    slug,
    nome: (nichos[slug] && nichos[slug].nome) || (NICHOS_DEMO[slug] && NICHOS_DEMO[slug].nome) || slug,
    builtin: !!NICHOS_DEMO[slug]
  }));
}

app.get('/minha-nichos', exigirLoginEmpresa, exigirGestor, exigirMatriz, async (req, res) => {
  try {
    const config = req.empresaLogin.configuracao || {};
    const base = { ...EMPRESA_PADRAO, ...config };
    delete base.nichos; // não devolve os nichos dentro da base
    // Número da demonstração — prioridade: (1) o que o webhook do Z-API informou
    // (numeroConectado, confiável); (2) o manual que o dono salvou; (3) fallback.
    // O manual serve de override quando a captura automática ainda não pegou.
    const numeroAuto = String(config.numeroConectado || '').replace(/\D/g, '');
    const numeroDemo = numeroAuto || String(config.numeroDemo || config.numeroWhatsapp || '').replace(/\D/g, '');
    res.json({
      ok: true,
      lista: listaNichos(config),
      nichos: config.nichos || {},
      defaults: NICHOS_DEMO,
      base,
      numeroDemo,
      numeroAuto // pra o painel saber se veio da detecção ou é manual
    });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Cria um novo mercado a partir do nome (gera o slug do link).
app.post('/minha-mercados', exigirLoginEmpresa, exigirGestor, exigirMatriz, async (req, res) => {
  try {
    const nome = String((req.body && req.body.nome) || '').trim();
    if (!nome) return res.status(400).json({ ok: false, erro: 'Informe o nome do mercado.' });
    let slug = slugNicho(nome);
    if (!slug) return res.status(400).json({ ok: false, erro: 'Nome inválido — use letras ou números.' });
    const config = req.empresaLogin.configuracao || { ...EMPRESA_PADRAO, nome: req.empresaLogin.nome };
    config.nichos = config.nichos || {};
    const existe = s => !!(NICHOS_DEMO[s] || config.nichos[s]);
    if (existe(slug)) { let i = 2; while (existe(`${slug}-${i}`)) i++; slug = `${slug}-${i}`; }
    config.nichos[slug] = { nome };
    await EMPRESAS_COL().doc(req.empresaLogin.id).set({ configuracao: config }, { merge: true });
    res.json({ ok: true, slug, nome, lista: listaNichos(config) });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post('/minha-nichos/:nicho', exigirLoginEmpresa, exigirGestor, exigirMatriz, async (req, res) => {
  try {
    const nicho = req.params.nicho;
    const config = req.empresaLogin.configuracao || { ...EMPRESA_PADRAO, nome: req.empresaLogin.nome };
    config.nichos = config.nichos || {};
    const valido = NICHOS_DEMO[nicho] || config.nichos[nicho];
    if (!valido) return res.status(400).json({ ok: false, erro: 'Mercado não encontrado.' });
    // Só aceita campos da whitelist (evita gravar lixo).
    const limpo = {};
    for (const k of Object.keys(req.body || {})) {
      if (CAMPOS_NICHO.has(k)) limpo[k] = req.body[k];
    }
    config.nichos[nicho] = { ...(config.nichos[nicho] || {}), ...limpo };
    await EMPRESAS_COL().doc(req.empresaLogin.id).set({ configuracao: config }, { merge: true });
    res.json({ ok: true, nicho: config.nichos[nicho] });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Remove um mercado criado pelo dono (os embutidos não podem ser excluídos).
app.delete('/minha-nichos/:nicho', exigirLoginEmpresa, exigirGestor, exigirMatriz, async (req, res) => {
  try {
    const nicho = req.params.nicho;
    if (NICHOS_DEMO[nicho]) {
      return res.status(400).json({ ok: false, erro: 'As áreas originais não podem ser excluídas — só editadas.' });
    }
    await EMPRESAS_COL().doc(req.empresaLogin.id).update({
      [`configuracao.nichos.${nicho}`]: admin.firestore.FieldValue.delete()
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Número do WhatsApp CONECTADO (auto-detectado da Z-API) — pro painel mostrar
// e pro link do Full sair certo sozinho.
app.get('/minha-whatsapp/numero', exigirLoginEmpresa, async (req, res) => {
  try {
    const empresa = await getEmpresaById(req.empresaLogin.id);
    const contexto = { empresa, empresaId: req.empresaLogin.id, zapi: zapiDaEmpresa(empresa), oficial: oficialDaEmpresa(empresa) };
    let numero = null;
    await tenantContext.run(contexto, async () => { numero = await getNumeroConectado(empresa); });
    res.json({ ok: true, numero: numero || null });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Salva o número usado nos links de demonstração (pra montar os wa.me).
app.post('/minha-nichos-numero', exigirLoginEmpresa, exigirGestor, exigirMatriz, async (req, res) => {
  try {
    const numeroDemo = String((req.body && req.body.numeroDemo) || '').replace(/\D/g, '');
    const config = req.empresaLogin.configuracao || { ...EMPRESA_PADRAO, nome: req.empresaLogin.nome };
    config.numeroDemo = numeroDemo;
    await EMPRESAS_COL().doc(req.empresaLogin.id).set({ configuracao: config }, { merge: true });
    res.json({ ok: true, numeroDemo });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ============================================================
// MÚLTIPLAS OFERTAS — Fase 1: CRUD + migração preguiçosa. Sem exigirMatriz —
// disponível pra qualquer cliente da plataforma (ver bloco CAMPOS_OPERACAO_EMPRESA
// / CAMPOS_PRODUTO_OFERTA logo depois de EMPRESA_PADRAO).
// ============================================================

// Lista as ofertas da empresa. Na 1ª chamada (empresa ainda sem `configuracao.ofertas`),
// migra sozinha: a config atual (topo) vira a oferta "Padrão" — zero impacto pra quem
// já usa o sistema, e ela fica marcada como `ofertaAtivaPadrao` (a que o robô usa).
app.get('/minha-ofertas', exigirLoginEmpresa, exigirGestor, exigirOfertasHabilitado, async (req, res) => {
  try {
    let config = req.empresaLogin.configuracao || { ...EMPRESA_PADRAO, nome: req.empresaLogin.nome };
    if (!config.ofertas || !Object.keys(config.ofertas).length) {
      const camposProduto = {};
      for (const chave of CAMPOS_PRODUTO_OFERTA) {
        if (config[chave] !== undefined) camposProduto[chave] = config[chave];
      }
      // Templates oficiais: mesmo fallback que getEmpresaById já usa hoje (prioriza
      // o que estiver dentro de `configuracao`, senão cai pro campo de topo do doc).
      ['oficialTemplateRecomendado', 'oficialTemplateInsistencia', 'oficialTemplateFollowupCliente', 'oficialTemplateConvite', 'oficialTemplateClienteInicial', 'oficialTemplateClienteContatos'].forEach(k => {
        camposProduto[k] = config[k] || req.empresaLogin[k] || null;
      });
      const agora = new Date().toISOString();
      const idPadrao = gerarIdOferta('padrao');
      config = {
        ...config,
        ofertas: { [idPadrao]: { nomeOferta: 'Padrão', ativa: true, criadoEm: agora, atualizadoEm: agora, ...camposProduto } },
        ofertaAtivaPadrao: idPadrao
      };
      await EMPRESAS_COL().doc(req.empresaLogin.id).set({ configuracao: config }, { merge: true });
    }
    let lista = Object.entries(config.ofertas).map(([id, o]) => ({
      id, nome: o.nomeOferta || id, ativa: !!o.ativa, criadoEm: o.criadoEm || null,
      padrao: id === config.ofertaAtivaPadrao, acessoLiberado: !!o.acessoLiberado
    })).sort((a, b) => (a.criadoEm || '').localeCompare(b.criadoEm || ''));
    // Rede de lojas: gestor de loja só enxerga a própria — nunca a lista da rede toda.
    if (req.usuario && req.usuario.ofertaId) lista = lista.filter(o => o.id === req.usuario.ofertaId);
    res.json({ ok: true, ofertas: lista });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Cria uma oferta nova, vazia (defaults de fábrica do EMPRESA_PADRAO — não copia
// nada de nenhuma oferta existente). Não mexe em qual é a `ofertaAtivaPadrao`.
app.post('/minha-ofertas', exigirLoginEmpresa, exigirGestor, exigirOfertasHabilitado, exigirUsuarioSemOferta, async (req, res) => {
  try {
    const nome = String((req.body && req.body.nome) || '').trim();
    if (!nome) return res.status(400).json({ ok: false, erro: 'Informe o nome da oferta.' });
    const config = req.empresaLogin.configuracao || { ...EMPRESA_PADRAO, nome: req.empresaLogin.nome };
    config.ofertas = config.ofertas || {};
    const duplicado = Object.values(config.ofertas).some(o => (o.nomeOferta || '').trim().toLowerCase() === nome.toLowerCase());
    if (duplicado) return res.status(400).json({ ok: false, erro: 'Já existe uma oferta com esse nome.' });
    const id = gerarIdOferta(nome);
    const agora = new Date().toISOString();
    config.ofertas[id] = { nomeOferta: nome, ativa: true, criadoEm: agora, atualizadoEm: agora };
    await EMPRESAS_COL().doc(req.empresaLogin.id).set({ configuracao: config }, { merge: true });
    res.status(201).json({ ok: true, id, nome, ativa: true, criadoEm: agora, padrao: false });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Renomear / ativar / desativar uma oferta. A oferta conectada ao WhatsApp
// (`ofertaAtivaPadrao`) nunca pode ser desativada nesta fase — reatribuir qual
// oferta fica "ao vivo" é trabalho da Fase 2 (roteamento).
app.patch('/minha-ofertas/:id', exigirLoginEmpresa, exigirGestor, exigirOfertasHabilitado, exigirEscopoOferta, async (req, res) => {
  try {
    const id = req.params.id;
    const config = req.empresaLogin.configuracao || {};
    const ofertas = config.ofertas || {};
    if (!ofertas[id]) return res.status(404).json({ ok: false, erro: 'Oferta não encontrada.' });
    const { nome, ativa, acessoLiberado } = req.body || {};
    const atualizacoes = {};
    // Rede de lojas: só a matriz (sem ofertaId) pode liberar/suspender o acesso
    // de uma loja — mesmo que exigirEscopoOferta deixe o gestor da própria loja
    // renomear/ativar a si mesmo, esse campo é exclusivo da matriz.
    if (acessoLiberado !== undefined) {
      if (req.usuario && req.usuario.ofertaId) {
        return res.status(403).json({ ok: false, erro: 'Só a matriz pode liberar/suspender o acesso de uma loja.' });
      }
      atualizacoes.acessoLiberado = !!acessoLiberado;
    }
    if (nome !== undefined) {
      const nomeLimpo = String(nome).trim();
      if (!nomeLimpo) return res.status(400).json({ ok: false, erro: 'Informe o nome da oferta.' });
      const duplicado = Object.entries(ofertas).some(([oid, o]) => oid !== id && (o.nomeOferta || '').trim().toLowerCase() === nomeLimpo.toLowerCase());
      if (duplicado) return res.status(400).json({ ok: false, erro: 'Já existe uma oferta com esse nome.' });
      atualizacoes.nomeOferta = nomeLimpo;
    }
    if (ativa !== undefined && !ativa) {
      if (id === config.ofertaAtivaPadrao) {
        return res.status(400).json({ ok: false, erro: 'Essa é a oferta conectada ao WhatsApp agora — não pode ser desativada.' });
      }
      const outrasAtivas = Object.entries(ofertas).filter(([oid, o]) => oid !== id && o.ativa).length;
      if (!outrasAtivas) return res.status(400).json({ ok: false, erro: 'Não é possível desativar a última oferta ativa.' });
      atualizacoes.ativa = false;
    } else if (ativa !== undefined) {
      atualizacoes.ativa = true;
    }
    atualizacoes.atualizadoEm = new Date().toISOString();
    ofertas[id] = { ...ofertas[id], ...atualizacoes };
    config.ofertas = ofertas;
    await EMPRESAS_COL().doc(req.empresaLogin.id).set({ configuracao: config }, { merge: true });
    res.json({ ok: true, oferta: { id, nome: ofertas[id].nomeOferta, ativa: !!ofertas[id].ativa, criadoEm: ofertas[id].criadoEm, padrao: id === config.ofertaAtivaPadrao, acessoLiberado: !!ofertas[id].acessoLiberado } });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Remove uma oferta. Bloqueado se for a única, ou se for a `ofertaAtivaPadrao`
// (a conectada ao WhatsApp — nunca pode sumir nesta fase).
app.delete('/minha-ofertas/:id', exigirLoginEmpresa, exigirGestor, exigirOfertasHabilitado, exigirUsuarioSemOferta, async (req, res) => {
  try {
    const id = req.params.id;
    const config = req.empresaLogin.configuracao || {};
    const ofertas = config.ofertas || {};
    if (!ofertas[id]) return res.status(404).json({ ok: false, erro: 'Oferta não encontrada.' });
    if (id === config.ofertaAtivaPadrao) {
      return res.status(400).json({ ok: false, erro: 'Essa é a oferta conectada ao WhatsApp agora — não pode ser removida.' });
    }
    if (Object.keys(ofertas).length <= 1) {
      return res.status(400).json({ ok: false, erro: 'Não é possível remover a única oferta.' });
    }
    // TODO Fase 2: bloquear/perguntar se houver leads.ofertaId === id (leads ainda
    // não têm ofertaId nesta fase — nada vinculado ainda, então é seguro remover).
    await EMPRESAS_COL().doc(req.empresaLogin.id).update({
      [`configuracao.ofertas.${id}`]: admin.firestore.FieldValue.delete()
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Config mesclada de uma oferta específica (mesmo padrão do getEmpresaById, escopado).
app.get('/minha-ofertas/:id/config', exigirLoginEmpresa, exigirGestor, exigirOfertasHabilitado, exigirEscopoOferta, async (req, res) => {
  try {
    const id = req.params.id;
    const config = req.empresaLogin.configuracao || {};
    const oferta = config.ofertas && config.ofertas[id];
    if (!oferta) return res.status(404).json({ ok: false, erro: 'Oferta não encontrada.' });
    res.json({ ok: true, empresa: mesclarOfertaComPadrao(oferta), padrao: id === config.ofertaAtivaPadrao });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Salva campos "produto" dentro de uma oferta. Se for a `ofertaAtivaPadrao`,
// espelha os mesmos campos na config de topo — é o que getEmpresaById lê pro
// robô ao vivo, então sem esse espelho a edição não teria efeito nenhum até a Fase 2.
app.post('/minha-ofertas/:id/config', exigirLoginEmpresa, exigirGestor, exigirOfertasHabilitado, exigirEscopoOferta, async (req, res) => {
  try {
    const id = req.params.id;
    const config = req.empresaLogin.configuracao || {};
    if (!config.ofertas || !config.ofertas[id]) return res.status(404).json({ ok: false, erro: 'Oferta não encontrada.' });
    const corpoFiltrado = {};
    for (const k of Object.keys(req.body || {})) {
      if (CAMPOS_PRODUTO_OFERTA.has(k)) corpoFiltrado[k] = req.body[k];
    }
    config.ofertas[id] = { ...config.ofertas[id], ...corpoFiltrado, atualizadoEm: new Date().toISOString() };
    if (id === config.ofertaAtivaPadrao) {
      Object.assign(config, corpoFiltrado);
    }
    await EMPRESAS_COL().doc(req.empresaLogin.id).set({ configuracao: config }, { merge: true });
    res.json({ ok: true, empresa: mesclarOfertaComPadrao(config.ofertas[id]), padrao: id === config.ofertaAtivaPadrao });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Envio de teste da Agenda de Marketing — manda o conteúdo SALVO para um número
// informado (ex.: o próprio gestor), sem afetar a recorrência dos clientes.
app.post('/minha-marketing/teste', exigirLoginEmpresa, exigirGestor, async (req, res) => {
  try {
    let tel = String((req.body && req.body.telefone) || '').replace(/\D/g, '');
    if ((tel.length === 10 || tel.length === 11) && !tel.startsWith('55')) tel = '55' + tel;
    if (tel.length < 12) return res.status(400).json({ ok: false, erro: 'Informe um telefone válido com DDD (ex.: 11999998888).' });
    const empresa = await getEmpresaById(req.empresaLogin.id);
    if (!empresa.marketingMensagem || !empresa.marketingMensagem.trim()) {
      return res.status(400).json({ ok: false, erro: 'Salve a mensagem da agenda antes de enviar o teste.' });
    }
    const contexto = { empresa, empresaId: req.empresaLogin.id, zapi: zapiDaEmpresa(empresa) };
    await tenantContext.run(contexto, async () => {
      await enviarMarketingAoRecomendador(tel, (req.body && req.body.nome) || 'Cliente', empresa);
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Prévia do atendimento pós-fluxo: mostra o que o robô responderia a uma
// pergunta, usando as infos SALVAS (não envia WhatsApp).
app.post('/minha-info/teste', exigirLoginEmpresa, exigirGestor, async (req, res) => {
  try {
    const pergunta = String((req.body && req.body.pergunta) || '').trim();
    if (!pergunta) return res.status(400).json({ ok: false, erro: 'Digite uma pergunta.' });
    const empresa = await getEmpresaById(req.empresaLogin.id);
    let resposta = null;
    await tenantContext.run({ empresa, empresaId: req.empresaLogin.id }, async () => {
      resposta = await responderPerguntaNegocio(pergunta, empresa);
    });
    res.json({ ok: true, resposta: resposta || 'Ainda não tenho essa informação cadastrada — preencha os campos acima e salve.' });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Teste do follow-up do recomendador — manda o lembrete AGORA para um número
// e deixa a sessão pronta pra reconhecer a resposta 1/2/3 (sem esperar a cadência).
app.post('/minha-followup/teste', exigirLoginEmpresa, exigirGestor, async (req, res) => {
  try {
    let tel = String((req.body && req.body.telefone) || '').replace(/\D/g, '');
    if ((tel.length === 10 || tel.length === 11) && !tel.startsWith('55')) tel = '55' + tel;
    if (tel.length < 12) return res.status(400).json({ ok: false, erro: 'Informe um telefone válido com DDD (ex.: 11999998888).' });
    const empresa = await getEmpresaById(req.empresaLogin.id);
    const contexto = { empresa, empresaId: req.empresaLogin.id, zapi: zapiDaEmpresa(empresa), oficial: oficialDaEmpresa(empresa) };
    let resultado = { ok: false };
    await tenantContext.run(contexto, async () => {
      const nome = (req.body && req.body.nome) || 'Cliente';
      const primeiroNome = String(nome).split(' ')[0];
      const vars = { nomeRecomendado: primeiroNome, recomendador: primeiroNome, empresa: empresa.nome };
      resultado = await sendText(tel, substituirVariaveis(empresa.followupRecomendadorMensagem || EMPRESA_PADRAO.followupRecomendadorMensagem, vars)) || { ok: true };
      await saveSessao(tel, { etapa: 'finalizado', clienteNome: nome, followupAguardando: true, followupConcluido: false });
      // Agenda o 2º (e, em cadeia, o 3º) respeitando a cadência configurada —
      // assim o teste simula a régua completa. `teste` faz rodar mesmo desligado.
      await agendarFollowupRecomendador(tel, empresa, 1, { teste: true });
    });
    if (resultado && resultado.ok === false) {
      return res.json({ ok: false, via: resultado.via, erro: resultado.erro || 'O WhatsApp recusou o envio.' });
    }
    res.json({ ok: true, via: resultado && resultado.via });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ============================================================
// WHATSAPP DA EMPRESA — credenciais Z-API próprias do cliente
// ============================================================
// O cliente cria a instância dele na Z-API, conecta o WhatsApp via QR code
// e cola aqui o Instance ID, o Token e o Client-Token. A URL de webhook
// (única por empresa) é mostrada pra ele configurar na Z-API.

function urlBase(req) {
  return process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

// ============================================================
// E-MAIL — envio via SMTP do Google Workspace (nodemailer)
// Configurar no Render: EMAIL_USER (ex.: alexandreclaro@recomendaleads.com.br)
// e EMAIL_APP_PASSWORD (senha de app gerada no Google, 16 letras).
// Sem essas variáveis, o envio é ignorado silenciosamente (não quebra nada).
// ============================================================
const EMAIL_USER = process.env.EMAIL_USER || '';
const EMAIL_APP_PASSWORD = process.env.EMAIL_APP_PASSWORD || '';
const EMAIL_FROM_NOME = process.env.EMAIL_FROM_NOME || 'RecomendaLeads';
let _emailTransporter = null;
function getEmailTransporter() {
  if (!EMAIL_USER || !EMAIL_APP_PASSWORD) return null;
  if (!_emailTransporter) {
    _emailTransporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: EMAIL_USER, pass: EMAIL_APP_PASSWORD }
    });
  }
  return _emailTransporter;
}

async function enviarEmail({ para, assunto, html, texto }) {
  const t = getEmailTransporter();
  if (!t) {
    console.log('[EMAIL] Envio ignorado (EMAIL_USER/EMAIL_APP_PASSWORD não configurados):', assunto, '->', para);
    return { ok: false, motivo: 'nao_configurado' };
  }
  if (!para) return { ok: false, motivo: 'sem_destinatario' };
  try {
    const info = await t.sendMail({
      from: `"${EMAIL_FROM_NOME}" <${EMAIL_USER}>`,
      to: para,
      subject: assunto,
      text: texto || undefined,
      html
    });
    console.log('[EMAIL] Enviado:', assunto, '->', para, '(', info.messageId, ')');
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    console.error('[EMAIL] Falha ao enviar para', para, ':', err.message);
    return { ok: false, motivo: err.message };
  }
}

// Monta e envia o e-mail de boas-vindas para um cliente recém-cadastrado.
function emailBoasVindasHtml({ nomeEmpresa, emailLogin, senha, linkLogin }) {
  const AZUL = '#1E5BE0', VERDE = '#16A34A';
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6fb;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.06);">
        <tr><td style="background:${AZUL};padding:28px 32px;">
          <span style="color:#fff;font-size:22px;font-weight:800;letter-spacing:.3px;">RecomendaLeads</span>
        </td></tr>
        <tr><td style="padding:32px;">
          <h1 style="margin:0 0 12px;font-size:22px;color:#111827;">Bem-vindo(a), ${nomeEmpresa}! 🎉</h1>
          <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#374151;">
            Sua conta na <strong>RecomendaLeads</strong> já está criada. A partir de agora você vai transformar cada cliente satisfeito em novos clientes, de forma automática, pelo WhatsApp.
          </p>
          <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:10px;padding:18px 20px;margin:0 0 22px;">
            <p style="margin:0 0 8px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;">Seus dados de acesso</p>
            <p style="margin:${senha ? '0 0 6px' : '0'};font-size:15px;"><strong>Login (e-mail):</strong> ${emailLogin}</p>
            ${senha ? `<p style="margin:0;font-size:15px;"><strong>Senha provisória:</strong> ${senha}</p>` : `<p style="margin:0;font-size:15px;color:#6b7280;">Use a senha que você definiu no cadastro.</p>`}
          </div>
          <div style="text-align:center;margin:0 0 24px;">
            <a href="${linkLogin}" style="display:inline-block;background:${VERDE};color:#fff;text-decoration:none;font-weight:700;font-size:16px;padding:14px 30px;border-radius:10px;">Acessar meu painel →</a>
          </div>
          <p style="margin:0 0 10px;font-size:15px;color:#374151;"><strong>Próximos passos:</strong></p>
          <ol style="margin:0 0 20px;padding-left:20px;font-size:14px;line-height:1.7;color:#374151;">
            ${senha ? '<li>Entre no painel com o login acima e <strong>troque sua senha</strong>.</li>' : '<li>Entre no painel com seu login e senha.</li>'}
            <li>Conecte seu <strong>WhatsApp</strong> (leitura do QR Code).</li>
            <li>Configure o prêmio/voucher que seu cliente vai ganhar por recomendar.</li>
            <li>Pronto! É só começar a recomendar. 🚀</li>
          </ol>
          <p style="margin:0;font-size:14px;line-height:1.6;color:#6b7280;">
            Qualquer dúvida, é só responder este e-mail. Estamos com você.<br>— Equipe RecomendaLeads
          </p>
        </td></tr>
        <tr><td style="background:#f8fafc;padding:16px 32px;text-align:center;font-size:12px;color:#9ca3af;">
          RecomendaLeads · A terceira onda das vendas
        </td></tr>
      </table>
    </td></tr>
  </table>
  </body></html>`;
}

async function enviarBoasVindasCliente({ nomeEmpresa, emailLogin, senha, req }) {
  const base = (req && urlBase(req)) || process.env.APP_BASE_URL || 'https://www.recomendaleads.com.br';
  const linkLogin = `${base}/login`;
  const html = emailBoasVindasHtml({ nomeEmpresa, emailLogin, senha, linkLogin });
  const texto = `Bem-vindo(a), ${nomeEmpresa}!\n\nSua conta na RecomendaLeads já está criada.\n\nLogin: ${emailLogin}\n${senha ? `Senha provisória: ${senha}\n` : 'Use a senha que você definiu no cadastro.\n'}Acesse: ${linkLogin}\n\nPróximos passos: ${senha ? 'troque a senha, ' : ''}conecte seu WhatsApp, configure o prêmio e comece a recomendar.\n\n— Equipe RecomendaLeads`;
  return enviarEmail({ para: emailLogin, assunto: '🎉 Bem-vindo(a) à RecomendaLeads — seus dados de acesso', html, texto });
}

app.get('/minha-whatsapp', exigirLoginEmpresa, async (req, res) => {
  try {
    const e = req.empresaLogin;
    const conectado = !!(e.zapiInstanceId && e.zapiToken);
    res.json({
      ok: true,
      conectado,
      whatsappTipo: e.whatsappTipo || 'zapi',
      // Nunca devolvemos o token cheio — só uma confirmação de que existe.
      zapiInstanceId: e.zapiInstanceId || '',
      temToken: !!e.zapiToken,
      temClientToken: !!e.zapiClientToken,
      webhookUrl: `${urlBase(req)}/webhook/${e.id}`,
      // API Oficial (Meta Cloud API)
      oficialPhoneId: e.oficialPhoneId || '',
      oficialWabaId: e.oficialWabaId || '',
      temOficialToken: !!e.oficialToken,
      temOficialVerifyToken: !!e.oficialVerifyToken,
      temOficialAppSecret: !!e.oficialAppSecret,
      oficialTemplateRecomendado: e.oficialTemplateRecomendado || '',
      oficialTemplateInsistencia: e.oficialTemplateInsistencia || '',
      oficialTemplateFollowupCliente: e.oficialTemplateFollowupCliente || '',
      oficialTemplateConvite: e.oficialTemplateConvite || '',
      oficialConectado: !!(e.oficialPhoneId && e.oficialToken),
      oficialWebhookUrl: `${urlBase(req)}/webhook-oficial/${e.id}`
    });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post('/minha-whatsapp', exigirLoginEmpresa, exigirGestor, async (req, res) => {
  try {
    const { zapiInstanceId, zapiToken, zapiClientToken } = req.body;
    if (!zapiInstanceId || !zapiToken) {
      return res.status(400).json({ ok: false, erro: 'Informe ao menos o Instance ID e o Token da Z-API' });
    }

    // Ao cadastrar credenciais Z-API, a empresa passa a operar em modo 'zapi'.
    await EMPRESAS_COL().doc(req.empresaLogin.id).set({
      whatsappTipo: 'zapi',
      zapiInstanceId: String(zapiInstanceId).trim(),
      zapiToken: String(zapiToken).trim(),
      zapiClientToken: zapiClientToken ? String(zapiClientToken).trim() : null
    }, { merge: true });

    res.json({
      ok: true,
      conectado: true,
      webhookUrl: `${urlBase(req)}/webhook/${req.empresaLogin.id}`
    });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ============================================================
// WHATSAPP DA EMPRESA — API Oficial (Meta Cloud API)
// ============================================================
// O cliente cria o app/WABA na Meta, cola aqui o Phone Number ID + token
// permanente + um verify token (que ele escolhe). A URL de webhook oficial
// (única por empresa) é mostrada pra ele configurar no app da Meta.
app.post('/minha-whatsapp/oficial', exigirLoginEmpresa, exigirGestor, exigirUsuarioSemOferta, async (req, res) => {
  try {
    const { oficialPhoneId, oficialToken, oficialVerifyToken, oficialWabaId, oficialAppSecret, oficialTemplateRecomendado,
      oficialTemplateInsistencia, oficialTemplateFollowupCliente, oficialTemplateConvite } = req.body;

    // Campos "já salvos" (Token, Verify Token, App Secret) podem vir VAZIOS do painel —
    // ele mostra "já salvo — preencha para trocar". Nesse caso, MANTÉM o valor gravado
    // em vez de exigir re-colar. Assim dá pra mudar só o nome do template (ou o WABA)
    // sem precisar colar de novo o token permanente. Mesma ideia pro WABA e o template
    // (não apaga se vier vazio).
    const snapAtual = await EMPRESAS_COL().doc(req.empresaLogin.id).get();
    const atual = snapAtual.exists ? snapAtual.data() : {};
    const tokenFinal = (oficialToken && String(oficialToken).trim()) || atual.oficialToken || '';
    const verifyFinal = (oficialVerifyToken && String(oficialVerifyToken).trim()) || atual.oficialVerifyToken || '';
    const appSecretFinal = (oficialAppSecret && String(oficialAppSecret).trim()) || atual.oficialAppSecret || null;

    if (!oficialPhoneId || !tokenFinal || !verifyFinal) {
      return res.status(400).json({ ok: false, erro: 'Informe Phone Number ID, Token e Verify Token (Token e Verify Token podem ficar em branco se já estiverem salvos).' });
    }

    // Ao cadastrar credenciais oficiais, a empresa passa a operar em modo 'oficial'.
    await EMPRESAS_COL().doc(req.empresaLogin.id).set({
      whatsappTipo: 'oficial',
      oficialPhoneId: String(oficialPhoneId).trim(),
      oficialToken: tokenFinal,
      oficialVerifyToken: verifyFinal,
      oficialWabaId: (oficialWabaId && String(oficialWabaId).trim()) || atual.oficialWabaId || null,
      oficialAppSecret: appSecretFinal,
      // NOTA (múltiplas ofertas — Fase 1): estes 4 templates ainda gravam aqui, no
      // topo do doc, compartilhados — só passam a ser por oferta quando esta tela
      // (e as demais de mensagens/prêmios) forem religadas ao endpoint por oferta,
      // numa próxima etapa. Enquanto isso, editar aqui sempre afeta a oferta padrão.
      oficialTemplateRecomendado: (oficialTemplateRecomendado && String(oficialTemplateRecomendado).trim()) || atual.oficialTemplateRecomendado || null,
      oficialTemplateInsistencia: (oficialTemplateInsistencia != null ? String(oficialTemplateInsistencia).trim() : (atual.oficialTemplateInsistencia || '')) || null,
      oficialTemplateFollowupCliente: (oficialTemplateFollowupCliente != null ? String(oficialTemplateFollowupCliente).trim() : (atual.oficialTemplateFollowupCliente || '')) || null,
      oficialTemplateConvite: (oficialTemplateConvite != null ? String(oficialTemplateConvite).trim() : (atual.oficialTemplateConvite || '')) || null,
      // Limpa o número que sobrou de sessão Z-API antiga (numeroConectado) pra o
      // link/painel não mostrar número torto — no modo oficial o número vem da Meta.
      configuracao: { numeroConectado: '', numeroDetectado: '' }
    }, { merge: true });
    // Zera o cache em memória do número (senão o valor antigo persiste até expirar).
    try { delete _numeroConectadoCache[req.empresaLogin.id]; } catch (e) {}

    res.json({
      ok: true,
      conectado: true,
      webhookUrl: `${urlBase(req)}/webhook-oficial/${req.empresaLogin.id}`
    });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Modelo "você dona a Z-API": o admin provisiona a instância da empresa e o
// cliente só ESCANEIA o QR no painel. Estes endpoints falam com a Z-API usando
// as credenciais da própria empresa (sem fallback pro número global).
function zapiCfgDaEmpresaLogin(e) {
  if (!e || !e.zapiInstanceId || !e.zapiToken) return null;
  return { instanceId: e.zapiInstanceId, token: e.zapiToken, clientToken: e.zapiClientToken || '' };
}

app.get('/minha-whatsapp/status', exigirLoginEmpresa, async (req, res) => {
  // Modo API Oficial (Meta): "conectado" = credenciais válidas. Confirma buscando
  // o número real na Meta (display_phone_number). Não depende de Z-API nenhuma.
  if (req.empresaLogin.whatsappTipo === 'oficial') {
    try {
      const empresa = await getEmpresaById(req.empresaLogin.id);
      const oficial = oficialDaEmpresa(empresa);
      if (!oficial) return res.json({ ok: true, provisionado: false, conectado: false, canal: 'oficial' });
      const numero = await getNumeroOficial(oficial);
      return res.json({ ok: true, provisionado: false, conectado: !!numero, canal: 'oficial', numero: numero || null });
    } catch (e) {
      return res.json({ ok: true, provisionado: false, conectado: false, canal: 'oficial', erro: e.message });
    }
  }
  // Instância própria da empresa ou, na falta dela, a Z-API global (caso PDN).
  // `provisionado` só é true quando a empresa tem instância PRÓPRIA — assim o
  // painel oferece o QR apenas para quem realmente pode escanear; quem roda no
  // número global (gerido pela equipe) vê só o status real de conexão.
  const propria = zapiCfgDaEmpresaLogin(req.empresaLogin);
  const cfg = propria || (ZAPI_GLOBAL.instanceId && ZAPI_GLOBAL.token ? ZAPI_GLOBAL : null);
  if (!cfg) return res.json({ ok: true, provisionado: false, conectado: false });
  try {
    const resp = await axios.get(`${zapiBaseUrl(cfg)}/status`, { headers: zapiHeaders(cfg) });
    const data = resp.data || {};
    const conectado = !!(data.connected || data.smartphoneConnected);
    res.json({ ok: true, provisionado: !!propria, conectado });
  } catch (err) {
    res.json({ ok: true, provisionado: !!propria, conectado: false, erro: err.response?.data?.error || err.message });
  }
});

app.get('/minha-whatsapp/qr', exigirLoginEmpresa, async (req, res) => {
  const cfg = zapiCfgDaEmpresaLogin(req.empresaLogin);
  if (!cfg) return res.json({ ok: false, provisionado: false, erro: 'WhatsApp ainda não provisionado para esta conta.' });
  try {
    const resp = await axios.get(`${zapiBaseUrl(cfg)}/qr-code/image`, { headers: zapiHeaders(cfg) });
    const data = resp.data || {};
    if (data.connected) return res.json({ ok: true, conectado: true });
    if (data.value) return res.json({ ok: true, qr: data.value });
    res.json({ ok: false, erro: data.error || 'QR indisponível no momento.' });
  } catch (err) {
    // Z-API costuma responder erro quando já está conectado.
    res.json({ ok: false, erro: err.response?.data?.error || err.message });
  }
});

// ============================================================
// CAIXA DE ENTRADA DO WHATSAPP — conversas da empresa logada
// ============================================================

// Lista as conversas (resumo) da empresa, mais recentes primeiro.
app.get('/minha-conversas', exigirLoginEmpresa, async (req, res) => {
  try {
    const snap = await CONVERSAS_COL().where('empresaId', '==', req.empresaLogin.id).get();
    let conversas = [];
    snap.forEach(d => conversas.push({ id: d.id, ...d.data() }));

    // Rede de lojas: filtro por oferta — usuário preso a uma loja (ofertaId no
    // próprio login) SEMPRE vê só a dele, mesmo que peça outra por engano;
    // matriz pode filtrar por qualquer loja via ?oferta= (ex.: veio do CRM
    // editando uma oferta específica), ou ver tudo sem o parâmetro.
    const ofertaFiltro = (req.usuario && req.usuario.ofertaId) || (req.query && req.query.oferta) || null;
    if (ofertaFiltro) {
      conversas = conversas.filter(c => c.ofertaId === ofertaFiltro);
    }

    // Atendente (não-gestor) — em ordem de prioridade:
    // 1) Já foi assumida (atendenteId setado, via /pausar, /enviar, /enviar-midia
    //    ou /transferir) — só o dono vê, ponto final, não importa quem o rodízio
    //    tinha chamado antes.
    // 2) Ainda não foi assumida, mas o rodízio já escolheu UM atendente específico
    //    pra avisar (atendenteAtribuidoId, em avisarAtendenteRevezamento) — só esse
    //    escolhido vê (senão o rodízio vira decoração: todo mundo vê e qualquer um
    //    pega, ignorando quem foi chamado). Se não responder a tempo, escala pro
    //    próximo e a visibilidade acompanha automaticamente.
    // 3) Nem foi assumida nem tem rodízio rolando — visível pra todo mundo, pra
    //    poder pegar livremente.
    // Gestor sempre vê tudo, sem filtro.
    if (req.papel !== 'gestor' && req.usuario) {
      conversas = conversas.filter(c => {
        if (c.atendenteId) return c.atendenteId === req.usuario.id;
        if (c.atendenteAtribuidoId) return c.atendenteAtribuidoId === req.usuario.id;
        return true;
      });
    } else if (req.query.atendenteId) {
      // Gestor pode "ver como" um atendente específico (um de cada vez), mesmo
      // filtro que já existe em GET /minha-leads.
      conversas = conversas.filter(c => c.atendenteId === req.query.atendenteId);
    }
    conversas.sort((a, b) => new Date(b.ultimaEm || 0) - new Date(a.ultimaEm || 0));
    res.json({ ok: true, conversas });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Preenche o papel (Cliente/Recomendado) das conversas que já existiam antes
// dessa marcação existir — cruza com as sessões (sessoes = cliente,
// sessoes_recomendado = recomendado) pra descobrir quem é quem. Rodar uma vez
// é suficiente; conversas que já têm papel não são mexidas.
app.post('/minha-conversas/backfill-papel', exigirLoginEmpresa, exigirGestor, async (req, res) => {
  try {
    const empresaId = req.empresaLogin.id;
    const snap = await CONVERSAS_COL().where('empresaId', '==', empresaId).get();
    let atualizados = 0;
    for (const doc of snap.docs) {
      const data = doc.data();
      if (data.papel || !data.telefone) continue;
      const chave = empresaId === EMPRESA_ID_PDN ? data.telefone : `${empresaId}__${data.telefone}`;
      const [sRec, sCli] = await Promise.all([
        SESSOES_RECOMENDADO_COL().doc(chave).get(),
        SESSOES_COL().doc(chave).get()
      ]);
      let papel = null;
      if (sRec.exists) papel = 'recomendado';
      else if (sCli.exists) papel = 'cliente';
      if (papel) { await doc.ref.set({ papel }, { merge: true }); atualizados++; }
    }
    res.json({ ok: true, atualizados, total: snap.size });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Rede de lojas: um atendente preso a uma loja só pode ver/mexer nas conversas
// da PRÓPRIA loja. Sem trava, ele acessava qualquer conversa da empresa via
// telefone direto (as rotas abaixo não filtravam por ofertaId, só empresaId).
// Não é loja-locked (ofertaId vazio) => acessa tudo, igual sempre foi.
async function podeAcessarConversaDaLoja(req, telefone) {
  if (!req.usuario || !req.usuario.ofertaId) return true;
  const chave = `${req.empresaLogin.id}__${telefone}`;
  const snap = await CONVERSAS_COL().doc(chave).get();
  const conv = snap.exists ? snap.data() : {};
  return conv.ofertaId === req.usuario.ofertaId;
}

// Mensagens de uma conversa (e marca como lida).
app.get('/minha-conversas/:telefone/mensagens', exigirLoginEmpresa, async (req, res) => {
  try {
    const telefone = req.params.telefone;
    if (!(await podeAcessarConversaDaLoja(req, telefone))) return res.status(404).json({ ok: false, erro: 'Conversa não encontrada' });
    const chave = `${req.empresaLogin.id}__${telefone}`;
    const snap = await MENSAGENS_CHAT_COL().where('chaveConversa', '==', chave).get();
    const mensagens = [];
    snap.forEach(d => mensagens.push({ id: d.id, ...d.data() }));
    mensagens.sort((a, b) => new Date(a.criadoEm || 0) - new Date(b.criadoEm || 0));
    // Marca como lida — MAS não tira mais o alerta "precisa atendente" só por abrir
    // (só de olhar, sem assumir de verdade). O alarme (som/piscar) e o revezamento
    // continuam até alguém clicar "Assumir" ou mandar mensagem (endpoints /pausar e
    // /enviar), que aí sim zeram precisaAtendente junto com botPausado.
    await CONVERSAS_COL().doc(chave).set({ naoLidas: 0 }, { merge: true }).catch(() => {});
    const conv = await CONVERSAS_COL().doc(chave).get().then(d => d.exists ? d.data() : {}).catch(() => ({}));
    res.json({ ok: true, mensagens, botPausado: !!conv.botPausado, atendenteNome: conv.atendenteNome || null });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Acha o lead (recomendado) ligado a este telefone, pra Conversas mostrar/mudar a
// etapa do Kanban direto da conversa (sem precisar ir no CRM arrastar o card).
app.get('/minha-conversas/:telefone/lead', exigirLoginEmpresa, async (req, res) => {
  try {
    if (!(await podeAcessarConversaDaLoja(req, req.params.telefone))) return res.status(404).json({ ok: false, erro: 'Conversa não encontrada' });
    const empresa = await getEmpresaById(req.empresaLogin.id);
    const contexto = { empresa, empresaId: req.empresaLogin.id };
    let lead = null;
    await tenantContext.run(contexto, async () => { lead = await acharLeadRecPorTelefone(req.params.telefone); });
    const etapas = (empresa.etapasKanban && empresa.etapasKanban.length) ? empresa.etapasKanban : EMPRESA_PADRAO.etapasKanban;
    res.json({ ok: true, lead: lead ? { id: lead.id, etapa: lead.etapa || null } : null, etapas });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Lista os templates APROVADOS na Meta pra essa empresa, com o TEXTO real (não
// só o nome) — pra usar num disparo individual direto de dentro da conversa
// (ex.: reabrir uma janela de 24h fechada, ou puxar assunto com quem nunca
// respondeu). Cacheia 10min por WABA — a lista de templates muda pouco.
const _todosTemplatesCache = {};
app.get('/minha-templates', exigirLoginEmpresa, async (req, res) => {
  try {
    const empresa = await getEmpresaById(req.empresaLogin.id);
    if (empresa.whatsappTipo !== 'oficial') return res.json({ ok: true, templates: [] });
    const oficial = oficialDaEmpresa(empresa);
    if (!oficial || !oficial.wabaId || !oficial.token) return res.json({ ok: true, templates: [] });

    const cacheKey = oficial.wabaId;
    const cache = _todosTemplatesCache[cacheKey];
    if (cache && (Date.now() - cache.em) < 10 * 60 * 1000) return res.json({ ok: true, templates: cache.templates });

    const resp = await axios.get(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/${oficial.wabaId}/message_templates`,
      { params: { limit: 250 }, headers: { Authorization: `Bearer ${oficial.token}` }, timeout: 8000 }
    );
    const arr = (resp.data && resp.data.data) || [];
    const templates = arr
      .filter(t => String(t.status || '').toUpperCase() === 'APPROVED')
      .map(t => {
        const body = (t.components || []).find(c => String(c.type || '').toUpperCase() === 'BODY');
        const texto = (body && body.text) || '';
        const nums = (texto.match(/\{\{\s*(\d+)\s*\}\}/g) || []).map(m => parseInt(m.replace(/\D/g, ''), 10));
        const variaveis = nums.length ? Math.max(...nums) : 0;
        return { name: t.name, categoria: String(t.category || '').toLowerCase(), idioma: t.language || '', texto, variaveis };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    _todosTemplatesCache[cacheKey] = { templates, em: Date.now() };
    res.json({ ok: true, templates });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.response ? JSON.stringify(err.response.data).slice(0, 200) : err.message });
  }
});

// Dispara um template ESCOLHIDO NA HORA direto pra uma conversa (disparo
// individual, diferente do disparo em massa) — serve pra reabrir a janela de
// 24h já fechada, ou puxar assunto com quem nunca respondeu. Mesmo padrão de
// "assume o atendimento" do /enviar (texto livre).
app.post('/minha-conversas/:telefone/enviar-template', exigirLoginEmpresa, async (req, res) => {
  try {
    const telefone = req.params.telefone;
    const template = String((req.body && req.body.template) || '').trim();
    if (!template) return res.status(400).json({ ok: false, erro: 'Escolha um template.' });
    const params = Array.isArray(req.body && req.body.params) ? req.body.params.map(x => String(x == null ? '' : x)) : [];
    if (!(await podeAcessarConversaDaLoja(req, telefone))) return res.status(404).json({ ok: false, erro: 'Conversa não encontrada' });

    const empresa = await getEmpresaById(req.empresaLogin.id);
    if (empresa.whatsappTipo !== 'oficial') return res.status(400).json({ ok: false, erro: 'Disparo por template só funciona no modo API Oficial.' });
    const contexto = { empresa, empresaId: req.empresaLogin.id, zapi: zapiDaEmpresa(empresa), oficial: oficialDaEmpresa(empresa) };
    let ok = false;
    await tenantContext.run(contexto, async () => {
      await pausarNumero(telefone); // assume o atendimento: bot para nesse contato
      ok = await sendTemplate(telefone, template, params);
    });
    if (!ok) return res.status(400).json({ ok: false, erro: 'A Meta recusou o envio — confira o template e as variáveis.' });

    const atendenteId = (req.usuario && req.usuario.id) || null;
    const nomeAt = (req.usuario && req.usuario.nome) || req.empresaLogin.nome || 'Atendente';
    await CONVERSAS_COL().doc(`${req.empresaLogin.id}__${telefone}`).set({ botPausado: true, atendenteId, atendenteNome: nomeAt, atendenteEm: new Date().toISOString(), precisaAtendente: false }, { merge: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Envia uma mensagem manual e pausa o bot para esse contato.
app.post('/minha-conversas/:telefone/enviar', exigirLoginEmpresa, async (req, res) => {
  try {
    const telefone = req.params.telefone;
    const mensagem = (req.body && req.body.mensagem || '').trim();
    if (!mensagem) return res.status(400).json({ ok: false, erro: 'Mensagem vazia' });
    if (!(await podeAcessarConversaDaLoja(req, telefone))) return res.status(404).json({ ok: false, erro: 'Conversa não encontrada' });

    const empresa = await getEmpresaById(req.empresaLogin.id);
    const contexto = { empresa, empresaId: req.empresaLogin.id, zapi: zapiDaEmpresa(empresa) };
    let resultado = null;
    await tenantContext.run(contexto, async () => {
      await pausarNumero(telefone);              // assume o atendimento: bot para nesse contato
      resultado = await sendText(telefone, mensagem); // envia e já registra a mensagem
    });
    // sendText pode falhar de verdade (ex.: fora da janela de 24h, número novo que
    // nunca falou com a gente) — sem checar o retorno, o painel dizia "enviado" mesmo
    // quando não saiu nada, e o atendente só descobria quando o cliente "sumia".
    if (!resultado || !resultado.ok) {
      return res.status(400).json({ ok: false, erro: (resultado && resultado.erro) || 'Falha ao enviar — se for a primeira mensagem pra esse número, use um template.' });
    }
    const atendenteId = (req.usuario && req.usuario.id) || null;
    const nomeAt = (req.usuario && req.usuario.nome) || req.empresaLogin.nome || 'Atendente';
    await CONVERSAS_COL().doc(`${req.empresaLogin.id}__${telefone}`).set({ botPausado: true, atendenteId, atendenteNome: nomeAt, atendenteEm: new Date().toISOString(), precisaAtendente: false }, { merge: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Envia mídia (imagem/áudio/vídeo/documento) manualmente — o atendente sobe o
// arquivo via /minha-conversas/upload e este endpoint despacha pro canal certo,
// igual o /enviar faz com texto (assume o atendimento).
app.post('/minha-conversas/:telefone/enviar-midia', exigirLoginEmpresa, async (req, res) => {
  try {
    const telefone = req.params.telefone;
    const { tipo, url, caption, fileName, extension } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, erro: 'Sem arquivo — faça o upload primeiro.' });
    if (!['imagem', 'audio', 'video', 'documento'].includes(tipo)) {
      return res.status(400).json({ ok: false, erro: 'Tipo de mídia inválido' });
    }
    if (!(await podeAcessarConversaDaLoja(req, telefone))) return res.status(404).json({ ok: false, erro: 'Conversa não encontrada' });

    const empresa = await getEmpresaById(req.empresaLogin.id);
    const contexto = { empresa, empresaId: req.empresaLogin.id, zapi: zapiDaEmpresa(empresa) };
    await tenantContext.run(contexto, async () => {
      await pausarNumero(telefone); // assume o atendimento: bot para nesse contato
      if (tipo === 'imagem') await sendImage(telefone, url, caption || '');
      else if (tipo === 'audio') await sendAudio(telefone, url);
      else if (tipo === 'video') await sendVideo(telefone, url, caption || '');
      else await sendDocument(telefone, url, fileName || 'arquivo', extension || '');
    });
    const atendenteId = (req.usuario && req.usuario.id) || null;
    const nomeAt = (req.usuario && req.usuario.nome) || req.empresaLogin.nome || 'Atendente';
    await CONVERSAS_COL().doc(`${req.empresaLogin.id}__${telefone}`).set({ botPausado: true, atendenteId, atendenteNome: nomeAt, atendenteEm: new Date().toISOString(), precisaAtendente: false }, { merge: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Agenda um lembrete de retorno pra ESTA conversa (ex.: "cliente pediu pra ligar
// mais tarde"). Notifica só o PRÓPRIO atendente que agendou (não é revezamento —
// é o dono do compromisso) na hora escolhida, via WhatsApp + o alarme do painel.
app.post('/minha-conversas/:telefone/agendar-retorno', exigirLoginEmpresa, async (req, res) => {
  try {
    const telefone = req.params.telefone;
    const quando = req.body && req.body.quando; // ISO datetime (local do navegador)
    const mensagem = (req.body && req.body.mensagem) ? String(req.body.mensagem).trim() : '';
    if (!quando || isNaN(new Date(quando).getTime())) return res.status(400).json({ ok: false, erro: 'Data/hora inválida' });
    if (new Date(quando).getTime() <= Date.now()) return res.status(400).json({ ok: false, erro: 'Escolha um horário no futuro' });
    if (!(await podeAcessarConversaDaLoja(req, telefone))) return res.status(404).json({ ok: false, erro: 'Conversa não encontrada' });
    const atendenteId = (req.usuario && req.usuario.id) || null;
    const atendenteNome = (req.usuario && req.usuario.nome) || req.empresaLogin.nome || 'Atendente';
    const chave = `${req.empresaLogin.id}__${telefone}`;
    await CONVERSAS_COL().doc(chave).set({ lembreteRetorno: { quando, atendenteId, atendenteNome, mensagem } }, { merge: true });
    const empresa = await getEmpresaById(req.empresaLogin.id);
    const contexto = { empresa, empresaId: req.empresaLogin.id };
    await tenantContext.run(contexto, async () => {
      await criarAgendamento({
        tipo: 'lembrete_retorno_atendente',
        executarEm: quando,
        dados: { telefone, atendenteId, atendenteNome, mensagem }
      });
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Cancela o lembrete agendado. Não precisa apagar da coleção de agendamentos —
// o executor checa `lembreteRetorno` antes de notificar, então limpar aqui basta.
app.post('/minha-conversas/:telefone/cancelar-lembrete', exigirLoginEmpresa, async (req, res) => {
  try {
    if (!(await podeAcessarConversaDaLoja(req, req.params.telefone))) return res.status(404).json({ ok: false, erro: 'Conversa não encontrada' });
    const chave = `${req.empresaLogin.id}__${req.params.telefone}`;
    await CONVERSAS_COL().doc(chave).set({ lembreteRetorno: null }, { merge: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Respostas rápidas ("/" no composer de Conversas) — compartilhadas pela equipe,
// qualquer atendente pode ver/editar (não é recurso só de gestor).
app.get('/minha-respostas-rapidas', exigirLoginEmpresa, async (req, res) => {
  try {
    const doc = await EMPRESAS_COL().doc(req.empresaLogin.id).get();
    const lista = (doc.exists && doc.data().respostasRapidas) || [];
    res.json({ ok: true, respostas: lista });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post('/minha-respostas-rapidas', exigirLoginEmpresa, async (req, res) => {
  try {
    const entrada = Array.isArray(req.body && req.body.respostas) ? req.body.respostas : [];
    const lista = entrada
      .map(r => ({
        atalho: String((r && r.atalho) || '').trim().toLowerCase().replace(/\s+/g, ''),
        texto: String((r && r.texto) || '').trim(),
        // Anexo opcional (imagem/vídeo/documento) — a resposta rápida pode mandar
        // mídia direto, não só texto. midiaTipo vem do upload (ver detectarTipoMidia).
        midiaUrl: (r && r.midiaUrl) ? String(r.midiaUrl).trim() : null,
        midiaTipo: (r && r.midiaTipo) ? String(r.midiaTipo).trim() : null
      }))
      .filter(r => r.atalho && (r.texto || r.midiaUrl)) // precisa ter texto OU mídia
      .slice(0, 200);
    await EMPRESAS_COL().doc(req.empresaLogin.id).set({ respostasRapidas: lista }, { merge: true });
    res.json({ ok: true, respostas: lista });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Devolve o atendimento ao robô (reativa o bot para o contato).
app.post('/minha-conversas/:telefone/devolver', exigirLoginEmpresa, async (req, res) => {
  try {
    const telefone = req.params.telefone;
    if (!(await podeAcessarConversaDaLoja(req, telefone))) return res.status(404).json({ ok: false, erro: 'Conversa não encontrada' });
    const empresa = await getEmpresaById(req.empresaLogin.id);
    const contexto = { empresa, empresaId: req.empresaLogin.id, zapi: zapiDaEmpresa(empresa) };
    await tenantContext.run(contexto, async () => { await despausarNumero(telefone); });
    await CONVERSAS_COL().doc(`${req.empresaLogin.id}__${telefone}`).set({ botPausado: false, atendenteId: null, atendenteNome: null, atendenteEm: null }, { merge: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Pausa o bot para o contato SEM enviar mensagem (você assume o atendimento).
app.post('/minha-conversas/:telefone/pausar', exigirLoginEmpresa, async (req, res) => {
  try {
    const telefone = req.params.telefone;
    if (!(await podeAcessarConversaDaLoja(req, telefone))) return res.status(404).json({ ok: false, erro: 'Conversa não encontrada' });
    const empresa = await getEmpresaById(req.empresaLogin.id);
    const contexto = { empresa, empresaId: req.empresaLogin.id, zapi: zapiDaEmpresa(empresa) };
    await tenantContext.run(contexto, async () => { await pausarNumero(telefone); });
    const atendenteId = (req.usuario && req.usuario.id) || null;
    const nomeAt = (req.usuario && req.usuario.nome) || req.empresaLogin.nome || 'Atendente';
    await CONVERSAS_COL().doc(`${req.empresaLogin.id}__${telefone}`).set({ botPausado: true, atendenteId, atendenteNome: nomeAt, atendenteEm: new Date().toISOString(), precisaAtendente: false }, { merge: true });
    res.json({ ok: true, atendenteNome: nomeAt });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Transfere a conversa pra outro atendente da equipe. Quem enxerga a conversa
// (o dono atual, ou o gestor vendo tudo) pode transferir — mesma regra de
// visibilidade do GET /minha-conversas.
app.post('/minha-conversas/:telefone/transferir', exigirLoginEmpresa, async (req, res) => {
  try {
    const telefone = req.params.telefone;
    const { atendenteId: novoId } = req.body || {};
    if (!novoId) return res.status(400).json({ ok: false, erro: 'Escolha pra quem transferir.' });
    if (!(await podeAcessarConversaDaLoja(req, telefone))) return res.status(404).json({ ok: false, erro: 'Conversa não encontrada' });
    const chave = `${req.empresaLogin.id}__${telefone}`;
    const ref = CONVERSAS_COL().doc(chave);
    const snap = await ref.get();
    const atual = snap.exists ? snap.data() : {};
    const souDono = atual.atendenteId && req.usuario && atual.atendenteId === req.usuario.id;
    if (req.papel !== 'gestor' && !souDono && atual.atendenteId) {
      return res.status(403).json({ ok: false, erro: 'Só o dono da conversa ou um gestor pode transferir.' });
    }
    const uDoc = await USUARIOS_COL().doc(novoId).get();
    if (!uDoc.exists || uDoc.data().empresaId !== req.empresaLogin.id) {
      return res.status(404).json({ ok: false, erro: 'Atendente de destino não encontrado' });
    }
    // Não deixa transferir pra alguém de outra loja (conversa ficaria órfã pro novo dono).
    if (atual.ofertaId && uDoc.data().ofertaId && uDoc.data().ofertaId !== atual.ofertaId) {
      return res.status(400).json({ ok: false, erro: 'Esse atendente é de outra loja.' });
    }
    await ref.set({ botPausado: true, atendenteId: novoId, atendenteNome: uDoc.data().nome || 'Atendente', atendenteEm: new Date().toISOString(), precisaAtendente: false }, { merge: true });
    res.json({ ok: true, atendenteNome: uDoc.data().nome || 'Atendente' });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Reset total do contato (zera sessões, agendamentos e conversa — igual "stop1",
// mas pelo painel, sem digitar comando nem vazar nada pro cliente).
app.post('/minha-conversas/:telefone/resetar', exigirLoginEmpresa, exigirGestor, async (req, res) => {
  try {
    const telefone = req.params.telefone;
    const empresa = await getEmpresaById(req.empresaLogin.id);
    const contexto = { empresa, empresaId: req.empresaLogin.id, zapi: zapiDaEmpresa(empresa) };
    await tenantContext.run(contexto, async () => { await resetarContato(telefone); });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post('/minha-config/faixa', exigirLoginEmpresa, exigirGestor, exigirEscopoOferta, async (req, res) => {
  try {
    const { quantidade, novaQuantidade, arquivo, link, texto, premio, ativa } = req.body;
    const configuracao = req.empresaLogin.configuracao || { ...EMPRESA_PADRAO, nome: req.empresaLogin.nome };

    // Múltiplas ofertas: ?oferta=<id> edita as faixas DENTRO dessa oferta, não as
    // do topo (mesmo padrão do /minha-config?oferta=).
    const ofertaId = req.query && req.query.oferta;
    const usaOferta = req.empresaLogin.ofertasHabilitado && ofertaId && configuracao.ofertas && configuracao.ofertas[ofertaId];
    const alvo = usaOferta ? configuracao.ofertas[ofertaId] : configuracao;
    // Oferta nova ainda não tem faixasBonus salvo (POST /minha-ofertas só grava
    // nome/ativa) — a tela (GET /minha-config) mostra nesse caso o faixasBonus
    // do TOPO da própria empresa (herdado, spread não sobrescreve chave ausente),
    // e só cai no exemplo genérico se nem isso existir. O back precisa partir da
    // MESMA fonte, senão o find() abaixo procura a quantidade errada e a 1ª
    // edição de qualquer oferta nova sempre falha com 404 (era isso que ainda
    // estava quebrado: a correção anterior usava só o exemplo genérico, que pode
    // ter uma quantidade diferente da que a empresa já usa). Copia os itens (não
    // usa a referência direta) pra não mutar um array compartilhado.
    const faixasBase = configuracao.faixasBonus || EMPRESA_PADRAO.faixasBonus;
    alvo.faixasBonus = alvo.faixasBonus || faixasBase.map(f => ({ ...f }));

    const faixa = alvo.faixasBonus.find(f => f.quantidade === quantidade);
    if (!faixa) {
      return res.status(404).json({ ok: false, erro: 'Faixa não encontrada para essa quantidade' });
    }
    if (arquivo !== undefined) faixa.arquivo = arquivo;
    if (link !== undefined) faixa.link = link;
    if (texto !== undefined) faixa.texto = texto;
    if (premio !== undefined) faixa.premio = premio;
    if (ativa !== undefined) faixa.ativa = !!ativa;
    if (novaQuantidade && novaQuantidade !== quantidade) {
      // Não pode ter duas etapas com o mesmo número de recomendações.
      if (alvo.faixasBonus.some(f => f !== faixa && f.quantidade === novaQuantidade)) {
        return res.status(400).json({ ok: false, erro: 'Já existe uma etapa com esse número de recomendações' });
      }
      faixa.quantidade = novaQuantidade;
    }

    // Mantém as etapas SEMPRE em ordem crescente de quantidade (o fluxo avança por ordem).
    alvo.faixasBonus.sort((a, b) => (a.quantidade || 0) - (b.quantidade || 0));

    if (usaOferta) {
      alvo.atualizadoEm = new Date().toISOString();
      configuracao.ofertas[ofertaId] = alvo;
      // Espelha no topo se for a oferta conectada ao WhatsApp.
      if (ofertaId === configuracao.ofertaAtivaPadrao) configuracao.faixasBonus = alvo.faixasBonus;
    }
    await EMPRESAS_COL().doc(req.empresaLogin.id).set({ configuracao }, { merge: true });
    res.json({ ok: true, faixa });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ============================================================
// LEADS ISOLADOS POR EMPRESA
// ============================================================

app.get('/minha-leads', exigirLoginEmpresa, async (req, res) => {
  try {
    let leads = await getLeadsPorEmpresa(req.empresaLogin.id);

    // Rede de lojas: usuário preso a uma loja só vê leads DAQUELA loja, mesmo
    // que peça outra por engano — mesmo padrão do GET /minha-conversas. Matriz
    // pode filtrar por qualquer loja via ?oferta=, ou ver tudo sem o parâmetro.
    const ofertaFiltro = (req.usuario && req.usuario.ofertaId) || (req.query && req.query.oferta) || null;
    if (ofertaFiltro) {
      leads = leads.filter(l => l.ofertaId === ofertaFiltro);
    }

    // Atendente (não-gestor): só vê leads sem dono (pra poder pegar) ou que ele
    // mesmo pegou — mesma regra das Conversas. Gestor vê tudo, sem filtro; o
    // parâmetro ?atendenteId=X deixa o gestor filtrar "um de cada" mesmo assim.
    if (req.papel !== 'gestor' && req.usuario) {
      leads = leads.filter(l => !l.atendenteId || l.atendenteId === req.usuario.id);
    } else if (req.query.atendenteId) {
      leads = leads.filter(l => l.atendenteId === req.query.atendenteId);
    }
    res.json({ ok: true, leads });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Cria um lead MANUALMENTE — pra quando alguém recomendou por fora do fluxo
// automático (ligou, foi pessoalmente etc.) e o dono/atendente precisa
// registrar mesmo assim pra não esquecer de chamar. Nasce na 1ª etapa do
// Kanban, igual um lead que veio do robô, e já fica com quem cadastrou.
app.post('/minha-leads', exigirLoginEmpresa, async (req, res) => {
  try {
    const nomeRecomendado = String((req.body && req.body.nomeRecomendado) || '').trim();
    const telefoneRecomendado = soDigitos((req.body && req.body.telefoneRecomendado) || '');
    if (!nomeRecomendado) return res.status(400).json({ ok: false, erro: 'Informe o nome do recomendado.' });
    if (telefoneRecomendado.length < 10) return res.status(400).json({ ok: false, erro: 'Informe um telefone válido com DDD.' });
    const nomeRecomendador = String((req.body && req.body.nomeRecomendador) || '').trim() || null;
    const telefoneRecomendadorRaw = (req.body && req.body.telefoneRecomendador) || '';
    const telefoneRecomendador = telefoneRecomendadorRaw ? soDigitos(telefoneRecomendadorRaw) : null;
    const vendedor = (req.body && req.body.vendedor) || null;

    // Rede de lojas: quem está preso a uma loja cadastra o lead já carimbado
    // com ela — sem isso, criarLead() gravava sempre ofertaId: null, mesmo
    // pra atendente de loja específica.
    let empresa = await getEmpresaById(req.empresaLogin.id);
    if (req.usuario && req.usuario.ofertaId) empresa = aplicarOferta(empresa, req.usuario.ofertaId);
    let lead = null;
    await tenantContext.run({ empresa, empresaId: req.empresaLogin.id }, async () => {
      lead = await criarLead({ nomeRecomendado, telefoneRecomendado, nomeRecomendador, telefoneRecomendador, vendedor, empresaId: req.empresaLogin.id });
    });

    // Quem cadastrou já vira o responsável — foi ele que soube da recomendação
    // e vai chamar a pessoa, mesmo padrão de "pegar" um lead sem dono.
    const atendenteId = (req.usuario && req.usuario.id) || null;
    const atendenteNome = (req.usuario && req.usuario.nome) || req.empresaLogin.nome || 'Atendente';
    if (atendenteId) {
      await LEADS_COL().doc(lead.id).set({ atendenteId, atendenteNome }, { merge: true });
      lead.atendenteId = atendenteId; lead.atendenteNome = atendenteNome;
    }

    res.status(201).json({ ok: true, lead });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Atendente pega um lead sem dono pra si (vira o responsável por ele).
app.post('/minha-leads/:id/assumir', exigirLoginEmpresa, async (req, res) => {
  try {
    const ref = LEADS_COL().doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists || snap.data().empresaId !== req.empresaLogin.id) {
      return res.status(404).json({ ok: false, erro: 'Lead não encontrado' });
    }
    // Rede de lojas: preso a uma loja só pode pegar lead da própria loja.
    if (req.usuario && req.usuario.ofertaId && snap.data().ofertaId !== req.usuario.ofertaId) {
      return res.status(404).json({ ok: false, erro: 'Lead não encontrado' });
    }
    if (snap.data().atendenteId && snap.data().atendenteId !== (req.usuario && req.usuario.id)) {
      return res.status(409).json({ ok: false, erro: 'Este lead já foi pego por outro atendente.' });
    }
    const atendenteId = (req.usuario && req.usuario.id) || null;
    const atendenteNome = (req.usuario && req.usuario.nome) || req.empresaLogin.nome || 'Atendente';
    await ref.set({ atendenteId, atendenteNome }, { merge: true });
    res.json({ ok: true, atendenteId, atendenteNome });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Transfere um lead pra outro atendente da equipe. Qualquer um que enxergue o
// lead (o dono atual, ou o gestor vendo tudo) pode transferir — mesma regra de
// visibilidade do GET acima.
app.post('/minha-leads/:id/transferir', exigirLoginEmpresa, async (req, res) => {
  try {
    const { atendenteId: novoId } = req.body || {};
    if (!novoId) return res.status(400).json({ ok: false, erro: 'Escolha pra quem transferir.' });
    const ref = LEADS_COL().doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists || snap.data().empresaId !== req.empresaLogin.id) {
      return res.status(404).json({ ok: false, erro: 'Lead não encontrado' });
    }
    const atual = snap.data();
    // Rede de lojas: preso a uma loja só mexe em lead da própria loja.
    if (req.usuario && req.usuario.ofertaId && atual.ofertaId !== req.usuario.ofertaId) {
      return res.status(404).json({ ok: false, erro: 'Lead não encontrado' });
    }
    const souDono = atual.atendenteId && req.usuario && atual.atendenteId === req.usuario.id;
    if (req.papel !== 'gestor' && !souDono && atual.atendenteId) {
      return res.status(403).json({ ok: false, erro: 'Só o dono do lead ou um gestor pode transferir.' });
    }
    const uDoc = await USUARIOS_COL().doc(novoId).get();
    if (!uDoc.exists || uDoc.data().empresaId !== req.empresaLogin.id) {
      return res.status(404).json({ ok: false, erro: 'Atendente de destino não encontrado' });
    }
    // Não deixa transferir pra alguém de outra loja (lead ficaria órfão pro novo dono).
    if (atual.ofertaId && uDoc.data().ofertaId && uDoc.data().ofertaId !== atual.ofertaId) {
      return res.status(400).json({ ok: false, erro: 'Esse atendente é de outra loja.' });
    }
    await ref.set({ atendenteId: novoId, atendenteNome: uDoc.data().nome || 'Atendente' }, { merge: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Pipeline do CLIENTE (recomendador): quem iniciou (leu o QR), deu o nome e recomendou.
app.get('/minha-clientes-pipeline', exigirLoginEmpresa, async (req, res) => {
  try {
    const snap = await CLIENTES_PIPELINE_COL().where('empresaId', '==', req.empresaLogin.id).get();
    const clientes = [];
    snap.forEach(doc => clientes.push({ id: doc.id, ...doc.data() }));
    clientes.sort((a, b) => new Date(b.atualizadoEm || b.criadoEm || 0) - new Date(a.atualizadoEm || a.criadoEm || 0));
    res.json({ ok: true, clientes });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Remove um card do funil do cliente (ex.: limpar teste). O id do doc já é
// `empresaId__telefone`, então o próprio empresaLogin.id na chave garante que
// só apaga dentro da empresa de quem está logado.
app.delete('/minha-clientes-pipeline/:telefone', exigirLoginEmpresa, exigirGestor, async (req, res) => {
  try {
    await CLIENTES_PIPELINE_COL().doc(`${req.empresaLogin.id}__${req.params.telefone}`).delete();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Move manualmente um card do funil do CLIENTE (arrastar no Kanban, corrigindo
// a etapa) e/ou grava o valor gasto numa compra — independente da etapa (esse
// funil não tem coluna "Comprou" própria, valorCompra é só um dado a mais no
// card, pra não duplicar a coluna que já existe no funil do Recomendado).
// Diferente do avanço automático (upsertClientePipeline, que nunca retrocede),
// aqui é alguém mexendo na mão — pode mover pra qualquer uma das 4 etapas.
// Sem exigirGestor de propósito: atendente também atende/vende, tem que poder
// mover o card e registrar o valor da compra — igual já funciona no funil do
// Recomendado (PATCH /minha-leads/:id, também sem essa trava).
app.patch('/minha-clientes-pipeline/:telefone', exigirLoginEmpresa, async (req, res) => {
  try {
    const ref = CLIENTES_PIPELINE_COL().doc(`${req.empresaLogin.id}__${req.params.telefone}`);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, erro: 'Card não encontrado' });

    const { etapa, valorCompra } = req.body || {};
    const dados = { atualizadoEm: new Date().toISOString() };
    if (etapa !== undefined) dados.etapa = etapa;
    if (valorCompra !== undefined) {
      const v = (valorCompra === null || valorCompra === '') ? null : Number(valorCompra);
      dados.valorCompra = (v === null || isNaN(v)) ? null : v;
    }
    await ref.set(dados, { merge: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Backfill único: move retroativamente pra "Recebeu o Prêmio" quem já estava
// em "Recomendou" ANTES dessa coluna existir (a entrega do voucher já rodava
// automática logo ao completar a faixa — só faltava o card andar no funil).
app.post('/minha-clientes-pipeline/backfill-recebeu-premio', exigirLoginEmpresa, exigirGestor, async (req, res) => {
  try {
    const empresaId = req.empresaLogin.id;
    const snap = await CLIENTES_PIPELINE_COL().where('empresaId', '==', empresaId).where('etapa', '==', 'recomendou').get();
    if (snap.empty) return res.json({ ok: true, atualizados: 0 });
    const batch = db.batch();
    snap.forEach(doc => batch.update(doc.ref, { etapa: 'recebeu_premio' }));
    await batch.commit();
    res.json({ ok: true, atualizados: snap.size });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Backfill: cria os cards do funil do cliente a partir das conversas (sessões) que já
// existem, pra o funil não ficar vazio com quem começou ANTES da função existir.
app.post('/minha-clientes-pipeline/backfill', exigirLoginEmpresa, exigirGestor, async (req, res) => {
  try {
    const empresaId = req.empresaLogin.id;
    const ehPadrao = empresaId === EMPRESA_ID_PDN;
    const prefix = `${empresaId}__`;

    // Quem já recomendou alguém (tem recomendado atribuído a ele).
    const leadsSnap = await LEADS_COL().where('empresaId', '==', empresaId).get();
    const recomendaram = new Set();
    leadsSnap.forEach(d => { const t = soDigitosTel(d.data().telefoneRecomendador); if (t) recomendaram.add(t); });

    // Cards já existentes (pra não rebaixar estágio de quem já está no funil).
    const cliSnap = await CLIENTES_PIPELINE_COL().where('empresaId', '==', empresaId).get();
    const jaTem = new Map();
    cliSnap.forEach(d => { const x = d.data(); jaTem.set(soDigitosTel(x.telefone), x.etapa); });

    const rank = { iniciou: 1, deu_nome: 2, recomendou: 3 };
    const sessSnap = await SESSOES_COL().get();
    let batch = db.batch(); let n = 0, criados = 0, atualizados = 0;
    for (const doc of sessSnap.docs) {
      const id = doc.id;
      let telefone;
      if (ehPadrao) { if (id.includes('__')) continue; telefone = id; }
      else { if (!id.startsWith(prefix)) continue; telefone = id.slice(prefix.length); }
      const tel = soDigitosTel(telefone);
      if (!tel) continue;
      const s = doc.data();
      let etapa;
      if (recomendaram.has(tel) || s.etapa === 'finalizado') etapa = 'recomendou';
      else if (s.clienteNome && s.clienteNome.trim()) etapa = 'deu_nome';
      else etapa = 'iniciou';
      const etapaAtual = jaTem.get(tel);
      if (etapaAtual && (rank[etapaAtual] || 0) >= (rank[etapa] || 1)) continue; // já igual/mais avançado
      const payload = {
        empresaId, telefone: tel, etapa,
        criadoEm: s.criadoEm || new Date().toISOString(),
        atualizadoEm: new Date().toISOString()
      };
      if (s.clienteNome && s.clienteNome.trim()) payload.nome = s.clienteNome.trim();
      batch.set(CLIENTES_PIPELINE_COL().doc(`${empresaId}__${tel}`), payload, { merge: true });
      if (etapaAtual) atualizados++; else criados++;
      if (++n >= 400) { await batch.commit(); batch = db.batch(); n = 0; }
    }
    if (n > 0) await batch.commit();
    console.log(`[BACKFILL FUNIL] empresa ${empresaId} — ${criados} criados, ${atualizados} atualizados`);
    res.json({ ok: true, criados, atualizados });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Zerar TODOS os leads da empresa logada (ex.: limpar testes antes de ir ao ar).
// Só gestor. Apaga somente os leads DESTA empresa (isolado por empresaId).
app.post('/minha-leads/zerar', exigirLoginEmpresa, exigirGestor, async (req, res) => {
  try {
    const snap = await LEADS_COL().where('empresaId', '==', req.empresaLogin.id).get();
    let apagados = 0;
    let batch = db.batch();
    let n = 0;
    for (const doc of snap.docs) {
      batch.delete(doc.ref); apagados++; n++;
      if (n >= 450) { await batch.commit(); batch = db.batch(); n = 0; }
    }
    if (n > 0) await batch.commit();
    console.log(`[ZERAR LEADS] empresa ${req.empresaLogin.id} — ${apagados} leads apagados`);
    res.json({ ok: true, apagados });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Zerar TODAS as conversas (caixa de entrada) da empresa — ex.: apagar conversas
// pessoais que vazaram quando o número é o mesmo do uso pessoal. Só gestor.
app.post('/minha-conversas/zerar', exigirLoginEmpresa, exigirGestor, async (req, res) => {
  try {
    const eid = req.empresaLogin.id;
    let apagadas = 0, batch = db.batch(), n = 0;
    const msgs = await MENSAGENS_CHAT_COL().where('empresaId', '==', eid).get();
    for (const d of msgs.docs) { batch.delete(d.ref); apagadas++; if (++n >= 450) { await batch.commit(); batch = db.batch(); n = 0; } }
    if (n > 0) await batch.commit();
    const convs = await CONVERSAS_COL().where('empresaId', '==', eid).get();
    batch = db.batch(); n = 0;
    for (const d of convs.docs) { batch.delete(d.ref); if (++n >= 450) { await batch.commit(); batch = db.batch(); n = 0; } }
    if (n > 0) await batch.commit();
    console.log(`[ZERAR CONVERSAS] empresa ${eid} — ${apagadas} mensagens apagadas`);
    res.json({ ok: true, apagadas });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Exclui UM lead (card). Só o gestor, e só da própria empresa.
app.delete('/minha-leads/:id', exigirLoginEmpresa, exigirGestor, async (req, res) => {
  try {
    const { id } = req.params;
    const ref = LEADS_COL().doc(id);
    const snap = await ref.get();
    if (!snap.exists || snap.data().empresaId !== req.empresaLogin.id) {
      return res.status(404).json({ ok: false, erro: 'Lead não encontrado' });
    }
    await ref.delete();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.patch('/minha-leads/:id', exigirLoginEmpresa, async (req, res) => {
  try {
    const { id } = req.params;

    const ref = LEADS_COL().doc(id);
    const snap = await ref.get();
    if (!snap.exists || snap.data().empresaId !== req.empresaLogin.id) {
      return res.status(404).json({ ok: false, erro: 'Lead não encontrado' });
    }

    const { etapa, vendedor, bonusPago, valorCompra } = req.body;
    const dados = {};
    if (etapa !== undefined) dados.etapa = etapa;
    if (vendedor !== undefined) dados.vendedor = vendedor;
    if (bonusPago !== undefined) dados.bonusPago = bonusPago;
    if (valorCompra !== undefined) {
      const v = (valorCompra === null || valorCompra === '') ? null : Number(valorCompra);
      dados.valorCompra = (v === null || isNaN(v)) ? null : v;
    }

    const lead = await atualizarLead(id, dados);
    if (!lead) {
      return res.status(404).json({ ok: false, erro: 'Lead não encontrado' });
    }

    // Gatilho: card movido para a coluna "Comprou" → presente ao RECOMENDADOR
    // (quem indicou). Dispara só uma vez por lead (flag vendaNotificada).
    if (dados.etapa && !lead.vendaNotificada && lead.telefoneRecomendador) {
      try {
        const empresa = await getEmpresaById(req.empresaLogin.id);
        const etapas = (empresa.etapasKanban && empresa.etapasKanban.length) ? empresa.etapasKanban : EMPRESA_PADRAO.etapasKanban;
        const alvo = etapas.find(e => e.id === dados.etapa);
        const ehComprou = !!alvo && (/comprou|comprar|vendeu|venda|fechou/i.test(alvo.nome || '') || /comprou|comprar|vendeu|venda|fechou/i.test(alvo.id || ''));
        if (ehComprou) {
          // Reivindica o envio de forma ATÔMICA (transação): se a PATCH chegar
          // duas vezes quase juntas, só uma marca o flag e envia — sem duplicar.
          const refLead = LEADS_COL().doc(id);
          const reivindicou = await db.runTransaction(async (t) => {
            const s = await t.get(refLead);
            if (!s.exists || s.data().vendaNotificada) return false;
            t.update(refLead, { vendaNotificada: true, vendaNotificadaEm: new Date().toISOString() });
            return true;
          });
          if (reivindicou) {
            const contexto = { empresa, empresaId: req.empresaLogin.id, zapi: zapiDaEmpresa(empresa) };
            await tenantContext.run(contexto, async () => {
              await enviarPresenteVendaAoRecomendador(lead, empresa);
            });
          }
        }
      } catch (e) {
        console.error('[VENDA] erro ao disparar presente ao recomendador:', e.message);
      }
    }

    res.json({ ok: true, lead });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ============================================================
// ROTA DE CRIAÇÃO DE EMPRESA (admin)
// ============================================================

app.post('/admin/empresas', exigirAcessoCriarEmpresa, async (req, res) => {
  try {
    const ehVendedor = !req.acesso.ehDono;

    const {
      // dados da empresa (endereço completo fica só aqui)
      razaoSocial, nomeFantasia, cnpj, cep, enderecoEmpresa, bairro, cidade, estado,
      emailEmpresa, telefoneEmpresa,
      // dados do sócio
      nomeSocio, cpfSocio, emailSocio, whatsappSocio,
      // instância Z-API provisionada para o cliente (opcional)
      zapiInstanceId, zapiToken, zapiClientToken,
      // acesso / compatibilidade com a versão antiga
      nome, email, senha, migrarConfigPrincipal, empresaTeste,
      // período gratuito (trial) concedido no cadastro, em dias (0 = nenhum)
      trialDias,
      // vendedor da comissão (informado pelo dono; vendedor é forçado abaixo)
      vendedorComissao,
      // autocadastro do cliente: plano escolhido + aceite do contrato
      plano, aceiteContrato
    } = req.body;

    // No autocadastro pelo link, o aceite do contrato é obrigatório.
    if (req.acesso.ehClienteLink && !aceiteContrato) {
      return res.status(400).json({ ok: false, erro: 'É preciso ler e aceitar o contrato.' });
    }

    // Vendedor logado: cliente sempre vinculado a ele; sem trial/migração.
    const vendedorVinc = ehVendedor ? req.acesso.vendedorId : (vendedorComissao || null);
    const _migrarConfig = ehVendedor ? false : migrarConfigPrincipal;
    const _empresaTeste = ehVendedor ? false : empresaTeste;

    // Nome de exibição (usado nas mensagens): fantasia > razão social > compat
    const nomeEmpresa = (nomeFantasia || razaoSocial || nome || '').trim();
    // E-mail de login: e-mail da empresa > sócio > compat
    const emailLogin = (emailEmpresa || emailSocio || email || '').trim().toLowerCase();

    if (!nomeEmpresa || !emailLogin || !senha) {
      return res.status(400).json({ ok: false, erro: 'Informe ao menos nome da empresa, e-mail de acesso e senha' });
    }

    const existenteSnap = await EMPRESAS_COL().where('email', '==', emailLogin).limit(1).get();
    if (!existenteSnap.empty) {
      return res.status(409).json({ ok: false, erro: 'Já existe uma empresa cadastrada com este e-mail' });
    }

    let configuracaoInicial = { ...EMPRESA_PADRAO, nome: nomeEmpresa };

    if (_empresaTeste) {
      // Empresa de teste: faixa 1 com quantidade = 1 e tempo de espera = 1 min
      // para validar todo o fluxo rapidamente sem precisar mandar 5 contatos
      configuracaoInicial = { ...EMPRESA_TESTE_CONFIG, nome: nomeEmpresa };
    } else if (_migrarConfig) {
      const empresaReal = await getEmpresa();
      configuracaoInicial = { ...empresaReal };
    }

    // Dados cadastrais completos — base para gerar o contrato depois.
    const cadastro = {
      razaoSocial: razaoSocial || null,
      nomeFantasia: nomeFantasia || null,
      cnpj: cnpj || null,
      cep: cep || null,
      enderecoEmpresa: enderecoEmpresa || null,
      bairro: bairro || null,
      cidade: cidade || null,
      estado: estado || null,
      emailEmpresa: emailEmpresa || null,
      telefoneEmpresa: telefoneEmpresa || null,
      nomeSocio: nomeSocio || null,
      cpfSocio: cpfSocio || null,
      emailSocio: emailSocio || null,
      whatsappSocio: whatsappSocio || null,
      ...(plano ? { plano: String(plano) } : {}),
      // Aceite do contrato (autocadastro): guarda quando e de onde veio.
      ...(req.acesso.ehClienteLink && aceiteContrato ? {
        contrato: {
          aceito: true,
          aceitoEm: new Date().toISOString(),
          ip: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim()
        }
      } : {})
    };

    // Período gratuito (trial) opcional — só o dono concede.
    const dias = ehVendedor ? 0 : Math.max(0, parseInt(trialDias, 10) || 0);
    let assinatura = null;
    if (dias > 0) {
      const ate = new Date(); ate.setDate(ate.getDate() + dias);
      assinatura = { status: 'trial', ciclo: 'trial', acessoAte: ate.toISOString(), atualizadoEm: new Date().toISOString() };
    }

    const ehLinkCliente = !!req.acesso.ehClienteLink;
    // No autocadastro a senha é sempre a padrão (o cliente troca no 1º login).
    // Forçado no servidor — não confia no que a página mandar.
    const senhaFinal = ehLinkCliente ? SENHA_PADRAO_AUTOCADASTRO : senha;
    const senhaHash = await bcrypt.hash(senhaFinal, 10);
    const ref = await EMPRESAS_COL().add({
      nome: nomeEmpresa,
      email: emailLogin,
      senhaHash,
      senhaProvisoria: true,
      // Veio pelo link do cliente? Entra PENDENTE — o dono valida antes de liberar.
      ...(ehLinkCliente ? { pendenteAprovacao: true } : {}),
      cadastro,
      zapiInstanceId: zapiInstanceId ? String(zapiInstanceId).trim() : null,
      zapiToken: zapiToken ? String(zapiToken).trim() : null,
      zapiClientToken: zapiClientToken ? String(zapiClientToken).trim() : null,
      criadoEm: new Date().toISOString(),
      configuracao: configuracaoInicial,
      ...(vendedorVinc ? { vendedorComissao: vendedorVinc } : {}),
      ...(assinatura ? { assinatura } : {})
    });

    res.json({ ok: true, pendente: ehLinkCliente, empresa: { id: ref.id, nome: nomeEmpresa, email: emailLogin, empresaTeste: !!_empresaTeste, trialDias: dias } });

    // E-mail de boas-vindas (não bloqueia a resposta; ignora se não configurado).
    // No autocadastro NÃO manda agora: só quando o dono validar o cadastro.
    if (!_empresaTeste && !ehLinkCliente) {
      enviarBoasVindasCliente({ nomeEmpresa, emailLogin, senha, req })
        .catch(e => console.error('[EMAIL] boas-vindas falhou:', e.message));
    }
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ============================================================
// PAINEL DO DONO — área administrativa (protegida por X-Admin-Key)
// ============================================================
// Exige acesso de DONO (chave mestra OU login de administrador). Usado em todos
// os endpoints administrativos sensíveis — sem mudança por endpoint.
function exigirAdmin(req, res, next) {
  return limiteAdmin(req, res, async () => {
    const ctx = await resolverAcessoAdmin(req);
    if (!ctx || !ctx.ehDono) {
      return res.status(401).json({ ok: false, erro: 'Chave administrativa inválida' });
    }
    req.acesso = ctx;
    next();
  });
}

// Resolve o acesso ao painel: dono (chave mestra OU login admin) OU vendedor.
async function resolverAcessoAdmin(req) {
  const chave = req.headers['x-admin-key'];
  if (chave && chave === ADMIN_SECRET) return { ehDono: true };
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) {
    try {
      const p = jwt.verify(m[1], JWT_SECRET);
      if (p && p.tipo === 'admin-dono' && p.adminId) {
        const ad = await ADMINS_COL().doc(p.adminId).get();
        if (ad.exists) return { ehDono: true, adminId: ad.id, adminEmail: ad.data().email || '' };
      }
      if (p && p.tipo === 'vendedor-admin' && p.vendedorId) {
        const vd = await VENDEDORES_COL().doc(p.vendedorId).get();
        if (vd.exists && vd.data().ativo !== false) {
          return { ehDono: false, vendedorId: vd.id, vendedorNome: vd.data().nome || p.nome || '' };
        }
      }
    } catch (e) {}
  }
  return null;
}

// Login fácil do administrador (e-mail + senha) → token de acesso total (7 dias).
app.post('/admin/admin-login', limiteLogin, async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const senha = String((req.body && req.body.senha) || '');
    if (!email || !senha) return res.status(400).json({ ok: false, erro: 'Informe e-mail e senha' });
    const snap = await ADMINS_COL().where('email', '==', email).limit(1).get();
    if (snap.empty) return res.status(401).json({ ok: false, erro: 'E-mail ou senha inválidos' });
    const doc = snap.docs[0];
    const ok = await bcrypt.compare(senha, doc.data().senhaHash || '');
    if (!ok) return res.status(401).json({ ok: false, erro: 'E-mail ou senha inválidos' });
    const token = jwt.sign({ tipo: 'admin-dono', adminId: doc.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ ok: true, token, email });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Cria/atualiza o login fácil do administrador (precisa estar autenticado como dono).
app.post('/admin/definir-acesso', exigirAdmin, async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const senha = String((req.body && req.body.senha) || '');
    if (!email || !senha) return res.status(400).json({ ok: false, erro: 'Informe e-mail e senha' });
    if (senha.length < 4) return res.status(400).json({ ok: false, erro: 'A senha precisa ter ao menos 4 caracteres' });
    const senhaHash = await bcrypt.hash(senha, 10);
    const snap = await ADMINS_COL().where('email', '==', email).limit(1).get();
    if (snap.empty) {
      await ADMINS_COL().add({ email, senhaHash, criadoEm: new Date().toISOString() });
    } else {
      await snap.docs[0].ref.set({ senhaHash, atualizadoEm: new Date().toISOString() }, { merge: true });
    }
    res.json({ ok: true, email });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Lista os e-mails de administrador já cadastrados (para exibição no painel).
app.get('/admin/meu-acesso', exigirAdmin, async (req, res) => {
  try {
    const snap = await ADMINS_COL().get();
    const emails = snap.docs.map(d => d.data().email).filter(Boolean);
    res.json({ ok: true, emails });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Middleware: aceita dono OU vendedor logado. Preenche req.acesso.
function exigirAcessoAdmin(req, res, next) {
  return limiteAdmin(req, res, async () => {
    const ctx = await resolverAcessoAdmin(req);
    if (!ctx) return res.status(401).json({ ok: false, erro: 'Acesso negado' });
    req.acesso = ctx;
    next();
  });
}

// Acesso para CRIAR EMPRESA: admin/vendedor logado OU o link fixo do cliente
// (/cliente/cadastro?c=CHAVE). O link tem escopo LIMITADO — só vale nesta rota,
// não dá acesso a comissões nem a nada mais do /admin, e o cadastro entra
// PENDENTE (o dono valida antes de liberar o acesso).
function exigirAcessoCriarEmpresa(req, res, next) {
  return limiteAdmin(req, res, async () => {
    const ctx = await resolverAcessoAdmin(req);
    if (ctx) { req.acesso = ctx; return next(); }
    const chave = String(req.headers['x-cadastro-key'] || '');
    if (chave) {
      const atual = await getChaveCadastroCliente();
      // comparação em tempo constante
      const a = Buffer.from(chave), b = Buffer.from(atual);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        req.acesso = { ehDono: false, ehClienteLink: true, vendedorId: null };
        return next();
      }
    }
    return res.status(401).json({ ok: false, erro: 'Acesso negado' });
  });
}

// Painel: pega o LINK FIXO de autocadastro do cliente (cria a chave na 1ª vez).
app.get('/admin/cadastro-cliente-link', exigirAcessoAdmin, async (req, res) => {
  try {
    const chave = await getChaveCadastroCliente();
    const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ ok: true, link: `${base}/cliente/cadastro?c=${encodeURIComponent(chave)}` });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Troca a chave (invalida o link antigo) — use se o link vazar.
app.post('/admin/cadastro-cliente-link/rotacionar', exigirAdmin, async (req, res) => {
  try {
    const chave = crypto.randomBytes(9).toString('base64url');
    await CADASTRO_CLIENTE_DOC().set({ chave, criadoEm: new Date().toISOString() }, { merge: true });
    const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ ok: true, link: `${base}/cliente/cadastro?c=${encodeURIComponent(chave)}` });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Página pública de autocadastro do cliente (link fixo compartilhado pelo dono).
app.get('/cliente/cadastro', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-criar-empresa.html'));
});

// Exclui uma empresa e TODOS os dados dela. IRREVERSÍVEL — só o dono.
// Limpa também as coleções ligadas por empresaId, pra não deixar lixo órfão.
app.delete('/admin/empresas/:id', exigirAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const ref = EMPRESAS_COL().doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, erro: 'Empresa não encontrada' });
    const nome = (snap.data() || {}).nome || '';

    // Trava de segurança: se a empresa TEM leads, é cliente de verdade —
    // exige confirmação com o nome exato. Fica no servidor de propósito
    // (a contagem do painel é best-effort e pode falhar).
    const temLeads = !(await LEADS_COL().where('empresaId', '==', id).limit(1).get()).empty;
    if (temLeads) {
      const confirmar = String((req.query && req.query.confirmar) || '');
      if (confirmar.trim() !== nome.trim()) {
        return res.status(428).json({
          ok: false, precisaConfirmar: true, nome,
          erro: 'Esta empresa tem leads. Para excluir, confirme digitando o nome exato.'
        });
      }
    }

    const cols = [
      ['usuarios', USUARIOS_COL], ['leads', LEADS_COL], ['sessoes', SESSOES_COL],
      ['agendamentos', AGENDAMENTOS_COL], ['mensagens_chat', MENSAGENS_CHAT_COL],
      ['conversas', CONVERSAS_COL]
    ];
    const apagados = {};
    for (const [rotulo, col] of cols) {
      let total = 0;
      try {
        // apaga em lotes (limite do batch do Firestore é 500)
        for (;;) {
          const s = await col().where('empresaId', '==', id).limit(400).get();
          if (s.empty) break;
          const batch = db.batch();
          s.docs.forEach(d => batch.delete(d.ref));
          await batch.commit();
          total += s.size;
          if (s.size < 400) break;
        }
      } catch (e) {
        console.error(`[excluir empresa ${id}] falha em ${rotulo}:`, e.message);
      }
      apagados[rotulo] = total;
    }
    await ref.delete();
    console.log(`[excluir empresa] ${id} (${nome}) removida:`, JSON.stringify(apagados));
    res.json({ ok: true, nome, apagados });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Valida (aprova) um cadastro que veio pelo link do cliente: libera o acesso
// e só então dispara o e-mail de boas-vindas.
app.post('/admin/empresas/:id/validar', exigirAdmin, async (req, res) => {
  try {
    const ref = EMPRESAS_COL().doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, erro: 'Empresa não encontrada' });
    const e = snap.data() || {};
    if (!e.pendenteAprovacao) return res.json({ ok: true, jaAtivo: true });
    await ref.update({ pendenteAprovacao: false, validadoEm: new Date().toISOString() });
    res.json({ ok: true });
    // Só cai aqui quem veio do autocadastro → a senha é a padrão (provisória).
    enviarBoasVindasCliente({ nomeEmpresa: e.nome, emailLogin: e.email, senha: SENHA_PADRAO_AUTOCADASTRO, req })
      .catch(err => console.error('[EMAIL] boas-vindas (validar) falhou:', err.message));
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Login do vendedor (e-mail + senha) → token de acesso limitado ao /admin.
app.post('/admin/vendedor-login', limiteLogin, async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const senha = String((req.body && req.body.senha) || '');
    if (!email || !senha) return res.status(400).json({ ok: false, erro: 'Informe e-mail e senha' });
    const snap = await VENDEDORES_COL().where('email', '==', email).limit(1).get();
    if (snap.empty) return res.status(401).json({ ok: false, erro: 'E-mail ou senha inválidos' });
    const doc = snap.docs[0];
    const v = doc.data();
    if (v.ativo === false) return res.status(403).json({ ok: false, erro: 'Conta de vendedor desativada' });
    const ok = await bcrypt.compare(senha, v.senhaHash || '');
    if (!ok) return res.status(401).json({ ok: false, erro: 'E-mail ou senha inválidos' });
    const token = jwt.sign({ tipo: 'vendedor-admin', vendedorId: doc.id, nome: v.nome || '' }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ ok: true, token, nome: v.nome || '', vendedorId: doc.id });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// CRUD de vendedores (somente o dono).
app.get('/admin/vendedores', exigirAdmin, async (req, res) => {
  try {
    const snap = await VENDEDORES_COL().get();
    const vendedores = snap.docs.map(d => {
      const x = d.data();
      return { id: d.id, nome: x.nome || '', email: x.email || '', cnpj: x.cnpj || '', endereco: x.endereco || '', whatsapp: x.whatsapp || '', banco: x.banco || {}, comissaoPct: (x.comissaoPct != null ? x.comissaoPct : COMISSAO_PCT), ativo: x.ativo !== false, autocadastro: !!x.autocadastro, contratoAceito: !!(x.contrato && x.contrato.aceito), criadoEm: x.criadoEm || null };
    }).sort((a, b) => (a.nome || '').localeCompare(b.nome || ''));
    res.json({ ok: true, vendedores });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post('/admin/vendedores', exigirAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const nome = String(b.nome || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    const senha = String(b.senha || '');
    if (!nome || !email || !senha) return res.status(400).json({ ok: false, erro: 'Informe nome, e-mail e senha' });
    const dup = await VENDEDORES_COL().where('email', '==', email).limit(1).get();
    if (!dup.empty) return res.status(409).json({ ok: false, erro: 'Já existe um vendedor com este e-mail' });
    const banco = b.banco && typeof b.banco === 'object' ? b.banco : {};
    const senhaHash = await bcrypt.hash(senha, 10);
    const pct = (b.comissaoPct != null && Number(b.comissaoPct) >= 0) ? Number(b.comissaoPct) : COMISSAO_PCT;
    const ref = await VENDEDORES_COL().add({
      nome, email, senhaHash, ativo: true,
      cnpj: b.cnpj || null, endereco: b.endereco || null, whatsapp: b.whatsapp || null,
      comissaoPct: pct,
      banco: {
        banco: banco.banco || null, agencia: banco.agencia || null, conta: banco.conta || null,
        tipo: banco.tipo || null, pix: banco.pix || null, titular: banco.titular || null
      },
      criadoEm: new Date().toISOString()
    });
    res.json({ ok: true, vendedor: { id: ref.id, nome, email } });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.patch('/admin/vendedores/:id', exigirAdmin, async (req, res) => {
  try {
    const ref = VENDEDORES_COL().doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ ok: false, erro: 'Vendedor não encontrado' });
    const b = req.body || {};
    const upd = {};
    ['nome', 'cnpj', 'endereco', 'whatsapp'].forEach(k => { if (b[k] !== undefined) upd[k] = (b[k] === '' ? null : b[k]); });
    if (b.email !== undefined && String(b.email).trim()) upd.email = String(b.email).trim().toLowerCase();
    if (b.banco && typeof b.banco === 'object') upd.banco = { ...(doc.data().banco || {}), ...b.banco };
    if (b.comissaoPct !== undefined && Number(b.comissaoPct) >= 0) upd.comissaoPct = Number(b.comissaoPct);
    if (b.ativo !== undefined) upd.ativo = !!b.ativo;
    if (b.novaSenha) upd.senhaHash = await bcrypt.hash(String(b.novaSenha), 10);
    if (!Object.keys(upd).length) return res.json({ ok: true });
    await ref.set(upd, { merge: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Página pública de autocadastro do vendedor (link compartilhado pelo dono).
app.get('/vendedor/cadastro', (req, res) => {
  res.sendFile(path.join(__dirname, 'vendedor-cadastro.html'));
});

// Autocadastro do vendedor: ele mesmo preenche os dados + banco e aceita o contrato.
app.post('/vendedor/cadastro', limiteLogin, async (req, res) => {
  try {
    const b = req.body || {};
    const nome = String(b.nome || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    const senha = String(b.senha || '');
    if (!nome || !email || !senha) return res.status(400).json({ ok: false, erro: 'Informe nome, e-mail e senha' });
    if (senha.length < 4) return res.status(400).json({ ok: false, erro: 'A senha precisa ter ao menos 4 caracteres' });
    if (!b.aceiteContrato) return res.status(400).json({ ok: false, erro: 'É preciso ler e aceitar o contrato' });
    const dup = await VENDEDORES_COL().where('email', '==', email).limit(1).get();
    if (!dup.empty) return res.status(409).json({ ok: false, erro: 'Já existe um cadastro com este e-mail' });
    const banco = b.banco && typeof b.banco === 'object' ? b.banco : {};
    const senhaHash = await bcrypt.hash(senha, 10);
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
    await VENDEDORES_COL().add({
      nome, email, senhaHash, ativo: true, autocadastro: true,
      cnpj: b.cnpj || null, endereco: b.endereco || null, whatsapp: b.whatsapp || null,
      comissaoPct: COMISSAO_PCT,
      banco: {
        banco: banco.banco || null, agencia: banco.agencia || null, conta: banco.conta || null,
        tipo: banco.tipo || null, pix: banco.pix || null, titular: banco.titular || null
      },
      contrato: { aceito: true, em: new Date().toISOString(), ip },
      criadoEm: new Date().toISOString()
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Aviso global — consultar (admin) e publicar para todos os clientes.
// Relatório de comissões dos vendedores (dono vê tudo; vendedor só as dele).
app.get('/admin/comissoes', exigirAcessoAdmin, async (req, res) => {
  try {
    const snap = await COMISSOES_COL().get();
    let itens = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => new Date(b.data || 0) - new Date(a.data || 0));
    if (!req.acesso.ehDono) itens = itens.filter(i => i.vendedorId === req.acesso.vendedorId);
    const map = {};
    itens.forEach(i => {
      const v = i.vendedor || '—';
      if (!map[v]) map[v] = { vendedor: v, aReceberCentavos: 0, pagoCentavos: 0, qtd: 0 };
      map[v].qtd++;
      if (i.pago) map[v].pagoCentavos += i.comissaoCentavos || 0;
      else map[v].aReceberCentavos += i.comissaoCentavos || 0;
    });
    res.json({ ok: true, itens, resumo: Object.values(map).sort((a, b) => b.aReceberCentavos - a.aReceberCentavos) });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Marca comissões como pagas (por vendedor — todas as pendentes, ou por id).
app.post('/admin/comissoes/marcar-pago', exigirAdmin, async (req, res) => {
  try {
    const { vendedor, id } = req.body || {};
    let marcados = 0;
    if (id) {
      await COMISSOES_COL().doc(id).set({ pago: true, pagoEm: new Date().toISOString() }, { merge: true });
      marcados = 1;
    } else if (vendedor) {
      const snap = await COMISSOES_COL().where('vendedor', '==', vendedor).get();
      const pend = snap.docs.filter(d => !d.data().pago);
      const batch = db.batch();
      pend.forEach(d => { batch.set(d.ref, { pago: true, pagoEm: new Date().toISOString() }, { merge: true }); marcados++; });
      if (marcados) await batch.commit();
    }
    res.json({ ok: true, marcados });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Histórico de avisos enviados (admin).
app.get('/admin/avisos', exigirAdmin, async (req, res) => {
  try {
    const snap = await AVISOS_COL().get();
    const avisos = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => new Date(b.criadoEm || 0) - new Date(a.criadoEm || 0));
    res.json({ ok: true, avisos });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Apaga um aviso (some da lista e para de aparecer pros clientes).
app.delete('/admin/aviso/:id', exigirAdmin, async (req, res) => {
  try {
    await AVISOS_COL().doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post('/admin/aviso', exigirAdmin, async (req, res) => {
  try {
    const { titulo, mensagem, enviarWhatsapp } = req.body || {};
    if (!String(mensagem || '').trim()) {
      return res.status(400).json({ ok: false, erro: 'Escreva a mensagem do aviso.' });
    }
    const ref = await AVISOS_COL().add({
      titulo: String(titulo || '').trim(),
      mensagem: String(mensagem || '').trim(),
      ativo: true,
      criadoEm: new Date().toISOString()
    });
    let zap = { enviados: 0, semNumero: 0 };
    if (enviarWhatsapp) zap = await broadcastAvisoWhatsapp(String(titulo || ''), String(mensagem || ''));
    res.json({ ok: true, id: ref.id, whatsapp: zap });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Envia o aviso por WhatsApp para o número do dono de cada empresa, usando a
// Z-API global (número da plataforma). Best-effort.
async function broadcastAvisoWhatsapp(titulo, mensagem) {
  const texto = (titulo ? `*${titulo}*\n\n` : '') + mensagem;
  let enviados = 0, semNumero = 0;
  if (!ZAPI_GLOBAL.instanceId || !ZAPI_GLOBAL.token) return { enviados, semNumero, erro: 'Z-API global não configurada' };
  const snap = await EMPRESAS_COL().get();
  for (const d of snap.docs) {
    const c = d.data().cadastro || {};
    let tel = String(c.whatsappSocio || c.telefoneEmpresa || c.telefone || '').replace(/\D/g, '');
    if (!tel) { semNumero++; continue; }
    if ((tel.length === 10 || tel.length === 11) && !tel.startsWith('55')) tel = '55' + tel;
    try {
      await tenantContext.run({ empresaId: EMPRESA_ID_PDN, zapi: ZAPI_GLOBAL }, async () => { await sendText(tel, texto); });
      enviados++;
    } catch (e) { console.error('[AVISO-WPP] falha para', tel, e.message); }
  }
  console.log(`[AVISO-WPP] enviados ${enviados}, sem número ${semNumero}`);
  return { enviados, semNumero };
}

// Lista todos os clientes com um resumo para o painel do dono.
app.get('/admin/empresas', exigirAdmin, async (req, res) => {
  try {
    const snap = await EMPRESAS_COL().get();
    const empresas = [];
    snap.forEach(d => {
      const data = d.data();
      empresas.push({
        id: d.id,
        nome: data.nome || null,
        email: data.email || null,
        criadoEm: data.criadoEm || null,
        senhaProvisoria: !!data.senhaProvisoria,
        // Autocadastro pelo link do cliente aguardando validação do dono.
        pendenteAprovacao: !!data.pendenteAprovacao,
        cadastro: data.cadastro || null,
        plano: data.plano || null,
        statusPagamento: data.statusPagamento || null,
        valorMensal: data.valorMensal || null,
        observacoes: data.observacoes || null,
        zapiInstanceId: data.zapiInstanceId || null,
        zapiToken: data.zapiToken || null,
        zapiClientToken: data.zapiClientToken || null,
        whatsappProvisionado: !!(data.zapiInstanceId && data.zapiToken),
        whatsappMonitor: data.whatsappMonitor || null,
        entregaMonitor: data.entregaMonitor || null,
        whatsappTipo: data.whatsappTipo || 'zapi',
        assinatura: data.assinatura || null,
        ofertasHabilitado: !!data.ofertasHabilitado,
        leads: 0
      });
    });
    // Conta leads por empresa
    try {
      const leadsSnap = await LEADS_COL().get();
      const contagem = {};
      leadsSnap.forEach(d => { const e = d.data().empresaId; if (e) contagem[e] = (contagem[e] || 0) + 1; });
      empresas.forEach(e => { e.leads = contagem[e.id] || 0; });
    } catch (e) { /* contagem é best-effort */ }
    empresas.sort((a, b) => new Date(b.criadoEm || 0) - new Date(a.criadoEm || 0));
    res.json({ ok: true, empresas });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// "Entrar como" — emite um token de sessão da empresa para o dono configurar
// o painel do cliente sem precisar da senha dele.
app.post('/admin/empresas/:id/impersonar', exigirAdmin, async (req, res) => {
  try {
    const doc = await EMPRESAS_COL().doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ ok: false, erro: 'Empresa não encontrada' });
    const d = doc.data();
    const token = jwt.sign({ empresaLoginId: doc.id }, JWT_SECRET, { expiresIn: '1d' });
    res.json({ ok: true, token, empresa: { id: doc.id, nome: d.nome, email: d.email } });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Libera um período de teste (trial) para a empresa — concedido manualmente
// pelo admin. Body: { dias } (padrão 14).
app.post('/admin/empresas/:id/trial', exigirAdmin, async (req, res) => {
  try {
    const doc = await EMPRESAS_COL().doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ ok: false, erro: 'Empresa não encontrada' });
    const dias = Math.max(1, parseInt((req.body && req.body.dias), 10) || 14);
    const ate = new Date(); ate.setDate(ate.getDate() + dias);
    const atual = doc.data().assinatura || {};
    await EMPRESAS_COL().doc(req.params.id).set({
      assinatura: { ...atual, status: 'trial', ciclo: 'trial', acessoAte: ate.toISOString(), atualizadoEm: new Date().toISOString() }
    }, { merge: true });
    res.json({ ok: true, acessoAte: ate.toISOString(), dias });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Reseta a senha do cliente para uma provisória (padrão 123mudar) e reativa a
// troca obrigatória no próximo acesso.
app.post('/admin/empresas/:id/resetar-senha', exigirAdmin, async (req, res) => {
  try {
    const doc = await EMPRESAS_COL().doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ ok: false, erro: 'Empresa não encontrada' });
    const novaSenha = (req.body && req.body.senha) || '123mudar';
    const senhaHash = await bcrypt.hash(novaSenha, 10);
    await EMPRESAS_COL().doc(req.params.id).set({ senhaHash, senhaProvisoria: true }, { merge: true });
    // Se pedido, reenvia o e-mail de boas-vindas com a nova senha provisória
    let emailEnviado = null;
    if (req.body && req.body.enviarEmail) {
      const e = doc.data();
      emailEnviado = await enviarBoasVindasCliente({
        nomeEmpresa: e.nome || 'Cliente', emailLogin: e.email, senha: novaSenha, req
      });
    }
    res.json({ ok: true, senha: novaSenha, emailEnviado });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Diagnóstico do e-mail: mostra se as variáveis estão no Render, testa a
// conexão SMTP (login/senha de app) e, se ?para=... for passado, envia um
// e-mail de teste e retorna o erro exato do Google, se houver.
app.get('/admin/email/diagnostico', exigirAdmin, async (req, res) => {
  const configurado = !!(EMAIL_USER && EMAIL_APP_PASSWORD);
  const info = {
    configurado,
    EMAIL_USER: EMAIL_USER ? EMAIL_USER : '(vazio)',
    EMAIL_APP_PASSWORD: EMAIL_APP_PASSWORD ? `definida (${EMAIL_APP_PASSWORD.length} caracteres)` : '(vazio)',
    dica: null,
    conexao: null,
    envioTeste: null
  };
  if (!configurado) {
    info.dica = 'Faltam as variáveis EMAIL_USER e/ou EMAIL_APP_PASSWORD no Render (Environment). Adicione e salve para reiniciar.';
    return res.json({ ok: true, diagnostico: info });
  }
  if (/\s/.test(EMAIL_APP_PASSWORD)) {
    info.dica = 'A EMAIL_APP_PASSWORD contém espaços. A senha de app do Google são 16 letras SEM espaços — remova os espaços no Render.';
  }
  // Testa a conexão/autenticação SMTP
  try {
    const t = getEmailTransporter();
    await t.verify();
    info.conexao = { ok: true, msg: 'Login SMTP OK (usuário e senha de app aceitos pelo Google).' };
  } catch (err) {
    info.conexao = { ok: false, erro: err.message, code: err.code || null, response: err.response || null };
    if (/Username and Password not accepted|BadCredentials|535/i.test(err.message + (err.response || ''))) {
      info.dica = 'Google recusou usuário/senha. Gere uma NOVA Senha de App (2 etapas precisa estar ATIVA na conta) e cole sem espaços. Não use a senha normal do e-mail.';
    }
  }
  // Envio de teste opcional
  const para = (req.query.para || '').trim();
  if (para) {
    info.envioTeste = await enviarEmail({
      para,
      assunto: '✅ Teste de e-mail — RecomendaLeads',
      html: '<p>Este é um e-mail de teste do RecomendaLeads. Se você recebeu, o envio está funcionando! 🎉</p>',
      texto: 'Teste de e-mail do RecomendaLeads. Se você recebeu, está funcionando!'
    });
  }
  res.json({ ok: true, diagnostico: info });
});

// Atualiza dados administrativos do cliente: plano, financeiro, Z-API, notas.
app.patch('/admin/empresas/:id', exigirAdmin, async (req, res) => {
  try {
    const ref = EMPRESAS_COL().doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ ok: false, erro: 'Empresa não encontrada' });
    const atual = doc.data();
    const b = req.body || {};
    const upd = {};
    ['plano', 'statusPagamento', 'valorMensal', 'observacoes', 'zapiInstanceId', 'zapiToken', 'zapiClientToken', 'vendedorComissao', 'whatsappTipo'].forEach(k => {
      if (b[k] !== undefined) upd[k] = (b[k] === '' ? null : b[k]);
    });
    // Pré-pago: liga/desliga a cobrança e ajusta os preços (em centavos).
    if (b.prepagoAtivo !== undefined) upd.prepagoAtivo = !!b.prepagoAtivo;
    // Múltiplas ofertas/lançamentos: função extra, só o admin habilita por cliente
    // (cobrada à parte). Gate real fica nos endpoints /minha-ofertas* (server-side).
    if (b.ofertasHabilitado !== undefined) upd.ofertasHabilitado = !!b.ofertasHabilitado;
    if (b.precoMktCentavos !== undefined && b.precoMktCentavos !== '') upd.precoMktCentavos = Math.max(0, parseInt(b.precoMktCentavos, 10) || 0);
    if (b.precoUtilCentavos !== undefined && b.precoUtilCentavos !== '') upd.precoUtilCentavos = Math.max(0, parseInt(b.precoUtilCentavos, 10) || 0);
    if (b.nome !== undefined && String(b.nome).trim()) {
      upd.nome = String(b.nome).trim();
      // mantém o nome de exibição usado nas mensagens em sincronia
      upd.configuracao = { ...(atual.configuracao || {}), nome: upd.nome };
    }
    if (b.email !== undefined && String(b.email).trim()) upd.email = String(b.email).trim().toLowerCase();
    if (b.cadastro && typeof b.cadastro === 'object') {
      upd.cadastro = { ...(atual.cadastro || {}), ...b.cadastro };
    }
    if (!Object.keys(upd).length) return res.json({ ok: true });
    await ref.set(upd, { merge: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ============================================================
// PRÉ-PAGO — endpoints (admin lança recarga / vê extrato; cliente vê saldo)
// ============================================================

// Extrato + saldo de uma empresa (admin). Últimas 50 transações.
app.get('/admin/empresas/:id/prepago', exigirAdmin, async (req, res) => {
  try {
    const doc = await EMPRESAS_COL().doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ ok: false, erro: 'Empresa não encontrada' });
    const d = doc.data();
    let extrato = [];
    try {
      const snap = await TRANSACOES_COL().where('empresaId', '==', req.params.id).get();
      extrato = snap.docs.map(x => x.data()).sort((a, b) => String(b.em).localeCompare(String(a.em))).slice(0, 50);
    } catch (e) { console.warn('[PREPAGO] extrato admin:', e.message); }
    res.json({
      ok: true,
      prepagoAtivo: !!d.prepagoAtivo,
      saldoCentavos: d.saldoCentavos || 0,
      precoMktCentavos: d.precoMktCentavos != null ? d.precoMktCentavos : PRECO_MKT_PADRAO,
      precoUtilCentavos: d.precoUtilCentavos != null ? d.precoUtilCentavos : PRECO_UTIL_PADRAO,
      extrato
    });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Lança recarga (crédito) numa empresa — depois que o cliente pagou o Pix.
// Body: { valorCentavos } OU { valorReais } (aceita "50", "50,00", "50.00").
app.post('/admin/empresas/:id/recarga', exigirAdmin, async (req, res) => {
  try {
    const doc = await EMPRESAS_COL().doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ ok: false, erro: 'Empresa não encontrada' });
    let centavos = 0;
    if (req.body && req.body.valorCentavos != null) centavos = parseInt(req.body.valorCentavos, 10) || 0;
    else if (req.body && req.body.valorReais != null) {
      centavos = Math.round(parseFloat(String(req.body.valorReais).replace(/\./g, '').replace(',', '.')) * 100) || 0;
    }
    if (centavos <= 0) return res.status(400).json({ ok: false, erro: 'Informe um valor de recarga maior que zero.' });
    const motivo = (req.body && String(req.body.motivo || '').trim()) || 'Recarga (Pix)';
    const novoSaldo = await creditarSaldo(req.params.id, centavos, motivo, (req.usuario && req.usuario.email) || 'admin');
    res.json({ ok: true, saldoCentavos: novoSaldo });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Saldo + extrato da PRÓPRIA empresa logada (cliente vê o quanto gastou/tem).
app.get('/minha-saldo', exigirLoginEmpresa, async (req, res) => {
  try {
    const doc = await EMPRESAS_COL().doc(req.empresaLogin.id).get();
    const d = doc.exists ? doc.data() : {};
    let extrato = [];
    try {
      const snap = await TRANSACOES_COL().where('empresaId', '==', req.empresaLogin.id).get();
      extrato = snap.docs.map(x => x.data()).sort((a, b) => String(b.em).localeCompare(String(a.em))).slice(0, 50);
    } catch (e) { console.warn('[PREPAGO] extrato cliente:', e.message); }
    res.json({
      ok: true,
      prepagoAtivo: !!d.prepagoAtivo,
      saldoCentavos: d.saldoCentavos || 0,
      precoMktCentavos: d.precoMktCentavos != null ? d.precoMktCentavos : PRECO_MKT_PADRAO,
      precoUtilCentavos: d.precoUtilCentavos != null ? d.precoUtilCentavos : PRECO_UTIL_PADRAO,
      extrato
    });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ============================================================
// DISPARO EM MASSA (campanha) — manda um template pra uma LISTA (modo oficial)
// ============================================================
// Roda em BACKGROUND (não trava o HTTP). Cada envio passa pelo sendTemplate, que
// cobra do pré-pago e BLOQUEIA quando o saldo acaba. Progresso via /status.
// Cada campanha é PERSISTIDA em DISPAROS_COL (com a lista de contatos) — é o
// que permite o relatório depois (entregues/lidos/responderam/recomendaram) e
// redisparar só pra quem não respondeu, sem precisar montar a lista nova à mão.
const _disparoStatus = {};

// Dispara em background e devolve na hora (campanhaId, total) — usado tanto
// pelo disparo normal quanto pelo "redisparar pra quem não respondeu".
async function iniciarDisparoMassa(empresa, template, contatos) {
  const agora = new Date().toISOString();
  const disparoRef = await DISPAROS_COL().add({
    empresaId: empresa.id, template, contatos, total: contatos.length,
    status: 'em_andamento', criadoEm: agora, terminadoEm: null
  });
  const campanhaId = disparoRef.id;

  const status = { campanhaId, total: contatos.length, enviados: 0, bloqueados: 0, falhas: 0, optout: 0, terminado: false, semSaldo: false, template, em: agora };
  _disparoStatus[empresa.id] = status;

  // Background: dispara com um pequeno intervalo entre mensagens (anti-flood).
  (async () => {
    const oficial = oficialDaEmpresa(empresa);
    for (const c of contatos) {
      try {
        if (await estaDescadastrado(c.telefone)) { status.optout++; continue; }
        let ok = false;
        await tenantContext.run({ empresa, empresaId: empresa.id, oficial }, async () => {
          ok = await sendTemplate(c.telefone, template, c.params, 'pt_BR', { campanhaId });
        });
        if (ok) { status.enviados++; }
        else {
          // Distingue "sem saldo" (para tudo) de falha pontual (segue).
          const snap = await EMPRESAS_COL().doc(empresa.id).get();
          const d = snap.exists ? snap.data() : {};
          const preco = precoDaCategoria(d, 'marketing');
          if (d.prepagoAtivo && (d.saldoCentavos || 0) < preco) { status.semSaldo = true; break; }
          status.falhas++;
        }
      } catch (e) { status.falhas++; }
      await new Promise(r => setTimeout(r, 350));
    }
    const processados = status.enviados + status.falhas + status.optout + status.bloqueados;
    if (status.semSaldo && processados < status.total) status.bloqueados += (status.total - processados);
    status.terminado = true; status.fimEm = new Date().toISOString();
    try {
      await disparoRef.set({
        status: 'concluido', terminadoEm: status.fimEm,
        enviados: status.enviados, bloqueados: status.bloqueados, falhas: status.falhas, optout: status.optout
      }, { merge: true });
    } catch (e) { console.error('[DISPARO] erro ao salvar resumo final:', e.message); }
    console.log(`[DISPARO] empresa=${empresa.id} enviados=${status.enviados} bloqueados=${status.bloqueados} falhas=${status.falhas} optout=${status.optout}`);
  })().catch(e => { status.terminado = true; console.error('[DISPARO] erro no loop:', e.message); });

  return { campanhaId, total: contatos.length };
}

app.post('/minha-disparo', exigirLoginEmpresa, exigirGestor, exigirUsuarioSemOferta, async (req, res) => {
  try {
    const empresa = await getEmpresaById(req.empresaLogin.id);
    if (empresa.whatsappTipo !== 'oficial') {
      return res.status(400).json({ ok: false, erro: 'O disparo em massa só funciona no modo API Oficial da Meta.' });
    }
    const template = String((req.body && req.body.template) || '').trim();
    if (!template) return res.status(400).json({ ok: false, erro: 'Informe o nome do template aprovado na Meta.' });
    let contatos = Array.isArray(req.body && req.body.contatos) ? req.body.contatos : [];
    contatos = contatos.map(c => ({
      telefone: soDigitos((c && (c.telefone || c.tel)) || ''),
      params: Array.isArray(c && c.params) ? c.params.map(x => String(x == null ? '' : x)) : []
    })).filter(c => c.telefone.length >= 10);
    if (!contatos.length) return res.status(400).json({ ok: false, erro: 'Nenhum contato válido — cada linha precisa de telefone com DDD.' });
    if (contatos.length > 1000) return res.status(400).json({ ok: false, erro: 'Máximo de 1000 contatos por disparo.' });
    const rodando = _disparoStatus[empresa.id];
    if (rodando && !rodando.terminado) return res.status(409).json({ ok: false, erro: 'Já existe um disparo em andamento. Aguarde terminar.' });

    const resultado = await iniciarDisparoMassa(empresa, template, contatos);
    res.json({ ok: true, ...resultado });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Disparo em massa direto de UMA COLUNA do Kanban de Leads (ex.: "Recebeu
// Mensagem") — sem precisar baixar CSV e colar telefone por telefone. Pega
// os leads que já estão naquela etapa, com o MESMO filtro de visibilidade do
// GET /minha-leads (rede de lojas + dono do lead), e usa a infra de disparo
// já existente — a campanha aparece no histórico normal, com relatório e tudo.
app.post('/minha-leads/coluna/:etapa/disparar', exigirLoginEmpresa, exigirGestor, exigirUsuarioSemOferta, async (req, res) => {
  try {
    const empresa = await getEmpresaById(req.empresaLogin.id);
    if (empresa.whatsappTipo !== 'oficial') {
      return res.status(400).json({ ok: false, erro: 'O disparo em massa só funciona no modo API Oficial da Meta.' });
    }
    const template = String((req.body && req.body.template) || '').trim();
    if (!template) return res.status(400).json({ ok: false, erro: 'Informe o nome do template aprovado na Meta.' });
    const etapa = req.params.etapa;

    let leads = await getLeadsPorEmpresa(req.empresaLogin.id);
    const ofertaFiltro = (req.usuario && req.usuario.ofertaId) || (req.query && req.query.oferta) || null;
    if (ofertaFiltro) leads = leads.filter(l => l.ofertaId === ofertaFiltro);
    if (req.papel !== 'gestor' && req.usuario) {
      leads = leads.filter(l => !l.atendenteId || l.atendenteId === req.usuario.id);
    }
    leads = leads.filter(l => l.etapa === etapa);

    // Dedup por telefone — a mesma pessoa pode ter mais de um lead na coluna
    // (indicada por gente diferente, por exemplo).
    const vistos = new Set();
    const contatos = [];
    for (const l of leads) {
      const tel = soDigitos(l.telefoneRecomendado || '');
      if (tel.length < 10 || vistos.has(tel)) continue;
      vistos.add(tel);
      contatos.push({ telefone: tel, params: [l.nomeRecomendado || '', l.nomeRecomendador || '', l.vendedor || empresa.nome] });
    }
    if (!contatos.length) return res.status(400).json({ ok: false, erro: 'Nenhum contato válido nessa coluna.' });
    if (contatos.length > 1000) return res.status(400).json({ ok: false, erro: 'Mais de 1000 contatos nessa coluna — não dá num disparo só (limite de 1000).' });

    const rodando = _disparoStatus[empresa.id];
    if (rodando && !rodando.terminado) return res.status(409).json({ ok: false, erro: 'Já existe um disparo em andamento. Aguarde terminar.' });

    const resultado = await iniciarDisparoMassa(empresa, template, contatos);
    res.json({ ok: true, ...resultado, total: contatos.length });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.get('/minha-disparo/status', exigirLoginEmpresa, (req, res) => {
  res.json({ ok: true, status: _disparoStatus[req.empresaLogin.id] || null });
});

// Histórico de campanhas (mais recente primeiro) — pra listar na tela e abrir
// o relatório de cada uma.
app.get('/minha-disparos', exigirLoginEmpresa, exigirGestor, exigirUsuarioSemOferta, async (req, res) => {
  try {
    const snap = await DISPAROS_COL().where('empresaId', '==', req.empresaLogin.id).get();
    const disparos = [];
    snap.forEach(d => {
      const x = d.data();
      disparos.push({
        id: d.id, template: x.template, total: x.total, status: x.status,
        criadoEm: x.criadoEm, terminadoEm: x.terminadoEm,
        enviados: x.enviados || 0, falhas: x.falhas || 0, optout: x.optout || 0, bloqueados: x.bloqueados || 0
      });
    });
    disparos.sort((a, b) => new Date(b.criadoEm || 0) - new Date(a.criadoEm || 0));
    res.json({ ok: true, disparos });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Relatório de uma campanha: cruza os contatos que foram no disparo com o
// status de entrega/leitura (MENSAGENS_CHAT_COL, casado por campanhaId), se
// responderam depois (CONVERSAS_COL.ultimaInboundEm posterior ao disparo) e se
// já recomendaram algum amigo (LEADS_COL.telefoneRecomendador).
// Nome de cada "momento" do pipeline — usado tanto no relatório quanto no
// disparo por coluna, pra não dessincronizar os rótulos.
const COLUNAS_PIPELINE_DISPARO = {
  nao_entregou: 'Não entregou',
  sem_resposta: 'Entregue, sem resposta',
  respondeu_sem_nome: 'Respondeu, mas não deu o nome',
  deu_nome_sem_indicar: 'Deu o nome, mas não indicou ninguém',
  recomendou: 'Recomendou pelo menos 1 amigo'
};

// Classifica cada contato do disparo no "momento" atual dele — cruza status de
// entrega (MENSAGENS_CHAT_COL), se respondeu depois (CONVERSAS_COL) e em que
// pé está a conversa (SESSOES_COL.etapa) e se já recomendou (LEADS_COL). É
// exatamente essa granularidade que permite um follow-up DIFERENTE pra quem
// nunca respondeu vs. quem respondeu mas travou no meio do fluxo.
async function calcularPipelineDisparo(disparo, empresaId) {
  const campanhaId = disparo._id;
  const msgsSnap = await MENSAGENS_CHAT_COL().where('campanhaId', '==', campanhaId).get();
  const statusPorTelefone = {};
  msgsSnap.forEach(d => { const m = d.data(); statusPorTelefone[m.telefone] = m.status || 'enviado'; });

  const convSnap = await CONVERSAS_COL().where('empresaId', '==', empresaId).get();
  const ultimaInboundPorTelefone = {};
  convSnap.forEach(d => { const c = d.data(); if (c.telefone) ultimaInboundPorTelefone[c.telefone] = c.ultimaInboundEm || null; });

  const leadsSnap = await LEADS_COL().where('empresaId', '==', empresaId).get();
  const recomendouTelefones = new Set();
  leadsSnap.forEach(d => { const l = d.data(); if (l.telefoneRecomendador) recomendouTelefones.add(soDigitos(l.telefoneRecomendador)); });

  const contatos = disparo.contatos || [];
  const chave = (tel) => (empresaId === EMPRESA_ID_PDN ? tel : `${empresaId}__${tel}`);
  const sessoes = await Promise.all(contatos.map(c => SESSOES_COL().doc(chave(c.telefone)).get()));
  const etapaPorTelefone = {};
  sessoes.forEach((snap, i) => { if (snap.exists) etapaPorTelefone[contatos[i].telefone] = snap.data().etapa; });

  const colunas = {}; Object.keys(COLUNAS_PIPELINE_DISPARO).forEach(k => { colunas[k] = []; });
  let entregues = 0, lidos = 0, falharam = 0, responderam = 0, recomendaram = 0;

  for (const c of contatos) {
    const st = statusPorTelefone[c.telefone];
    if (st === 'entregue' || st === 'lido') entregues++;
    if (st === 'lido') lidos++;
    if (st === 'falhou') falharam++;
    const ultimaInbound = ultimaInboundPorTelefone[c.telefone];
    const respondeu = !!(ultimaInbound && disparo.criadoEm && new Date(ultimaInbound) > new Date(disparo.criadoEm));
    if (respondeu) responderam++;
    const jaRecomendou = recomendouTelefones.has(c.telefone);
    if (jaRecomendou) recomendaram++;

    const item = { telefone: c.telefone, nome: (c.params && c.params[0]) || null };
    let coluna;
    if (st === 'falhou') coluna = 'nao_entregou';
    else if (!respondeu) coluna = 'sem_resposta';
    else if (jaRecomendou) coluna = 'recomendou';
    else if (etapaPorTelefone[c.telefone] === 'coletando_contatos') coluna = 'deu_nome_sem_indicar';
    else coluna = 'respondeu_sem_nome';
    colunas[coluna].push(item);
  }

  return {
    resumo: { total: contatos.length, entregues, lidos, falharam, responderam, recomendaram },
    colunas: Object.entries(COLUNAS_PIPELINE_DISPARO).map(([id, nome]) => ({ id, nome, contatos: colunas[id] }))
  };
}

app.get('/minha-disparos/:id/relatorio', exigirLoginEmpresa, exigirGestor, exigirUsuarioSemOferta, async (req, res) => {
  try {
    const doc = await DISPAROS_COL().doc(req.params.id).get();
    if (!doc.exists || doc.data().empresaId !== req.empresaLogin.id) {
      return res.status(404).json({ ok: false, erro: 'Disparo não encontrado' });
    }
    const disparo = { ...doc.data(), _id: doc.id };
    const { resumo, colunas } = await calcularPipelineDisparo(disparo, req.empresaLogin.id);

    res.json({
      ok: true,
      disparo: { id: doc.id, template: disparo.template, total: disparo.total, criadoEm: disparo.criadoEm, status: disparo.status },
      resumo,
      colunas
    });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Disparo por COLUNA do pipeline — dá pra usar um template DIFERENTE pra quem
// nunca respondeu vs. quem respondeu mas travou no meio do fluxo. Recalcula a
// coluna na hora (não confia em cache) e cria uma campanha NOVA (rastreável
// como qualquer outra), sem mexer no disparo original.
app.post('/minha-disparos/:id/pipeline/disparar', exigirLoginEmpresa, exigirGestor, exigirUsuarioSemOferta, async (req, res) => {
  try {
    const empresa = await getEmpresaById(req.empresaLogin.id);
    if (empresa.whatsappTipo !== 'oficial') {
      return res.status(400).json({ ok: false, erro: 'O disparo em massa só funciona no modo API Oficial da Meta.' });
    }
    const coluna = String((req.body && req.body.coluna) || '');
    if (!COLUNAS_PIPELINE_DISPARO[coluna]) return res.status(400).json({ ok: false, erro: 'Coluna inválida.' });
    const template = String((req.body && req.body.template) || '').trim();
    if (!template) return res.status(400).json({ ok: false, erro: 'Informe o template.' });

    const doc = await DISPAROS_COL().doc(req.params.id).get();
    if (!doc.exists || doc.data().empresaId !== req.empresaLogin.id) {
      return res.status(404).json({ ok: false, erro: 'Disparo não encontrado' });
    }
    const disparo = { ...doc.data(), _id: doc.id };

    const rodando = _disparoStatus[empresa.id];
    if (rodando && !rodando.terminado) return res.status(409).json({ ok: false, erro: 'Já existe um disparo em andamento. Aguarde terminar.' });

    const { colunas } = await calcularPipelineDisparo(disparo, req.empresaLogin.id);
    const alvo = colunas.find(c => c.id === coluna);
    const contatos = (alvo ? alvo.contatos : []).map(c => ({ telefone: c.telefone, params: [] }));
    if (!contatos.length) return res.status(400).json({ ok: false, erro: 'Ninguém nessa coluna agora — nada pra disparar.' });

    const resultado = await iniciarDisparoMassa(empresa, template, contatos);
    res.json({ ok: true, ...resultado, coluna, disparadoDe: req.params.id });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Redispara SÓ pra quem ainda não respondeu essa campanha (recalcula na hora,
// não confia em cache) — cria uma campanha NOVA, não mexe na original.
app.post('/minha-disparos/:id/redisparar', exigirLoginEmpresa, exigirGestor, exigirUsuarioSemOferta, async (req, res) => {
  try {
    const empresa = await getEmpresaById(req.empresaLogin.id);
    if (empresa.whatsappTipo !== 'oficial') {
      return res.status(400).json({ ok: false, erro: 'O disparo em massa só funciona no modo API Oficial da Meta.' });
    }
    const doc = await DISPAROS_COL().doc(req.params.id).get();
    if (!doc.exists || doc.data().empresaId !== req.empresaLogin.id) {
      return res.status(404).json({ ok: false, erro: 'Disparo não encontrado' });
    }
    const disparo = doc.data();
    const template = String((req.body && req.body.template) || disparo.template || '').trim();
    if (!template) return res.status(400).json({ ok: false, erro: 'Informe o template.' });

    const rodando = _disparoStatus[empresa.id];
    if (rodando && !rodando.terminado) return res.status(409).json({ ok: false, erro: 'Já existe um disparo em andamento. Aguarde terminar.' });

    const convSnap = await CONVERSAS_COL().where('empresaId', '==', req.empresaLogin.id).get();
    const ultimaInboundPorTelefone = {};
    convSnap.forEach(d => { const c = d.data(); if (c.telefone) ultimaInboundPorTelefone[c.telefone] = c.ultimaInboundEm || null; });
    const contatos = (disparo.contatos || []).filter(c => {
      const ultimaInbound = ultimaInboundPorTelefone[c.telefone];
      return !(ultimaInbound && disparo.criadoEm && new Date(ultimaInbound) > new Date(disparo.criadoEm));
    });
    if (!contatos.length) return res.status(400).json({ ok: false, erro: 'Todo mundo dessa campanha já respondeu — nada pra redisparar.' });

    const resultado = await iniciarDisparoMassa(empresa, template, contatos);
    res.json({ ok: true, ...resultado, redisparadoDe: req.params.id });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Reconstrói RETROATIVAMENTE o último disparo em massa que rodou ANTES desse
// rastreio por campanha existir — as mensagens de template já ficavam salvas
// (registrarMensagem sempre gravou), só não tinham campanhaId. Agrupa os envios
// de template mais recentes desse empresa que ainda não pertencem a nenhuma
// campanha, pelo mesmo nome de template + dentro de uma janela de tempo, cria
// um DISPAROS_COL retroativo com esse lote e carimba campanhaId nas mensagens
// — depois disso o relatório funciona igual a qualquer campanha nova. Rodar de
// novo não duplica: mensagem já tagueada nunca entra de novo no cálculo.
app.post('/minha-disparos/reconstruir-ultimo', exigirLoginEmpresa, exigirGestor, exigirUsuarioSemOferta, async (req, res) => {
  try {
    const empresaId = req.empresaLogin.id;
    const snap = await MENSAGENS_CHAT_COL().where('empresaId', '==', empresaId).where('direcao', '==', 'out').get();
    const candidatas = [];
    snap.forEach(d => {
      const m = d.data();
      if (m.campanhaId) return; // já pertence a uma campanha rastreada
      if (typeof m.texto === 'string' && m.texto.startsWith('[template: ') && m.texto.endsWith(']')) {
        candidatas.push({ ref: d.ref, telefone: m.telefone, criadoEm: m.criadoEm, template: m.texto.slice(11, -1) });
      }
    });
    if (!candidatas.length) return res.status(404).json({ ok: false, erro: 'Não encontrei nenhum disparo de template antigo, sem campanha, pra reconstruir.' });
    candidatas.sort((a, b) => new Date(b.criadoEm) - new Date(a.criadoEm));
    const maisRecente = candidatas[0];
    // Um disparo em lote manda tudo em minutos (350ms de intervalo entre cada);
    // 3h de janela é folga generosa sem misturar com um disparo antigo diferente.
    const limite = new Date(maisRecente.criadoEm).getTime() - 3 * 60 * 60 * 1000;
    const lote = candidatas.filter(c => c.template === maisRecente.template && new Date(c.criadoEm).getTime() >= limite);
    const vistos = new Set();
    const unicos = lote.filter(c => { if (vistos.has(c.telefone)) return false; vistos.add(c.telefone); return true; });
    unicos.sort((a, b) => new Date(a.criadoEm) - new Date(b.criadoEm));

    const disparoRef = await DISPAROS_COL().add({
      empresaId, template: maisRecente.template,
      contatos: unicos.map(c => ({ telefone: c.telefone, params: [] })),
      total: unicos.length, status: 'concluido',
      criadoEm: unicos[0].criadoEm, terminadoEm: unicos[unicos.length - 1].criadoEm,
      reconstruido: true
    });
    const campanhaId = disparoRef.id;
    const batch = db.batch();
    unicos.forEach(c => batch.update(c.ref, { campanhaId }));
    await batch.commit();

    res.json({ ok: true, campanhaId, total: unicos.length, template: maisRecente.template });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Cancela agendamentos ainda pendentes de "chamar o recomendado" desta empresa —
// útil pra abortar disparos de teste antes de saírem (evita cobrança à toa na
// API Oficial). Não afeta o que já foi enviado, só o que ainda está na fila.
app.post('/minha-disparo/cancelar-recomendados-pendentes', exigirLoginEmpresa, exigirGestor, async (req, res) => {
  try {
    const snap = await AGENDAMENTOS_COL()
      .where('status', '==', 'pendente')
      .where('empresaId', '==', req.empresaLogin.id)
      .where('tipo', '==', 'iniciar_conversa_recomendado')
      .get();
    const batch = db.batch();
    let n = 0;
    snap.forEach(doc => { batch.update(doc.ref, { status: 'cancelado' }); n++; });
    if (n) await batch.commit();
    res.json({ ok: true, cancelados: n });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ============================================================
// UPLOAD DE ARQUIVO — Firebase Storage
// ============================================================

const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const tiposPermitidos = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf'];
    if (tiposPermitidos.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de arquivo não permitido. Use JPEG, PNG, WebP ou PDF.'));
    }
  }
});

app.post('/upload-arquivo', exigirLoginEmpresa, exigirGestor, uploadMiddleware.single('arquivo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, erro: 'Nenhum arquivo enviado.' });
    }

    const empresaId = req.empresaLogin.id;
    const timestamp = Date.now();
    const nomeArquivo = `vouchers/${empresaId}/${timestamp}_${req.file.originalname.replace(/\s+/g, '_')}`;

    const bucket = admin.storage().bucket();
    const fileRef = bucket.file(nomeArquivo);

    await fileRef.save(req.file.buffer, {
      metadata: { contentType: req.file.mimetype }
    });

    const [url] = await fileRef.getSignedUrl({
      action: 'read',
      expires: '01-01-2125'
    });

    res.json({ ok: true, url });
  } catch (err) {
    console.error('Erro ao fazer upload:', err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Upload pra anexar em Conversas (atendente manda foto/áudio/vídeo/documento pro
// cliente) — qualquer usuário logado (não só gestor), mais tipos, limite maior
// (áudio/vídeo pesam mais que imagem de voucher).
const uploadChatMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const permitidosExatos = [
      'application/pdf', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain'
    ];
    const ok = permitidosExatos.includes(file.mimetype) || /^(image|audio|video)\//.test(file.mimetype);
    if (ok) cb(null, true);
    else cb(new Error('Tipo de arquivo não suportado.'));
  }
});

app.post('/minha-conversas/upload', exigirLoginEmpresa, uploadChatMiddleware.single('arquivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, erro: 'Nenhum arquivo enviado.' });
    const empresaId = req.empresaLogin.id;
    const timestamp = Date.now();
    const nomeArquivo = `conversas/${empresaId}/${timestamp}_${req.file.originalname.replace(/\s+/g, '_')}`;
    const bucket = admin.storage().bucket();
    const fileRef = bucket.file(nomeArquivo);
    await fileRef.save(req.file.buffer, { metadata: { contentType: req.file.mimetype } });
    const [url] = await fileRef.getSignedUrl({ action: 'read', expires: '01-01-2125' });
    res.json({ ok: true, url, mimetype: req.file.mimetype, originalname: req.file.originalname });
  } catch (err) {
    console.error('Erro ao fazer upload (conversas):', err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ============================================================
// EXECUTOR DE AGENDAMENTOS — roda a cada 3 minutos
// ============================================================

async function processarAgendamento(agendamento) {
  // Resolve a empresa dona do agendamento e processa dentro do contexto dela,
  // pra que os envios saiam pelo WhatsApp correto. Agendamentos antigos (sem
  // empresaId) caem na PDN — comportamento de hoje.
  const empresaId = agendamento.empresaId || EMPRESA_ID_PDN;
  let empresa = null;
  try {
    empresa = await getEmpresaById(empresaId);
  } catch (err) {
    console.error('Erro ao resolver empresa do agendamento:', err.message);
  }
  if (!empresa) empresa = await getEmpresa();

  // Rede de lojas: reaplica a oferta que estava ativa quando o agendamento foi
  // criado (carimbada em criarAgendamento) — sem isso, todo follow-up/disparo
  // agendado saía com o conteúdo cru da empresa (a oferta Padrão), mesmo
  // quando quem originou o agendamento estava numa loja diferente.
  if (agendamento.ofertaId) {
    empresa = aplicarOferta(empresa, agendamento.ofertaId);
  }

  const contexto = {
    empresa,
    empresaId: empresa.id || empresaId,
    zapi: zapiDaEmpresa(empresa)
  };
  return tenantContext.run(contexto, () => processarAgendamentoInterno(agendamento));
}

async function processarAgendamentoInterno(agendamento) {
  const empresa = await getEmpresa();

  if (agendamento.tipo === 'confirmar_agendamento_check') {
    const { telefone } = agendamento.dados;
    if (await numeroEstaPausado(telefone)) return;
    const sessao = await getSessaoRecomendado(telefone);
    // Guard de staleness: se a sessão mudou desde que o check foi agendado
    // (resetou, marcou outro agendamento, etc.), não manda mensagem à toa.
    if (!sessao || sessao.etapa !== 'finalizado' || sessao.ultimaMensagemEm !== agendamento.marcaTempoReferencia) return;
    await sendText(telefone, substituirVariaveis(empresa.posConfirmacaoCheck || EMPRESA_PADRAO.posConfirmacaoCheck, variaveisRec(sessao, empresa)));
    return;
  }

  // Menu do recomendado enviado com intervalo, caso ele não tenha reagido ao "gostou?".
  if (agendamento.tipo === 'menu_apos_reacao') {
    const { telefone } = agendamento.dados;
    if (await numeroEstaPausado(telefone)) return;
    const sessao = await getSessaoRecomendado(telefone);
    if (!sessao || sessao.etapa !== 'aguardando_reacao_presente') return; // já respondeu / mudou de estado
    await enviarMenuEFollowupRec(telefone, sessao, empresa);
    return;
  }

  // Revezamento de atendimento: se ninguém assumiu (botPausado) em 1 min,
  // escala o aviso pro próximo atendente online.
  if (agendamento.tipo === 'escalar_aviso_atendente') {
    const { telefone, nomePessoa, excluirIds, tentativa } = agendamento.dados;
    const chave = `${empresa.id}__${telefone}`;
    const convSnap = await CONVERSAS_COL().doc(chave).get();
    const conv = convSnap.exists ? convSnap.data() : {};
    if (conv.botPausado) {
      console.log(`[REVEZAMENTO] ${telefone} já foi assumido — não escalona mais`);
      return;
    }
    await avisarAtendenteRevezamento(telefone, nomePessoa, empresa, excluirIds, tentativa);
    return;
  }

  // Lembrete de retorno agendado numa conversa (ex.: "cliente pediu pra ligar mais
  // tarde"). Avisa só o atendente que agendou, não é revezamento.
  if (agendamento.tipo === 'lembrete_retorno_atendente') {
    const { telefone, atendenteId, atendenteNome, mensagem } = agendamento.dados;
    const chave = `${empresa.id}__${telefone}`;
    const convSnap = await CONVERSAS_COL().doc(chave).get();
    const conv = convSnap.exists ? convSnap.data() : {};
    if (!conv.lembreteRetorno) {
      console.log(`[LEMBRETE] ${telefone} — cancelado ou já tratado, não notifica`);
      return; // foi cancelado (ou reagendado, o que sobrescreve o campo)
    }
    // Manda a mensagem automática pro CLIENTE, se foi configurada uma — só entrega
    // se a conversa ainda estiver na janela de 24h (texto livre); fora da janela a
    // Meta recusa e não há como avisar aqui (seria preciso um template).
    if (mensagem && mensagem.trim()) {
      try { await sendText(telefone, mensagem.trim()); console.log(`[LEMBRETE] mensagem automática enviada pra ${telefone}`); }
      catch (e) { console.warn('[LEMBRETE] falha ao mandar mensagem automática:', e.message); }
    }
    await CONVERSAS_COL().doc(chave).set({
      precisaAtendente: true, precisaAtendenteEm: new Date().toISOString(), lembreteRetorno: null
    }, { merge: true });
    let telAtendente = null;
    if (atendenteId) {
      try { const u = await USUARIOS_COL().doc(atendenteId).get(); if (u.exists) telAtendente = soDigitosTel(u.data().telefone); } catch (e) {}
    }
    if (!telAtendente) telAtendente = await getNumeroAvisoAtendente(empresa);
    if (telAtendente) {
      const base = process.env.APP_BASE_URL || 'https://www.recomendaleads.com.br';
      const link = `${base}/conversas?tel=${encodeURIComponent(soDigitosTel(telefone))}`;
      const linhaMsg = (mensagem && mensagem.trim()) ? `\n✅ A mensagem automática já foi enviada pro cliente.` : '';
      await enviarSemLog(telAtendente, `⏰ *Lembrete de retorno*\n\n${atendenteNome ? atendenteNome + ', você' : 'Você'} agendou pra voltar nesta conversa agora.${linhaMsg}\n\n👉 ${link}`);
    }
    return;
  }

  if (agendamento.tipo === 'iniciar_conversa_recomendado') {
    const { contato, nomeRecomendador, vendedorNome, telefoneRecomendador } = agendamento.dados;

    // 🛡️ Trava anti-ban: se a empresa está no modo FULL (inbound/seguro), NUNCA
    // dispara pros amigos — nem disparos antigos que ficaram na fila do modo Basic.
    // No Full o amigo é quem chama; disparo frio é o gatilho do shadow ban.
    if (modoRecAtual(empresa) === 'full') {
      console.log(`[DISPARO BLOQUEADO] empresa em modo Full — disparo frio pra ${contato.telefone} não enviado (inbound only)`);
      return;
    }

    // ✅ CORREÇÃO: verifica se o número está pausado antes de iniciar
    // Se stop1 foi enviado após o agendamento ser criado, não inicia a conversa
    if (contato.telefone && await numeroEstaPausado(contato.telefone)) {
      console.log(`[AGENDAMENTO IGNORADO] ${contato.telefone} está pausado (stop1) — conversa não iniciada`);
      return;
    }

    await iniciarConversaRecomendado(contato, nomeRecomendador, vendedorNome, empresa, telefoneRecomendador);
    return;
  }

  if (agendamento.tipo === 'followup_recomendado') {
    const { telefone, indiceFollowup } = agendamento.dados;

    // ✅ CORREÇÃO: verifica se o número está pausado antes de enviar follow-up
    if (await numeroEstaPausado(telefone)) {
      console.log(`[AGENDAMENTO IGNORADO] ${telefone} está pausado (stop1) — follow-up não enviado`);
      return;
    }

    const sessaoAtual = await getSessaoRecomendado(telefone);

    if (!sessaoAtual || sessaoAtual.ultimaMensagemEm !== agendamento.marcaTempoReferencia) {
      return;
    }

    const cadencia = empresa.cadenciaFollowupRecomendado || [];
    const proximo = cadencia[indiceFollowup];
    if (!proximo) return;

    const variaveisFollowup = {
      nomeRecomendado: sessaoAtual.nomeRecomendado ? sessaoAtual.nomeRecomendado.split(' ')[0] : 'você',
      recomendado: sessaoAtual.nomeRecomendado ? sessaoAtual.nomeRecomendado.split(' ')[0] : 'você',
      recomendador: sessaoAtual.nomeRecomendador ? sessaoAtual.nomeRecomendador.split(' ')[0] : 'seu amigo',
      vendedor: sessaoAtual.vendedorNome || empresa.nome,
      empresa: empresa.nome
    };
    // Insistência com o amigo (recomendado) — pode cair FORA da janela de 24h, então
    // no oficial usa o template desta mensagem (cada uma tem o seu, sem padrão
    // compartilhado). {{1}} nome do recomendado, {{2}} quem recomendou, {{3}} vendedor.
    const templateEscolhido = proximo.template && String(proximo.template).trim();
    // Sem texto E sem template = mensagem em branco (linha adicionada mas nunca
    // preenchida) — não manda nada em branco, só avança pra próxima da cadência.
    if ((proximo.texto || '').trim() || templateEscolhido) {
      await sendTextOuTemplate(
        telefone,
        substituirVariaveis(proximo.texto, variaveisFollowup),
        templateEscolhido,
        [variaveisFollowup.nomeRecomendado, variaveisFollowup.recomendador, variaveisFollowup.vendedor]
      );
    } else {
      console.log(`[FOLLOWUP RECOMENDADO] mensagem ${indiceFollowup} vazia (sem texto e sem template) — pulando envio`);
    }
    const novaMarca = new Date().toISOString();
    await saveSessaoRecomendado(telefone, { ultimaMensagemEm: novaMarca });
    await agendarProximoFollowup(telefone, empresa, novaMarca, indiceFollowup + 1);
    return;
  }

  // Follow-up — Sem resposta (CLIENTE): nunca respondeu ao "qual é o seu nome?".
  if (agendamento.tipo === 'followup_cliente_inicial') {
    const { telefone, indiceFollowup } = agendamento.dados;

    if (await numeroEstaPausado(telefone)) {
      console.log(`[AGENDAMENTO IGNORADO] ${telefone} está pausado (stop1) — follow-up cliente não enviado`);
      return;
    }

    const sessaoAtual = await getSessao(telefone);
    // Stale se já respondeu (etapa avançou) OU se a conversa foi reiniciada
    // (resetSessao + novo iniciarConversa gera um criadoEm novo).
    if (!sessaoAtual || sessaoAtual.etapa !== 'aguardando_nome' || sessaoAtual.criadoEm !== agendamento.marcaTempoReferencia) {
      return;
    }

    const cadencia = empresa.cadenciaFollowupClienteInicial || [];
    const proximo = cadencia[indiceFollowup];
    if (!proximo) return;

    // O nome do cliente ainda não é conhecido nesta etapa — só {empresa} disponível.
    // Cada mensagem tem o seu próprio template, sem padrão compartilhado.
    const variaveisFollowup = { empresa: empresa.nome };
    const templateEscolhido = proximo.template && String(proximo.template).trim();
    // Sem texto E sem template = mensagem em branco (linha adicionada mas nunca
    // preenchida) — não manda nada em branco, só avança pra próxima da cadência.
    if ((proximo.texto || '').trim() || templateEscolhido) {
      await sendTextOuTemplate(
        telefone,
        substituirVariaveis(proximo.texto, variaveisFollowup),
        templateEscolhido,
        [variaveisFollowup.empresa]
      );
    } else {
      console.log(`[FOLLOWUP CLIENTE] mensagem ${indiceFollowup} vazia (sem texto e sem template) — pulando envio`);
    }
    // criadoEm não muda enquanto a etapa continuar aguardando_nome — reusa a
    // mesma referência pro próximo passo (diferente do lado Recomendado).
    await agendarProximoFollowupCliente(telefone, empresa, sessaoAtual.criadoEm, indiceFollowup + 1);
    return;
  }

  // Follow-up — Sem resposta (CLIENTE): deu o nome mas travou sem mandar as
  // indicações ("coletando_contatos"). Referência é ultimaAtividadeContatosEm,
  // reancorada a cada contato parcial que ele manda (ver processarMensagem) —
  // stale se ele terminar a faixa (etapa avança) ou mandar mais um contato
  // nesse meio tempo (marca muda).
  if (agendamento.tipo === 'followup_cliente_contatos') {
    const { telefone, indiceFollowup } = agendamento.dados;

    if (await numeroEstaPausado(telefone)) {
      console.log(`[AGENDAMENTO IGNORADO] ${telefone} está pausado (stop1) — follow-up contatos não enviado`);
      return;
    }

    const sessaoAtual = await getSessao(telefone);
    if (!sessaoAtual || sessaoAtual.etapa !== 'coletando_contatos' || sessaoAtual.ultimaAtividadeContatosEm !== agendamento.marcaTempoReferencia) {
      return;
    }

    const cadencia = empresa.cadenciaFollowupClienteContatos || [];
    const proximo = cadencia[indiceFollowup];
    if (!proximo) return;

    const faixaAtual = faixasAtivas(empresa)[sessaoAtual.indiceFaixaAtual || 0] || {};
    const jaMandou = (sessaoAtual.contatosFaixaAtual || []).length;
    const variaveisFollowup = {
      nomeRecomendado: sessaoAtual.clienteNome ? sessaoAtual.clienteNome.split(' ')[0] : '',
      empresa: empresa.nome,
      premio: faixaAtual.premio || '',
      quantidade: faixaAtual.quantidade || '',
      faltam: faixaAtual.quantidade ? Math.max(faixaAtual.quantidade - jaMandou, 0) : ''
    };
    const templateEscolhido = proximo.template && String(proximo.template).trim();
    // Sem texto E sem template = mensagem em branco (linha adicionada mas nunca
    // preenchida) — não manda nada em branco, só avança pra próxima da cadência.
    if ((proximo.texto || '').trim() || templateEscolhido) {
      await sendTextOuTemplate(
        telefone,
        substituirVariaveis(proximo.texto, variaveisFollowup),
        templateEscolhido,
        [variaveisFollowup.nomeRecomendado, variaveisFollowup.premio, variaveisFollowup.faltam]
      );
    } else {
      console.log(`[FOLLOWUP CLIENTE CONTATOS] mensagem ${indiceFollowup} vazia (sem texto e sem template) — pulando envio`);
    }
    // Não reancora sozinho aqui — reusa a mesma marca (nada mudou desde que
    // agendamos), só avança pro próximo índice da cadência.
    await agendarProximoFollowupClienteContatos(telefone, empresa, sessaoAtual.ultimaAtividadeContatosEm, indiceFollowup + 1);
    return;
  }

  // Lembrete ao RECOMENDADOR (cliente que indicou) pra avisar os amigos.
  if (agendamento.tipo === 'followup_avisar_amigos') {
    const { telefone, indice, teste } = agendamento.dados;
    // Em teste, roda mesmo com o recurso desligado (pra você conferir a cadência).
    if (!empresa.followupRecomendadorAtivo && !teste) return;
    if (await numeroEstaPausado(telefone)) {
      console.log(`[FOLLOWUP-AVISAR] ${telefone} pausado — não enviado`);
      return;
    }
    const snap = await SESSOES_COL().doc(chaveSessao(telefone)).get();
    const sessao = snap.exists ? snap.data() : null;
    // Se já respondeu "já avisei", encerra a série.
    if (sessao && sessao.followupConcluido) return;
    const primeiroNome = (sessao && sessao.clienteNome) ? sessao.clienteNome.split(' ')[0] : 'você';
    const vars = {
      nomeRecomendado: primeiroNome,
      recomendador: primeiroNome,
      vendedor: (sessao && sessao.vendedorNome) || empresa.nome,
      empresa: empresa.nome
    };
    // Cada lembrete pode ter seu próprio texto (2º e 3º). Vazio = repete o 1º.
    const padrao1 = empresa.followupRecomendadorMensagem || EMPRESA_PADRAO.followupRecomendadorMensagem;
    const textosLembrete = [
      padrao1,
      empresa.followupRecomendadorMensagem2 || padrao1,
      empresa.followupRecomendadorMensagem3 || padrao1
    ];
    const textoLembrete = textosLembrete[indice] || padrao1;
    // Lembrete ao cliente — costuma ser dias depois (fora da janela 24h), então
    // no oficial usa o template configurado. {{1}} nome do cliente, {{2}} empresa.
    await sendTextOuTemplate(
      telefone,
      substituirVariaveis(textoLembrete, vars),
      empresa.oficialTemplateFollowupCliente,
      [vars.nomeRecomendado, empresa.nome]
    );
    await saveSessao(telefone, { followupAguardando: true });
    await agendarFollowupRecomendador(telefone, empresa, indice + 1, teste ? { teste: true } : undefined);
    return;
  }

  // Pergunta do próximo prêmio, enviada com intervalo pra não encavalar com o
  // aviso anterior (avisar os amigos) — evita o cliente responder "ok" pra pergunta errada.
  if (agendamento.tipo === 'perguntar_proxima_faixa') {
    const { telefone } = agendamento.dados;
    if (await numeroEstaPausado(telefone)) return;
    const snap = await SESSOES_COL().doc(chaveSessao(telefone)).get();
    const sessao = snap.exists ? snap.data() : null;
    if (!sessao || sessao.etapa !== 'aguardando_intervalo_proxima_faixa') return; // cliente já mudou de estado
    await sendText(telefone, sessao.proximaFaixaPergunta || 'Quer liberar o próximo prêmio? 😊');
    await saveSessao(telefone, { etapa: 'aguardando_autorizacao_proxima_faixa' });
    return;
  }

  // Basic com confirmação: passou a espera depois do "muito obrigado" → agora manda o
  // menu "avisar os amigos" (1/2/3), dando tempo do cliente ter avisado as amigas.
  if (agendamento.tipo === 'pedir_confirmacao_basic') {
    const { telefone } = agendamento.dados;
    if (await numeroEstaPausado(telefone)) return;
    const snap = await SESSOES_COL().doc(chaveSessao(telefone)).get();
    const sessao = snap.exists ? snap.data() : null;
    if (!sessao || !sessao.aguardandoIntervaloConfirmacao || sessao.aguardandoConfirmacaoDisparo) return;
    sessao.aguardandoIntervaloConfirmacao = false;
    await pedirConfirmacaoDisparoBasic(telefone, sessao, empresa);
    return;
  }

  // Basic com confirmação: lembrete pedindo o cliente confirmar pra a gente disparar.
  if (agendamento.tipo === 'confirmar_disparo') {
    const { telefone, indice } = agendamento.dados;
    if (await numeroEstaPausado(telefone)) return;
    const snap = await SESSOES_COL().doc(chaveSessao(telefone)).get();
    const sessao = snap.exists ? snap.data() : null;
    if (!sessao || !sessao.aguardandoConfirmacaoDisparo) return; // já confirmou ou não aplica
    const cad = empresa.basicConfirmacaoCadencia || EMPRESA_PADRAO.basicConfirmacaoCadencia || [];
    const item = cad[indice];
    const nome = (sessao.clienteNome || '').split(' ')[0] || 'você';
    if (item) {
      console.log(`[BASIC-CONFIRM] disparando lembrete indice=${indice} pra ${telefone} agora (executarEm era ${agendamento.executarEm})`);
      await sendText(telefone, substituirVariaveis(item.texto, { nomeRecomendado: nome, recomendador: nome, empresa: empresa.nome }));
      await agendarConfirmacaoDisparo(telefone, empresa, indice + 1);
    } else {
      // Esgotou os lembretes sem confirmação. Segue a política escolhida.
      if (empresa.basicSemConfirmacao === 'envia') {
        await dispararRecomendados(sessao.clienteNome, sessao.vendedorNome, sessao.contatosPendentesDisparo || [], empresa, telefone);
        console.log(`[BASIC-CONFIRM] ${telefone} não confirmou — disparando mesmo assim (política 'envia')`);
      } else {
        console.log(`[BASIC-CONFIRM] ${telefone} não confirmou — NÃO disparado (política 'nao_envia')`);
      }
      await saveSessao(telefone, { aguardandoConfirmacaoDisparo: false, contatosPendentesDisparo: [] });
    }
    return;
  }

  // Full: cobrança do "enviei" — insiste pro cliente confirmar que encaminhou.
  if (agendamento.tipo === 'confirmar_envio_full') {
    const { telefone, indice } = agendamento.dados;
    if (await numeroEstaPausado(telefone)) return;
    const snap = await SESSOES_COL().doc(chaveSessao(telefone)).get();
    const sessao = snap.exists ? snap.data() : null;
    if (!sessao || sessao.etapa !== 'aguardando_confirmacao_envio') return; // já confirmou ou saiu do estado
    const cad = empresa.fullConfirmacaoCadencia || EMPRESA_PADRAO.fullConfirmacaoCadencia || [];
    const item = cad[indice];
    if (item) {
      const nome = (sessao.clienteNome || '').split(' ')[0] || 'você';
      await sendText(telefone, substituirVariaveis(item.texto, { nomeRecomendado: nome, recomendador: nome, empresa: empresa.nome }));
      await agendarConfirmacaoEnvioFull(telefone, empresa, indice + 1);
    }
    // Esgotou os lembretes: o presente fica reservado; o cliente ainda pode confirmar depois.
    return;
  }

  console.log(`[AGENDAMENTO] Tipo desconhecido ignorado: ${agendamento.tipo}`);
}

async function executarAgendamentosPendentes() {
  if (!db) return;
  try {
    const pendentes = await buscarAgendamentosVencidos();
    for (const agendamento of pendentes) {
      try {
        await processarAgendamento(agendamento);
      } catch (err) {
        console.error(`Erro ao processar agendamento ${agendamento.id}:`, err.message);
      } finally {
        await marcarAgendamentoConcluido(agendamento.id);
      }
    }
  } catch (err) {
    console.error('Erro ao buscar agendamentos pendentes:', err.message);
  }
}

// Migração idempotente: garante um usuário "gestor" para cada empresa_login,
// reaproveitando o email/senhaHash atuais. Roda no boot. Quem loga hoje
// continua logando igual — agora pela coleção `usuarios`.
async function migrarUsuariosGestores() {
  if (!db) return;
  try {
    const empresas = await EMPRESAS_COL().get();
    let criados = 0;
    for (const doc of empresas.docs) {
      const e = doc.data() || {};
      if (!e.email || !e.senhaHash) continue;
      const emailNorm = String(e.email).trim().toLowerCase();
      const jaExiste = await USUARIOS_COL().where('email', '==', emailNorm).limit(1).get();
      if (!jaExiste.empty) continue;
      await USUARIOS_COL().add({
        empresaId: doc.id,
        nome: e.nome || 'Gestor',
        email: emailNorm,
        senhaHash: e.senhaHash,
        papel: 'gestor',
        senhaProvisoria: !!e.senhaProvisoria,
        ativo: true,
        criadoEm: new Date().toISOString()
      });
      criados++;
    }
    if (criados) console.log(`[migração] ${criados} usuário(s) gestor criado(s) a partir de empresas_login`);
  } catch (err) {
    console.error('[migração] Falha ao migrar usuários gestores:', err.message);
  }
}

// Envia a mensagem da Agenda de Marketing para um recomendador. Roda dentro
// do contexto da empresa (zapi correto).
async function enviarMarketingAoRecomendador(tel, nomeRecomendador, empresa) {
  const vars = {
    recomendador: (nomeRecomendador || '').split(' ')[0] || 'você',
    nomeRecomendador: nomeRecomendador || '',
    empresa: empresa.nome || '',
    premio: empresa.marketingPremio || ''
  };
  const msg = substituirVariaveis(empresa.marketingMensagem ?? EMPRESA_PADRAO.marketingMensagem, vars);
  // Recorrente (a cada N dias) = fora das 24h → usa template no oficial (se configurado).
  // Params na ordem: {{1}} recomendador · {{2}} empresa · {{3}} prêmio.
  if (msg && msg.trim()) await sendTextOuTemplate(tel, msg, empresa.oficialTemplateMarketing, [vars.recomendador, empresa.nome || '', empresa.marketingPremio || '']);
  if (empresa.marketingArquivo) {
    await enviarVoucher(tel, empresa.marketingArquivo, empresa.marketingPremio || '', empresa.marketingPremio || 'presente');
    await new Promise(r => setTimeout(r, 2500)); // imagem chega antes do link/texto
  }
  if (empresa.marketingLink) await sendText(tel, empresa.marketingLink);
  if (empresa.marketingTexto && empresa.marketingTexto.trim()) {
    await sendText(tel, substituirVariaveis(empresa.marketingTexto, vars));
  }
  console.log(`[MARKETING] enviado para ${tel} (${empresa.nome})`);
}

// Agenda de Marketing: a cada rodada, para cada empresa com a agenda ativa,
// envia a mensagem recorrente aos recomendadores cujo ciclo (a cada N dias,
// contado da entrada) venceu. Idempotente via doc de controle + transação.
async function processarAgendaMarketing() {
  if (!db) return;
  try {
    const empresas = await EMPRESAS_COL().get();
    for (const empDoc of empresas.docs) {
      const cfg = { ...EMPRESA_PADRAO, ...(empDoc.data().configuracao || {}) };
      if (!cfg.marketingAtivo) continue;
      const intervaloMs = Math.max(1, parseInt(cfg.marketingIntervaloDias, 10) || 45) * 86400000;
      const empresaId = empDoc.id;
      const empresaFull = await getEmpresaById(empresaId);
      if (!empresaFull) continue;

      // Recomendadores únicos da empresa, com a data de ENTRADA (lead mais antigo).
      const leads = await LEADS_COL().where('empresaId', '==', empresaId).get();
      const recs = new Map();
      leads.forEach(d => {
        const x = d.data();
        const tel = x.telefoneRecomendador;
        if (!tel) return;
        const entrada = new Date(x.criadoEm || 0).getTime();
        const cur = recs.get(tel);
        if (!cur || entrada < cur.entrada) recs.set(tel, { nome: x.nomeRecomendador || '', entrada });
      });

      const agora = Date.now();
      for (const [tel, info] of recs) {
        const ref = MARKETING_ENVIOS_COL().doc(`${empresaId}__${tel}`);
        // Reivindica o envio de forma atômica (sem duplicar entre rodadas).
        const reivindicou = await db.runTransaction(async (t) => {
          const s = await t.get(ref);
          const prox = s.exists ? new Date(s.data().proximoEm || 0).getTime() : (info.entrada + intervaloMs);
          if (agora < prox) return false;
          t.set(ref, {
            empresaId, telefone: tel,
            ultimoEnvioEm: new Date(agora).toISOString(),
            proximoEm: new Date(agora + intervaloMs).toISOString()
          }, { merge: true });
          return true;
        });
        if (!reivindicou) continue;
        const contexto = { empresa: empresaFull, empresaId, zapi: zapiDaEmpresa(empresaFull) };
        await tenantContext.run(contexto, async () => {
          try { await enviarMarketingAoRecomendador(tel, info.nome, empresaFull); }
          catch (e) { console.error(`[MARKETING] falha ao enviar para ${tel}:`, e.message); }
        });
      }
    }
  } catch (e) {
    console.error('[MARKETING] erro no processamento:', e.message);
  }
}

function iniciarExecutorAgendamentos() {
  const INTERVALO_EXECUTOR_MS = 1 * 60 * 1000;
  executarAgendamentosPendentes();
  setInterval(executarAgendamentosPendentes, INTERVALO_EXECUTOR_MS);
}

// ============================================================
// MONITOR DE CONEXÃO — checa periodicamente se o WhatsApp (Z-API) de cada
// empresa está conectado e MARCA quando cai, pra o dono ver no /admin sem
// precisar abrir o painel de cada cliente.
// ============================================================
async function checarConexaoZapi(empresa) {
  const cfg = zapiDaEmpresa(empresa);
  if (!cfg || !cfg.instanceId || !cfg.token) return null; // sem instância própria
  try {
    const resp = await axios.get(`${zapiBaseUrl(cfg)}/status`, { headers: zapiHeaders(cfg), timeout: 8000 });
    const d = resp.data || {};
    return !!(d.connected || d.smartphoneConnected);
  } catch (e) { return false; }
}
async function monitorarConexoes() {
  if (!db) return;
  try {
    const snap = await EMPRESAS_COL().get();
    for (const doc of snap.docs) {
      const empresa = { id: doc.id, ...doc.data() };
      // Só monitora quem tem instância Z-API PRÓPRIA (número em preparação/global fica de fora).
      if (!empresa.zapiInstanceId || !empresa.zapiToken || empresa.whatsappTipo === 'oficial') continue;
      const conectado = await checarConexaoZapi(empresa);
      if (conectado === null) continue;
      const agora = new Date().toISOString();
      const mon = empresa.whatsappMonitor || {};
      const eraConectado = mon.conectado !== false; // sem histórico = tratado como estava ok
      const patch = { conectado, checadoEm: agora };
      if (!conectado && eraConectado) {
        patch.caiuEm = agora; // acabou de cair — guarda o momento
        console.warn(`[MONITOR] WhatsApp CAIU — ${empresa.nome || empresa.id} (${empresa.id})`);
      }
      if (conectado) patch.caiuEm = null; // voltou
      await EMPRESAS_COL().doc(empresa.id).set({ whatsappMonitor: patch }, { merge: true });
    }
  } catch (e) { console.error('[MONITOR] erro:', e.message); }
}
function iniciarMonitorConexoes() {
  setTimeout(monitorarConexoes, 30000); // 1ª checagem 30s após subir
  setInterval(monitorarConexoes, 5 * 60 * 1000).unref?.(); // depois, de 5 em 5 min
}

// ============================================================
// MONITOR DE ENTREGA (API Oficial) — o monitor acima só cobre Z-API (conexão
// do celular). No Oficial a entrega pode parar por outro motivo (cobrança de
// threshold travada, template pausado/recusado) SEM nenhuma queda de conexão
// pra detectar. Aqui a gente olha o resultado de verdade: se a maioria das
// mensagens saindo agora está voltando 'falhou', avisa — em vez de só
// descobrir quando alguém testar na mão ou um cliente reclamar.
// ============================================================
const JANELA_MONITOR_ENTREGA_MS = 30 * 60 * 1000; // últimos 30min
async function checarEntregaOficial(empresaId) {
  const cutoff = new Date(Date.now() - JANELA_MONITOR_ENTREGA_MS).toISOString();
  // Só filtros de igualdade (empresaId, direcao) — não precisa de índice composto,
  // igual já é feito em outros pontos do código. O corte por tempo/status é em JS.
  const snap = await MENSAGENS_CHAT_COL().where('empresaId', '==', empresaId).where('direcao', '==', 'out').get();
  let total = 0, falhas = 0;
  snap.forEach(doc => {
    const d = doc.data();
    if (!d.criadoEm || d.criadoEm < cutoff) return;
    if (!d.status) return; // ainda sem status resolvido (webhook pode demorar) — ignora
    total++;
    if (d.status === 'falhou') falhas++;
  });
  return { total, falhas };
}
async function monitorarEntregaOficial() {
  if (!db) return;
  try {
    const snap = await EMPRESAS_COL().get();
    for (const doc of snap.docs) {
      const empresa = { id: doc.id, ...doc.data() };
      if (empresa.whatsappTipo !== 'oficial') continue;
      let contagem;
      try { contagem = await checarEntregaOficial(empresa.id); }
      catch (e) { console.error(`[MONITOR-ENTREGA] erro ao checar ${empresa.id}:`, e.message); continue; }
      const { total, falhas } = contagem;
      // Exige um mínimo de volume (evita alarme falso com 1 mensagem isolada
      // que falhou por sorte) E maioria falhando — sintoma de algo sistêmico
      // (cobrança travada, template pausado), não de 1 número queimado.
      const emAlerta = total >= 3 && (falhas / total) >= 0.6;
      const agora = new Date().toISOString();
      const atual = empresa.entregaMonitor || {};
      const jaEstavaEmAlerta = !!atual.ativo;
      const patch = { ativo: emAlerta, total, falhas, checadoEm: agora };
      if (emAlerta && !jaEstavaEmAlerta) {
        patch.desde = agora;
        console.warn(`[MONITOR-ENTREGA] ${empresa.nome || empresa.id}: ${falhas}/${total} mensagens falharam nos últimos 30min`);
      } else if (emAlerta) {
        patch.desde = atual.desde || agora;
      } else {
        patch.desde = null;
      }
      await EMPRESAS_COL().doc(empresa.id).set({ entregaMonitor: patch }, { merge: true });
    }
  } catch (e) { console.error('[MONITOR-ENTREGA] erro geral:', e.message); }
}
function iniciarMonitorEntregaOficial() {
  setTimeout(monitorarEntregaOficial, 45000); // 1ª checagem 45s após subir
  setInterval(monitorarEntregaOficial, 15 * 60 * 1000).unref?.(); // depois, de 15 em 15 min
}

// ============================================================
// INICIALIZAÇÃO DO SERVIDOR
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RecomendaLeads Bot v2 (Firestore) rodando na porta ${PORT}`);
  console.log(`Webhook disponível em: /webhook`);
  console.log(`Firestore inicializado: ${db ? 'SIM' : 'NÃO — verifique FIREBASE_SERVICE_ACCOUNT'}`);
  migrarUsuariosGestores();
  iniciarExecutorAgendamentos();
  iniciarMonitorConexoes();
  console.log('Monitor de conexão iniciado (checagem a cada 5 min)');
  iniciarMonitorEntregaOficial();
  console.log('Monitor de entrega (Oficial) iniciado (checagem a cada 15 min)');
  // Agenda de Marketing: checa de hora em hora quem está no ciclo de reenvio.
  setInterval(processarAgendaMarketing, 60 * 60 * 1000).unref?.();
  processarAgendaMarketing();
  console.log('Executor de agendamentos iniciado (checagem a cada 1 min)');
});
