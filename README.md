# Rune

[![CI](https://github.com/netorojas/rune/actions/workflows/ci.yml/badge.svg)](https://github.com/netorojas/rune/actions/workflows/ci.yml)

**Central local-first de controle do seu uso de IA.**
Tokens, custo, cota, saúde, orçamento e diagnóstico — sem conta, sem nuvem, sem enviar seus dados para lugar nenhum.

Rune lê metadados locais do [9router](https://github.com/9router), do Qoder Desktop e do coletor `~/.ai-usage`, e transforma tudo em um porto 3D explorável com dez alas: Atlas, Fluxo, Sessões, Oficina, Oráculo, Biblioteca, Diário, Guilda, Perfil e Ajuda.

> **Status:** alpha funcional. Feito para macOS; o coletor e o servidor usam caminhos locais e podem ser adaptados para Linux/Windows.

![Porto Rune: mapa 3D com fonte, IAs e ferramentas](docs/screenshot.png)

[English](#english) · [Começar](#começar) · [Privacidade](#privacidade) · [Contribuir](#contribuir)

---

## Por que existe

Ferramentas de IA cobram por token, por crédito e por janela de uso. O gasto real fica espalhado entre provedores, modelos, assinaturas e chaves. O Rune junta esses sinais em um só lugar e responde:

- **Quanto eu gastei hoje, nesta semana e neste mês?**
- **Qual provedor está lento, falhando ou com pouca folga de cota?**
- **Quanto o mês fecha se o ritmo continuar?**
- **Qual tarefa está desperdiçando tokens e por quê?**
- **O que eu faço agora para corrigir um erro ou reduzir custo?**
- **Meu ambiente local está exposto?**

## O que já funciona

| Área | O que você vê e faz |
|---|---|
| **Atlas** | Porto 3D navegável: a fonte (9router), as IAs e as ferramentas instaladas, cada uma com seu papel. Clique numa construção para ver o que ela faz, sua fatia de uso e a próxima ação. |
| **Fluxo** | Consumo por dia/hora, projeção do mês, orçamento global e por provedor. |
| **Sessões** | Chamadas recentes, projetos, latência, status e diagnóstico por provedor. |
| **Oficina** | Inventário de CLIs/apps, skills, artefatos e sinais de desperdício. |
| **Oráculo** | Assistente local por regras: lê seus números e propõe ações. Nenhuma IA na nuvem. |
| **Biblioteca** | Manual da frota: finalidade de cada IA, comparações e como administrar o consumo. |
| **Diário** | Changelog, conquistas e memória da operação. |
| **Guilda** | Comunidade, roadmap e próximos passos — via GitHub, sem login. |
| **Perfil** | Conexões mascaradas, fontes locais, idioma/moeda, privacidade e auditoria de segurança. |
| **Ajuda** | Erros agrupados com causa provável, correção e prompt pronto para copiar. |

### Monitoramento de verdade

- **Frota viva** lida do 9router em `/v1/models`: cada IA plugada, quantos modelos ela tem, contexto máximo e capacidades (visão, ferramentas, raciocínio, gratuito).
- **Sonda de orquestração** ("Testar rotas"): prova com uma chamada de 1 token se a rota responde de verdade, sem depender do que o catálogo promete. O resultado fica em `.rune-data/fleet.json` (`0600`) e sobrevive ao reload; o número "X de 11 rotas respondem" aparece no dock do Atlas.
- **Orçamentos** em BRL, USD ou EUR, com limite global, limite por provedor e marcador de alerta (60–90%). O custo-base é USD, como o 9router grava; a conversão acontece só na exibição e no formulário.
- **Motor de alertas** para orçamento estourado, cota baixa, cache abaixo da meta, erros e coleta parada.
- **SLO por provedor** na janela de 7 dias: p50, p95, tempo até o primeiro token e taxa de erro.
- **Exportação CSV** com série diária e resumo por provedor, em `cost_usd`.
- **Endpoint Prometheus** em `/metrics` (`rune_cost_today_usd`, `rune_provider_cost_usd`) com cache de 20 s para não remontar o snapshot a cada scrape.
- **Auditoria local** de permissões de arquivo, segredos em texto, exposição do 9router e exigência de API key.
- **Manual "Como jogar"** em 5 passos, com checklist ao vivo do que já está funcionando.
- **Idiomas** PT-BR, EN e ES, com troca imediata e moeda BRL/USD/EUR (taxas editáveis).

## Começar

### Requisitos

- macOS (caminho do Qoder Desktop é específico do macOS; Linux/Windows exigem ajuste).
- Python 3.10+ (somente biblioteca padrão).
- [9router](https://github.com/9router) rodando localmente, com `~/.9router/db/data.sqlite`.
- Opcional: Qoder Desktop e o coletor `~/.ai-usage` para dados complementares.

### Rodar

```bash
git clone https://github.com/netorojas/rune.git
cd rune
./run.sh
```

O `run.sh` cria `.rune-data/`, roda o coletor, sobe o servidor em `127.0.0.1:8770` e abre o navegador.

Se você já usa o coletor em `~/.ai-usage`:

```bash
AI_USAGE_HOME="$HOME/.ai-usage" python3 server.py
```

### Instalar como serviço (macOS)

```bash
./install.sh
```

O instalador registra um agente `launchd` de usuário (`com.netorojas.rune`) apontando para este clone: o painel sobe no login, reinicia se cair e grava logs em `~/Library/Logs/Rune`. Não usa `sudo`, não copia o código e não mexe no 9router.

- Atualizar: `git pull && ./install.sh`
- Remover o serviço: `./install.sh --uninstall` (dados, logs e o clone ficam)
- Conferir o plist sem instalar: `./install.sh --print-plist`

### Testes

```bash
python3 -m unittest discover -s tests -v   # contratos do servidor
node --check app.js && node --check i18n.js
node tests/test_i18n.mjs                   # cobertura PT/EN/ES
```

O CI em `.github/workflows/ci.yml` roda os mesmos comandos a cada push e pull request.

### Variáveis

| Variável | Padrão | Para quê |
|---|---|---|
| `RUNE_PORT` | `8770` | Porta local do painel. |
| `RUNE_HOST` | `127.0.0.1` | Interface de escuta. Mantenha loopback. |
| `AI_USAGE_HOME` | `~/.ai-usage` | Onde ficam `data.json`, `config.json` e o coletor. |
| `RUNE_NO_OPEN` | vazio | Defina `1` para o `run.sh` não abrir o navegador. |
| `RUNE_OPERATOR` | nome do sistema | Como o Rune chama você (também editável no Perfil). |
| `RUNE_METRICS_TTL` | `20` | Segundos de cache do `/metrics` (o snapshot é caro; Prometheus bate a cada 15 s). |

## API local

| Rota | Método | Conteúdo |
|---|---|---|
| `/api/snapshot` | GET | Snapshot completo usado pelo painel, incluindo `fleet.routes` com o último resultado de cada rota. |
| `/api/fleet` | GET | Catálogo vivo do 9router (`/v1/models`): modelos, donos, contexto e capacidades. |
| `/api/probe` | POST | Sonda de orquestração. Corpo `{"connection":"codex"}` testa a rota, `{"model":"cx/gpt-6.1-sol"}` testa um modelo e `{"all":true}` testa todas. Cada teste é uma chamada de 1 token. |
| `/api/security` | GET | Auditoria local, com achados e correções. |
| `/metrics` | GET | Métricas Prometheus. |
| `/api/health` | GET | Processo e porta. |
| `/api/refresh` | POST | Executa o coletor e devolve um snapshot novo. |

`POST` recusa requisições cujo `Origin` não corresponde ao `Host` local — outra aba aberta no navegador não consegue disparar coleta nem gastar token pelo `localhost`.

## Privacidade

O contrato do Rune é curto e verificável no código:

- O painel e o coletor rodam **100% na sua máquina**.
- **Nunca** exibem ou enviam tokens OAuth, API keys ou senhas.
- Usam tokens já guardados pelo 9router **apenas** para consultar cotas oficiais.
- **Não** removem a exigência de API key do 9router — ela protege a exposição via `0.0.0.0` + túnel Cloudflare.
- Mostram apenas `keyId`/prefixo de chave, nunca o segredo completo.
- Arquivos de dados são gravados com permissão `0600`.
- **Não** escrevem no banco do 9router; a leitura é `mode=ro`.
- **Não** usam refresh token do Claude.
- Prompts, respostas e trechos de código **não** são persistidos nem enviados.
- A sonda de orquestração envia somente `ping` com `max_tokens: 1` pelo 9router; nenhum conteúdo seu entra na sondagem. O painel guarda apenas modelo, latência, código HTTP e horário em `.rune-data/fleet.json` (`0600`).

O único tráfego externo possível é o que o próprio 9router já faz para falar com os provedores.

## Arquitetura

```text
~/.9router/db/data.sqlite ─┐
~/.ai-usage/data.json ─────┼─▶ collector/collect.py ─▶ data.json (0600)
Qoder Desktop (main.sqlite)┘                              │
                                                          ▼
                                        server.py (127.0.0.1:8770)
                                          ├── /api/snapshot
                                          ├── /api/fleet · /api/probe
                                          ├── /api/security
                                          ├── /metrics
                                          └── index.html + app.js + i18n.js + styles.css
```

- `server.py`: HTTP local, leitura somente-leitura dos SQLite, agregação SLO, métricas e auditoria.
- `collector/collect.py`: coleta metadados de uso, cota, inventário e projetos.
- `app.js`: runtime do painel, dez alas, orçamento, alertas, missões/XP, i18n e câmbio.
- `i18n.js`: dicionários PT/EN/ES.
- `styles.css`: identidade editorial, porto 3D explorável, shell responsivo, temas dia/crepúsculo e componentes.

## Segurança

Leia [SECURITY.md](SECURITY.md). A auditoria do painel é somente leitura e nunca altera permissões, chaves ou configurações.

## Contribuir

Leia [CONTRIBUTING.md](CONTRIBUTING.md). Issues e Discussions são o canal da comunidade; o Rune não tem login nem conta na nuvem.

## Licença

[MIT](LICENSE). Rune não é afiliado ao 9router, Qoder, OpenAI, Anthropic, Google ou qualquer outro provedor.

---

## English

**Rune is a local-first control center for your AI usage.** Tokens, cost, quota, health, budgets and diagnostics — no account, no cloud, no data leaving your machine.

### Why

AI costs are split across providers, models, subscriptions and keys. Rune turns local metadata from 9router, Qoder Desktop and the `~/.ai-usage` collector into an explorable 3D port with ten functional wings.

The Atlas separates the source (9router, the local router — not an AI), the AIs that answer and the tools where you work. Click any building to see its role, usage share and next action. A five-step "How to play" manual shows how to wire your AI tools into the panel with a live checklist.

### Features

- Ten functional wings: overview, flow, sessions, workshop, local assistant, fleet manual, changelog, community, profile and help.
- Live fleet read from 9router plus a 1-token orchestration probe per route ("X of 11 routes answering"), persisted locally so it survives a reload.
- Navigable 3D Atlas plus a five-step interactive manual with live collection checks.
- Global and per-provider budgets with forecast and threshold alerts.
- 7-day SLOs: p50, p95, time to first token and error rate.
- CSV export and a Prometheus `/metrics` endpoint.
- Local security audit: file permissions, plaintext secrets, 9router tunnel and API-key requirement.
- PT-BR, EN and ES, with BRL/USD/EUR conversion.
- Read-only SQLite access, loopback-only server, `0600` data files and masked credentials.

### Quick start

```bash
git clone https://github.com/netorojas/rune.git
cd rune
./run.sh
```

Requires macOS, Python 3.10+ and a local 9router database at `~/.9router/db/data.sqlite`. The dashboard runs at `http://127.0.0.1:8770`. Run `./install.sh` to register a per-user launchd agent so the panel starts at login and restarts if it crashes.

### Privacy contract

Runs entirely on your machine. Never displays or uploads OAuth tokens or API keys. Uses 9router-stored tokens only to query official quota endpoints. Does not remove 9router's API key requirement, does not write to its database and does not persist prompts or code.

### License

MIT. Not affiliated with 9router, Qoder, OpenAI, Anthropic, Google or any other provider.
