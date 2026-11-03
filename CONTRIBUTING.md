# Contribuir com o Rune

Obrigado pelo interesse. O Rune é local-first por princípio: qualquer contribuição deve preservar a privacidade, a leitura somente-leitura dos bancos e a exigência de API key do 9router.

## Ambiente

```bash
git clone <seu-fork>/rune-live.git
cd rune-live
./run.sh
```

Requisitos: macOS, Python 3.10+ e um 9router local com `~/.9router/db/data.sqlite`. Não é preciso instalar dependências Python.

## Antes de abrir um PR

```bash
node --check app.js
node --check i18n.js
python3 -m py_compile server.py collector/collect.py
curl -s http://127.0.0.1:8770/api/health
curl -s http://127.0.0.1:8770/api/security | python3 -m json.tool
curl -s http://127.0.0.1:8770/metrics | head
```

Teste também no navegador: abra o painel, navegue pelas alas, alterne idioma/moeda, crie um orçamento, exporte CSV e confira o console sem erros.

## O que aceitamos bem

- Correções de acessibilidade, contraste, teclado e responsividade.
- Novas traduções e revisões de PT/EN/ES.
- Novos provedores e formatos de cota, desde que sem expor segredos.
- Melhorias nos diagnósticos de erro e nas regras do Oráculo.
- Testes, documentação e exemplos de configuração.

## O que não aceitamos

- Qualquer código que envie dados para a nuvem por padrão.
- Exibição, log ou persistência de tokens, chaves ou prompts.
- Escrita no banco do 9router ou remoção da exigência de API key.
- Dependências pesadas para tarefas que a biblioteca padrão resolve.

## Estilo

- JavaScript sem framework, funções pequenas e nomes explícitos.
- Python com biblioteca padrão, sem dependências externas.
- Comentários apenas quando o “porquê” não é óbvio.
- Texto de interface sempre via `tr("chave")` em `i18n.js`, com PT/EN/ES.
- Novas alas seguem o padrão de `WING_RENDERERS` e `bindWing`.

## i18n

1. Adicione a chave nos três dicionários de `i18n.js`.
2. Use interpolação `{nome}` em vez de concatenar strings.
3. Verifique os três idiomas no painel antes de abrir o PR.

## Commits

Mensagens curtas no imperativo, focadas no porquê. Um PR por assunto. Descreva o que mudou, como testou e qual é o impacto na privacidade.

## Código de conduta

Seja direto e respeitoso. Discorde de ideias, não de pessoas. Não publique dados pessoais, caminhos locais ou capturas com informações reais.
