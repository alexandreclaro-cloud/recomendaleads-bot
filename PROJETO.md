# RecomendaLeads — Documento de Continuidade do Projeto

> Escrito em 2026-08-03. Este documento existe pra que **qualquer programador
> consiga continuar este projeto sem depender de conversas anteriores com IA**.
> Se você é esse programador: leia este arquivo inteiro antes de mexer em
> qualquer coisa. Se algo aqui parecer desatualizado, o código é sempre a
> fonte da verdade — mas isto deveria ser mantido atualizado a cada mudança
> grande (arquitetura, modelo de dados, decisões de negócio).

## 1. O que é o sistema

RecomendaLeads é um **SaaS multi-tenant** (várias empresas clientes usando a
mesma plataforma) que automatiza um programa de indicação/recomendação via
WhatsApp: um cliente de uma loja/empresa recomenda amigos, o bot conversa com
os amigos automaticamente, entrega prêmios e alimenta um CRM (Kanban) pro
dono acompanhar tudo. O dono do produto é o Alexandre Claro (`PDN` /
"Poder do Network" é a marca principal usando a plataforma).

Modelo de negócio: cada empresa cliente paga uma assinatura (Stripe) ou usa
pré-pago por mensagem enviada via API Oficial do WhatsApp.

## 2. Stack e hospedagem

- **Backend**: Node.js + Express, tudo em um único arquivo `server.js`
  (~7.800 linhas). Sem framework de front-end — os painéis são HTML/CSS/JS
  puro (sem build step, sem bundler).
- **Banco de dados**: Firebase Firestore (NoSQL). Sem ORM — todo acesso é via
  `firebase-admin` direto.
- **Armazenamento de arquivos**: Firebase Storage (uploads de voucher, imagens
  do chat, etc).
- **Hospedagem**: Render (`recomendaleads-bot`, plano web service). Deploy
  automático a cada `git push` na branch `main`.
- **Domínio**: `recomendaleads.com.br` (subdomínios por nicho, ex.
  `dentista.recomendaleads.com.br`, todos apontando pro mesmo serviço Render).
- **Pagamentos**: Stripe (assinaturas) + sistema de pré-pago próprio (saldo em
  centavos, debitado por mensagem enviada via API Oficial).
- **IA usada dentro do produto**: Claude (Anthropic API, modelo Haiku) — usada
  pelo próprio bot pra interpretar respostas ambíguas do recomendado e pro
  atendimento pós-fluxo (dúvidas do cliente). Isso é **diferente** de mim
  (Claude Code, a ferramenta usada pra desenvolver o projeto) — o produto usa
  a API do Claude como uma feature, não depende do Claude Code pra rodar.

Repositório: `github.com/alexandreclaro-cloud/recomendaleads-bot` (branch
`main`, sem outras branches em uso). **O código nunca esteve preso a
nenhuma ferramenta de IA — é um repositório Git comum, qualquer programador
pode clonar e continuar.**

## 3. Estrutura de arquivos (o que é cada coisa)

### Backend
- `server.js` — tudo: rotas, lógica do bot, integrações, agendamentos. Ver
  seção 5 pra entender como navegar um arquivo desse tamanho.
- `package.json` — dependências (axios, bcryptjs, express, firebase-admin,
  jsonwebtoken, multer, nodemailer, stripe).

### Painéis (HTML servido como arquivo estático, sem build)
- `crm.html` — painel principal do CRM: Kanban de leads, todas as
  configurações do bot (mensagens, prêmios, follow-ups, templates), Ranking.
  É o arquivo mais denso depois do server.js (~176 mil linhas de código-fonte
  contando marcação, a maior parte é JS inline num único `<script>`).
- `minha-empresa-configurar.html` — painel mais novo, complementar ao
  crm.html: conexão de WhatsApp (Z-API/API Oficial), Ofertas (múltiplas
  lojas), Equipe, Disparo em massa, Plano/assinatura. **Nota importante**:
  hoje existem CAMPOS DUPLICADOS entre este arquivo e o crm.html — é uma
  fonte real de confusão histórica (ver seção 8). Antes de adicionar uma
  configuração nova, procure se ela já existe nos dois lugares.
- `conversas.html` — inbox de atendimento (conversas ao vivo, assumir
  atendimento humano, script de vendas).
- `admin.html` — painel do DONO da plataforma (não dos clientes): lista de
  empresas, cadastro, cobrança, comissão de vendedores, avisos.
- `admin-criar-empresa.html` — formulário de cadastro de empresa nova
  (usado pelo dono ou por vendedores).
- `login.html`, `cadastro.html`, `assinar.html`, `contrato.html`,
  `vendedor-cadastro.html`, `completar.html` — fluxos de autenticação e
  onboarding de clientes/vendedores.
- `recomendometro-*.html` — landing pages de quiz gamificado por nicho
  (barbearia, dentista, cabeleireiro, estética). São arquivos grandes
  (2-3 MB cada) porque embutem imagens em base64. Servem só como página de
  captação de leads (Meta Ads), não têm lógica de backend própria além de
  mandar o resultado pro `/recomendometro/lead`.
- `landing.html` / `landing-nova.html` / `landing-antiga*.html` — versões da
  página institucional do produto (não do cliente final).
- `calculadora.html`, `logos.html`, `configurar-vouchers.html` — páginas
  auxiliares/experimentais, baixo uso.
- `theme.css` — estilos compartilhados entre os painéis.

### Outros
- `_genh.js` — script local de um uso só (processamento de uma imagem
  específica), não faz parte do app em produção, pode ser ignorado/apagado.
- `MIGRACAO-API-OFICIAL.md` — guia narrow de como migrar uma empresa de
  Z-API pra API Oficial da Meta. Ainda válido, só cite que a linha sobre
  "desliga o Baileys" está obsoleta (Baileys foi removido do sistema em
  2026-08-03).
- `README.md` — **está desatualizado** (descreve uma versão antiga,
  single-tenant, sem Firestore). Precisa ser reescrito ou substituído por
  este arquivo.

## 4. Modelo de dados (coleções do Firestore)

| Coleção | O que guarda |
|---|---|
| `empresas_login` | Uma empresa cliente por doc. Config completa (mensagens, prêmios, templates, credenciais WhatsApp) vive dentro do campo `configuracao`, mesclado com o objeto `EMPRESA_PADRAO` (os defaults) em tempo de leitura. |
| `usuarios` | Login de usuários dentro de uma empresa (Gestor/Atendente, ou preso a uma "loja" via `ofertaId` — ver seção 7). |
| `leads` | Cada pessoa recomendada (o "amigo"), com etapa no Kanban, `empresaId`, `ofertaId`. |
| `clientes_pipeline` | Funil separado do cliente (recomendador): iniciou / deu o nome / recomendou. |
| `sessoes` | Estado da conversa em andamento com o CLIENTE (quem recomenda). |
| `sessoes_recomendado` | Estado da conversa com o AMIGO recomendado. |
| `conversas` / `mensagens_chat` | Histórico de mensagens pro inbox (conversas.html). |
| `agendamentos` | Fila de tarefas futuras (follow-ups, lembretes) — processada a cada 1 min por `processarAgendamentoInterno`. |
| `vendedores` | Cadastro de vendedores (comissão). |
| `comissoes` | Registro de comissão paga/a pagar. |
| `transacoes_prepago` | Histórico de cobrança por mensagem (API Oficial). |
| `vouchers_emitidos` | Controle de vouchers/prêmios entregues. |
| `numeros_pausados` | Números que pediram "stop" (opt-out) — anti-spam/anti-ban. |
| `descadastros` | Opt-out formal. |
| `recomendometro_leads` | Leads capturados pelas landing pages de quiz. |
| `admins` | Login do(s) dono(s) da plataforma. |
| `avisos` | Avisos internos mostrados no admin. |
| `config` | Coleção legada de quando o sistema era single-tenant (pré-multi-tenant). Só a conta PDN ainda usa como fallback em alguns pontos — não crie dados novos aqui. |

**Não existe `firestore.indexes.json`** no repositório — os índices
compostos foram criados manualmente no console do Firebase conforme
necessário. Se uma query nova precisar de índice, o Firestore devolve um
link direto no erro pra criar.

## 5. Como navegar o server.js (7.800 linhas, um arquivo só)

Não há separação em módulos/pastas — é um monólito histórico. Pontos de
entrada úteis pra se localizar (buscar por essas strings):

- `EMPRESA_PADRAO` — o objeto com TODOS os campos de configuração possíveis
  e seus valores default. É o melhor lugar pra entender "quais configurações
  existem" sem ler o resto do arquivo.
- `CAMPOS_OPERACAO_EMPRESA` / `CAMPOS_PRODUTO_OFERTA` — logo depois do
  `EMPRESA_PADRAO`, classificam quais campos são compartilhados entre lojas
  (operação) vs. específicos de cada oferta/loja (produto).
- `tenantContext` (AsyncLocalStorage) — mecanismo central de isolamento
  multi-tenant. Toda requisição autenticada roda dentro de
  `tenantContext.run(contexto, ...)`, e funções como `getEmpresa()`,
  `tipoWppAtual()` leem esse contexto em vez de variável global mutável.
  **Isto é o que impede vazamento de dados entre empresas** — qualquer
  função nova que precise saber "qual é a empresa atual" deve usar esse
  mecanismo, nunca uma variável de módulo.
- `iniciarConversa` / `iniciarConversaRecomendado` — os dois pontos de
  entrada do roteiro do bot (lado Cliente e lado Recomendado).
- `processarAgendamentoInterno` — o "cron" interno (roda a cada 1 min),
  executa todo tipo de tarefa futura agendada (follow-ups, lembretes).
- Rotas `/minha-*` — API autenticada usada pelos painéis (`exigirLoginEmpresa`
  como middleware). Rotas `/admin/*` — API do dono da plataforma
  (`exigirAdmin`). Rotas `/webhook*` — recebem mensagens do WhatsApp
  (Z-API ou Meta).

## 6. Conceitos-chave (glossário)

- **Cliente (recomendador)** — a pessoa que já é cliente da empresa e
  recomenda amigos. Fala primeiro com o bot, ganha prêmio ao atingir uma
  meta de recomendações.
- **Recomendado (amigo)** — quem foi indicado. O bot fala com ele depois,
  oferecendo um presente.
- **Faixas de bônus** (`faixasBonus`) — metas escalonadas de quantidade de
  recomendações (ex.: 5 recomendações = prêmio 1, 10 = prêmio 2).
- **Modo Basic vs Full** — Basic: o bot fala direto com cada amigo assim que
  recomendado. Full: manda um link pro cliente encaminhar, e é o AMIGO quem
  chama o bot (inbound) — muito mais seguro contra banimento do WhatsApp,
  mas só existe fora do modo API Oficial (na API Oficial só existe um fluxo).
- **Z-API vs API Oficial (Meta) vs Baileys** — três formas históricas de
  conectar o WhatsApp. **Baileys foi removido em 2026-08-03** (decisão do
  Alexandre — instabilidade, sessões quebravam sozinhas). Z-API é uma
  automação não-oficial (risco de banimento). API Oficial é a integração
  direta com a Meta Cloud API — mais estável, cobra por mensagem fora da
  janela de 24h, exige templates pré-aprovados pela Meta.
- **Janela de 24h** — regra do WhatsApp: só dá pra mandar texto livre pra
  quem falou com você nas últimas 24h. Fora disso (API Oficial), é
  obrigatório usar um "template" pré-aprovado pela Meta. **O sistema NÃO
  verifica essa janela por conta própria** — cada mecanismo de follow-up
  simplesmente usa template se um estiver configurado, sempre.
- **Múltiplas Ofertas / Rede de Lojas** — uma empresa pode ter mais de uma
  "oferta" (ex.: uma franquia com 4 lojas usando o mesmo número de
  WhatsApp). Cada oferta tem sua própria config de produto (mensagens,
  prêmios), login próprio por loja (`usuarios.ofertaId`), e acesso liberado
  pela matriz (`configuracao.ofertas[id].acessoLiberado`). Funcionalidade
  paga à parte (`ofertasHabilitado`).
- **Pré-pago** — cobrança por mensagem enviada via API Oficial
  (`marketing` ~R$0,35 / `utility` ~R$0,05 / conversa de serviço grátis).
  Saldo em `empresas_login.saldoCentavos`, debitado em `cobrarEnvioOficial`.
- **Follow-up — Sem resposta** — mecanismo de reengajamento (aba no CRM)
  pra quem não respondeu, dividido em **Cliente** (nunca respondeu ao "qual
  é seu nome?") e **Recomendado** (amigo que nunca respondeu ao convite).
  Cada mensagem da cadência pode ter seu próprio template — não existe mais
  um "template padrão compartilhado" (removido em 2026-08-03 por ser
  confuso e ter causado um incidente real de template errado).

## 7. Segurança — status em 2026-08-03

Auditoria completa feita e as 3 falhas reais encontradas foram corrigidas:

1. `JWT_SECRET`/`ADMIN_SECRET` não têm mais fallback fraco — o app quebra no
   boot se essas env vars não estiverem configuradas no Render (evita rodar
   em produção com segredo previsível).
2. Rotas antigas sem autenticação (`/status`, `/config`, `/leads`) foram
   removidas — eram sobra de antes do sistema virar multi-tenant.
3. Webhook da API Oficial da Meta agora valida a assinatura
   `X-Hub-Signature-256` (HMAC com `META_APP_SECRET`) — sem isso, qualquer
   um que descobrisse a URL do webhook + o phone_number_id (público)
   conseguiria forjar mensagens.

Isolamento multi-tenant foi auditado e está sólido (ver `tenantContext` na
seção 5). Senhas usam bcrypt. Nenhum segredo foi encontrado commitado no
código ou no histórico do Git. CORS restrito a origens conhecidas (não é
`*`).

**Dívida técnica não-crítica** (não é falha de segurança, é maturidade de
engenharia): sem testes automatizados, sem monitoramento (Sentry/health
check), tudo em um arquivo único grande. Não é urgente pro tamanho atual do
negócio, mas vale planejar conforme a base de clientes crescer.

## 8. Decisões e histórico importante

- **"Só vamos usar a API Oficial, não vai existir mais o Basic vs Full"**
  (decisão do Alexandre, 2026-07-29) — o modo Full (inbound, mais seguro)
  não se aplica dentro do modo oficial; a estratégia de "confirmar antes de
  disparar" foi movida pro card "Avisar os amigos".
- **Baileys (QR grátis) removido por completo** (2026-08-03) — causava
  sessões que quebravam sozinhas (erro 401) e ficavam presas em loop por um
  bug de limpeza no Firestore (corrigido antes da remoção, mas a decisão de
  negócio foi parar de oferecer de qualquer forma).
- **Painéis duplicados (`crm.html` vs `minha-empresa-configurar.html`)** —
  problema arquitetural conhecido: várias configurações têm UI em dois
  lugares diferentes, gravando o mesmo campo sem coordenação. Já causou pelo
  menos um bug real (dois formulários sobrescrevendo `cadenciaFollowupRecomendado`
  um do outro). Direção declarada pelo Alexandre: centralizar tudo no painel
  novo (`minha-empresa-configurar.html`), por partes — ainda incompleto.
- **Sem verificação real de janela de 24h** — comportamento intencional,
  não um bug: como os follow-ups automáticos são pra quem NUNCA respondeu, a
  janela nunca abriu de verdade, então usar template sempre (quando
  configurado) é o comportamento correto.
- **Incidente Shadow Ban (Z-API)** — causa raiz confirmada de uma queda de
  entrega foi banimento silencioso do WhatsApp (`SHADOW_BAN` no
  `DeliveryCallback`), não bug de código. Reforça a prioridade de migrar
  clientes pra API Oficial.

## 9. Checklist de acessos externos necessários

Documentação e código **não bastam** — pra continuar operando o produto (com
ou sem programador novo), é preciso ter acesso a estas contas, que são do
Alexandre, não ficam no código:

- [ ] **GitHub** — dono do repositório `alexandreclaro-cloud/recomendaleads-bot`.
- [ ] **Render** — hospedagem do servidor + todas as variáveis de ambiente
  (`JWT_SECRET`, `ADMIN_SECRET`, `META_APP_SECRET`, `FIREBASE_SERVICE_ACCOUNT`,
  `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, credenciais
  Z-API). **Sem essas variáveis, ninguém consegue rodar o sistema, mesmo com
  o código em mãos.**
- [ ] **Firebase / Google Cloud** — projeto do Firestore + Storage. É onde
  TODOS os dados reais (empresas, leads, conversas) realmente vivem.
- [ ] **Meta Business Suite** (developers.facebook.com) — apps da API
  Oficial do WhatsApp de cada empresa cliente que usa esse modo, incluindo o
  App Secret usado na verificação de webhook.
- [ ] **Z-API** — contas/instâncias das empresas que ainda usam esse modo.
- [ ] **Stripe** — conta de cobrança das assinaturas.
- [ ] **Domínio** (`recomendaleads.com.br`) — registro.br ou onde estiver
  registrado, + configuração de DNS apontando pro Render.
- [ ] **E-mail transacional** (usado por `nodemailer` pra enviar boas-vindas,
  senha provisória etc.) — conferir qual provedor está configurado.

## 10. Como rodar localmente / fazer deploy

- **Deploy**: `git push origin main` → Render detecta e faz deploy automático
  (build roda `npm install`, depois `node server.js`). Não existe ambiente de
  staging — main é produção.
- **Local**: não há ambiente local funcional documentado hoje (precisaria de
  um `FIREBASE_SERVICE_ACCOUNT` de teste + as demais env vars). Todo
  desenvolvimento até aqui foi feito com verificação estática
  (`node --check`, checagem de sintaxe do `<script>` inline nos HTML) e teste
  direto em produção pelo Alexandre após cada deploy.
- **Sem suíte de testes automatizados** — validação é manual.

## 11. Pendências conhecidas (em 2026-08-03)

- README.md precisa ser reescrito (está descrevendo uma versão antiga do
  sistema).
- Duplicação de configuração entre `crm.html` e `minha-empresa-configurar.html`
  ainda não foi totalmente resolvida (só a parte "Conversa do cliente" foi
  centralizada).
- Fase 2d (filtro de conversas/leads por loja) e Fase 3 (dashboard
  consolidado da matriz) da Rede de Lojas foram desenhadas mas não
  implementadas.
- Revogação de token JWT antes de expirar (30 dias) não existe.
- Relatório de mensagens enviadas × abertas × respondidas foi cogitado mas
  não construído (exigiria processar webhooks de status da Meta, que hoje
  não são tratados).
