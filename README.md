# RecomendaLeads Bot

SaaS multi-tenant de automação de programa de indicação via WhatsApp
(Método Poder da Recomendação). Node.js + Express + Firebase Firestore,
hospedado no Render, deploy automático a cada push na branch `main`.

**Leia [`PROJETO.md`](./PROJETO.md) primeiro** — é o documento de
continuidade completo (arquitetura, modelo de dados, conceitos-chave,
decisões importantes, checklist de acessos externos). Este README é só um
resumo rápido.

## Variáveis de ambiente (Render → Environment)

Obrigatórias: `JWT_SECRET`, `ADMIN_SECRET`, `FIREBASE_SERVICE_ACCOUNT`.
Conforme a integração usada: `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`,
`ANTHROPIC_API_KEY`, `META_APP_SECRET` (assinatura do webhook da Meta),
`ZAPI_INSTANCE_ID` / `ZAPI_TOKEN` / `ZAPI_CLIENT_TOKEN` (por empresa, salvos
no banco — não são globais). Sem `JWT_SECRET`/`ADMIN_SECRET` configuradas, o
servidor recusa subir de propósito (ver seção de Segurança no PROJETO.md).

## Deploy

`git push origin main` → Render detecta e faz o deploy sozinho. Não existe
staging; `main` é produção.

## Estrutura

Ver seção 3 do `PROJETO.md` para o mapa completo de arquivos. Resumo:
`server.js` é o backend inteiro (rotas + lógica do bot + integrações);
`crm.html` e `minha-empresa-configurar.html` são os painéis principais dos
clientes; `admin.html` é o painel do dono da plataforma.
