# Segurança

## Modelo de ameaça

O Rune foi desenhado para uma máquina pessoal com 9router local. O servidor escuta apenas em `127.0.0.1` e não tem autenticação própria — quem já executa código na sua sessão de usuário não ganha nada novo com ele. O que importa é não expor o painel e não transformar metadados em credenciais.

## Garantias

- Leitura somente-leitura dos bancos SQLite (`mode=ro`).
- Nenhum token OAuth, API key ou senha é exibido, gravado pelo painel ou enviado pela rede.
- Chaves do 9router aparecem apenas por `keyId` e nunca por valor completo.
- E-mails e padrões de segredo são mascarados antes de qualquer resposta HTTP.
- Prompts, respostas e trechos de código não são persistidos.
- Arquivos de dados e configuração são gravados com permissão `0600`.
- O servidor não altera permissões, não escreve no banco do 9router e não remove a exigência de API key do 9router.
- Não usa refresh token do Claude.
- `POST` exige que o `Origin` (quando presente) corresponda ao `Host` local: outra página aberta no navegador não consegue disparar `/api/refresh` nem `/api/probe` via `localhost`.

## Sonda de orquestração

`POST /api/probe` prova se uma rota do 9router responde de verdade, porque o catálogo lista modelos já desligados.

- A chave usada é a chave ativa do 9router, lida em memória e somente-leitura (`mode=ro`) no momento da chamada. Ela nunca é devolvida, gravada pelo painel ou enviada para fora do `127.0.0.1`.
- Cada teste é uma chamada `POST /v1/chat/completions` com `messages: [{"role":"user","content":"ping"}]` e `max_tokens: 1`.
- O painel persiste apenas `connection`, `model`, `latency_ms`, código HTTP, mensagem de erro mascarada e horário em `.rune-data/fleet.json`, com diretório `0700` e arquivo `0600`. Prompts, respostas e a chave não entram no arquivo.
- No máximo 3 sondagens rodam em paralelo para não saturar a máquina, e o resultado de cada rota é reaproveitado por 60 segundos.

## Auditoria local

`GET /api/security` faz checagens somente-leitura e devolve achados com correção sugerida:

1. servidor escutando apenas em loopback;
2. permissões de `data.json`, `config.json`, `~/.9router/db/data.sqlite`, banco do Qoder e diretórios;
3. varredura por padrões de segredo nos arquivos do coletor (sem devolver o valor);
4. túnel do 9router ativo com chave válida e restrição de modelos;
5. uso de SQLite somente-leitura;
6. mascaramento de credenciais e ausência de prompts no coletor.

O painel mostra o resultado em **Perfil → Segurança local** e permite copiar a correção. A auditoria não aplica nada automaticamente.

## Reportar

Encontrou uma falha? Abra uma issue privada pelo canal de segurança do repositório ou envie um e-mail para o mantenedor listado no perfil do GitHub. Não publique segredos, caminhos pessoais ou capturas com dados reais em issues públicas.

Inclua:

- versão do Rune (commit) e do sistema;
- passos para reproduzir sem dados sensíveis;
- impacto observado;
- se possível, uma sugestão de correção.

## Escopo fora do Rune

Vulnerabilidades no 9router, Qoder Desktop, provedores de IA ou no seu túnel Cloudflare devem ser reportadas aos projetos responsáveis. O Rune apenas lê dados locais e nunca contorna a proteção de API key do 9router.
