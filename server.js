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
const multer = require('multer');
const baileys = require('./wa-baileys.js');
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
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Key');
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
    metodos: ['card', 'boleto', 'pix'],
    descricao: 'R$ 347/mês — R$ 2.082 cobrados de uma vez (6 meses)'
  },
  anual: {
    nome: 'Anual', tipo: 'unico', meses: 12,
    valorCentavos: 356400, // 12 x 297,00
    metodos: ['card', 'boleto', 'pix'],
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

// Tipo de WhatsApp da empresa no contexto: 'baileys' (conexão própria) ou 'zapi'.
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
// atrás do whatsappTipo, sem afetar Z-API/Baileys.
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
const SESSOES_COL = () => db.collection('sessoes');
const LEADS_COL = () => db.collection('leads');
const SESSOES_RECOMENDADO_COL = () => db.collection('sessoes_recomendado');
const AGENDAMENTOS_COL = () => db.collection('agendamentos');
const MENSAGENS_PROCESSADAS_COL = () => db.collection('mensagens_processadas');
const NUMEROS_PAUSADOS_COL = () => db.collection('numeros_pausados');
// Caixa de entrada: cada mensagem trocada + um resumo por conversa
const MENSAGENS_CHAT_COL = () => db.collection('mensagens_chat');
const CONVERSAS_COL = () => db.collection('conversas');

// Grava uma mensagem (recebida ou enviada) no histórico da conversa e atualiza
// o resumo da conversa. Usado para a caixa de entrada do WhatsApp.
async function registrarMensagem({ empresaId, telefone, nome, direcao, texto, tipo }) {
  if (!db || !telefone) return;
  const agora = new Date().toISOString();
  try {
    await MENSAGENS_CHAT_COL().add({
      empresaId: empresaId || EMPRESA_ID_PDN,
      chaveConversa: `${empresaId || EMPRESA_ID_PDN}__${telefone}`,
      telefone,
      direcao, // 'in' (recebida) ou 'out' (enviada)
      texto: texto || '',
      tipo: tipo || 'texto',
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
    if (direcao === 'in') resumo.naoLidas = admin.firestore.FieldValue.increment(1);
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

// ============================================================
// DEMONSTRAÇÃO POR NICHO — mesma empresa (PDN), "peles" diferentes por área.
// O cliente entra por um link com um código (#demo-barbearia etc). O robô veste
// a config daquele nicho (textos/imagens próprios) por toda a conversa, no MESMO
// número. Não muda a empresa/roteamento — é só uma sobreposição de apresentação.
// ============================================================
// Cada nicho tem um nome e um conjunto PADRÃO de textos (ponto de partida). Na
// Etapa 2 esses textos ficam editáveis no painel e sobrescrevem estes defaults.
const NICHOS_DEMO = {
  barbearia: {
    nome: 'Barbearia',
    mensagemAgradecimento: 'Olá! 💈 Bem-vindo(a) à demonstração do RecomendaLeads para *Barbearias*. Obrigado por testar! Vou te mostrar como seus clientes recomendam amigos e todos ganham. 🙏'
  },
  cabeleireiro: {
    nome: 'Cabeleireiro',
    mensagemAgradecimento: 'Olá! 💇 Bem-vindo(a) à demonstração do RecomendaLeads para *Cabeleireiros e Salões*. Obrigado por testar! Vou te mostrar como seus clientes recomendam amigos e todos ganham. 🙏'
  },
  dentista: {
    nome: 'Dentista',
    mensagemAgradecimento: 'Olá! 🦷 Bem-vindo(a) à demonstração do RecomendaLeads para *Dentistas e Clínicas Odontológicas*. Obrigado por testar! Vou te mostrar como seus pacientes recomendam amigos e todos ganham. 🙏'
  },
  estetica: {
    nome: 'Clínica de Estética',
    mensagemAgradecimento: 'Olá! ✨ Bem-vindo(a) à demonstração do RecomendaLeads para *Clínicas de Estética*. Obrigado por testar! Vou te mostrar como suas clientes recomendam amigas e todas ganham. 🙏'
  }
};

// Gera um "slug" (código do link) a partir do nome do mercado.
// Ex: "Pet Shop" -> "pet-shop". Só letras/números/hífen, sem acento.
function slugNicho(nome) {
  return String(nome || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// Detecta o código do nicho no texto de entrada (ex: "...#demo-barbearia").
// Exige o "#" literal: assim a mensagem REAL do link (com "#demo-x") é
// reconhecida, mas o link cru colado no chat (que vem com "%23demo-x") é
// ignorado — evitando iniciar a conversa duas vezes. O nicho é válido se for
// um dos embutidos OU um mercado criado pelo dono (empresa.nichos).
function detectarNichoDemo(texto, empresa) {
  if (!texto) return null;
  const t = String(texto).toLowerCase();
  const m = t.match(/#demo[-_\s]?([a-z0-9-]+)/);
  if (!m) return null;
  const slug = m[1].replace(/-+$/, '');
  const existe = NICHOS_DEMO[slug] || (empresa && empresa.nichos && empresa.nichos[slug]);
  return existe ? slug : null;
}

// Sobrepõe a config do nicho sobre a base da empresa: primeiro os defaults
// embutidos (NICHOS_DEMO), depois o que o dono personalizou no painel
// (empresa.nichos[nicho]). Assim já há diferença visível antes de personalizar.
function aplicarNicho(empresa, nicho) {
  if (!empresa || !nicho) return empresa;
  const def = NICHOS_DEMO[nicho] || {};
  const over = (empresa.nichos && empresa.nichos[nicho]) || {};
  return { ...empresa, ...def, ...over, id: empresa.id, nichos: empresa.nichos };
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

const JWT_SECRET = process.env.JWT_SECRET || 'recomendaleads-segredo-trocar-em-producao';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'troque-esta-chave';

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
  linkRecomendado: null,
  textoRecomendado: null,
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
  mensagemAguardandoConfirmacao: 'Prometo que é rapidinho e sem compromisso 😊 Posso te mostrar o que prepararam pra você? 🎁',
  mensagemAntesPresente: '🎉 Boa notícia! Você ganhou {premio}. Aqui está o seu presente 👇',
  gatilhoPresente: 'quero meu presente',

  // ===== Conversa do CLIENTE (quem recomenda) — editável =====
  mensagemPedeNome: 'Pra começar, qual é o seu nome?',
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
  followupRecomendadorMensagem: 'Oi {cliente}! 😊 Passando pra lembrar: você já avisou seus amigos que a {empresa} vai entrar em contato com eles?\n\n1️⃣ Sim, já avisei\n2️⃣ Ainda não\n3️⃣ Me manda um textinho pronto pra eu enviar\n\n👇 _Digite o número_',
  followupJaAvisei: 'Perfeito, muito obrigado(a)! 🙌 Isso ajuda bastante — assim seus amigos já esperam a nossa mensagem.',
  followupAindaNao: 'Sem problema! 😉 Quando puder, dá um alô pra eles avisando. Assim eles recebem nosso contato numa boa. Obrigado(a)!',
  followupTextoPronto: 'Oi! 😊 Acabei de te recomendar pra {empresa} e você vai ganhar um presente 🎁 Eles vão te chamar aqui no WhatsApp, pode responder tranquilo!',
  // Textos do 2º e 3º lembretes (opcionais). Vazio = repete o texto do 1º.
  followupRecomendadorMensagem2: 'Oi {cliente}! 😊 Só passando de novo: conseguiu avisar seus amigos que a {empresa} vai chamar eles?\n\n1️⃣ Sim, já avisei\n2️⃣ Ainda não\n3️⃣ Me manda um textinho pronto pra eu enviar\n\n👇 _Digite o número_',
  followupRecomendadorMensagem3: 'Oi {cliente}! 😊 Última passadinha aqui 🙌 Já deu aquele alô pros amigos que você recomendou?\n\n1️⃣ Sim, já avisei\n2️⃣ Ainda não\n3️⃣ Me manda um textinho pronto pra eu enviar\n\n👇 _Digite o número_',

  cadenciaFollowupRecomendado: [
    { esperaMin: 1440, texto: 'Olá! 😊 Passei só pra lembrar que o presente recomendado pra você continua disponível 🎁 Posso te explicar?' },
    { esperaMin: 4320, texto: 'Olá, tudo bem? O presente segue reservado no seu nome 🎁 Se tiver interesse, é só me avisar que te envio. Caso não, sem problema 😊' }
  ],
  tempoEsperaConversaoMin: 60,
  tempoFollowupMin: 30,

  // ===== Fluxo pós-presente (todos editáveis no painel, na sequência) =====
  posMenuPrincipal: `🎉 *Prontinho!*\n\nEspero que você goste do presente 😊\nO(a) {recomendador} vai ficar feliz de saber que você recebeu.\n\nAgora é só escolher o que prefere 👇\n\n🟢 *1* — Quero usar meu presente\n🟡 *2* — Vou usar depois\n⚪ *3* — Tenho uma dúvida\n\n👇 _Digite o número_`,
  posLinkAgendamento: 'Perfeito! 😊 É só escolher o melhor horário pra você aqui:',
  posPerguntaPeriodo: `Perfeito! 😊 Vamos combinar sua visita.\n\nQual período fica melhor pra você?\n\n*1* — Manhã ☀️\n*2* — Tarde 🌤️\n*3* — Noite 🌙\n\n👇 _Digite o número_`,
  posPerguntaDia: 'Ótimo! Agora escolha o melhor dia 📅',
  posConfirmacaoAgendamento: `🎉 *Tudo certo!*\n\nSua visita foi reservada:\n📅 {dia} — período da {periodo}\n\nNossa equipe vai confirmar com você pertinho do dia. Vai ser um prazer te receber! 😊`,
  posConfirmacaoCheck: 'Oi {nomeRecomendado}! 😊 Conseguiu confirmar seu agendamento? Se ficou alguma dúvida, é só me chamar aqui 👍',
  posMenuDepois: `Sem problemas! 😊 Seu presente continua reservado pra você.\n\nComo prefere fazer?\n\n🟢 *1* — Deixar uma data reservada\n🟡 *2* — Receber um lembrete depois\n\n👇 _Digite o número_`,
  posLembrete: 'Perfeito! 😊 Vamos te lembrar no momento certo de aproveitar seu presente. Até breve! 👋',
  posMenuDuvidas: `Claro! Sobre o que você gostaria de saber?\n\n*1* — Como funciona o presente?\n*2* — Qual a validade?\n*3* — Onde fica a empresa?\n*4* — Horários de atendimento\n*5* — Falar com um atendente\n\n👇 _Digite o número_`,
  faqComoFunciona: 'Seu presente é: {premio}. É só apresentar essa mensagem quando vier nos visitar 😊',
  faqValidade: 'É por tempo limitado, então recomendo aproveitar logo! 😉 Qualquer detalhe, nossa equipe te ajuda.',
  enderecoEmpresa: '',
  horariosEmpresa: '',
  posAtendente: 'Claro! 😊 Já estou chamando um atendente pra falar com você por aqui. É só aguardar um pouquinho.',
  linkAgendamento: '',

  etapasKanban: [
    { id: 'recebeu_mensagem', nome: 'Recebeu Mensagem' },
    { id: 'recebeu_premio', nome: 'Recebeu o Prêmio' },
    { id: 'agendou', nome: 'Agendou' },
    { id: 'comprou', nome: 'Comprou' },
    { id: 'nao_respondeu', nome: 'Não respondeu' },
    { id: 'nao_tem_interesse', nome: 'Não tem interesse' }
  ]
};

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
    oficialTemplateRecomendado: data.oficialTemplateRecomendado || null
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

async function saveEmpresa(empresa) {
  await EMPRESA_DOC().set(empresa, { merge: true });
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

async function getTodasSessoes() {
  const snap = await SESSOES_COL().get();
  const sessoes = {};
  snap.forEach(doc => { sessoes[doc.id] = doc.data(); });
  return sessoes;
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
    etapa: etapaInicial,
    bonusPago: false,
    criadoEm: new Date().toISOString(),
    historico: [{ etapa: etapaInicial, em: new Date().toISOString() }]
  };
  const ref = await LEADS_COL().add(lead);
  return { id: ref.id, ...lead };
}

async function getTodosLeads() {
  const snap = await LEADS_COL().orderBy('criadoEm', 'desc').get();
  const leads = [];
  snap.forEach(doc => leads.push({ id: doc.id, ...doc.data() }));
  return leads;
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

async function sendText(phone, message) {
  if (tipoWppAtual() === 'baileys') {
    try {
      await baileys.enviarTexto(empresaIdAtual(), phone, message);
      console.log(`[ENVIADO/baileys] para ${phone}: ${message.slice(0, 60)}...`);
      registrarMensagem({ empresaId: empresaIdAtual(), telefone: phone, direcao: 'out', texto: message });
      return { ok: true, via: 'baileys' };
    } catch (err) { console.error('Erro ao enviar texto (Baileys):', err.message); return { ok: false, via: 'baileys', erro: err.message }; }
  }
  if (tipoWppAtual() === 'oficial') {
    try {
      const cfg = oficialAtual();
      await axios.post(metaMessagesUrl(cfg), {
        messaging_product: 'whatsapp', to: soDigitos(phone), type: 'text',
        text: { preview_url: true, body: message }
      }, { headers: metaHeaders(cfg) });
      console.log(`[ENVIADO/oficial] para ${phone}: ${message.slice(0, 60)}...`);
      registrarMensagem({ empresaId: empresaIdAtual(), telefone: phone, direcao: 'out', texto: message });
      return { ok: true, via: 'oficial' };
    } catch (err) { const e = err.response?.data ? JSON.stringify(err.response.data) : err.message; console.error('Erro ao enviar texto (Oficial):', e); return { ok: false, via: 'oficial', erro: e }; }
  }
  try {
    const cfg = zapiAtual();
    await axios.post(`${zapiBaseUrl(cfg)}/send-text`, { phone, message }, { headers: zapiHeaders(cfg) });
    console.log(`[ENVIADO] para ${phone}: ${message.slice(0, 60)}...`);
    registrarMensagem({ empresaId: empresaIdAtual(), telefone: phone, direcao: 'out', texto: message });
    return { ok: true, via: 'zapi' };
  } catch (err) {
    const e = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('Erro ao enviar texto:', e);
    return { ok: false, via: 'zapi', erro: e };
  }
}

async function sendImage(phone, imageUrl, caption) {
  if (tipoWppAtual() === 'baileys') {
    try {
      const d = dataUriParaBuffer(imageUrl);
      if (d) await baileys.enviarMidia(empresaIdAtual(), phone, d.buffer, d.mimetype, caption || '', false);
      else { await baileys.enviarTexto(empresaIdAtual(), phone, (caption ? caption + '\n' : '') + imageUrl); }
      registrarMensagem({ empresaId: empresaIdAtual(), telefone: phone, direcao: 'out', texto: caption || '📷 Imagem', tipo: 'imagem' });
    } catch (err) { console.error('Erro ao enviar imagem (Baileys):', err.message); }
    return;
  }
  if (tipoWppAtual() === 'oficial') {
    try {
      const cfg = oficialAtual();
      const d = dataUriParaBuffer(imageUrl);
      let image;
      if (d) { const id = await metaUploadMedia(cfg, d.buffer, d.mimetype, 'imagem'); image = { id, caption: caption || '' }; }
      else { image = { link: imageUrl, caption: caption || '' }; }
      await axios.post(metaMessagesUrl(cfg), {
        messaging_product: 'whatsapp', to: soDigitos(phone), type: 'image', image
      }, { headers: metaHeaders(cfg) });
      console.log(`[IMAGEM ENVIADA/oficial] para ${phone}`);
      registrarMensagem({ empresaId: empresaIdAtual(), telefone: phone, direcao: 'out', texto: caption || '📷 Imagem', tipo: 'imagem' });
    } catch (err) { console.error('Erro ao enviar imagem (Oficial):', err.response?.data || err.message); }
    return;
  }
  try {
    const cfg = zapiAtual();
    await axios.post(`${zapiBaseUrl(cfg)}/send-image`, {
      phone, image: imageUrl, caption: caption || ''
    }, { headers: zapiHeaders(cfg) });
    console.log(`[IMAGEM ENVIADA] para ${phone}`);
    registrarMensagem({ empresaId: empresaIdAtual(), telefone: phone, direcao: 'out', texto: caption || '📷 Imagem', tipo: 'imagem' });
  } catch (err) {
    console.error('Erro ao enviar imagem:', err.response?.data || err.message);
  }
}

async function sendDocument(phone, base64OrUrl, fileName, extension) {
  if (tipoWppAtual() === 'baileys') {
    try {
      const d = dataUriParaBuffer(base64OrUrl);
      if (d) await baileys.enviarMidia(empresaIdAtual(), phone, d.buffer, d.mimetype, '', true, `${fileName || 'arquivo'}.${extension || ''}`);
      else { await baileys.enviarTexto(empresaIdAtual(), phone, base64OrUrl); }
      registrarMensagem({ empresaId: empresaIdAtual(), telefone: phone, direcao: 'out', texto: `📎 ${fileName || 'Documento'}`, tipo: 'documento' });
    } catch (err) { console.error('Erro ao enviar documento (Baileys):', err.message); }
    return;
  }
  if (tipoWppAtual() === 'oficial') {
    try {
      const cfg = oficialAtual();
      const nomeArq = `${fileName || 'arquivo'}${extension ? '.' + extension : ''}`;
      const d = dataUriParaBuffer(base64OrUrl);
      let document;
      if (d) { const id = await metaUploadMedia(cfg, d.buffer, d.mimetype, nomeArq); document = { id, filename: nomeArq }; }
      else { document = { link: base64OrUrl, filename: nomeArq }; }
      await axios.post(metaMessagesUrl(cfg), {
        messaging_product: 'whatsapp', to: soDigitos(phone), type: 'document', document
      }, { headers: metaHeaders(cfg) });
      console.log(`[DOCUMENTO ENVIADO/oficial] para ${phone}: ${nomeArq}`);
      registrarMensagem({ empresaId: empresaIdAtual(), telefone: phone, direcao: 'out', texto: `📎 ${fileName || 'Documento'}`, tipo: 'documento' });
    } catch (err) { console.error('Erro ao enviar documento (Oficial):', err.response?.data || err.message); }
    return;
  }
  try {
    const cfg = zapiAtual();
    await axios.post(`${zapiBaseUrl(cfg)}/send-document/${extension}`, {
      phone, document: base64OrUrl, fileName
    }, { headers: zapiHeaders(cfg) });
    console.log(`[DOCUMENTO ENVIADO] para ${phone}: ${fileName}`);
    registrarMensagem({ empresaId: empresaIdAtual(), telefone: phone, direcao: 'out', texto: `📎 ${fileName || 'Documento'}`, tipo: 'documento' });
  } catch (err) {
    console.error('Erro ao enviar documento:', err.response?.data || err.message);
  }
}

// Envia um template APROVADO na Meta. Obrigatório pra INICIAR conversa com quem
// não te falou nas últimas 24h (ex.: o recomendado). Só existe no modo oficial.
// bodyParams: strings que preenchem {{1}}, {{2}}... do corpo do template.
// Retorna true se enviou por template; false se não estava em modo oficial (o
// chamador então segue com o envio de texto normal — Baileys/Z-API).
async function sendTemplate(phone, templateName, bodyParams = [], lang = 'pt_BR') {
  if (tipoWppAtual() !== 'oficial') return false;
  try {
    const cfg = oficialAtual();
    const components = bodyParams.length
      ? [{ type: 'body', parameters: bodyParams.map(t => ({ type: 'text', text: String(t) })) }]
      : [];
    await axios.post(metaMessagesUrl(cfg), {
      messaging_product: 'whatsapp', to: soDigitos(phone), type: 'template',
      template: { name: templateName, language: { code: lang }, components }
    }, { headers: metaHeaders(cfg) });
    console.log(`[TEMPLATE ENVIADO/oficial] ${templateName} → ${phone}`);
    registrarMensagem({ empresaId: empresaIdAtual(), telefone: phone, direcao: 'out', texto: `[template: ${templateName}]` });
    return true;
  } catch (err) {
    console.error('Erro ao enviar template (Oficial):', err.response?.data || err.message);
    return false;
  }
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

async function iniciarConversa(telefone) {
  const empresa = await getEmpresa();
  await getSessao(telefone);
  await sendText(telefone, substituirVariaveis(empresa.mensagemAgradecimento, { empresa: empresa.nome }));
  await sendText(telefone, substituirVariaveis(empresa.mensagemPedeNome || EMPRESA_PADRAO.mensagemPedeNome, { empresa: empresa.nome }));
}

async function processarMensagem(telefone, texto, vCard, contatosMultiplos) {
  const empresa = await getEmpresa();
  const sessao = await getSessao(telefone);

  if (sessao.etapa === 'aguardando_nome') {
    sessao.clienteNome = (texto || '').trim();
    sessao.etapa = 'aguardando_vendedor';
    await saveSessao(telefone, sessao);

    const listaVendedores = empresa.vendedores.map((v, i) => `${i + 1}️⃣ ${v}`).join('\n');
    const perguntaVendedor = substituirVariaveis(empresa.mensagemPedeVendedor || EMPRESA_PADRAO.mensagemPedeVendedor, { nomeRecomendado: sessao.clienteNome.split(' ')[0], empresa: empresa.nome });
    await sendText(telefone, `${perguntaVendedor}\n\n${listaVendedores}\n\nResponda com o número ou o nome.`);
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
      await sendText(telefone, 'Não encontrei esse vendedor. Pode digitar o número da lista ou o nome certinho?');
      return;
    }

    sessao.vendedorNome = vendedor;
    sessao.etapa = 'coletando_contatos';
    sessao.indiceFaixaAtual = 0;
    sessao.contatosFaixaAtual = [];
    await saveSessao(telefone, sessao);

    const primeiraFaixa = empresa.faixasBonus[0];
    const varsCliente = { nomeRecomendado: sessao.clienteNome.split(' ')[0], empresa: empresa.nome, premio: primeiraFaixa.premio, quantidade: primeiraFaixa.quantidade };
    await sendText(telefone, substituirVariaveis(empresa.mensagemPedeContatos || EMPRESA_PADRAO.mensagemPedeContatos, varsCliente));
    await sendText(telefone, substituirVariaveis(empresa.mensagemColeta || EMPRESA_PADRAO.mensagemColeta, varsCliente));
    return;
  }

  if (sessao.etapa === 'coletando_contatos') {
    let novosContatos = [];

    if (contatosMultiplos && contatosMultiplos.length > 0) {
      novosContatos = contatosMultiplos.filter(c => c && c.nome);
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

    if (novosContatos.length > 0) {
      const faixaAtual = empresa.faixasBonus[sessao.indiceFaixaAtual];
      const contatosFaixaAtual = [...(sessao.contatosFaixaAtual || []), ...novosContatos];

      sessao.contatos = [...(sessao.contatos || []), ...novosContatos];

      if (contatosFaixaAtual.length < faixaAtual.quantidade) {
        sessao.contatosFaixaAtual = contatosFaixaAtual;
        await saveSessao(telefone, sessao);

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

  if (sessao.etapa === 'aguardando_autorizacao_proxima_faixa') {
    if (respostaEhPositiva(texto)) {
      const proximoIndice = sessao.indiceFaixaAtual + 1;
      const proximaFaixa = empresa.faixasBonus[proximoIndice];
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
        await saveSessao(telefone, sessao);
        const faltam = proximaFaixa.quantidade - excedentePendente.length;
        await sendText(telefone, `Show! Faltam ${faltam} recomendações para você garantir "${proximaFaixa.premio}". Quem mais vem na sua mente?`);
      }
    } else {
      sessao.excedentePendente = [];
      sessao.etapa = 'finalizado';
      await saveSessao(telefone, sessao);
      await sendText(telefone, 'Sem problemas! Muito obrigado(a) por participar e por confiar na gente 🙏');
    }
    return;
  }

  if (sessao.etapa === 'finalizado') {
    return;
  }
}

async function finalizarFaixa(telefone, sessao, faixa, empresa, contatosDestaFaixa, excedente) {
  await sendText(telefone, `🎉 Perfeito! Você completou ${contatosDestaFaixa.length} recomendações.`);
  await sendText(telefone, `🎁 Aqui está o seu presente:`);

  // Ordem congruente: presente (imagem) → mensagem de orientação → link
  if (faixa.arquivo) {
    await enviarVoucher(telefone, faixa.arquivo, faixa.premio, faixa.premio);
  } else {
    await sendText(telefone, faixa.premio);
  }

  if (faixa.texto) {
    await sendText(telefone, faixa.texto);
  }

  if (faixa.link) {
    await sendText(telefone, faixa.link);
  }

  const msgValidarAmigo = empresa.mensagemValidarAmigo ?? EMPRESA_PADRAO.mensagemValidarAmigo;
  if (msgValidarAmigo && msgValidarAmigo.trim()) {
    await sendText(telefone, substituirVariaveis(msgValidarAmigo, {
      nomeRecomendado: (sessao.clienteNome || '').split(' ')[0],
      empresa: empresa.nome
    }));
  }

  for (const contato of contatosDestaFaixa) {
    try {
      await criarLead({
        nomeRecomendado: contato.nome,
        telefoneRecomendado: contato.telefone,
        nomeRecomendador: sessao.clienteNome,
        telefoneRecomendador: telefone,
        vendedor: sessao.vendedorNome,
        empresaId: empresaIdAtual()
      });
    } catch (err) {
      console.error('Erro ao criar lead no CRM:', err.message);
    }
  }

  // Agenda o follow-up do recomendador (só uma vez, no 1º prêmio completado):
  // ele já mandou recomendações, então começa a série de lembretes pra avisar
  // os amigos. Só agenda se o recurso estiver ligado no painel.
  if (empresa.followupRecomendadorAtivo && !sessao.followupRecomendadorAgendado) {
    sessao.followupRecomendadorAgendado = true;
    try { await agendarFollowupRecomendador(telefone, empresa, 0); } catch (e) { console.error('agendarFollowupRecomendador:', e.message); }
  }

  const proximaFaixa = empresa.faixasBonus[sessao.indiceFaixaAtual + 1];

  if (!proximaFaixa) {
    sessao.etapa = 'finalizado';
    sessao.faixaFinal = faixa;
    await saveSessao(telefone, sessao);
    await sendText(telefone, 'Muito obrigado(a) por participar e por confiar na gente! 🙏');
  } else {
    sessao.etapa = 'aguardando_autorizacao_proxima_faixa';
    sessao.excedentePendente = excedente;
    await saveSessao(telefone, sessao);

    if (excedente.length > 0) {
      const palavraContato = excedente.length === 1 ? 'contato' : 'contatos';
      await sendText(telefone, `E olha, você já mandou ${excedente.length} ${palavraContato} a mais! Quer completar mais ${proximaFaixa.quantidade - excedente.length} recomendações e ganhar "${proximaFaixa.premio}"?`);
    } else {
      const incremento = proximaFaixa.quantidade - faixa.quantidade;
      await sendText(telefone, `Quer liberar o próximo prêmio? São +${incremento} recomendações e o prêmio é "${proximaFaixa.premio}". Quer continuar?`);
    }
  }

  const executarEm = new Date(Date.now() + empresa.tempoEsperaConversaoMin * 60 * 1000).toISOString();
  for (const contato of contatosDestaFaixa) {
    try {
      // Cancela agendamentos pendentes anteriores para este mesmo telefone
      // evita que o recomendado receba o roteiro múltiplas vezes
      if (contato.telefone) {
        const snapPendentes = await AGENDAMENTOS_COL()
          .where('status', '==', 'pendente')
          .where('tipo', '==', 'iniciar_conversa_recomendado')
          .get();
        const batch = db.batch();
        snapPendentes.forEach(doc => {
          if (doc.data().dados?.contato?.telefone === contato.telefone) {
            batch.update(doc.ref, { status: 'cancelado' });
          }
        });
        await batch.commit();
      }
      await criarAgendamento({
        tipo: 'iniciar_conversa_recomendado',
        executarEm,
        dados: {
          contato,
          nomeRecomendador: sessao.clienteNome,
          vendedorNome: sessao.vendedorNome
        }
      });
    } catch (err) {
      console.error('Erro ao criar agendamento para recomendado:', err.message);
    }
  }

  console.log(`[FAIXA FINALIZADA] ${sessao.clienteNome} via ${sessao.vendedorNome} — ${contatosDestaFaixa.length} contatos nesta faixa, ${excedente.length} excedentes pendentes`);
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
// AGENDAMENTOS PERSISTIDOS — substituem setTimeout em memória
// ============================================================

async function criarAgendamento({ tipo, executarEm, dados, marcaTempoReferencia }) {
  await AGENDAMENTOS_COL().add({
    tipo,
    executarEm,
    status: 'pendente',
    // Registra a empresa dona deste agendamento, pra que o follow-up depois
    // seja enviado pelo WhatsApp dela (e não pelo número global).
    empresaId: empresaIdAtual(),
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

// ---- Follow-up do RECOMENDADOR (cliente que indicou) ----
// Agenda o lembrete de índice `indice` (0,1,2...) pedindo que ele avise os amigos.
async function agendarFollowupRecomendador(telefone, empresa, indice) {
  const cadencia = empresa.cadenciaFollowupRecomendador || EMPRESA_PADRAO.cadenciaFollowupRecomendador || [];
  const item = cadencia[indice];
  if (!item) return;
  const esperaMin = Math.max(1, parseInt(item.esperaMin, 10) || 1440);
  const executarEm = new Date(Date.now() + esperaMin * 60 * 1000).toISOString();
  await criarAgendamento({
    tipo: 'followup_avisar_amigos',
    executarEm,
    dados: { telefone, indice }
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

async function iniciarConversaRecomendado(contato, nomeRecomendador, vendedorNome, empresa) {
  if (!contato.telefone) {
    console.log(`[AVISO] Contato "${contato.nome}" sem telefone válido — não foi possível iniciar conversa.`);
    return;
  }

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

  const mensagemInicial = substituirVariaveis(empresa.mensagemInicialRecomendado, variaveis);
  // No modo OFICIAL, a primeira mensagem ao recomendado (que nunca te chamou)
  // precisa ser um TEMPLATE aprovado pela Meta. Params na ordem:
  // {{1}}=nome do recomendado, {{2}}=quem recomendou, {{3}}=empresa.
  // Fora do modo oficial (ou sem template configurado) segue como hoje.
  if (tipoWppAtual() === 'oficial' && empresa.oficialTemplateRecomendado) {
    const enviou = await sendTemplate(contato.telefone, empresa.oficialTemplateRecomendado,
      [primeiroNomeRecomendado, nomeRecomendador.split(' ')[0], empresa.nome]);
    if (!enviou) await sendText(contato.telefone, mensagemInicial);
  } else {
    await sendText(contato.telefone, mensagemInicial);
  }

  const marcaTempo = new Date().toISOString();
  await saveSessaoRecomendado(contato.telefone, {
    etapa: 'aguardando_confirmacao',
    nomeRecomendado: contato.nome,
    telefoneRecomendado: contato.telefone,
    nomeRecomendador: nomeRecomendador,
    vendedorNome: vendedorNome,
    ultimaMensagemEm: marcaTempo,
    criadoEm: marcaTempo
  });

  await agendarProximoFollowup(contato.telefone, empresa, marcaTempo, 0);
  console.log(`[ROTEIRO RECOMENDADO INICIADO] ${contato.nome} (${contato.telefone})`);
}

async function enviarPremioRecomendado(telefone, sessao, empresa) {
  // Move o card para "Recebeu o Prêmio" assim que a pessoa aceita o presente.
  await marcarLeadRecebeuPremio(telefone, empresa);

  // Mensagem-ponte: enviada logo após a pessoa responder, antes do presente.
  const ponte = substituirVariaveis(empresa.mensagemAntesPresente ?? EMPRESA_PADRAO.mensagemAntesPresente, { ...variaveisRec(sessao, empresa), premio: empresa.premioRecomendado || 'seu presente' });
  if (ponte && ponte.trim()) await sendText(telefone, ponte);

  if (empresa.arquivoRecomendado) {
    await enviarVoucher(telefone, empresa.arquivoRecomendado, empresa.premioRecomendado || '', empresa.premioRecomendado || 'presente');
  }

  if (empresa.linkRecomendado) {
    await sendText(telefone, empresa.linkRecomendado);
  }

  if (empresa.textoRecomendado && empresa.textoRecomendado.trim()) {
    const orientacao = substituirVariaveis(empresa.textoRecomendado, { ...variaveisRec(sessao, empresa), premio: empresa.premioRecomendado || 'seu presente' });
    await sendText(telefone, orientacao);
  }

  const marcaTempo = new Date().toISOString();
  await enviarMenuPrincipalRec(telefone, sessao, marcaTempo);
  await agendarProximoFollowup(telefone, empresa, marcaTempo, 0);
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
  if (msg && msg.trim()) await sendText(tel, msg);
  if (empresa.arquivoVenda) {
    await enviarVoucher(tel, empresa.arquivoVenda, empresa.premioVenda || '', empresa.premioVenda || 'presente');
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

// Agenda a checagem de confirmação ~3 min após o agendamento.
async function agendarCheckConfirmacao(telefone) {
  const executarEm = new Date(Date.now() + 3 * 60 * 1000).toISOString();
  await criarAgendamento({ tipo: 'confirmar_agendamento_check', executarEm, dados: { telefone } });
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
    await saveSessaoRecomendado(telefone, { etapa: 'finalizado', ultimaMensagemEm: new Date().toISOString() });
    await agendarCheckConfirmacao(telefone);
    return;
  }
  await enviarPerguntaPeriodoRec(telefone, empresa, fluxo);
}

async function enviarPerguntaPeriodoRec(telefone, empresa, fluxo) {
  const texto = substituirVariaveis((empresa && empresa.posPerguntaPeriodo) || EMPRESA_PADRAO.posPerguntaPeriodo, variaveisRec(null, empresa));
  await sendText(telefone, texto);
  await saveSessaoRecomendado(telefone, { etapa: 'agendar_periodo', fluxoAgendamento: fluxo || 'agora', ultimaMensagemEm: new Date().toISOString() });
}

function gerarOpcoesDias() {
  const semana = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
  const dias = [];
  for (let i = 1; i <= 5; i++) {
    const d = new Date(); d.setDate(d.getDate() + i);
    dias.push({ idx: i, label: `${semana[d.getDay()]}, ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}` });
  }
  return dias;
}

async function enviarPerguntaDiaRec(telefone) {
  const empresa = await getEmpresa();
  const dias = gerarOpcoesDias();
  const linhas = dias.map(d => `*${d.idx}* — ${d.label}`).join('\n');
  const header = (empresa.posPerguntaDia || EMPRESA_PADRAO.posPerguntaDia);
  await sendText(telefone, `${header}\n\n${linhas}\n\n👇 _Digite o número_`);
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
  await saveSessaoRecomendado(telefone, { etapa: 'finalizado' });
  await agendarCheckConfirmacao(telefone);
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
  else if (opcao === 3) resposta = empresa.enderecoEmpresa ? `Estamos em: ${empresa.enderecoEmpresa} 📍` : 'Um atendente já te passa o endereço certinho 😊';
  else if (opcao === 4) resposta = empresa.horariosEmpresa ? `Nosso atendimento: ${empresa.horariosEmpresa} 🕒` : 'Um atendente já te passa os horários 😊';
  else return false;
  await sendText(telefone, resposta);
  await sendText(telefone, `Posso ajudar em mais alguma coisa? 😊\n\n*1* — Como funciona   *2* — Validade\n*3* — Endereço   *4* — Horários\n*5* — Falar com atendente\n\nOu responda *0* se estiver tudo certo 👍`);
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

  // IA DESATIVADA — fluxo 100% por palavras-chave e respostas fixas do CRM.
  // Mais rápido, previsível e sem delay de API.

  if (sessao.etapa === 'aguardando_confirmacao') {
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
    const dias = sessao.diasOpcoes || gerarOpcoesDias();
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
      await sendText(telefone, substituirVariaveis(empresa.posAtendente || EMPRESA_PADRAO.posAtendente, variaveisRec(sessao, empresa)));
      await saveSessaoRecomendado(telefone, { etapa: 'finalizado_atendente' });
      return true;
    }
    const ok = await responderDuvidaRec(telefone, op, empresa);
    if (!ok) await sendText(telefone, 'Me responde com o número da dúvida 😊 (1 a 5), ou *0* se estiver tudo certo.');
    return true;
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
    let textoChat = texto;
    if (!textoChat) {
      if (contatosMultiplos && contatosMultiplos.length) textoChat = '👤 Contato(s) compartilhado(s)';
      else if (vCard) textoChat = '👤 Contato compartilhado';
      else if (body.image) textoChat = '📷 Imagem';
      else if (body.audio) textoChat = '🎤 Áudio';
      else if (body.document) textoChat = '📎 Documento';
    }
    if (textoChat) {
      registrarMensagem({ empresaId: empresaIdAtual(), telefone, nome: nomeContato, direcao: 'in', texto: textoChat });
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
    // Se o número está pausado, só reage ao gatilho de ativação do presente
    const ehGatilhoInicialParaPausa = ehGatilhoPresente(texto, empGatilho) || !!detectarNichoDemo(texto, empGatilho);
    if (!ehGatilhoInicialParaPausa && await numeroEstaPausado(telefone)) {
      console.log(`[PAUSA MANUAL] Mensagem ignorada — ${telefone} está pausado`);
      return res.sendStatus(200);
    }

    const ehEventoVazio = !texto && !vCard && !contatosMultiplos;
    if (ehEventoVazio) {
      const sessaoExistenteSnap = await SESSOES_COL().doc(chaveSessao(telefone)).get();
      if (sessaoExistenteSnap.exists) {
        const sessao = sessaoExistenteSnap.data();
        const empresa = await getEmpresa();
        const msg = mensagemNaoEntendiPorEtapa(sessao.etapa, empresa);
        if (msg) await sendText(telefone, msg);
      } else {
        const sessaoRecomendado = await getSessaoRecomendado(telefone);
        if (sessaoRecomendado && sessaoRecomendado.etapa !== 'finalizado' && sessaoRecomendado.etapa !== 'finalizado_negativo') {
          await sendText(telefone, 'Acho que não entendi essa última mensagem 🙂 Pode me responder em texto?');
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
    const ehGatilhoInicial = ehGatilhoPresente(texto, empGatilho);

    // Um mesmo número pode ter sido cliente/recomendador antes e agora estar
    // recebendo o roteiro como RECOMENDADO. Se a sessão de cliente já está
    // finalizada (ou não existe) e existe uma sessão de recomendado ATIVA,
    // a mensagem pertence ao fluxo de recomendado — não ao de cliente.
    const sessaoRecomendado = clienteAtivo ? null : await getSessaoRecomendado(telefone);
    const recomendadoAtivo = sessaoRecomendado
      && sessaoRecomendado.etapa
      && !['finalizado', 'finalizado_negativo', 'finalizado_atendente'].includes(sessaoRecomendado.etapa);

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

    // Follow-up do recomendador: se está aguardando resposta ao lembrete
    // (1/2/3), trata aqui — antes do roteamento normal.
    if (sessaoExiste && sessaoExistenteSnap.data().followupAguardando && !ehGatilhoInicial && !nichoDetectado) {
      const tratou = await tratarRespostaFollowupRecomendador(telefone, texto, sessaoExistenteSnap.data());
      if (tratou) return res.sendStatus(200);
    }

    if (ehGatilhoInicial || nichoDetectado) {
      await resetSessao(telefone);
      await iniciarConversa(telefone);
      if (nichoEfetivo) await saveSessao(telefone, { nicho: nichoEfetivo });
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
function metaMensagemParaInterno(value, msg) {
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
  } else if (msg.type === 'contacts' && Array.isArray(msg.contacts)) {
    base.contactArray = msg.contacts.map(c => {
      const phones = (c.phones && c.phones.map(p => p.phone)) || [];
      return { nome: (c.name && c.name.formatted_name) || '', telefone: (phones[0] || '').replace(/\D/g, '') };
    });
  } else {
    return null; // tipos não tratados (áudio, mídia recebida, etc.)
  }
  return base;
}

async function comWebhookOficial(req, res, empresaId) {
  res.sendStatus(200); // responde rápido; a Meta reentrega se demorar
  try {
    const empresa = await getEmpresaById(empresaId);
    if (!empresa) { console.warn(`[WEBHOOK-OFICIAL] empresaId desconhecido: ${empresaId}`); return; }
    for (const entry of ((req.body && req.body.entry) || [])) {
      for (const change of (entry.changes || [])) {
        const value = change.value || {};
        const phoneIdRecebido = value.metadata && value.metadata.phone_number_id;
        if (empresa.oficialPhoneId && phoneIdRecebido && String(phoneIdRecebido) !== String(empresa.oficialPhoneId)) {
          console.warn(`[WEBHOOK-OFICIAL] phone_number_id não confere (${phoneIdRecebido}) — ignorando`);
          continue;
        }
        for (const msg of (value.messages || [])) {
          const interno = metaMensagemParaInterno(value, msg);
          if (!interno) continue;
          const contexto = { empresa, empresaId: empresa.id, zapi: zapiDaEmpresa(empresa), oficial: oficialDaEmpresa(empresa) };
          const fakeRes = { sendStatus() {}, status() { return this; }, json() {}, send() {} };
          await tenantContext.run(contexto, () => tratarWebhook({ body: interno }, fakeRes));
        }
      }
    }
  } catch (e) {
    console.error('[WEBHOOK-OFICIAL] erro:', e.message);
  }
}

app.post('/webhook-oficial/:empresaId', (req, res) => comWebhookOficial(req, res, req.params.empresaId));

// ---- WhatsApp via Baileys: ponte de mensagens recebidas + reconexão ----
// Mensagens recebidas pelo Baileys entram no MESMO fluxo do webhook Z-API.
baileys.init(db, async (empresaId, body) => {
  const fakeRes = { sendStatus() {}, status() { return this; }, json() {}, send() {} };
  try { await comWebhook({ body, params: { empresaId } }, fakeRes, empresaId); }
  catch (e) { console.error('[BAILEYS] ponte erro:', e.message); }
});

// Após reiniciar o servidor, reconecta as empresas que usam Baileys (sessão no Firestore).
async function reconectarSessoesBaileys() {
  if (!db) return;
  try {
    const snap = await EMPRESAS_COL().where('whatsappTipo', '==', 'baileys').get();
    snap.forEach(doc => { baileys.iniciarSessao(doc.id).catch(e => console.error('[BAILEYS] reconectar', doc.id, e.message)); });
    if (!snap.empty) console.log(`[BAILEYS] reconectando ${snap.size} sessão(ões) salvas`);
  } catch (e) { console.error('[BAILEYS] erro ao reconectar sessões:', e.message); }
}
setTimeout(reconectarSessoesBaileys, 5000);

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

app.get('/', (req, res) => {
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

// Página de diagnóstico do WhatsApp (usa o token do login guardado no navegador).
app.get('/minha-whatsapp/debug', (req, res) => {
  res.sendFile(path.join(__dirname, 'whatsapp-debug.html'));
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
        usuario = { id: null, empresaId: d.id, nome: e.nome, email: emailNorm, senhaHash: e.senhaHash, papel: 'gestor', senhaProvisoria: !!e.senhaProvisoria, ativo: true };
      }
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
    try {
      const empDoc = await EMPRESAS_COL().doc(usuario.empresaId).get();
      if (empDoc.exists) nomeEmpresa = empDoc.data().nome || nomeEmpresa;
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
      empresa: { id: usuario.empresaId, nome: nomeEmpresa, email: usuario.email, papel: usuario.papel, senhaProvisoria: !!usuario.senhaProvisoria }
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
    const session = await stripe.checkout.sessions.create({
      mode: ehAssinatura ? 'subscription' : 'payment',
      payment_method_types: plano.metodos,
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
    });
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
    const meta = { tipo: 'signup', plano: planoId, ...(vendedor ? { vendedor } : {}) };
    const session = await stripe.checkout.sessions.create({
      mode: ehAssinatura ? 'subscription' : 'payment',
      payment_method_types: plano.metodos,
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
    });
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

app.get('/minha-equipe', exigirLoginEmpresa, exigirGestor, async (req, res) => {
  try {
    const snap = await USUARIOS_COL().where('empresaId', '==', req.empresaLogin.id).get();
    const usuarios = snap.docs.map(d => {
      const u = d.data();
      return {
        id: d.id,
        nome: u.nome,
        email: u.email,
        papel: u.papel,
        ativo: u.ativo !== false,
        souEu: !!(req.usuario && req.usuario.id === d.id)
      };
    }).sort((a, b) => (a.nome || '').localeCompare(b.nome || ''));
    res.json({ ok: true, usuarios });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post('/minha-equipe', exigirLoginEmpresa, exigirGestor, async (req, res) => {
  try {
    const { nome, email, senha, papel } = req.body;
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
    const senhaHash = await bcrypt.hash(String(senha), 10);
    const ref = await USUARIOS_COL().add({
      empresaId: req.empresaLogin.id,
      nome: String(nome).trim(),
      email: emailNorm,
      senhaHash,
      papel: papelFinal,
      senhaProvisoria: true,
      ativo: true,
      criadoEm: new Date().toISOString()
    });
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
    const { nome, papel, novaSenha } = req.body;
    const update = {};
    if (nome) update.nome = String(nome).trim();
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
    res.json({ ok: true });
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

app.get('/minha-config', exigirLoginEmpresa, async (req, res) => {
  try {
    // Mescla com os padrões pra o painel mostrar todos os textos preenchidos
    // (campos não personalizados vêm com o texto padrão, pronto pra editar).
    const configuracao = { ...EMPRESA_PADRAO, ...(req.empresaLogin.configuracao || { nome: req.empresaLogin.nome }) };
    res.json({ ok: true, empresa: configuracao, ehMatriz: req.empresaLogin.id === EMPRESA_ID_PDN });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post('/minha-config', exigirLoginEmpresa, exigirGestor, async (req, res) => {
  try {
    const configuracaoAtual = req.empresaLogin.configuracao || { ...EMPRESA_PADRAO, nome: req.empresaLogin.nome };
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
  'linkRecomendado', 'textoRecomendado', 'faixasBonus'
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
    res.json({
      ok: true,
      lista: listaNichos(config),
      nichos: config.nichos || {},
      defaults: NICHOS_DEMO,
      base,
      numeroDemo: config.numeroDemo || ''
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
      oficialTemplateRecomendado: e.oficialTemplateRecomendado || '',
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
    // Sem isto, quem estava em Baileys continuaria ENVIANDO pelo Baileys (o
    // whatsappTipo não mudava) e o bot ficaria mudo mesmo com Z-API salva.
    await EMPRESAS_COL().doc(req.empresaLogin.id).set({
      whatsappTipo: 'zapi',
      zapiInstanceId: String(zapiInstanceId).trim(),
      zapiToken: String(zapiToken).trim(),
      zapiClientToken: zapiClientToken ? String(zapiClientToken).trim() : null
    }, { merge: true });

    // Encerra a sessão Baileys (se houver) pra os dois não brigarem pelo número.
    // Best-effort: nunca deixa a falha aqui derrubar o salvamento das credenciais.
    try { await baileys.desconectar(req.empresaLogin.id); } catch (e) {}

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
app.post('/minha-whatsapp/oficial', exigirLoginEmpresa, exigirGestor, async (req, res) => {
  try {
    const { oficialPhoneId, oficialToken, oficialVerifyToken, oficialWabaId, oficialTemplateRecomendado } = req.body;
    if (!oficialPhoneId || !oficialToken || !oficialVerifyToken) {
      return res.status(400).json({ ok: false, erro: 'Informe Phone Number ID, Token e Verify Token' });
    }

    // Ao cadastrar credenciais oficiais, a empresa passa a operar em modo 'oficial'.
    await EMPRESAS_COL().doc(req.empresaLogin.id).set({
      whatsappTipo: 'oficial',
      oficialPhoneId: String(oficialPhoneId).trim(),
      oficialToken: String(oficialToken).trim(),
      oficialVerifyToken: String(oficialVerifyToken).trim(),
      oficialWabaId: oficialWabaId ? String(oficialWabaId).trim() : null,
      oficialTemplateRecomendado: oficialTemplateRecomendado ? String(oficialTemplateRecomendado).trim() : null
    }, { merge: true });

    // Encerra o Baileys (se houver) pra não brigar pelo número.
    try { await baileys.desconectar(req.empresaLogin.id); } catch (e) {}

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
// WHATSAPP GRÁTIS (Baileys) — conexão própria por QR Code
// ============================================================

// Ativa o modo Baileys para a empresa e inicia a sessão (gera o QR).
app.post('/minha-whatsapp/baileys/conectar', exigirLoginEmpresa, exigirGestor, async (req, res) => {
  try {
    const id = req.empresaLogin.id;
    await EMPRESAS_COL().doc(id).set({ whatsappTipo: 'baileys' }, { merge: true });
    await baileys.iniciarSessao(id);
    res.json({ ok: true, ...baileys.getStatus(id) });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Status + QR (imagem em dataURL) da sessão Baileys da empresa.
app.get('/minha-whatsapp/baileys/status', exigirLoginEmpresa, async (req, res) => {
  try {
    const id = req.empresaLogin.id;
    const st = baileys.getStatus(id);
    // Se o modo é baileys mas a sessão não está na memória (ex: pós-deploy), tenta subir.
    if (st.status === 'desconectado' && req.empresaLogin.whatsappTipo === 'baileys') {
      baileys.iniciarSessao(id).catch(() => {});
    }
    res.json({ ok: true, ...st });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Diagnóstico: últimas mensagens RECEBIDAS por esta empresa via Baileys, com
// detalhes (remoteJid, @lid, senderPn, número resolvido, ação). Ajuda a ver
// por que o bot não respondeu.
app.get('/minha-whatsapp/baileys/debug', exigirLoginEmpresa, async (req, res) => {
  try {
    const id = req.empresaLogin.id;
    let st = baileys.getStatus(id);
    // Auto-reparo: se caiu (ex.: após deploy) e a empresa usa baileys, tenta subir.
    if (st.status === 'desconectado' && req.empresaLogin.whatsappTipo === 'baileys') {
      baileys.iniciarSessao(id).catch(() => {});
      st = baileys.getStatus(id);
    }
    res.json({ ok: true, empresaId: id, status: st, recebidas: baileys.getDebug(id) });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Teste de envio (diagnóstico): manda uma mensagem e devolve o que aconteceu.
app.post('/minha-whatsapp/baileys/teste', exigirLoginEmpresa, exigirGestor, async (req, res) => {
  try {
    const id = req.empresaLogin.id;
    const tel = String((req.body && req.body.telefone) || '').replace(/\D/g, '');
    if (tel.length < 8) return res.status(400).json({ ok: false, erro: 'Informe um telefone válido (com DDD).' });
    const r = await baileys.diagnosticarEnvio(id, tel, 'Mensagem de teste do RecomendaLeads ✅');
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Desconecta/desvincula o número (logout). O modo (definido pelo admin) é mantido,
// então o painel volta a oferecer o QR para reconectar.
app.post('/minha-whatsapp/baileys/desconectar', exigirLoginEmpresa, exigirGestor, async (req, res) => {
  try {
    await baileys.desconectar(req.empresaLogin.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ============================================================
// CAIXA DE ENTRADA DO WHATSAPP — conversas da empresa logada
// ============================================================

// Lista as conversas (resumo) da empresa, mais recentes primeiro.
app.get('/minha-conversas', exigirLoginEmpresa, async (req, res) => {
  try {
    const snap = await CONVERSAS_COL().where('empresaId', '==', req.empresaLogin.id).get();
    const conversas = [];
    snap.forEach(d => conversas.push({ id: d.id, ...d.data() }));
    conversas.sort((a, b) => new Date(b.ultimaEm || 0) - new Date(a.ultimaEm || 0));
    res.json({ ok: true, conversas });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Mensagens de uma conversa (e marca como lida).
app.get('/minha-conversas/:telefone/mensagens', exigirLoginEmpresa, async (req, res) => {
  try {
    const telefone = req.params.telefone;
    const chave = `${req.empresaLogin.id}__${telefone}`;
    const snap = await MENSAGENS_CHAT_COL().where('chaveConversa', '==', chave).get();
    const mensagens = [];
    snap.forEach(d => mensagens.push({ id: d.id, ...d.data() }));
    mensagens.sort((a, b) => new Date(a.criadoEm || 0) - new Date(b.criadoEm || 0));
    // marca como lida
    await CONVERSAS_COL().doc(chave).set({ naoLidas: 0 }, { merge: true }).catch(() => {});
    const pausado = await CONVERSAS_COL().doc(chave).get()
      .then(d => d.exists && d.data().botPausado) .catch(() => false);
    res.json({ ok: true, mensagens, botPausado: !!pausado });
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

    const empresa = await getEmpresaById(req.empresaLogin.id);
    const contexto = { empresa, empresaId: req.empresaLogin.id, zapi: zapiDaEmpresa(empresa) };
    await tenantContext.run(contexto, async () => {
      await pausarNumero(telefone);      // assume o atendimento: bot para nesse contato
      await sendText(telefone, mensagem); // envia e já registra a mensagem
    });
    await CONVERSAS_COL().doc(`${req.empresaLogin.id}__${telefone}`).set({ botPausado: true }, { merge: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Devolve o atendimento ao robô (reativa o bot para o contato).
app.post('/minha-conversas/:telefone/devolver', exigirLoginEmpresa, async (req, res) => {
  try {
    const telefone = req.params.telefone;
    const empresa = await getEmpresaById(req.empresaLogin.id);
    const contexto = { empresa, empresaId: req.empresaLogin.id, zapi: zapiDaEmpresa(empresa) };
    await tenantContext.run(contexto, async () => { await despausarNumero(telefone); });
    await CONVERSAS_COL().doc(`${req.empresaLogin.id}__${telefone}`).set({ botPausado: false }, { merge: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Pausa o bot para o contato SEM enviar mensagem (você assume o atendimento).
app.post('/minha-conversas/:telefone/pausar', exigirLoginEmpresa, async (req, res) => {
  try {
    const telefone = req.params.telefone;
    const empresa = await getEmpresaById(req.empresaLogin.id);
    const contexto = { empresa, empresaId: req.empresaLogin.id, zapi: zapiDaEmpresa(empresa) };
    await tenantContext.run(contexto, async () => { await pausarNumero(telefone); });
    await CONVERSAS_COL().doc(`${req.empresaLogin.id}__${telefone}`).set({ botPausado: true }, { merge: true });
    res.json({ ok: true });
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

app.post('/minha-config/faixa', exigirLoginEmpresa, exigirGestor, async (req, res) => {
  try {
    const { quantidade, novaQuantidade, arquivo, link, texto, premio } = req.body;
    const configuracao = req.empresaLogin.configuracao || { ...EMPRESA_PADRAO, nome: req.empresaLogin.nome };

    const faixa = configuracao.faixasBonus.find(f => f.quantidade === quantidade);
    if (!faixa) {
      return res.status(404).json({ ok: false, erro: 'Faixa não encontrada para essa quantidade' });
    }
    if (arquivo !== undefined) faixa.arquivo = arquivo;
    if (link !== undefined) faixa.link = link;
    if (texto !== undefined) faixa.texto = texto;
    if (premio !== undefined) faixa.premio = premio;
    if (novaQuantidade && novaQuantidade !== quantidade) {
      faixa.quantidade = novaQuantidade;
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
    const leads = await getLeadsPorEmpresa(req.empresaLogin.id);
    res.json({ ok: true, leads });
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

app.post('/admin/empresas', exigirAcessoAdmin, async (req, res) => {
  try {
    const ehVendedor = !req.acesso.ehDono;

    const {
      // dados da empresa
      razaoSocial, nomeFantasia, cnpj, enderecoEmpresa, emailEmpresa, telefoneEmpresa,
      // dados do sócio
      nomeSocio, cpfSocio, emailSocio, enderecoSocio, whatsappSocio,
      // instância Z-API provisionada para o cliente (opcional)
      zapiInstanceId, zapiToken, zapiClientToken,
      // acesso / compatibilidade com a versão antiga
      nome, email, senha, migrarConfigPrincipal, empresaTeste,
      // período gratuito (trial) concedido no cadastro, em dias (0 = nenhum)
      trialDias,
      // vendedor da comissão (informado pelo dono; vendedor é forçado abaixo)
      vendedorComissao,
      // modo de WhatsApp: 'baileys' (QR grátis) ou 'zapi' (padrão)
      whatsappTipo
    } = req.body;

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
      enderecoEmpresa: enderecoEmpresa || null,
      emailEmpresa: emailEmpresa || null,
      telefoneEmpresa: telefoneEmpresa || null,
      nomeSocio: nomeSocio || null,
      cpfSocio: cpfSocio || null,
      emailSocio: emailSocio || null,
      enderecoSocio: enderecoSocio || null,
      whatsappSocio: whatsappSocio || null
    };

    // Período gratuito (trial) opcional — só o dono concede.
    const dias = ehVendedor ? 0 : Math.max(0, parseInt(trialDias, 10) || 0);
    let assinatura = null;
    if (dias > 0) {
      const ate = new Date(); ate.setDate(ate.getDate() + dias);
      assinatura = { status: 'trial', ciclo: 'trial', acessoAte: ate.toISOString(), atualizadoEm: new Date().toISOString() };
    }

    const senhaHash = await bcrypt.hash(senha, 10);
    const ref = await EMPRESAS_COL().add({
      nome: nomeEmpresa,
      email: emailLogin,
      senhaHash,
      senhaProvisoria: true,
      cadastro,
      zapiInstanceId: zapiInstanceId ? String(zapiInstanceId).trim() : null,
      zapiToken: zapiToken ? String(zapiToken).trim() : null,
      zapiClientToken: zapiClientToken ? String(zapiClientToken).trim() : null,
      criadoEm: new Date().toISOString(),
      configuracao: configuracaoInicial,
      ...(vendedorVinc ? { vendedorComissao: vendedorVinc } : {}),
      ...(whatsappTipo === 'baileys' ? { whatsappTipo: 'baileys' } : {}),
      ...(assinatura ? { assinatura } : {})
    });

    res.json({ ok: true, empresa: { id: ref.id, nome: nomeEmpresa, email: emailLogin, empresaTeste: !!_empresaTeste, trialDias: dias } });

    // E-mail de boas-vindas (não bloqueia a resposta; ignora se não configurado)
    if (!_empresaTeste) {
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
        cadastro: data.cadastro || null,
        plano: data.plano || null,
        statusPagamento: data.statusPagamento || null,
        valorMensal: data.valorMensal || null,
        observacoes: data.observacoes || null,
        zapiInstanceId: data.zapiInstanceId || null,
        zapiToken: data.zapiToken || null,
        zapiClientToken: data.zapiClientToken || null,
        whatsappProvisionado: !!(data.zapiInstanceId && data.zapiToken),
        assinatura: data.assinatura || null,
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

app.get('/status', async (req, res) => {
  try {
    const empresa = await getEmpresa();
    const sessoes = await getTodasSessoes();
    res.json({
      empresa: empresa.nome,
      sessoesAtivas: Object.keys(sessoes).length,
      sessoes
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.get('/config', async (req, res) => {
  try {
    const empresa = await getEmpresa();
    res.json({ ok: true, empresa });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post('/config', async (req, res) => {
  try {
    const empresaAtual = await getEmpresa();
    const novaEmpresa = { ...empresaAtual, ...req.body };
    await saveEmpresa(novaEmpresa);
    res.json({ ok: true, empresa: novaEmpresa });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post('/config/faixa', async (req, res) => {
  try {
    const { quantidade, arquivo, link, texto, premio } = req.body;
    const empresa = await getEmpresa();
    const faixa = empresa.faixasBonus.find(f => f.quantidade === quantidade);
    if (!faixa) {
      return res.status(404).json({ ok: false, erro: 'Faixa não encontrada para essa quantidade' });
    }
    if (arquivo !== undefined) faixa.arquivo = arquivo;
    if (link !== undefined) faixa.link = link;
    if (texto !== undefined) faixa.texto = texto;
    if (premio !== undefined) faixa.premio = premio;
    await saveEmpresa(empresa);
    res.json({ ok: true, faixa });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ============================================================
// ROTAS DO CRM KANBAN (antigas — sem login)
// ============================================================

app.get('/leads', async (req, res) => {
  try {
    const leads = await getTodosLeads();
    res.json({ ok: true, leads });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.patch('/leads/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { etapa, vendedor, bonusPago } = req.body;
    const dados = {};
    if (etapa !== undefined) dados.etapa = etapa;
    if (vendedor !== undefined) dados.vendedor = vendedor;
    if (bonusPago !== undefined) dados.bonusPago = bonusPago;

    const lead = await atualizarLead(id, dados);
    if (!lead) {
      return res.status(404).json({ ok: false, erro: 'Lead não encontrado' });
    }
    res.json({ ok: true, lead });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post('/leads', async (req, res) => {
  try {
    const { nomeRecomendado, telefoneRecomendado, nomeRecomendador, telefoneRecomendador, vendedor } = req.body;
    const lead = await criarLead({ nomeRecomendado, telefoneRecomendado, nomeRecomendador, telefoneRecomendador, vendedor });
    res.json({ ok: true, lead });
  } catch (err) {
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
    await sendText(telefone, substituirVariaveis(empresa.posConfirmacaoCheck || EMPRESA_PADRAO.posConfirmacaoCheck, variaveisRec(sessao, empresa)));
    return;
  }

  if (agendamento.tipo === 'iniciar_conversa_recomendado') {
    const { contato, nomeRecomendador, vendedorNome } = agendamento.dados;

    // ✅ CORREÇÃO: verifica se o número está pausado antes de iniciar
    // Se stop1 foi enviado após o agendamento ser criado, não inicia a conversa
    if (contato.telefone && await numeroEstaPausado(contato.telefone)) {
      console.log(`[AGENDAMENTO IGNORADO] ${contato.telefone} está pausado (stop1) — conversa não iniciada`);
      return;
    }

    await iniciarConversaRecomendado(contato, nomeRecomendador, vendedorNome, empresa);
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
    await sendText(telefone, substituirVariaveis(proximo.texto, variaveisFollowup));
    const novaMarca = new Date().toISOString();
    await saveSessaoRecomendado(telefone, { ultimaMensagemEm: novaMarca });
    await agendarProximoFollowup(telefone, empresa, novaMarca, indiceFollowup + 1);
    return;
  }

  // Lembrete ao RECOMENDADOR (cliente que indicou) pra avisar os amigos.
  if (agendamento.tipo === 'followup_avisar_amigos') {
    const { telefone, indice } = agendamento.dados;
    if (!empresa.followupRecomendadorAtivo) return;
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
    await sendText(telefone, substituirVariaveis(textoLembrete, vars));
    await saveSessao(telefone, { followupAguardando: true });
    await agendarFollowupRecomendador(telefone, empresa, indice + 1);
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
  if (msg && msg.trim()) await sendText(tel, msg);
  if (empresa.marketingArquivo) {
    await enviarVoucher(tel, empresa.marketingArquivo, empresa.marketingPremio || '', empresa.marketingPremio || 'presente');
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
// INICIALIZAÇÃO DO SERVIDOR
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RecomendaLeads Bot v2 (Firestore) rodando na porta ${PORT}`);
  console.log(`Webhook disponível em: /webhook`);
  console.log(`Firestore inicializado: ${db ? 'SIM' : 'NÃO — verifique FIREBASE_SERVICE_ACCOUNT'}`);
  migrarUsuariosGestores();
  iniciarExecutorAgendamentos();
  // Agenda de Marketing: checa de hora em hora quem está no ciclo de reenvio.
  setInterval(processarAgendaMarketing, 60 * 60 * 1000).unref?.();
  processarAgendaMarketing();
  console.log('Executor de agendamentos iniciado (checagem a cada 1 min)');
});
