// ============================================================
// WhatsApp via Baileys (conexão própria por QR — alternativa grátis ao Z-API)
// ------------------------------------------------------------
// - Uma sessão (socket) por empresa, mantida em memória.
// - Estado de autenticação salvo no FIRESTORE (sobrevive a reinício do Render).
// - Mensagens recebidas são entregues ao server.js via callback `onMessage`,
//   no MESMO formato do webhook Z-API, pra reaproveitar todo o fluxo do bot.
// ============================================================

const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  initAuthCreds,
  BufferJSON,
  proto,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');

let _db = null;
let _onMessage = null;
const sessoes = {}; // empresaId -> { sock, status, qr, qrDataUrl, numero, iniciandoEm }

function init(db, onMessage) {
  _db = db;
  _onMessage = onMessage;
}

// ---- Estado de auth no Firestore ----------------------------------------
async function useFirestoreAuthState(empresaId) {
  const base = _db.collection('wa_sessions').doc(empresaId);
  const keysCol = base.collection('keys');

  let creds;
  const credsDoc = await base.get();
  if (credsDoc.exists && credsDoc.data().creds) {
    creds = JSON.parse(credsDoc.data().creds, BufferJSON.reviver);
  } else {
    creds = initAuthCreds();
  }

  const keys = {
    get: async (type, ids) => {
      const result = {};
      await Promise.all(ids.map(async (id) => {
        const d = await keysCol.doc(`${type}--${id}`).get();
        if (d.exists && d.data().v != null) {
          let val = JSON.parse(d.data().v, BufferJSON.reviver);
          if (type === 'app-state-sync-key' && val) {
            val = proto.Message.AppStateSyncKeyData.fromObject(val);
          }
          result[id] = val;
        }
      }));
      return result;
    },
    set: async (data) => {
      const batch = _db.batch();
      let n = 0;
      for (const type in data) {
        for (const id in data[type]) {
          const value = data[type][id];
          const ref = keysCol.doc(`${type}--${id}`);
          if (value) batch.set(ref, { v: JSON.stringify(value, BufferJSON.replacer) });
          else batch.delete(ref);
          n++;
          // Firestore: máx 500 ops por batch
          if (n % 450 === 0) { await batch.commit(); }
        }
      }
      await batch.commit();
    }
  };

  const saveCreds = async () => {
    await base.set({ creds: JSON.stringify(creds, BufferJSON.replacer), atualizadoEm: new Date().toISOString() }, { merge: true });
  };

  return { state: { creds, keys }, saveCreds };
}

// Apaga toda a sessão salva (usado no logout/reset).
async function limparSessaoFirestore(empresaId) {
  const base = _db.collection('wa_sessions').doc(empresaId);
  try {
    const keysSnap = await base.collection('keys').get();
    const batch = _db.batch();
    keysSnap.forEach(d => batch.delete(d.ref));
    batch.delete(base);
    await batch.commit();
  } catch (e) { console.error('[BAILEYS] erro ao limpar sessão:', e.message); }
}

// ---- Conexão -------------------------------------------------------------
async function iniciarSessao(empresaId) {
  if (sessoes[empresaId] && sessoes[empresaId].sock) return sessoes[empresaId];

  const sessao = sessoes[empresaId] = { sock: null, status: 'conectando', qr: null, qrDataUrl: null, numero: null, iniciandoEm: Date.now(), jids: {} };

  const { state, saveCreds } = await useFirestoreAuthState(empresaId);
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch (e) {}

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['RecomendaLeads', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false
  });
  sessao.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      sessao.qr = qr;
      sessao.status = 'qr';
      try { sessao.qrDataUrl = await QRCode.toDataURL(qr); } catch (e) {}
    }
    if (connection === 'open') {
      sessao.status = 'conectado';
      sessao.qr = null; sessao.qrDataUrl = null;
      sessao.numero = (sock.user && sock.user.id || '').split(':')[0].replace(/\D/g, '') || null;
      console.log(`[BAILEYS] empresa ${empresaId} conectada (${sessao.numero || '?'})`);
    }
    if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
      console.log(`[BAILEYS] empresa ${empresaId} desconectou (code ${code})`);
      delete sessoes[empresaId];
      if (code === DisconnectReason.loggedOut) {
        // Número desvinculou — limpa pra permitir novo QR.
        await limparSessaoFirestore(empresaId);
      } else {
        // Queda transitória — reconecta sozinho.
        setTimeout(() => { iniciarSessao(empresaId).catch(e => console.error('[BAILEYS] reconexão falhou:', e.message)); }, 4000);
      }
    }
  });

  sock.ev.on('messages.upsert', async (ev) => {
    try {
      if (ev.type !== 'notify') return;
      for (const msg of ev.messages) {
        if (!msg.message || (msg.key && msg.key.fromMe)) continue;
        const jid = (msg.key && msg.key.remoteJid) || '';
        if (jid.endsWith('@g.us') || jid.endsWith('@broadcast')) continue; // grupo/status
        const phone = jid.replace(/@s\.whatsapp\.net$/, '').replace(/\D/g, '');
        if (!phone) continue;
        // Guarda o JID EXATO de origem (pode ser @lid) para responder no mesmo endereço.
        sessao.jids[phone] = jid;
        const m = msg.message;
        const texto = m.conversation
          || (m.extendedTextMessage && m.extendedTextMessage.text)
          || (m.imageMessage && m.imageMessage.caption)
          || (m.buttonsResponseMessage && m.buttonsResponseMessage.selectedDisplayText)
          || (m.listResponseMessage && m.listResponseMessage.title)
          || '';
        // contatos (vCard) compartilhados
        let contactArray = null;
        if (m.contactMessage) {
          contactArray = [{ vcard: m.contactMessage.vcard, displayName: m.contactMessage.displayName }];
        } else if (m.contactsArrayMessage && Array.isArray(m.contactsArrayMessage.contacts)) {
          contactArray = m.contactsArrayMessage.contacts.map(c => ({ vcard: c.vcard, displayName: c.displayName }));
        }
        const body = {
          phone,
          messageId: msg.key.id,
          fromMe: false,
          isGroup: false,
          text: texto ? { message: texto } : undefined,
          ...(contactArray ? { contactArray } : {})
        };
        if (_onMessage) { _onMessage(empresaId, body).catch(e => console.error('[BAILEYS] onMessage erro:', e.message)); }
      }
    } catch (e) { console.error('[BAILEYS] messages.upsert erro:', e.message); }
  });

  return sessao;
}

function getStatus(empresaId) {
  const s = sessoes[empresaId];
  if (!s) return { status: 'desconectado', numero: null };
  return { status: s.status, numero: s.numero, qrDataUrl: s.status === 'qr' ? s.qrDataUrl : null };
}

function conectado(empresaId) {
  const s = sessoes[empresaId];
  return !!(s && s.status === 'conectado' && s.sock);
}

async function desconectar(empresaId) {
  const s = sessoes[empresaId];
  if (s && s.sock) { try { await s.sock.logout(); } catch (e) {} }
  delete sessoes[empresaId];
  await limparSessaoFirestore(empresaId);
}

// ---- Envio ---------------------------------------------------------------
function jidDe(phone) {
  return String(phone).replace(/\D/g, '') + '@s.whatsapp.net';
}

// Descobre o JID certo para enviar:
// 1) se já recebemos mensagem desse número, responde no MESMO jid (resolve @lid);
// 2) senão, valida no WhatsApp via onWhatsApp (resolve o "9" dos números do Brasil);
// 3) por último, monta número@s.whatsapp.net.
async function resolverJid(s, phone) {
  const num = String(phone).replace(/\D/g, '');
  if (s.jids && s.jids[num]) return s.jids[num];
  try {
    const res = await s.sock.onWhatsApp(num);
    if (res && res[0] && res[0].exists && res[0].jid) return res[0].jid;
  } catch (e) { console.error('[BAILEYS] onWhatsApp falhou:', e.message); }
  return num + '@s.whatsapp.net';
}

async function enviarTexto(empresaId, phone, message) {
  const s = sessoes[empresaId];
  if (!s || !s.sock || s.status !== 'conectado') throw new Error('WhatsApp (Baileys) não conectado');
  const jid = await resolverJid(s, phone);
  await s.sock.sendMessage(jid, { text: message });
  console.log(`[BAILEYS] texto enviado p/ ${jid} (origem ${phone})`);
}

async function enviarMidia(empresaId, phone, buffer, mimetype, caption, asDocument, fileName) {
  const s = sessoes[empresaId];
  if (!s || !s.sock || s.status !== 'conectado') throw new Error('WhatsApp (Baileys) não conectado');
  const jid = await resolverJid(s, phone);
  if (asDocument) {
    await s.sock.sendMessage(jid, { document: buffer, mimetype: mimetype || 'application/octet-stream', fileName: fileName || 'arquivo', caption: caption || '' });
  } else {
    await s.sock.sendMessage(jid, { image: buffer, caption: caption || '' });
  }
}

module.exports = { init, iniciarSessao, getStatus, conectado, desconectar, enviarTexto, enviarMidia };
