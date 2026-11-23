# CLAUDE.md — RecomendaLeads Bot

> Instruções pra qualquer IA (Claude Code ou outra) que for trabalhar neste
> projeto. Escrito pra sobreviver a troca de conta/sessão sem perder contexto.
> **Leia também [`HANDOFF.md`](./HANDOFF.md)** — é o estado da última sessão
> de trabalho (o que ficou pela metade, próximos passos). Este arquivo
> (`CLAUDE.md`) é sobre o projeto em si; `HANDOFF.md` é sobre "onde paramos".
> Para arquitetura e modelo de dados detalhados, **[`PROJETO.md`](./PROJETO.md)
> é a referência completa** — este arquivo aqui é o resumo rápido + regras de
> trabalho com o Alexandre.

## 1. O que é o projeto

RecomendaLeads é um SaaS multi-tenant que automatiza um programa de
indicação/recomendação via WhatsApp: o cliente de uma empresa recomenda
amigos, um bot conversa com os amigos automaticamente, entrega prêmios e
alimenta um CRM (Kanban) pro dono da empresa acompanhar. Dono do produto:
**Alexandre Claro**. Em produção em `recomendaleads.com.br`, hospedado no
Render com deploy automático a cada push em `main`.

## 2. Quem usa isto

- **Alexandre** (dono da plataforma) — único desenvolvedor/responsável
  técnico, não é programador de formação, trabalha via Claude Code.
- **Empresas clientes** (donos de barbearia, dentista, clínica de estética,
  pet shop, restaurante, etc.) — usam `minha-empresa-configurar.html` /
  `crm.html` pra configurar o bot da própria empresa.
- **Vendedores** — parceiros que vendem o produto pra novas empresas, ganham
  comissão (20%, paga manualmente), logam em `admin.html` (`/vendedor`).
- **Alexandre como admin da plataforma** — painel `admin.html` (`/admin`).

## 3. Estrutura (resumo — detalhe completo na seção 3 do PROJETO.md)

- `server.js` — backend inteiro (rotas + lógica do bot + integrações),
  arquivo único e grande (~700 mil caracteres). Sem módulos/pastas.
- `crm.html` — painel principal do CRM (Kanban, configs do bot, Ranking).
- `minha-empresa-configurar.html` — painel mais novo (WhatsApp, Ofertas,
  Equipe, Disparo em massa, Plano). **Existem campos configurados em dois
  lugares** (ver seção 8 do PROJETO.md) — checar os dois antes de criar algo.
- `admin.html` — painel do dono da plataforma E também o painel do
  vendedor (`/vendedor`) — a UI do vendedor deve ser sempre uma **extensão
  visual do painel do dono**, nunca uma versão "simplificada"/diferente.
- `admin-criar-empresa.html`, `login.html`, `cadastro.html`, `assinar.html`,
  `contrato.html`, `vendedor-cadastro.html`, `completar.html` — fluxos de
  autenticação/onboarding.
- `conversas.html` — inbox de atendimento humano.
- `parceiro.html` — landing de captação de vendedores/parceiros.
  **⚠️ Nunca commitar/alterar via automação** — fica sempre fora dos commits
  por instrução permanente do Alexandre (ele edita isso por fora).
- `recomendometro-*.html` — quiz gamificado por nicho (landing de Meta Ads).
- `docs/` — notas de roteiro de mensagens e schema vs. spec de melhorias.
- `PROJETO.md` — documento de continuidade técnico completo (arquitetura,
  modelo de dados, glossário, segurança, decisões). **Leia antes de mudanças
  grandes.**
- `MIGRACAO-API-OFICIAL.md` — guia de migração de empresa Z-API → API
  Oficial da Meta.

## 4. Como rodar, testar e fazer deploy

- **Não existe ambiente local funcional documentado** — não há banco de
  teste nem suíte automatizada. Validação é manual/estática:
  - `node --check server.js` depois de qualquer edição no backend.
  - Para HTML com `<script>` inline grande (`crm.html`,
    `minha-empresa-configurar.html`, `admin.html`): extrair o conteúdo do
    `<script>` com regex pra um arquivo temporário e rodar `node --check`
    nele, e checar balanceamento de `<div>`/`</div>`.
  - Preview estático sem backend real (pasta `funis-estaticos`, se existir,
    via `python -m http.server`) é preferível a rodar o `server.js` de
    verdade — o servidor real tem **cron jobs em background que mandam
    mensagens reais de WhatsApp**, então rodá-lo localmente é arriscado.
- **Deploy**: `git push origin main` → Render detecta e faz o deploy
  sozinho. Não existe staging; `main` é produção. **Só dar push depois de
  confirmação explícita do Alexandre** (ele quer ver/aprovar antes).
- Variáveis obrigatórias no Render: `JWT_SECRET`, `ADMIN_SECRET`,
  `FIREBASE_SERVICE_ACCOUNT`. Ver seção 5 (segredos) e seção 9 do
  PROJETO.md pra lista completa.

## 5. Onde ficam configuração e segredos (nomes só — nunca o valor aqui)

- `.env` (local, gitignorado) — `FIREBASE_SERVICE_ACCOUNT`, `JWT_SECRET`,
  `ADMIN_SECRET`, `PORT`. Nunca commitar este arquivo.
- Render → aba Environment — mesmas variáveis + conforme a integração:
  `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` (se Stripe estiver ativo),
  `ANTHROPIC_API_KEY`, `META_APP_SECRET` (assinatura do webhook da Meta),
  `WA_PROXY_URL` (proxy residencial pro QR do Baileys, se usado).
- Credenciais de WhatsApp por empresa (Z-API `instanceId`/`token`/
  `clientToken`, ou token/phone-id da API Oficial da Meta) ficam salvas
  **no Firestore**, por empresa — não são variáveis globais.
- Checklist completo de contas externas necessárias (GitHub, Render,
  Firebase, Meta Business, Z-API, Stripe, domínio, e-mail transacional):
  seção 9 do `PROJETO.md`.

## 6. Decisões importantes e porquês

- **Vendedor não escolhe o número de WhatsApp manualmente onde o dono já
  tiver uma config pronta** — a tela do vendedor é tratada como extensão
  visual do painel do dono; qualquer UI nova no lado do dono deve ser
  replicada visualmente no lado do vendedor (mesmo grid, mesmo estilo de
  card, mesmo botão "🔗 Copiar link").
- **Banner "totem" em tela cheia com QR Code** — quando uma empresa/nicho
  tem uma imagem própria configurada (`bannerFundo`), o sistema **exibe só
  a imagem, sem desenhar nada por cima**. O Alexandre monta a arte final
  (foto + QR Code já embutido) por fora do sistema e só faz upload do
  resultado. **Já foi tentado um overlay configurável/arrastável de QR por
  cima da foto e foi explicitamente rejeitado** — não reintroduzir essa
  ideia. Sem `bannerFundo`, usa o banner padrão (logo + texto + QR gerado).
- **Emoji por nicho** (`NICHOS_EMOJI`, duplicado em `admin.html` e
  `minha-empresa-configurar.html`) — cada nicho tem um emoji específico
  (💈 barbearia, 💇 cabeleireiro, 🦷 dentista, ✨ estética, 🐶 pet-shop,
  🍽️ restaurante), nunca o genérico 🎯 de fallback.
- **Linguagem do produto**: copy sempre usa "**recomendar**", nunca
  "indicar".
- **Pré-pago via API Oficial**: cobra por mensagem (marketing ~R$0,35,
  utility ~R$0,05, serviço 24h grátis), bloqueia envio quando o saldo zera.
- **Fluxo curto do recomendador é GLOBAL** (`FLUXO_CURTO_GLOBAL = true` em
  `server.js`): agradecimento → nome → contatos → prêmio → 1 lembrete → fim.
  Elimina o "Modo Full" e todas as perguntas de "já avisou os amigos?" pra
  reduzir abandono. É reversível (trocar pra `false`). Pergunta de vendedor
  fica condicional (só se a empresa tem vendedores).
- **Não-entrega no Z-API = SHADOW_BAN do WhatsApp**, não é bug nosso. O fix
  real é **API Oficial da Meta** ou modelo inbound — não há conserto no canal
  não-oficial (Z-API/Baileys/Evolution sofrem o mesmo). Há "Teste de entrega"
  no painel que mostra o `errorCode` real do `DeliveryCallback`.
- Mais decisões/histórico técnico completo: seção 8 do `PROJETO.md`.

## 7. Como o Alexandre gosta de trabalhar (regras de colaboração)

- **Responder sempre em português.** Sem exceção.
- Ele manda prints de tela pra mostrar bugs/problemas visuais — analisar a
  imagem antes de propor fix.
- **Avançar 1 funcionalidade por vez**, não empacotar várias mudanças numa
  tacada só.
- **Nunca dar `git push` sem confirmação explícita dele** — perguntar e
  esperar "sim" antes de subir pro Render (que é produção direto, sem
  staging).
- Preferir investigar automação/scripts que ele já tem (ex. backup do pen
  drive) em vez de inventar um processo novo.
- `parceiro.html` fica **sempre fora dos commits** — ele edita por fora.
- Se ele pedir algo e depois corrigir o rumo com força ("pelo amor de
  Deus", "isso vai ficar uma bosta" etc.), tratar como reversão completa
  da abordagem, não um ajuste fino — reverter de verdade, não só mitigar.
- Backup: existe automação própria em
  `/Volumes/Lexar/BACKUP-ALEXANDRE/backup-claude/atualizar-pendrive.sh`
  (roda a cada 2h via LaunchAgent, também pode ser chamada manualmente) —
  usar essa automação em vez de copiar arquivos manualmente. O script usa
  `set -uo pipefail` (sem `-e`), então **loga "ok" no fim mesmo se o rsync
  falhar no meio** — sempre conferir o log
  (`~/Documents/Backup Claude/ultimo-backup-pendrive.log`) depois de rodar,
  não confiar só no código de saída.
