# Roteiro de mensagens — novo cliente

Copie este arquivo pra cada cliente novo (ex: `roteiro-studiocarly.md`), preencha
e depois cole cada resposta no campo correspondente em **Configurar → Mensagens**
no painel. Os campos aqui estão na MESMA ORDEM em que aparecem lá.

> Dica: se o cliente for parecido com um já pronto, marque aquele como
> **⭐ modelo** (Ofertas → clique na estrela) e as ofertas novas já nascem
> preenchidas — aí você só ajusta o que muda.

## Variáveis disponíveis (o robô troca sozinho)

Use `{variavel}` no texto — não é case-sensitive e aceita apelidos:

| Escreva | Vira |
|---|---|
| `{recomendado}` / `{nome}` / `{cliente}` | primeiro nome de quem foi recomendado |
| `{recomendador}` / `{amigo}` | primeiro nome de quem recomendou |
| `{vendedor}` / `{atendente}` / `{consultor}` | quem atendeu na loja |
| `{empresa}` / `{negocio}` | nome do negócio |
| `{premio}` | o prêmio cadastrado |
| `{dia}` / `{periodo}` / `{quantidade}` | usados só nas mensagens de agendamento |

## Regras de tom

- Sempre **"recomendar"**, nunca "indicar".
- Emoji com moderação — 1 por mensagem curta, no máximo 2 nas mais longas.
- Frases curtas, como WhatsApp de gente de verdade, não texto institucional.
- Nunca soar como script robótico lido — o cliente tem que sentir que É o
  dono/vendedor falando.

---

## 1. Fluxo do CLIENTE (quem recomenda)

- [ ] **Saudação / boas-vindas (1ª mensagem)** — `mensagemAgradecimento`

- [ ] **Pedir o nome** — `mensagemPedeNome`

- [ ] **Perguntar quem atendeu** — `mensagemPedeVendedor`

- [ ] **Pedir os contatos** — `mensagemPedeContatos`

- [ ] **Pedido de recomendações** — `mensagemColeta`

- [ ] **Aviso pra avisar os amigos** — `mensagemValidarAmigo`

---

## 2. Fluxo do RECOMENDADO (amigo que recebe o convite)

- [ ] **Prêmio do amigo recomendado (texto)** — `premioRecomendado`

- [ ] **1ª mensagem ao amigo recomendado** — `mensagemInicialRecomendado`

- [ ] **Mensagem repetida enquanto a pessoa não confirma** — `mensagemAguardandoConfirmacao`
  > Enviada tanto quando a pessoa hesita quanto quando **recusa de vez**
  > (digitando "não" ou clicando um botão de template tipo "Não quero,
  > obrigado"). Por isso: **primeiro reconheça o "não", só depois deixe a
  > porta aberta** — nunca insista na mesma frase.
  > Exemplo: *"Sem problema, super entendo 😊 Fico por aqui então — se mudar
  > de ideia é só chamar, tá guardadinho pra você 🎁"*

- [ ] **Antes de entregar o presente** — `mensagemAntesPresente`

- [ ] **Mensagem de fechamento** — `mensagemFechamentoRecomendado`

---

## 3. Pós-presente (menu e agendamento)

- [ ] **Conexão após o presente** (ex: "E aí, gostou?") — `posMensagemConexao`
- [ ] **Menu principal (1 · 2 · 3)** — `posMenuPrincipal`
- [ ] **Link de agendamento** (opcional, ex: Calendly) — `linkAgendamento`
- [ ] **Mensagem antes do link de agendamento** — `posLinkAgendamento`
- [ ] **Pergunta de período** (manhã/tarde/noite) — `posPerguntaPeriodo`
- [ ] **Pergunta do dia** (cabeçalho) — `posPerguntaDia`
- [ ] **Confirmação do agendamento** — `posConfirmacaoAgendamento`
- [ ] **Checagem "conseguiu confirmar?"** — `posConfirmacaoCheck`
- [ ] **Menu "vou usar depois"** — `posMenuDepois`
- [ ] **Mensagem de "receber lembrete depois"** — `posLembrete`
- [ ] **Menu de dúvidas** — `posMenuDuvidas`
- [ ] **Resposta: como funciona o presente** — `faqComoFunciona`
- [ ] **Resposta: qual a validade** — `faqValidade`
- [ ] **Mensagem ao "falar com um atendente"** — `posAtendente`

---

## 4. Se o cliente usa API Oficial (Meta) com template

- [ ] Nome do template aprovado: ______________________
- [ ] Texto exato aprovado pela Meta (copiar aqui pra conferência):

- [ ] Botões de resposta rápida (se tiver) e o que cada um deve disparar:
  - Botão 1: "________________" → deve contar como (positiva/negativa)
  - Botão 2: "________________" → deve contar como (positiva/negativa)
  > O robô já entende clique de botão como se fosse texto digitado — não
  > precisa configurar nada além de escrever a mensagem de recusa acima
  > (item da seção 2) e conferir se o texto do botão bate com as listas de
  > palavras positivas/negativas no código.
