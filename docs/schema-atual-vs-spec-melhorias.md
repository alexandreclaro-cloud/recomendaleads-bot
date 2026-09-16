# Schema atual vs. Especificação de Melhorias (v1.0) — levantamento

Resposta ao item 0 do documento `RecomendaLeads — Especificação de Melhorias`.
**Nenhum código foi alterado para produzir este documento** — é só leitura do
`server.js` atual. Objetivo: mapear o que já existe, pra não duplicar.

---

## 1. Coleções Firestore hoje (`recomendaleads-8063e`)

| Coleção | Pra que serve hoje | Chave do doc |
|---|---|---|
| `empresas_login` | Tenant raiz. Login, config (`configuracao`), saldo pré-pago (`saldoCentavos`), credenciais Meta/Z-API | id = empresaId |
| `usuarios` | Equipe da empresa: gestor/atendente, `atendenteOficial`, telefone, status online (revezamento) | auto-id |
| `sessoes` | Estado da conversa do **cliente** (quem recomenda) — máquina de etapas do bot | `chaveSessao(telefone)` |
| `sessoes_recomendado` | Estado da conversa do **recomendado** (amigo) — etapas: `aguardando_confirmacao`, `menu_principal`, `agendar_periodo`... | `chaveSessao(telefone)` |
| `sessoes_agente_script` | Estado do agente de IA por script de vendas (multi-oferta) | telefone |
| `leads` | **Isto é a entidade "recomendação" hoje.** Um doc por recomendado: `nomeRecomendado`, `telefoneRecomendado`, `nomeRecomendador`, `telefoneRecomendador`, `vendedor`, `empresaId`, `ofertaId`, `etapa` (Kanban, customizável por empresa via `empresa.etapasKanban`), `bonusPago`, `criadoEm`, `historico: [{etapa, em}]` | auto-id |
| `clientes_pipeline` | Kanban separado do **cliente** (recomendador): iniciou → deu_nome → recomendou → recebeu_premio. Guarda `recomendados: [{nome,telefone}]` | `${empresaId}__${telefoneDigitos}` |
| `conversas` | Metadados por conversa: `ultimaInboundEm` (**é a janela de 24h atual**), `botPausado`, `precisaAtendente`, `atendenteId/Nome`, `papel` (cliente/recomendado), `campanhaId`, resumo pro inbox | `${empresaId}__${telefone}` (bare telefone se `EMPRESA_ID_PDN`) |
| `mensagens_chat` | Histórico de mensagens (in/out) de cada conversa, com `tipo` (texto/imagem/audio/video/documento), `midiaUrl` | auto-id |
| `agendamentos` | Fila de jobs genérica (followups, lembretes, revezamento de atendente, agenda de marketing...). Poll a cada 1 min | auto-id, campo `status: pendente\|concluido` |
| `disparos_massa` | Campanhas de disparo em massa (lista de contatos, template, relatório agregado) | auto-id |
| `descadastros` | Opt-out — **já existe e já é definitivo/por empresa** | telefone+empresa |
| `numeros_pausados` | Bot pausado pra aquele número (atendimento humano assumiu o fluxo) | `chaveSessao(telefone)` |
| `transacoes_prepago` | **Ledger de cobrança de mensagem oficial** — todo débito/crédito, com `categoria` (utility/marketing/servico), `valorCentavos`, `saldoDepois`, `motivo`, `em`. Debitado via `db.runTransaction` (atômico) | auto-id |
| `vouchers_emitidos` | Controle de voucher/cupom entregue por recomendação | — |
| `comissoes`, `vendedores` | Comissão de vendedor interno (20% manual) | — |
| `recomendacao_refs` | Código opaco `#r<cod>` → quem recomendou (modelo "Full"/RADAR: link rastreável, o amigo é quem chama) | `${empresaId}__${codigo}` |
| `marketing_envios` | Log de envio da Agenda de Marketing recorrente | — |

## 2. Como "recomendação" é modelada hoje

**Não existe uma coleção `recomendacoes`, mas ela já existe em espírito: é a coleção `leads`.**
Cada doc de `leads` já é 1:1 com o que a especificação chama de `recomendacoes/{id}`:
tem recomendador, recomendado, `empresaId`, etapa (Kanban) e até um `historico`
de transições (embutido no doc, não subcoleção).

**O que falta em `leads` pra cobrir o M1/M3:**
- Não tem os status *automáticos* de comunicação (contato feito / respondeu /
  não respondeu) — só tem a etapa de *negócio*, que é customizável por empresa
  (`empresa.etapasKanban`, ex: pode ser "Novo", "Contatado", "Fechou" com
  rótulos livres). **Isso são duas dimensões diferentes, não uma.**
- Não tem `janelaExpiraEm`/`primeiraRespostaEm` — isso já existe, mas em
  `conversas.ultimaInboundEm`, não em `leads`.
- `historico` é um array embutido, não subcoleção — funciona pra volume baixo,
  mas se o M1 quer histórico rico (quem moveu, de/para) vale migrar pra
  subcoleção nesse módulo mesmo.

**Recomendação:** não criar `recomendacoes` do zero. Estender `leads` com os
campos novos (status de comunicação, janela, followUpsEnviados, optOut lido de
`descadastros`) e migrar `historico` pra subcoleção. Isso evita ter DOIS
lugares com "quem recomendou quem" (risco real de dessincronia).

## 3. Isolamento multi-tenant hoje

Padrão: `tenantContext` (AsyncLocalStorage) carrega `{empresaId, empresa, zapi}`
por request; `empresaIdAtual()` lê disso. Toda coleção nova hoje já nasce
gravando `empresaId` e a maioria das queries já filtra por ele.

**Risco real encontrado, direto relevante ao item 3 do briefing:** existe uma
constante `EMPRESA_ID_PDN` (a empresa mais antiga/principal) usada como
**fallback silencioso** em ~20 lugares do código, no padrão
`d.empresaId || EMPRESA_ID_PDN`. Ou seja: hoje, se algum dado é gravado ou lido
sem `empresaId` (bug, migração incompleta, endpoint novo esquecendo o campo),
ele **não dá erro — cai silenciosamente na conta da PDN Vendas**. Isso é
tolerável no estado atual (1 cliente pagante de fato rodando full), mas é uma
bomba-relógio pro M6 (autosserviço, múltiplos clientes reais): um bug de
isolamento não vai aparecer como erro, vai aparecer como **dado de uma empresa
vazando pra outra**. Recomendo, antes do M6: auditar esses ~20 pontos e trocar
o fallback por uma checagem explícita que loga/erra quando `empresaId` está
ausente, ao invés de assumir PDN.

`chaveSessao(telefone)` tem uma exceção parecida: pra `EMPRESA_ID_PDN` a chave
é o telefone puro (sem prefixo de empresa); pra todas as outras é
`${empresaId}__${telefone}`. Isso é legado (a PDN existia antes do
multi-tenant) — funciona, mas é mais um lugar onde "esquecer o empresaId"
degrada pra PDN em vez de falhar alto.

## 4. Módulo a módulo

### M3 — Cadência com janela de 24h
- **O ponto único de saída já existe, parcialmente:** `sendTextOuTemplate(telefone, textoLivre, templateName, params)`
  já decide janela aberta → texto livre / janela fechada → template / sem
  template → não envia e loga. É praticamente o `enviarMensagem` pedido no
  spec. **O gap real não é construir a função — é auditar todo o código e
  garantir que TODO envio proativo passe por ela** (hoje várias chamadas
  ainda usam `sendText`/`enviarSemLog` direto).
- **A janela de 24h já existe:** `conversas.{empresaId}__{telefone}.ultimaInboundEm`,
  lida por `dentroJanela24h()`. Não precisa criar coleção `contatos` nova —
  dá pra estender `conversas` com `optOut` (hoje é uma coleção separada,
  `descadastros`, e pode continuar sendo — só cruzar as duas checagens).
- **O log de custo/auditoria já existe, parcialmente:** `transacoes_prepago`
  já grava categoria, valor e saldo por débito, dentro de uma
  `db.runTransaction` atômica — é o precedente de bloqueio a copiar, e talvez
  a própria coleção a estender (falta nela: `telefone`, `recomendacaoId`,
  `statusEntrega`). Duplicar como `envios` separado arrisca dois sistemas de
  custo divergindo.
- **Confirmado, é um bug real e concreto:** `buscarAgendamentosVencidos()` +
  `marcarAgendamentoConcluido()` (o executor genérico de `agendamentos`, que
  roda a cada 1 min) **não tem lock nenhum** — busca tudo com
  `status:'pendente'`, processa, só marca `concluido` DEPOIS. Se o Render
  rodar 2 instâncias (ou o executor anterior atrasar), o mesmo job pode
  disparar 2x. **Existem, sim, dois precedentes de lock correto no próprio
  código** (`db.runTransaction` em `cobrarEnvioOficial`/`creditarSaldo` e em
  `processarAgendaMarketing`) — o M3 pode copiar exatamente esse padrão pro
  executor genérico, resolvendo o problema pra TODOS os tipos de agendamento
  de uma vez, não só pro follow-up de recomendação.

### M1 — Pipeline visual
- Kanban de `leads` já existe em `/crm` e `/minha-empresa-configurar` com
  `etapasKanban` **customizável por empresa** — não é um enum fixo de 8
  status. O M1 propõe um enum FIXO de status automáticos+manuais. **Esses
  são dois eixos diferentes** (fase de negócio, definida pela empresa × status
  de comunicação, automático) — recomendo modelar como dois campos no mesmo
  doc de `leads`, não substituir um pelo outro.
- `historico` já existe mas como array embutido — migrar pra subcoleção
  `leads/{id}/historico` é direto, sem quebrar nada que já lê o array (dá pra
  ler dos dois lugares durante a transição).
- Multi-tenant: os endpoints atuais de Kanban já filtram por
  `req.empresaLogin.id` — copiar esse padrão, não inventar novo.

### M2 — Métricas
- Não existe hoje nenhuma coleção de métricas pré-agregadas — confirma que
  `metricas_diarias` é módulo novo de verdade.
- O bloco de custo pode nascer direto de `transacoes_prepago` (já tem
  categoria e valor por envio) em vez de recalcular do zero.

### M5 — Transcrição de áudio
- **Confirmado, é exatamente o problema descrito:** `metaMensagemParaInterno`
  já baixa e sobe o áudio (`baixarMidiaMetaEUpload`, pro Firebase Storage) e
  guarda a URL — mas comenta explicitamente no código: *"Sem texto — o
  roteamento normal (por texto) não trata isso; entra só na caixa de entrada
  pro atendente ver."* Ou seja, hoje TODO áudio recebido já é sempre perdido
  pelo motor de palavras-chave, sem exceção.
- **Dependência direta do backlog #1:** a transcrição vai reusar
  `baixarMidiaMetaEUpload`, que grava no **Firebase Storage** — o mesmo
  caminho que o backlog aponta como instável ("Premature close"). Faz sentido
  resolver esse backlog ANTES do M5, porque senão a transcrição herda o
  mesmo bug de upload.

### M4 — Avaliação → TAT
- Não existe nenhuma coleção nem lógica de NPS/avaliação hoje — módulo 100%
  novo, sem conflito de nome ou dado.
- O motor de faixas (`empresa.faixasBonus`, `faixasAtivas()`) já existe e já
  é usado por `enviarPremioRecomendado`/Kanban de faixas — o M4 (e o M1/M7)
  devem chamar essas funções existentes, não recriar a lógica de tier.

### M6 — Planos e limites
- `transacoes_prepago` + `saldoCentavos` em `empresas_login` já são um
  sistema de billing funcionando (recarga manual, débito por mensagem,
  bloqueio em zero) — é o precedente direto pro middleware
  `verificarLimite`, inclusive o padrão de transação atômica pra não deixar
  passar 2 requisições ao mesmo tempo furando o limite.
- **Pré-requisito que o próprio spec já identificou bate com o código:**
  hoje `oficialAtual()`/`zapiAtual()` leem **1 credencial por empresa** —
  não existe estrutura de múltiplos números Oficial por cliente. Confirmado:
  é bloqueador de verdade pro 2º cliente, como o spec já diz.
- Nenhum campo `aceiteTermos` existe em `empresas_login` hoje — confirma que
  cadastro autosserviço com aceite de termos é 100% novo.

### M7 — Programa de recomendação do próprio RecomendaLeads
- `recomendacao_refs` (`#r<código>` → recomendador) já é o precedente exato
  do mecanismo de atribuição por código que o M7 pede — mas ele hoje atribui
  **contato dentro do mesmo tenant** (cliente → amigo dele), não **empresa →
  empresa** (o que o M7 precisa: uma empresa cliente recomendando o
  RecomendaLeads pra outra). São entidades diferentes; o padrão de código
  (doc com `codigo` opaco, resolvido no primeiro contato) é reaproveitável,
  mas a coleção `parceiros` proposta é nova mesmo, e mora em outro nível
  (não dentro do tenant — é sobre tenants).
- Reusa o motor de faixas, confirmado que dá pra reaproveitar sem alteração.

## 5. O que eu mudaria na ordem de execução

A ordem do spec (M3 → M1 → M2 → M5 → M4 → M6 → M7) continua fazendo sentido.
Um ajuste: dentro do M3, a correção do lock de concorrência no executor de
`agendamentos` **beneficia todos os módulos que agendam job** (M3, M4, M5), e
é uma mudança pequena e isolada (só o executor genérico) — vale ser o
primeiro commit do M3, isolado, antes de mexer em cadência.

## 6. Perguntas em aberto antes de codar (não são técnicas, são de decisão)

1. `leads.etapa` (Kanban de negócio, customizável) vai continuar existindo
   do jeito que está, e o M1 adiciona um campo NOVO de status automático ao
   lado dele? (Recomendo isso — ver seção 4/M1.)
2. Migrar `transacoes_prepago` pra virar também o log de auditoria `envios`
   do M3 (adicionando `telefone`/`recomendacaoId`), ou manter os dois
   sistemas separados (billing vs. auditoria de entrega)?
3. `EMPRESA_ID_PDN` como fallback silencioso: ok manter assim até o M6, ou
   já vale trocar por erro explícito agora, antes de mais módulos se
   apoiarem nesse comportamento?
