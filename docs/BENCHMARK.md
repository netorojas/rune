# Benchmark — Rune contra o mercado

Este documento compara o Rune com produtos adjacentes e aponta onde ele ganha, onde perde, o que copiar de design e o que consertar primeiro.

Método: leitura do código no estado atual do repositório (HEAD `c647d94` mais as alterações locais não commitadas que adicionam a frota e a sonda) e consulta às páginas oficiais de preço e documentação em novembro de 2026. Preço de tabela muda sem aviso; os valores abaixo são referência, não contrato.

O Rune é MIT, roda em `127.0.0.1:8770`, não tem conta nem plano pago. A comparação é de função, não de categoria: quase todos os produtos abaixo são gateways ou plataformas de observabilidade; o Rune é um leitor local do que já aconteceu.

## 1. Panorama

| Produto | Foco | Onde rodam os dados | Preço | O que fazem melhor | O que não fazem |
|---|---|---|---|---|---|
| [Langfuse](https://langfuse.com) | Observabilidade de apps LLM: traces, spans, evals, prompt management | Cloud (UE/EUA) ou self-host com Postgres + Redis + ClickHouse + S3 | OSS grátis (recursos EE à parte); Cloud US$ 0 (50k units, 2 usuários, 30 dias), Core US$ 29, Pro US$ 199, Enterprise US$ 2.499/mês | Tracing por span, datasets, evals e comparação de prompts; ecossistema de integrações | Não lê o banco do 9router; não modela janela 5h/semanal de assinatura; exige instrumentar a aplicação |
| [Helicone](https://www.helicone.ai) | Proxy/gateway com observabilidade de requests | Cloud; self-host só no Enterprise | Hobby grátis (10k requests, 7 dias), Pro US$ 79, Team US$ 799, Enterprise sob consulta | Integração trocando a baseURL; cache, rate limit e logs por request | O tráfego precisa passar pelo proxy; retenção curta; sem cota de assinatura de CLI |
| [LiteLLM](https://www.litellm.ai) | Proxy OpenAI-compatible + dashboard de gasto | Self-host (Postgres); Enterprise sob contrato | OSS grátis para self-host; Enterprise anual por capacidade | Virtual keys, budgets por key/team/user, 100+ provedores, fallback e métricas Prometheus | Só enxerga o que passa pelo proxy; não lê o histórico do 9router nem a janela do seu plano |
| [OpenRouter](https://openrouter.ai) | Marketplace/roteador com Activity dashboard | Cloud OpenRouter | Sem mensalidade; 5,5% no crédito (Standard), 8% (Business); BYOK 5% acima de US$ 25k/mês | Dashboard de 2026 por modelo, usuário, agente e chave; P50/P90/P99; drill-down até a requisição; API de analytics | Só tráfego OpenRouter; exige conta; latência detalhada dura ~31 dias e o histórico ~365 |
| [Portkey](https://portkey.ai) | AI gateway com observabilidade e guardrails | Cloud; OSS self-host | Developer grátis (10k logs, 3 dias), Production US$ 49/mês, Enterprise sob consulta | Guardrails, roteamento e logs com governança | O tráfego passa pelo gateway; retenção de log curta no grátis; sem leitura de assinatura local |
| [Cursor — tela de uso](https://cursor.com/help/models-and-usage/usage-limits) | Consumo do editor | Conta Cursor (nuvem) | Incluído no plano; planos de US$ 0 a US$ 200/mês, Teams a partir de US$ 30/usuário | Pool do plano, data de reset e consumo on-demand em uma tela | Só Cursor; sem custo por projeto; sem visão dos outros provedores |
| [Claude Code — `/usage`](https://code.claude.com/docs/en/costs) | Consumo do agente de código | Estimativa local por sessão + conta Anthropic para as barras do plano | Incluído em Pro (US$ 17–20), Max (US$ 100), Ultra (US$ 200); Team US$ 20–25/assento | Janelas de 5h e semanal, cache, breakdown por skill/subagente/MCP; export OTel por usuário | Só Claude; custo de assinatura não é fatura; sem multi-provedor |
| [ccusage](https://github.com/ccusage/ccusage) | Relatórios de uso de CLIs de código | 100% local (JSONL das ferramentas) | Grátis, MIT | Diário/semanal/mensal/sessão, bloco de 5h, statusline, 18 CLIs | Sem UI, alertas, auditoria ou visão de roteador; preço estimado por tabela |
| [Grafana + Prometheus](https://grafana.com/products/cloud/free-tier/) | Dashboards e alerting de métricas | Self-host ou Grafana Cloud | Prometheus grátis; Cloud com 14 dias de retenção, Pro a partir de US$ 19 + uso, Enterprise US$ 25k/ano | Alerting maduro, retenção configurável e composição com qualquer exporter | Não coleta sozinho; sem semântica de modelo/cota; exige montar e manter |
| [Bifrost](https://github.com/maximhq/bifrost) | Gateway open source de alta performance + UI local | Local/self-host (Apache-2.0) | Grátis; Enterprise sob consulta | UI local sem conta, fallback, MCP/agent gateway, 23+ provedores | Precisa ser o gateway do tráfego; sem cota de assinatura de CLI; sem leitura passiva de outro banco |

O padrão é claro: quem cobra assinatura vende o caminho do tráfego (gateway) ou o tracing da aplicação (plataforma). Nenhum dos dez lê o banco de outro gateway nem cruza o histórico de requests com a folga da janela do seu plano. É esse o espaço do Rune.

## 2. Onde o Rune ganha

1. **Lê o banco do 9router em vez de pedir que você troque de gateway.** `_ro()` abre `file:...?mode=ro` (`server.py:46-54`) e o snapshot sai de `usageDaily`, `usageHistory` e `requestDetails` (`server.py:143-301`). Não há proxy no caminho, nem SDK, nem migração de chave. O custo de adoção é abrir o painel.
2. **Cota calculada na janela real da assinatura.** O coletor normaliza Codex em 5h/semana (`collector/collect.py:272-323`) e Claude em 5h/7d/crédito (`collector/collect.py:324-350`); o servidor expõe folga, reset, ritmo e meta (`server.py:543-590`, `924-947`). Concorrentes mostram requests e gasto; o Rune mostra "quanto falta da sua janela", que é a pergunta que trava o trabalho.
3. **SLO por provedor sem instrumentar nada.** p50, p95, TTFT e taxa de erro saem de `requestDetails` na janela de 7 dias (`server.py:296-342`), com tom de alerta por limiar (`server.py:360-365`) e export Prometheus (`server.py:1085-1093`). O mesmo dado aparece na gaveta do provedor, no cockpit e no `/metrics`.
4. **Prova de orquestração: configurado não é o mesmo que respondendo.** `POST /api/probe {connection}` escolhe até 4 modelos da rota (`server.py:735`), manda `max_tokens: 1` (`server.py:791-795`), tenta o próximo se falhar e guarda o modelo que respondeu (`server.py:741`); modelo morto entra em TTL por código HTTP (`server.py:699`, `713-717`), com no máximo 3 sondagens simultâneas (`server.py:620`). Na interface, "Testar rota" fica na gaveta do provedor e "Testar todas" na Biblioteca, com três workers (`app.js:4026-4062`). Um modelo listado em `/v1/models` não prova nada; a sonda prova.
5. **Desperdício atribuído à sessão e ao arquivo, não só ao provedor.** O Rune lê a composição de contexto por categoria e as leituras duplicadas de arquivo, estimando tokens reprocessados (`server.py:434-519`); a ala Sessões ordena por contexto, mensagens e duplicatas (`app.js:4248-4300`), e o Oráculo responde com esses números (`app.js:4358-4415`). Há custo por chamada e por modelo (`server.py:1030-1038`). Ainda não há custo por tarefa fechada, e isso está no roadmap.
6. **Auditoria local e zero conta.** O Rune verifica permissões `0600/0700`, segredos em JSON, túnel do 9router sem API key e leitura somente-leitura (`server.py:1134-1235`). Não há login, telemetria, trial ou cartão. Para quem usa vários provedores no mesmo Mac, é uma vantagem que os SaaS acima não replicam sem self-host.

## 3. Onde o Rune perde

- **Equipe e multiusuário.** Existe um único operador (`server.py:120-132`), sem autenticação, papéis ou custo por pessoa. LiteLLM, Portkey e OpenRouter tratam isso como produto; o Rune trata como variável de ambiente.
- **Tracing de prompt e span.** Por contrato, prompts e respostas não são persistidos (`README.md:110`). Não há replay de request, dataset nem eval. Langfuse vive disso; o Rune não tenta competir.
- **Alertas fora da aba, só nos dois canais.** O vigia do servidor notifica pelo macOS e por webhook (HTTPS ou loopback), com deduplicação e espera configurável; não há e-mail, Slack, PagerDuty nem fila de reentrega. Se o Mac dormir, o ciclo atrasa.
- **Retenção histórica.** O histórico mensal agora cobre 12 meses agregados do `usageHistory` (custo, tokens, chamadas e cache hit), mas a série diária continua em 14 dias, o `data.json` é sobrescrito a cada coleta (`collector/collect.py:726-729`) e o resultado da sonda guarda só o último estado por rota. Não há banco próprio: se o 9router podar o histórico, a série recomeça. OpenRouter guarda ~365 dias; Langfuse Pro, 3 anos.
- **SDKs e OpenTelemetry.** Não há ingestão de spans nem biblioteca cliente. Claude Code exporta OTel; Helicone e Langfuse têm SDKs em várias linguagens. O Rune depende do 9router, do Qoder e do coletor.
- **Distribuição.** Instalação é `git clone` + `./run.sh` (`README.md:64-70`), sem Homebrew, pipx, pacote assinado ou auto-update. Também é macOS-only na prática: caminho do Qoder (`server.py:36`), `/Applications` (`collector/collect.py:371`) e `~/Projetos` (`collector/collect.py:27`).

## 4. Benchmark de design

| Referência | O que copiar | O que evitar |
|---|---|---|
| [Linear](https://linear.app) | Densidade com hierarquia: muito dado por tela, tipografia pequena e consistente, ⌘K onipresente e ações no mesmo campo de busca | Densidade sem agrupamento: uma parede de texto com 40 números do mesmo peso |
| [Vercel](https://vercel.com) | Hierarquia tipográfica: número grande, rótulo pequeno, um acento só; tabela legível sem zebra | Minimalismo que esconde custo ou erro atrás de hover ou de outra página |
| [Raycast](https://www.raycast.com) | Latência percebida baixa, busca fuzzy com ações no resultado, atalhos visíveis e estado vazio que ensina | Excesso de comandos sem relação com o que está selecionado |
| [Claude Code `/usage`](https://code.claude.com/docs/en/costs) | Nomear a janela ("5h", "semanal"), mostrar reset e ritmo, e dizer o que fazer com o número | Precisão falsa: o próprio doc avisa que custo de assinatura não é fatura; o Rune deve repetir esse aviso |
| [OpenAI — usage](https://help.openai.com/en/articles/10478918-reviewing-api-usage-and-costs) | Filtro de período, projeto e chave no mesmo nível; custo agrupado por dimensão; export ao lado do gráfico | Exigir conta em nuvem para ver um número que já está na máquina |
| [Observable](https://observablehq.com) / [D3](https://d3js.org) | Anotação dentro do gráfico, small multiples e narrativa antes do detalhe | Animação e 3D que atrasam a leitura do número; movimento sem função |
| [Grafana](https://grafana.com/grafana/dashboards/) | Semântica de cor consistente e limiar explícito no alerta; um painel, uma pergunta | Mural de 20 painéis sem hierarquia, em que ninguém sabe onde olhar primeiro |

O Rune já tem o começo certo: ⌘K (`app.js:3670-3700`), tour de cinco passos (`app.js:1930`), atalhos `1–9` e `R`, e `prefers-reduced-motion` respeitado em oito pontos do runtime. O que falta é disciplina de primeira dobra: a resposta mais cara do produto (quais rotas respondem) ainda mora na quinta ala.

## 5. Autocrítica

1. **Quatro arquivos, nenhum build.** `server.py` tem 1.854 linhas, `app.js` 5.133, `styles.css` 5.992 e `i18n.js` 1.832. HTTP, SQL, SLO, sonda, orçamento e alertas dividem o mesmo arquivo. Sem módulos, lint ou tipos, toda mudança de snapshot toca vários pontos e ninguém consegue revisar isolado.
2. **Testes existem, cobertura ainda curta.** `tests/test_contract.py` cobre mascaramento, origem, cota, shape do snapshot e da frota, auditoria, métricas, persistência da sonda, normalização de `settings.json`, o ciclo de alertas (limiar, deduplicação, cooldown), a exportação CSV e a série de 12 meses; são 35 testes. `tests/test_i18n.mjs` reprova chave ausente, órfã ou com variáveis divergentes; `.github/workflows/ci.yml` roda tudo a cada push. Falta teste de integração HTTP real (subir o servidor e chamar as rotas) e regressão visual automatizada.
3. **macOS-only e sem pacote.** O caminho do Qoder (`server.py:36`), `/Applications` (`collector/collect.py:371`) e `~/Projetos` (`collector/collect.py:27`) são fixos, e não há `pyproject.toml`, Homebrew ou pacote assinado. O README admite o macOS; "adaptável" significa editar código.
4. **O "porto 3D" é SVG isométrico, não WebGL.** A cena é gerada com `portBlob`, `<g>` e transform de câmera (`app.js:992-1405`). Cada construção abre um inspetor com dados e duas ações, então não é decoração pura; mas são centenas de linhas de cenário para um painel que precisa entregar número em dois segundos.
5. **i18n fechado nas superfícies da frota.** São 585 entradas por pack e 351 chaves usadas pelo painel, sem furos; o lint `tests/test_i18n.mjs` roda no CI e reprova chave ausente, órfã ou com variáveis divergentes. O que resta é traduzir textos gerados no servidor (diagnósticos e prompts de correção), que continuam em PT.
6. **~~O orçamento mensal mede 14 dias.~~ Corrigido.** O mês agora é agregado no servidor a partir do `usageHistory` completo (`server.py`, bloco `month` em `load_router_usage`): custo, tokens, cache hit, dias ativos, projeção por dia corrido e quebra por provedor. O orçamento saiu do `localStorage` e vive em `.rune-data/settings.json` (`0600`), então vale para qualquer navegador e para o vigia fora da aba. Falta ratear por projeto.
7. **~~Retenção quase zero.~~ Corrigido em parte.** O gasto mensal de 12 meses agora sai do `usageHistory` completo, zero-preenchido e exposto no snapshot (`months`), com card no Fluxo e tooltip de tokens/chamadas/cache. O que continua frágil: `data.json` é sobrescrito a cada coleta (`collector/collect.py:726-729`), a sonda guarda só o último estado por rota e não há banco próprio — se o 9router podar o histórico, a série recomeça.
8. **~~A sonda só conhece rotas codificadas.~~ Corrigido.** `OWNER_META` continua dando o rótulo bonito, mas uma conexão nova no `/v1/models` vira rota sondável na hora: `_owner_for_connection` resolve pelo catálogo vivo e `probe_all` inclui essas conexões. O laço tenta até 4 modelos por rota. O SLO ainda é recortado pelas últimas 5.000 requisições (`server.py:300`), não pelos 7 dias completos. O README já documenta `/api/probe` e `/api/fleet`.
9. **~~POST local sem checagem de origem.~~ Corrigido.** `/api/refresh` e `/api/probe` agora comparam `Origin` com `Host` e recusam `403` quando não batem (`_same_origin`); curl e scripts locais sem `Origin` continuam funcionando.
10. **~~`/metrics` caro e com moeda fixa.~~ Corrigido.** O scrape agora reaproveita o corpo por 20 s (`RUNE_METRICS_TTL`), e as métricas passaram a `rune_cost_today_usd` / `rune_provider_cost_usd` depois de descobrir que o 9router grava custo em USD — o painel exibia USD como BRL e ainda dividia pela taxa. A base agora é USD, a conversão acontece só na exibição e os orçamentos antigos são migrados uma vez. Os assets também ganharam `ETag` com `Cache-Control: no-cache`: reload revalida e recebe `304`, sem baixar os 600 KB de novo.

## 6. Roadmap priorizado

Os primeiros itens são os que fazem alguém pagar: prova de orquestração, orçamento por projeto, exportação contábil, instalador, alerta fora da aba e modo equipe. O resto protege o que já existe.

| # | Item | Impacto | Esforço | Status | Justificativa |
|---|---|---|---|---|---|
| 1 | Prova de orquestração por rota ("Testar rota" / "Testar todas") | alto | P | Feito: API + UI + dock | É o diferencial que nenhum concorrente cobre; a contagem "X de Y" já está na primeira dobra |
| 2 | Resumo "X de Y rotas respondem" na abertura | alto | P | Feito: métrica no dock do Atlas + cais no inspetor | O número mais caro do produto agora está na primeira dobra e sobrevive ao reload |
| 3 | Persistir o resultado da sonda por rota (último OK, código, latência, quando) | alto | M | Feito: `.rune-data/fleet.json` 0600 | Servidor grava o último estado e o painel hidrata no boot; falta virar série histórica e alerta |
| 4 | Orçamento por projeto | alto | M | Não | Só global e por provedor (`app.js:319`); projetos já têm caminho e sessões, falta custo |
| 5 | Exportação contábil mensal (CSV/PDF por projeto e modelo) | alto | P | Feito em CSV: `/api/export.csv` por dia/provedor/modelo | Falta ratear por projeto e gerar PDF; o CSV já fecha o mês em USD e neutraliza fórmulas de planilha |
| 6 | Instalador de um comando (brew/pipx/uvx) + launchd | alto | M | Feito: `./install.sh` + launchd | O serviço sobe no login, reinicia se cair e aponta para o clone; falta empacotar em brew/pipx |
| 7 | Alertas nativos no macOS + webhook | alto | P | Feito: vigia `RUNE_ALERT_INTERVAL` + `osascript` + webhook | Orçamento, cota, cache, erros e coleta parada saem da aba; webhook só HTTPS ou loopback, estado em `.rune-data/notify.json` |
| 8 | Modo equipe opcional (perfis locais, custo por operador) | alto | G | Não | Um operador só (`server.py:120-132`); é o que destrava compra por time sem virar SaaS |
| 9 | Retenção local de 12 meses (SQLite do Rune) | alto | G | Parcial: 12 meses lidos do `usageHistory` (`months`), sem banco próprio | Já há tendência mensal e comparação; falta retenção independente do 9router e custo por projeto |
| 10 | Testes de contrato do `/api/snapshot` + CI | médio | M | Feito: testes + workflow | Mudança de schema agora quebra o CI, não a tela do usuário |
| 11 | Orçamento e gasto do mês no servidor | alto | P | Feito: `settings.json` + `month` no snapshot | Projeção deixa de subestimar, orçamento vale fora da aba e `/metrics` expõe `rune_month_cost_usd` e `rune_month_projected_usd` |
| 11 | Lint de i18n e remoção de PT fixo | médio | P | Feito: `tests/test_i18n.mjs` no CI | Chave ausente ou variável divergente reprova o push |
| 12 | Cache do `/metrics` e moeda explícita | médio | P | Feito: TTL de 20 s + custo em USD | Custo em USD corrige a leitura de gasto; o cache tira o snapshot do caminho de cada scrape |
| 13 | Série de 12 meses no painel | médio | P | Feito: `months` no snapshot + card no Fluxo | Histórico mensal zero-preenchido, destaque do mês corrente e detalhe por tokens/chamadas/cache |

## 7. Fontes

- Langfuse — preços: https://langfuse.com/pricing
- Langfuse — self-hosting: https://langfuse.com/self-hosting
- Helicone — preços: https://www.helicone.ai/pricing
- LiteLLM — preços: https://www.litellm.ai/pricing
- LiteLLM — spend tracking: https://docs.litellm.ai/docs/proxy/cost_tracking
- OpenRouter — preços: https://openrouter.ai/pricing
- OpenRouter — Activity dashboard (ago/2026): https://openrouter.ai/blog/announcements/activity-dashboard/
- Portkey — preços: https://portkey.ai/pricing
- Cursor — usage e limites: https://cursor.com/help/models-and-usage/usage-limits
- Cursor — preços: https://cursor.com/pricing
- Claude Code — `/usage` e custos: https://code.claude.com/docs/en/costs
- Claude — planos: https://claude.com/pricing
- ccusage — repositório: https://github.com/ccusage/ccusage
- ccusage — guia: https://ccusage.com/guide/
- Grafana Cloud — free tier: https://grafana.com/products/cloud/free-tier/
- Grafana — dashboards: https://grafana.com/grafana/dashboards/
- Prometheus: https://prometheus.io
- Bifrost: https://github.com/maximhq/bifrost
- OpenAI — usage e custos: https://help.openai.com/en/articles/10478918-reviewing-api-usage-and-costs
- Linear: https://linear.app
- Vercel: https://vercel.com
- Raycast: https://www.raycast.com
- Observable: https://observablehq.com
- D3: https://d3js.org
