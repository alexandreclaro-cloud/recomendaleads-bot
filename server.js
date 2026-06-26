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

const app = express();
// Atrás do proxy do Render: faz req.protocol refletir https (X-Forwarded-Proto),
// pra que urlBase() gere webhooks com https (exigido pela Z-API).
app.set('trust proxy', true);
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Key');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

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

function zapiBaseUrl(cfg) {
  return `https://api.z-api.io/instances/${cfg.instanceId}/token/${cfg.token}`;
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

const PALAVRAS_POSITIVAS = [
  'sim', 'pode', 'posso', 'claro', 'ok', 'okay', 'manda', 'pode falar', 'pode sim', 'com certeza sim', 'ta bom', 'tá bom', 'oi', 'olá', 'ola',
  'com certeza', 'isso', 'aham', 'uhum', 'beleza', 'blz', 'vai', 'fala',
  'diga', 'segue', 'continua', 'quero', 'demorou'
];

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
  ctaRecomendado: 'Que tal aproveitar e passar pra retirar o seu? 😊',
  mensagemInicialRecomendado: 'Olá {nomeRecomendado}, tudo bem? 😊 Aqui é {vendedor}, da {empresa}. O(a) {recomendador} recomendou você para receber um presente que separamos 🎁 Posso te explicar rapidinho?',
  mensagemAguardandoConfirmacao: 'Prometo que é rapidinho e sem compromisso 😊 Posso te mostrar o que prepararam pra você? 🎁',
  mensagemAntesPresente: 'Como forma de agradecer essa recomendação, preparamos um presente especial para você.',

  // ===== Conversa do CLIENTE (quem recomenda) — editável =====
  mensagemPedeNome: 'Pra começar, qual é o seu nome?',
  mensagemPedeVendedor: 'Prazer, {nome}! E me diz, quem te atendeu hoje?',
  mensagemPedeContatos: 'Show! Agora me envie o contato dos seus amigos para você receber {premio}.',
  mensagemColeta: 'Me envie {quantidade} recomendações e já garanta seu presente.\n\nVocê pode mandar o contato direto da sua agenda. Então, qual é a primeira pessoa que vem na sua mente?\nLembrando que ela também vai ganhar um presente nosso 🎁',
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
    zapiInstanceId: data.zapiInstanceId || null,
    zapiToken: data.zapiToken || null,
    zapiClientToken: data.zapiClientToken || null
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

async function sendText(phone, message) {
  try {
    const cfg = zapiAtual();
    await axios.post(`${zapiBaseUrl(cfg)}/send-text`, { phone, message }, { headers: zapiHeaders(cfg) });
    console.log(`[ENVIADO] para ${phone}: ${message.slice(0, 60)}...`);
    registrarMensagem({ empresaId: empresaIdAtual(), telefone: phone, direcao: 'out', texto: message });
  } catch (err) {
    console.error('Erro ao enviar texto:', err.response?.data || err.message);
  }
}

async function sendImage(phone, imageUrl, caption) {
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
    return 'Acho que não entendi essa última mensagem 🙂 Pode mandar o contato direto da sua agenda (toque em 📎 → Contato), ou digitar no formato "Nome - telefone com DDD"?';
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
      await sendText(telefone, 'Não consegui identificar um contato aí. Pode mandar o contato direto da sua agenda (toque em 📎 → Contato), ou digitar no formato "Nome - telefone com DDD"?');
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

  await sendText(telefone, `Só uma coisa importante: avise seus amigos que vamos entrar em contato com eles em breve, combinado? Assim eles já esperam nossa mensagem 😉`);

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
  await sendText(contato.telefone, mensagemInicial);

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
  const ponte = substituirVariaveis(empresa.mensagemAntesPresente ?? EMPRESA_PADRAO.mensagemAntesPresente, variaveisRec(sessao, empresa));
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
    empresa: (empresa && empresa.nome) || ''
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

async function registrarEscolhaNoLead(telefone, dados, empresa, moverParaAgendou) {
  try {
    const snap = await LEADS_COL().where('telefoneRecomendado', '==', telefone).get();
    let lead = null;
    snap.forEach(d => {
      const x = { id: d.id, ...d.data() };
      if ((x.empresaId || EMPRESA_ID_PDN) === empresaIdAtual()) {
        if (!lead || new Date(x.criadoEm || 0) > new Date(lead.criadoEm || 0)) lead = x;
      }
    });
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
    const snap = await LEADS_COL().where('telefoneRecomendado', '==', telefone).get();
    let lead = null;
    snap.forEach(d => {
      const x = { id: d.id, ...d.data() };
      if ((x.empresaId || EMPRESA_ID_PDN) === empresaIdAtual()) {
        if (!lead || new Date(x.criadoEm || 0) > new Date(lead.criadoEm || 0)) lead = x;
      }
    });
    if (!lead) return;

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

    if (respostaEhPositiva(texto)) {
      // Resposta positiva — envia prêmio imediatamente
      const marcaTempo = new Date().toISOString();
      await saveSessaoRecomendado(telefone, { ultimaMensagemEm: marcaTempo });
      await enviarPremioRecomendado(telefone, sessao, empresa);
    } else {
      // Verifica se é uma objeção conhecida
      const respostaObjecao = verificarObjecao(texto, variaveis);
      if (respostaObjecao) {
        // Responde à objeção e envia o presente logo em seguida
        await sendText(telefone, respostaObjecao);
        const marcaTempo = new Date().toISOString();
        await saveSessaoRecomendado(telefone, { ultimaMensagemEm: marcaTempo });
        await enviarPremioRecomendado(telefone, sessao, empresa);
      } else {
        // Qualquer outra coisa — repete a mensagem de confirmação do CRM
        const marcaTempo = new Date().toISOString();
        await saveSessaoRecomendado(telefone, { ultimaMensagemEm: marcaTempo });
        await sendText(telefone, substituirVariaveis(empresa.mensagemAguardandoConfirmacao || 'Prometo que é rapidinho e sem compromisso 😊 Posso te mostrar o que prepararam pra você? 🎁', variaveis));
        await agendarProximoFollowup(telefone, empresa, marcaTempo, 0);
      }
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

      await pausarNumero(alvo);
      await resetSessao(alvo);

      const sessaoRec = await getSessaoRecomendado(alvo);
      if (sessaoRec) {
        await saveSessaoRecomendado(alvo, { etapa: 'finalizado_negativo' });
      }

      try {
        const snap = await AGENDAMENTOS_COL()
          .where('status', '==', 'pendente')
          .get();
        const batch = db.batch();
        snap.forEach(doc => {
          const d = doc.data();
          const telefoneAgendamento =
            d.dados?.contato?.telefone ||
            d.dados?.telefone ||
            null;
          const mesmaEmpresa = (d.empresaId || EMPRESA_ID_PDN) === empresaIdAtual();
          if (telefoneAgendamento === alvo && mesmaEmpresa) {
            batch.update(doc.ref, { status: 'cancelado' });
          }
        });
        await batch.commit();
      } catch (err) {
        console.error('Erro ao cancelar agendamentos no stop1:', err.message);
      }

      console.log(`[PAUSA MANUAL] Bot pausado para ${alvo} (comando enviado por ${telefone})`);
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

    // Se o número está pausado, só reage ao gatilho "quero meu presente"
    const ehGatilhoInicialParaPausa = texto && texto.toLowerCase().includes('quero meu presente');
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
    const ehGatilhoInicial = texto && texto.toLowerCase().includes('quero meu presente');

    // Um mesmo número pode ter sido cliente/recomendador antes e agora estar
    // recebendo o roteiro como RECOMENDADO. Se a sessão de cliente já está
    // finalizada (ou não existe) e existe uma sessão de recomendado ATIVA,
    // a mensagem pertence ao fluxo de recomendado — não ao de cliente.
    const sessaoRecomendado = clienteAtivo ? null : await getSessaoRecomendado(telefone);
    const recomendadoAtivo = sessaoRecomendado
      && sessaoRecomendado.etapa
      && !['finalizado', 'finalizado_negativo', 'finalizado_atendente'].includes(sessaoRecomendado.etapa);

    if (ehGatilhoInicial) {
      await resetSessao(telefone);
      await iniciarConversa(telefone);
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

  const contexto = {
    empresa,
    empresaId: (empresa && empresa.id) || empresaId || EMPRESA_ID_PDN,
    zapi: zapiDaEmpresa(empresa)
  };

  return tenantContext.run(contexto, () => tratarWebhook(req, res));
}

app.post('/webhook', (req, res) => comWebhook(req, res, null));
app.post('/webhook/:empresaId', (req, res) => comWebhook(req, res, req.params.empresaId));

// ============================================================
// ROTAS DE ADMINISTRAÇÃO
// ============================================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'landing.html'));
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

app.post('/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) {
      return res.status(400).json({ ok: false, erro: 'Informe email e senha' });
    }

    const snap = await EMPRESAS_COL().where('email', '==', email).limit(1).get();
    if (snap.empty) {
      return res.status(401).json({ ok: false, erro: 'Email ou senha incorretos' });
    }

    const doc = snap.docs[0];
    const empresaLogin = { id: doc.id, ...doc.data() };

    const senhaValida = await bcrypt.compare(senha, empresaLogin.senhaHash);
    if (!senhaValida) {
      return res.status(401).json({ ok: false, erro: 'Email ou senha incorretos' });
    }

    const token = jwt.sign({ empresaLoginId: empresaLogin.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ ok: true, token, empresa: { id: empresaLogin.id, nome: empresaLogin.nome, email: empresaLogin.email, senhaProvisoria: !!empresaLogin.senhaProvisoria } });
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
    await EMPRESAS_COL().doc(req.empresaLogin.id).set(
      { senhaHash, senhaProvisoria: false },
      { merge: true }
    );
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
    const doc = await EMPRESAS_COL().doc(payload.empresaLoginId).get();
    if (!doc.exists) {
      return res.status(401).json({ ok: false, erro: 'Empresa não encontrada' });
    }

    req.empresaLogin = { id: doc.id, ...doc.data() };
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, erro: 'Sessão inválida ou expirada' });
  }
}

app.get('/minha-config', exigirLoginEmpresa, async (req, res) => {
  try {
    // Mescla com os padrões pra o painel mostrar todos os textos preenchidos
    // (campos não personalizados vêm com o texto padrão, pronto pra editar).
    const configuracao = { ...EMPRESA_PADRAO, ...(req.empresaLogin.configuracao || { nome: req.empresaLogin.nome }) };
    res.json({ ok: true, empresa: configuracao });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post('/minha-config', exigirLoginEmpresa, async (req, res) => {
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
// WHATSAPP DA EMPRESA — credenciais Z-API próprias do cliente
// ============================================================
// O cliente cria a instância dele na Z-API, conecta o WhatsApp via QR code
// e cola aqui o Instance ID, o Token e o Client-Token. A URL de webhook
// (única por empresa) é mostrada pra ele configurar na Z-API.

function urlBase(req) {
  return process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

app.get('/minha-whatsapp', exigirLoginEmpresa, async (req, res) => {
  try {
    const e = req.empresaLogin;
    const conectado = !!(e.zapiInstanceId && e.zapiToken);
    res.json({
      ok: true,
      conectado,
      // Nunca devolvemos o token cheio — só uma confirmação de que existe.
      zapiInstanceId: e.zapiInstanceId || '',
      temToken: !!e.zapiToken,
      temClientToken: !!e.zapiClientToken,
      webhookUrl: `${urlBase(req)}/webhook/${e.id}`
    });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post('/minha-whatsapp', exigirLoginEmpresa, async (req, res) => {
  try {
    const { zapiInstanceId, zapiToken, zapiClientToken } = req.body;
    if (!zapiInstanceId || !zapiToken) {
      return res.status(400).json({ ok: false, erro: 'Informe ao menos o Instance ID e o Token da Z-API' });
    }

    await EMPRESAS_COL().doc(req.empresaLogin.id).set({
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

// Modelo "você dona a Z-API": o admin provisiona a instância da empresa e o
// cliente só ESCANEIA o QR no painel. Estes endpoints falam com a Z-API usando
// as credenciais da própria empresa (sem fallback pro número global).
function zapiCfgDaEmpresaLogin(e) {
  if (!e || !e.zapiInstanceId || !e.zapiToken) return null;
  return { instanceId: e.zapiInstanceId, token: e.zapiToken, clientToken: e.zapiClientToken || '' };
}

app.get('/minha-whatsapp/status', exigirLoginEmpresa, async (req, res) => {
  const cfg = zapiCfgDaEmpresaLogin(req.empresaLogin);
  if (!cfg) return res.json({ ok: true, provisionado: false, conectado: false });
  try {
    const resp = await axios.get(`${zapiBaseUrl(cfg)}/status`, { headers: zapiHeaders(cfg) });
    const data = resp.data || {};
    const conectado = !!(data.connected || data.smartphoneConnected);
    res.json({ ok: true, provisionado: true, conectado });
  } catch (err) {
    res.json({ ok: true, provisionado: true, conectado: false, erro: err.response?.data?.error || err.message });
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

app.post('/minha-config/faixa', exigirLoginEmpresa, async (req, res) => {
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

// ============================================================
// ROTA DE CRIAÇÃO DE EMPRESA (admin)
// ============================================================

app.post('/admin/empresas', async (req, res) => {
  try {
    const chaveAdmin = req.headers['x-admin-key'];
    if (!chaveAdmin || chaveAdmin !== ADMIN_SECRET) {
      return res.status(401).json({ ok: false, erro: 'Chave administrativa inválida' });
    }

    const {
      // dados da empresa
      razaoSocial, nomeFantasia, cnpj, enderecoEmpresa, emailEmpresa, telefoneEmpresa,
      // dados do sócio
      nomeSocio, cpfSocio, emailSocio, enderecoSocio, whatsappSocio,
      // instância Z-API provisionada para o cliente (opcional)
      zapiInstanceId, zapiToken, zapiClientToken,
      // acesso / compatibilidade com a versão antiga
      nome, email, senha, migrarConfigPrincipal, empresaTeste
    } = req.body;

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

    if (empresaTeste) {
      // Empresa de teste: faixa 1 com quantidade = 1 e tempo de espera = 1 min
      // para validar todo o fluxo rapidamente sem precisar mandar 5 contatos
      configuracaoInicial = { ...EMPRESA_TESTE_CONFIG, nome: nomeEmpresa };
    } else if (migrarConfigPrincipal) {
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
      configuracao: configuracaoInicial
    });

    res.json({ ok: true, empresa: { id: ref.id, nome: nomeEmpresa, email: emailLogin, empresaTeste: !!empresaTeste } });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ============================================================
// PAINEL DO DONO — área administrativa (protegida por X-Admin-Key)
// ============================================================
function exigirAdmin(req, res, next) {
  const chave = req.headers['x-admin-key'];
  if (!chave || chave !== ADMIN_SECRET) {
    return res.status(401).json({ ok: false, erro: 'Chave administrativa inválida' });
  }
  next();
}

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

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

// Reseta a senha do cliente para uma provisória (padrão 123mudar) e reativa a
// troca obrigatória no próximo acesso.
app.post('/admin/empresas/:id/resetar-senha', exigirAdmin, async (req, res) => {
  try {
    const doc = await EMPRESAS_COL().doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ ok: false, erro: 'Empresa não encontrada' });
    const novaSenha = (req.body && req.body.senha) || '123mudar';
    const senhaHash = await bcrypt.hash(novaSenha, 10);
    await EMPRESAS_COL().doc(req.params.id).set({ senhaHash, senhaProvisoria: true }, { merge: true });
    res.json({ ok: true, senha: novaSenha });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
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
    ['plano', 'statusPagamento', 'valorMensal', 'observacoes', 'zapiInstanceId', 'zapiToken', 'zapiClientToken'].forEach(k => {
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

app.post('/upload-arquivo', exigirLoginEmpresa, uploadMiddleware.single('arquivo'), async (req, res) => {
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
  iniciarExecutorAgendamentos();
  console.log('Executor de agendamentos iniciado (checagem a cada 1 min)');
});
