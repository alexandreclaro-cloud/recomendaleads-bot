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

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.apps.length ? admin.firestore() : null;

const EMPRESA_DOC = () => db.collection('config').doc('empresa');
const SESSOES_COL = () => db.collection('sessoes');
const LEADS_COL = () => db.collection('leads');
// Sessões do roteiro enviado ao RECOMENDADO (pessoa que recebeu a indicação),
// separada de SESSOES_COL (que é do roteiro de quem RECOMENDA). Usar uma
// coleção própria evita misturar os dois fluxos caso a mesma pessoa apareça
// nos dois papéis em momentos diferentes.
const SESSOES_RECOMENDADO_COL = () => db.collection('sessoes_recomendado');
// Agendamentos persistidos: tudo que precisa acontecer no futuro (iniciar
// conversa com o recomendado depois do tempo de espera, disparar cada passo
// da cadência de follow-up) é gravado aqui em vez de usar setTimeout em
// memória. Um executor roda a cada minuto (ver iniciarExecutorAgendamentos)
// e processa qualquer agendamento cujo executarEm já tenha passado. Isso
// sobrevive a reinícios do servidor (deploys, hibernação, etc.) — algo que
// setTimeout não sobrevive, já que vive só na memória do processo.
const AGENDAMENTOS_COL = () => db.collection('agendamentos');
// Coleção nova, isolada — usada só pelo sistema de login. Não afeta o EMPRESA_DOC
// único que o bot/CRM/configurações continuam usando normalmente nesta etapa.
const EMPRESAS_COL = () => db.collection('empresas_login');

// Palavras que, quando presentes na resposta do recomendado, são interpretadas
// como confirmação para seguir a conversa (etapa "aguardando_confirmacao").
// Lista fixa por enquanto — editar aqui diretamente se precisar ajustar.
const PALAVRAS_POSITIVAS = [
  'sim', 'pode', 'claro', 'ok', 'okay', 'manda', 'pode falar', 'pode sim',
  'com certeza', 'isso', 'aham', 'uhum', 'beleza', 'blz', 'vai', 'fala',
  'diga', 'segue', 'continua', 'quero', 'demorou'
];

function respostaEhPositiva(texto) {
  if (!texto) return false;
  const normalizado = texto.toLowerCase().trim();
  return PALAVRAS_POSITIVAS.some(palavra => normalizado.includes(palavra));
}

const JWT_SECRET = process.env.JWT_SECRET || 'recomendaleads-segredo-trocar-em-producao';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'troque-esta-chave';

// ID do documento da PDN Vendas em empresas_login (confirmado no Firestore).
// Usado para já vincular todo lead novo criado pelo bot a esta empresa, já que
// hoje existe apenas 1 número de WhatsApp ativo (o da PDN). Quando houver mais
// de um número/empresa, este valor fixo deve ser substituído por uma lógica
// dinâmica (ex: mapear pelo número de WhatsApp que recebeu a mensagem).
const EMPRESA_ID_PDN = 'MFMcfVJfqv35dA9MotLK';

// ============================================================
// SEED — configuração padrão da empresa
// ============================================================
const EMPRESA_PADRAO = {
  nome: 'Empresa Demo',
  mensagemAgradecimento: 'Olá! Muito obrigado por ser nosso cliente e confiar no nosso trabalho. 🙏',
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
  ctaRecomendado: 'Gostaria de vir retirar?',
  // Mensagem inicial enviada ao recomendado, antes de falar do prêmio — pede
  // confirmação para seguir a conversa. Suporta variáveis entre chaves.
  mensagemInicialRecomendado: 'Oi {nomeRecomendado}, aqui é {vendedor} da {empresa} e seu amigo {recomendador} me recomendou você... Posso falar?',
  // Mensagem repetida enquanto a resposta do recomendado não bate com
  // nenhuma palavra positiva (ver PALAVRAS_POSITIVAS mais abaixo).
  mensagemAguardandoConfirmacao: 'Posso te contar mais sobre isso?',
  // Cadência de follow-up: mensagens extras enviadas em sequência se o
  // recomendado não responder. Cada item espera X minutos desde a última
  // mensagem enviada antes de disparar o texto seguinte.
  cadenciaFollowupRecomendado: [
    { esperaMin: 1440, texto: 'Oi, só passando pra saber se você viu minha mensagem 🙂' },
    { esperaMin: 4320, texto: 'Seu presente ainda está disponível! Posso te contar mais?' }
  ],
  tempoEsperaConversaoMin: 60,
  tempoFollowupMin: 30,
  // Etapas do CRM Kanban — totalmente editáveis pelo cliente em /configurar-vouchers.
  // Cada lead nasce na primeira etapa desta lista (índice 0).
  etapasKanban: [
    { id: 'recebeu_mensagem', nome: 'Recebeu Mensagem' },
    { id: 'aceitou_mensagem', nome: 'Aceitou Mensagem' },
    { id: 'agendou', nome: 'Agendou' },
    { id: 'comprou', nome: 'Comprou' },
    { id: 'nao_respondeu', nome: 'Não respondeu' },
    { id: 'nao_tem_interesse', nome: 'Não tem interesse' }
  ]
};

async function getEmpresa() {
  const snap = await EMPRESA_DOC().get();
  if (!snap.exists) {
    await EMPRESA_DOC().set(EMPRESA_PADRAO);
    return { ...EMPRESA_PADRAO };
  }
  return snap.data();
}

async function saveEmpresa(empresa) {
  await EMPRESA_DOC().set(empresa, { merge: true });
}

async function getSessao(telefone) {
  const snap = await SESSOES_COL().doc(telefone).get();
  if (!snap.exists) {
    const novaSessao = {
      etapa: 'aguardando_nome',
      clienteNome: null,
      vendedorNome: null,
      contatos: [],
      criadoEm: new Date().toISOString()
    };
    await SESSOES_COL().doc(telefone).set(novaSessao);
    return novaSessao;
  }
  return snap.data();
}

async function saveSessao(telefone, sessao) {
  await SESSOES_COL().doc(telefone).set(sessao, { merge: true });
}

async function resetSessao(telefone) {
  await SESSOES_COL().doc(telefone).delete();
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
// Cada documento representa UM contato recomendado por um cliente.
// As etapas (colunas) são definidas pelo cliente em empresa.etapasKanban.
// O lead sempre nasce na primeira etapa dessa lista.
//
// Campo novo: empresaId — identifica a qual empresa (doc de empresas_login)
// este lead pertence. Leads antigos (criados antes desta etapa) não têm esse
// campo e continuam acessíveis apenas pelas rotas antigas /leads, sem login.

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

// Mesma lógica de getTodosLeads, mas filtrando só os leads da empresa logada.
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

  // Se a etapa mudou, registra no histórico
  if (dados.etapa && dados.etapa !== atual.etapa) {
    atualizado.historico = [...(atual.historico || []), { etapa: dados.etapa, em: new Date().toISOString() }];
  }

  await ref.set(atualizado, { merge: true });
  return { id, ...atualizado };
}

// ============================================================
// HELPERS DE ENVIO — Z-API
// ============================================================

async function sendText(phone, message) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (ZAPI_CLIENT_TOKEN && ZAPI_CLIENT_TOKEN !== 'COLOQUE_SEU_CLIENT_TOKEN_AQUI') {
      headers['Client-Token'] = ZAPI_CLIENT_TOKEN;
    }
    await axios.post(`${ZAPI_BASE_URL}/send-text`, { phone, message }, { headers });
    console.log(`[ENVIADO] para ${phone}: ${message.slice(0, 60)}...`);
  } catch (err) {
    console.error('Erro ao enviar texto:', err.response?.data || err.message);
  }
}

async function sendImage(phone, imageUrl, caption) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (ZAPI_CLIENT_TOKEN && ZAPI_CLIENT_TOKEN !== 'COLOQUE_SEU_CLIENT_TOKEN_AQUI') {
      headers['Client-Token'] = ZAPI_CLIENT_TOKEN;
    }
    await axios.post(`${ZAPI_BASE_URL}/send-image`, {
      phone, image: imageUrl, caption: caption || ''
    }, { headers });
    console.log(`[IMAGEM ENVIADA] para ${phone}`);
  } catch (err) {
    console.error('Erro ao enviar imagem:', err.response?.data || err.message);
  }
}

async function sendDocument(phone, base64OrUrl, fileName, extension) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (ZAPI_CLIENT_TOKEN && ZAPI_CLIENT_TOKEN !== 'COLOQUE_SEU_CLIENT_TOKEN_AQUI') {
      headers['Client-Token'] = ZAPI_CLIENT_TOKEN;
    }
    await axios.post(`${ZAPI_BASE_URL}/send-document/${extension}`, {
      phone, document: base64OrUrl, fileName
    }, { headers });
    console.log(`[DOCUMENTO ENVIADO] para ${phone}: ${fileName}`);
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
// LÓGICA PRINCIPAL DO ROTEIRO DE NEUROVENDAS
// ============================================================

async function iniciarConversa(telefone) {
  const empresa = await getEmpresa();
  await getSessao(telefone);
  await sendText(telefone, empresa.mensagemAgradecimento);
  await sendText(telefone, 'Pra começar, qual é o seu nome?');
}

async function processarMensagem(telefone, texto, vCard, contatosMultiplos) {
  const empresa = await getEmpresa();
  const sessao = await getSessao(telefone);

  // ETAPA 1: aguardando nome do cliente
  if (sessao.etapa === 'aguardando_nome') {
    sessao.clienteNome = (texto || '').trim();
    sessao.etapa = 'aguardando_vendedor';
    await saveSessao(telefone, sessao);

    const listaVendedores = empresa.vendedores.map((v, i) => `${i + 1}️⃣ ${v}`).join('\n');
    await sendText(telefone, `Prazer, ${sessao.clienteNome.split(' ')[0]}! E me diz, quem te atendeu hoje?\n\n${listaVendedores}\n\nResponda com o número ou o nome.`);
    return;
  }

  // ETAPA 2: aguardando escolha do vendedor
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
    await saveSessao(telefone, sessao);

    const primeiraFaixa = empresa.faixasBonus[0];
    await sendText(telefone, `Show! Agora me envie o contato dos seus amigos para você receber ${primeiraFaixa.premio.toLowerCase()}.`);
    await sendText(telefone, `Me envie ${primeiraFaixa.quantidade} recomendações e já garanta seu presente.\n\nVocê pode mandar o contato direto da sua agenda (toque em 📎 → Contato) ou digitar nome e telefone. Então, qual é a primeira pessoa que vem na sua mente? Lembrando que ela também vai ganhar um presente nosso 🎁`);
    return;
  }

  // ETAPA 3: coletando contatos recomendados
  if (sessao.etapa === 'coletando_contatos') {
    let novosContatos = [];

    if (contatosMultiplos && contatosMultiplos.length > 0) {
      novosContatos = contatosMultiplos.filter(c => c && c.nome);
    } else if (vCard) {
      const c = parseVCard(vCard);
      if (c && c.nome) novosContatos = [c];
    } else if (texto) {
      // Só aceita texto livre como contato se contiver um padrão de telefone BR plausível,
      // e rejeita textos longos ou que pareçam URLs/códigos Pix (evita falsos positivos)
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
      sessao.contatos = [...(sessao.contatos || []), ...novosContatos];
      await saveSessao(telefone, sessao);

      const metaAtual = empresa.faixasBonus.find(f => f.quantidade >= sessao.contatos.length) || empresa.faixasBonus[empresa.faixasBonus.length - 1];
      const faltam = metaAtual.quantidade - sessao.contatos.length;

      if (faltam > 0) {
        const nomesAdicionados = novosContatos.map(c => c.nome).join(', ');
        await sendText(telefone, `Anotado, ${nomesAdicionados}! ✅ Faltam ${faltam} recomendações para você garantir "${metaAtual.premio}". Quem mais vem na sua mente?`);
      } else {
        await finalizarFaixa(telefone, sessao, metaAtual, empresa);
      }
    } else {
      await sendText(telefone, 'Não consegui identificar um contato aí. Pode mandar o contato direto da sua agenda (toque em 📎 → Contato), ou digitar no formato "Nome - telefone com DDD"?');
    }
    return;
  }

  // ETAPA 4: já finalizado — ignora mensagens soltas (ex: "Ok", "obrigado").
  // Só reinicia quando a pessoa mandar o gatilho "quero meu presente" de novo,
  // o que já é tratado separadamente no webhook antes de chegar aqui.
  if (sessao.etapa === 'finalizado') {
    return;
  }
}

async function finalizarFaixa(telefone, sessao, faixa, empresa) {
  await sendText(telefone, `🎉 Perfeito! Você completou ${sessao.contatos.length} recomendações.`);
  await sendText(telefone, `Seu presente: ${faixa.premio}`);

  if (faixa.texto) {
    await sendText(telefone, faixa.texto);
  }

  if (faixa.arquivo) {
    const linkDownload = converterLinkDrive(faixa.arquivo);
    const extensao = (faixa.arquivo.match(/\.(\w+)(\?|$)/) || [])[1] || 'pdf';
    const ehImagem = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(extensao.toLowerCase());

    if (ehImagem) {
      await sendImage(telefone, linkDownload, faixa.premio);
    } else {
      await sendDocument(telefone, linkDownload, `Voucher - ${faixa.premio}`, extensao);
    }
  }

  if (faixa.link) {
    await sendText(telefone, faixa.link);
  }

  await sendText(telefone, `Só uma coisa importante: avise seus amigos que vamos entrar em contato com eles em breve, combinado? Assim eles já esperam nossa mensagem 😉`);

  sessao.etapa = 'finalizado';
  sessao.faixaFinal = faixa;
  await saveSessao(telefone, sessao);

  // Alimenta o CRM Kanban: cada contato recomendado entra como um novo lead.
  // empresaId fixo na PDN por enquanto — único número de WhatsApp ativo hoje.
  for (const contato of sessao.contatos) {
    try {
      await criarLead({
        nomeRecomendado: contato.nome,
        telefoneRecomendado: contato.telefone,
        nomeRecomendador: sessao.clienteNome,
        telefoneRecomendador: telefone,
        vendedor: sessao.vendedorNome,
        empresaId: EMPRESA_ID_PDN
      });
    } catch (err) {
      console.error('Erro ao criar lead no CRM:', err.message);
    }
  }

  // Agenda o início da conversa com cada recomendado. Em vez de setTimeout
  // (perdido se o servidor reiniciar), grava no Firestore um agendamento
  // com a data/hora exata de execução — o executor (ver mais abaixo) confere
  // isso a cada minuto e dispara quando chegar a hora, mesmo que o servidor
  // tenha sido reiniciado nesse meio tempo.
  const executarEm = new Date(Date.now() + empresa.tempoEsperaConversaoMin * 60 * 1000).toISOString();
  for (const contato of sessao.contatos) {
    try {
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

  console.log(`[SESSÃO FINALIZADA] ${sessao.clienteNome} via ${sessao.vendedorNome} — ${sessao.contatos.length} contatos`);
}

// ============================================================
// ROTEIRO DO RECOMENDADO — etapas com confirmação e cadência
// ============================================================
// Substitui o antigo envio único de "contatarRecomendado". Agora a conversa
// com o recomendado tem 3 etapas, cada uma esperando uma resposta da pessoa
// antes de avançar:
//   1) mensagem inicial → espera confirmação (palavra positiva)
//   2) prêmio + arquivo + link → espera qualquer reação
//   3) CTA (agendamento, convite à loja, etc.)
// Se a pessoa não responder, a cadência de follow-up configurada dispara em
// sequência até a pessoa responder ou a lista acabar.

function substituirVariaveis(template, variaveis) {
  if (!template) return '';
  return template.replace(/\{(\w+)\}/g, (match, chave) => variaveis[chave] ?? match);
}

async function getSessaoRecomendado(telefone) {
  const snap = await SESSOES_RECOMENDADO_COL().doc(telefone).get();
  return snap.exists ? snap.data() : null;
}

async function saveSessaoRecomendado(telefone, sessao) {
  await SESSOES_RECOMENDADO_COL().doc(telefone).set(sessao, { merge: true });
}

async function encerrarSessaoRecomendado(telefone) {
  await SESSOES_RECOMENDADO_COL().doc(telefone).delete();
}

// ============================================================
// AGENDAMENTOS PERSISTIDOS — substituem setTimeout em memória
// ============================================================
// Cada documento representa uma ação futura. Campos:
//   tipo: 'iniciar_conversa_recomendado' | 'followup_recomendado'
//   executarEm: ISO string da data/hora em que deve rodar
//   status: 'pendente' | 'concluido' | 'cancelado'
//   dados: payload específico do tipo de agendamento
//   marcaTempoReferencia: timestamp da sessão no momento em que o
//     agendamento foi criado — usado para invalidar agendamentos antigos
//     se a pessoa responder antes (igual o setTimeout antigo fazia com
//     ultimaMensagemEm, só que agora persistido).

async function criarAgendamento({ tipo, executarEm, dados, marcaTempoReferencia }) {
  await AGENDAMENTOS_COL().add({
    tipo,
    executarEm,
    status: 'pendente',
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

// Agenda o próximo passo de follow-up (índice da cadência) se a pessoa não
// responder antes do tempo configurado. O agendamento carrega a marca de
// tempo da sessão no momento da criação — se a pessoa responder antes
// (mudando ultimaMensagemEm), o executor confere isso e ignora o agendamento
// vencido, exatamente como o setTimeout antigo fazia, só que sobrevivendo a
// reinícios do servidor.
async function agendarProximoFollowup(telefone, empresa, marcaTempo, indiceFollowup) {
  const cadencia = empresa.cadenciaFollowupRecomendado || [];
  const proximo = cadencia[indiceFollowup];
  if (!proximo) return; // cadência esgotada, não agenda mais nada

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

  const variaveis = {
    nomeRecomendado: contato.nome.split(' ')[0],
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
  await sendText(telefone, `Por ter sido recomendado pelo seu amigo, você ganhou ${empresa.premioRecomendado}.`);
  await sendText(telefone, `E já estou te enviando agora mesmo seu presente 🎁`);

  if (empresa.arquivoRecomendado) {
    const linkDownload = converterLinkDrive(empresa.arquivoRecomendado);
    const extensao = (empresa.arquivoRecomendado.match(/\.(\w+)(\?|$)/) || [])[1] || 'pdf';
    const ehImagem = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(extensao.toLowerCase());

    if (ehImagem) {
      await sendImage(telefone, linkDownload, empresa.premioRecomendado || '');
    } else {
      await sendDocument(telefone, linkDownload, `Voucher - ${empresa.premioRecomendado || 'presente'}`, extensao);
    }
  }

  if (empresa.linkRecomendado) {
    await sendText(telefone, empresa.linkRecomendado);
  }

  const marcaTempo = new Date().toISOString();
  await saveSessaoRecomendado(telefone, { etapa: 'aguardando_reacao', ultimaMensagemEm: marcaTempo });
  await agendarProximoFollowup(telefone, empresa, marcaTempo, 0);
}

async function enviarCtaRecomendado(telefone, sessao, empresa) {
  await sendText(telefone, empresa.ctaRecomendado);
  await saveSessaoRecomendado(telefone, { etapa: 'finalizado' });
  console.log(`[ROTEIRO RECOMENDADO FINALIZADO] ${sessao.nomeRecomendado} (${telefone})`);
}

async function processarMensagemRecomendado(telefone, texto, empresa) {
  const sessao = await getSessaoRecomendado(telefone);
  if (!sessao) return false; // não é uma conversa de recomendado em andamento

  if (sessao.etapa === 'aguardando_confirmacao') {
    if (respostaEhPositiva(texto)) {
      await enviarPremioRecomendado(telefone, sessao, empresa);
    } else {
      await sendText(telefone, empresa.mensagemAguardandoConfirmacao);
      const marcaTempo = new Date().toISOString();
      await saveSessaoRecomendado(telefone, { ultimaMensagemEm: marcaTempo });
      await agendarProximoFollowup(telefone, empresa, marcaTempo, 0);
    }
    return true;
  }

  if (sessao.etapa === 'aguardando_reacao') {
    await enviarCtaRecomendado(telefone, sessao, empresa);
    return true;
  }

  // etapa 'finalizado' — não há mais nada a processar, ignora mensagens soltas
  return true;
}

// ============================================================
// WEBHOOK — recebe mensagens da Z-API
// ============================================================

app.post('/webhook', async (req, res) => {
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

    const sessaoExistenteSnap = await SESSOES_COL().doc(telefone).get();
    const sessaoExiste = sessaoExistenteSnap.exists;
    const ehGatilhoInicial = texto && texto.toLowerCase().includes('quero meu presente');

    if (ehGatilhoInicial) {
      // Gatilho explícito sempre tem prioridade e sempre é tratado como
      // fluxo de quem recomenda, mesmo que essa pessoa tenha uma conversa
      // de recomendado em andamento no mesmo número.
      await resetSessao(telefone);
      await iniciarConversa(telefone);
    } else if (sessaoExiste) {
      await processarMensagem(telefone, texto, vCard, contatosMultiplos);
    } else {
      // Não é fluxo de quem recomenda — verifica se é uma resposta de
      // alguém que está no roteiro de recomendado (etapas com confirmação).
      const empresa = await getEmpresa();
      await processarMensagemRecomendado(telefone, texto, empresa);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Erro no webhook:', err);
    res.sendStatus(500);
  }
});

// ============================================================
// ROTAS DE ADMINISTRAÇÃO
// ============================================================

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <title>RecomendaLeads</title>
      <style>
        body { font-family: -apple-system, sans-serif; background: #0a1628; color: #e8edf4; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
        .box { text-align: center; }
        h1 { color: #f0d878; margin-bottom: 6px; }
        p { color: #9aabc0; margin-bottom: 28px; }
        a { display: inline-block; margin: 6px; padding: 12px 22px; background: #d4af37; color: #0a1628; font-weight: 700; border-radius: 8px; text-decoration: none; }
        a:hover { opacity: 0.9; }
      </style>
    </head>
    <body>
      <div class="box">
        <h1>✅ RecomendaLeads Bot</h1>
        <p>Servidor rodando — escolha um painel:</p>
        <a href="/crm">📋 CRM Kanban</a>
        <a href="/configurar-vouchers">⚙️ Configurações</a>
        <a href="/login">🔑 Login da Empresa</a>
      </div>
    </body>
    </html>
  `);
});

app.get('/configurar-vouchers', (req, res) => {
  res.sendFile(path.join(__dirname, 'configurar-vouchers.html'));
});

// Rota nova e separada — página de configuração protegida por login.
// Usa as rotas /minha-config (não as antigas /config), e exige login no navegador.
app.get('/minha-empresa/configurar', (req, res) => {
  res.sendFile(path.join(__dirname, 'minha-empresa-configurar.html'));
});

// /crm continua na mesma URL de sempre. A proteção por login agora é feita
// dentro do próprio crm.html (ele verifica o token salvo no navegador e
// redireciona para /login se não houver um válido), então a rota do servidor
// não precisa mudar — ela só continua servindo o arquivo.
app.get('/crm', (req, res) => {
  res.sendFile(path.join(__dirname, 'crm.html'));
});

// ============================================================
// NOVO — sistema de login (etapa 1, sem proteção ainda)
// ============================================================
// Estas rotas são aditivas: nada do bot, CRM ou configurações foi alterado.
// Por enquanto, login e cadastro de empresa só existem para serem testados;
// nenhuma rota passou a exigir autenticação.

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
    res.json({ ok: true, token, empresa: { id: empresaLogin.id, nome: empresaLogin.nome, email: empresaLogin.email } });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.get('/admin/criar-empresa', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-criar-empresa.html'));
});

// ============================================================
// NOVO — proteção por login (etapa 2)
// ============================================================
// Middleware que exige um token JWT válido e anexa a empresa logada em req.empresaLogin.
// Usado apenas pelas rotas novas abaixo — nada das rotas antigas (/config, /leads,
// /crm, etc., usadas pela Empresa Demo) foi alterado ou passou a exigir login.

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

// Lê a configuração da empresa que está logada (não a Empresa Demo antiga).
// Se a empresa ainda não tiver configuração salva (ex: X Mentor, criada antes
// desta etapa), devolve os valores padrão sem quebrar nada.
app.get('/minha-config', exigirLoginEmpresa, async (req, res) => {
  try {
    const configuracao = req.empresaLogin.configuracao || { ...EMPRESA_PADRAO, nome: req.empresaLogin.nome };
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

app.post('/minha-config/faixa', exigirLoginEmpresa, async (req, res) => {
  try {
    const { quantidade, arquivo, link, texto, premio } = req.body;
    const configuracao = req.empresaLogin.configuracao || { ...EMPRESA_PADRAO, nome: req.empresaLogin.nome };

    const faixa = configuracao.faixasBonus.find(f => f.quantidade === quantidade);
    if (!faixa) {
      return res.status(404).json({ ok: false, erro: 'Faixa não encontrada para essa quantidade' });
    }
    if (arquivo !== undefined) faixa.arquivo = arquivo;
    if (link !== undefined) faixa.link = link;
    if (texto !== undefined) faixa.texto = texto;
    if (premio !== undefined) faixa.premio = premio;

    await EMPRESAS_COL().doc(req.empresaLogin.id).set({ configuracao }, { merge: true });
    res.json({ ok: true, faixa });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ============================================================
// NOVO — leads isolados por empresa (etapa 3, protegidos por login)
// ============================================================
// Mesma forma e contrato das rotas antigas /leads, mas:
// 1) exigem login (exigirLoginEmpresa)
// 2) só retornam/alteram leads cujo campo empresaId é o da empresa logada
// As rotas antigas /leads continuam existindo e abertas, sem filtro — usadas
// hoje apenas pela "Empresa Demo" (leads sem empresaId, criados antes desta etapa).

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

    // Confirma que o lead pertence à empresa logada antes de alterar —
    // impede que alguém logado numa empresa altere lead de outra empresa.
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

app.post('/admin/empresas', async (req, res) => {
  try {
    const chaveAdmin = req.headers['x-admin-key'];
    if (!chaveAdmin || chaveAdmin !== ADMIN_SECRET) {
      return res.status(401).json({ ok: false, erro: 'Chave administrativa inválida' });
    }

    const { nome, email, senha, migrarConfigPrincipal } = req.body;
    if (!nome || !email || !senha) {
      return res.status(400).json({ ok: false, erro: 'Informe nome, email e senha' });
    }

    const existenteSnap = await EMPRESAS_COL().where('email', '==', email).limit(1).get();
    if (!existenteSnap.empty) {
      return res.status(409).json({ ok: false, erro: 'Já existe uma empresa cadastrada com este email' });
    }

    // Se migrarConfigPrincipal=true, a conta nasce com os dados REAIS já salvos
    // em config/empresa (mensagem, vendedores, faixas de bônus, etc.), em vez dos
    // valores de exemplo. Usado uma única vez para dar à empresa principal sua
    // própria conta de login sem perder o que já estava configurado.
    let configuracaoInicial = { ...EMPRESA_PADRAO, nome };
    if (migrarConfigPrincipal) {
      const empresaReal = await getEmpresa();
      configuracaoInicial = { ...empresaReal };
    }

    const senhaHash = await bcrypt.hash(senha, 10);
    const ref = await EMPRESAS_COL().add({
      nome,
      email,
      senhaHash,
      criadoEm: new Date().toISOString(),
      // Configuração inicial da empresa — mesma estrutura usada em /configurar-vouchers,
      // agora isolada por empresa em vez de compartilhada (Empresa Demo antiga).
      configuracao: configuracaoInicial
    });

    res.json({ ok: true, empresa: { id: ref.id, nome, email } });
  } catch (err) {
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
// ROTAS DO CRM KANBAN (ANTIGAS — Empresa Demo, sem login, intocadas)
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
// EXECUTOR DE AGENDAMENTOS — roda a cada 1 minuto
// ============================================================
// Substitui setTimeout em memória: busca no Firestore todo agendamento
// vencido (executarEm <= agora, status pendente) e processa de acordo com
// o tipo. Como o estado vive no banco, não no processo, isso sobrevive a
// reinícios do servidor — qualquer agendamento perdido durante o tempo em
// que o servidor estava reiniciando/hibernando é simplesmente processado
// na próxima checagem, em vez de desaparecer.

async function processarAgendamento(agendamento) {
  const empresa = await getEmpresa();

  if (agendamento.tipo === 'iniciar_conversa_recomendado') {
    const { contato, nomeRecomendador, vendedorNome } = agendamento.dados;
    await iniciarConversaRecomendado(contato, nomeRecomendador, vendedorNome, empresa);
    return;
  }

  if (agendamento.tipo === 'followup_recomendado') {
    const { telefone, indiceFollowup } = agendamento.dados;
    const sessaoAtual = await getSessaoRecomendado(telefone);

    // Só dispara o follow-up se a sessão ainda existir e a pessoa não tiver
    // respondido depois que este agendamento foi criado (ou seja, o
    // timestamp de referência ainda bate com o atual da sessão).
    if (!sessaoAtual || sessaoAtual.ultimaMensagemEm !== agendamento.marcaTempoReferencia) {
      return;
    }

    const cadencia = empresa.cadenciaFollowupRecomendado || [];
    const proximo = cadencia[indiceFollowup];
    if (!proximo) return;

    await sendText(telefone, proximo.texto);
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
        // Marca como concluído mesmo se falhar, para não tentar de novo em
        // loop infinito — erros já ficam registrados no log acima.
        await marcarAgendamentoConcluido(agendamento.id);
      }
    }
  } catch (err) {
    console.error('Erro ao buscar agendamentos pendentes:', err.message);
  }
}

function iniciarExecutorAgendamentos() {
  // Roda imediatamente uma vez no boot (cobre agendamentos que venceram
  // enquanto o servidor estava off) e depois a cada 60 segundos.
  executarAgendamentosPendentes();
  setInterval(executarAgendamentosPendentes, 60 * 1000);
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
  console.log('Executor de agendamentos iniciado (checagem a cada 60s)');
});
