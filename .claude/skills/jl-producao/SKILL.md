---
name: jl-producao
description: Lança no Controle de Produção JL Vestuário o que o Gabriel mandar (texto, foto de caderno/romaneio ou ditado) e confere os dados. Use sempre que ele falar de corte, bobina, cortador, costureira, retorno, revisão, "prestou", pagamento, código R00XX, ou pedir para conferir/ver como está a produção.
---

# Lançamentos do Controle de Produção JL

O Gabriel não preenche mais o app na mão. Ele manda a informação do jeito dele (sem códigos); você identifica o lote, interpreta, confere, mostra um resumo curto, grava e confirma. Responda curto, em português do Brasil.

## O Gabriel nunca fala código nem id

Códigos (R00XX) e ids são internos: ele não sabe nem vai saber. Ele fala como fala no dia a dia ("a Mariani trouxe 52 do infantil preto", "mandei 3 bobinas de cinza pro Lucas", "paguei o João"). Você descobre sozinho, pelo `resumo`/`costureira <nome>`/`json producao`, qual corte/retorno é: pessoa, produto, cor, tamanhos, quantidades, datas e o que está em mãos. Se só um lote encaixa, use. Se houver mais de um possível, pergunte pelo que ele conhece (cor, produto, data aproximada, quantidade) — nunca peça código. Nas respostas para ele, descreva o lote por cor/produto/quantidade; o código pode aparecer só como referência no fim.

## Ferramenta

`ferramentas/jl.js` (neste repositório) grava direto no banco usando as mesmas fórmulas do app, com backup + histórico + trava de conflito numa gravação só.

- Com node (sessão na nuvem): `node ferramentas/jl.js <comando>`
- No Mac dele (sem node): `osascript -l JavaScript ferramentas/jl.js <comando>` (se estiver fora do repositório, baixe antes: `curl -sL https://raw.githubusercontent.com/jlvestuario-svg/Controle-de-Produ-o/main/ferramentas/jl.js -o /tmp/jl.js`)

Login: o banco exige login. O script entra como `claude@jlvestuario.app` usando a senha da variável `JL_SENHA` (sessão na nuvem) ou do arquivo `~/.jl_senha` (Mac). Se aparecer "Sem permissão no banco" ou "Login do script falhou", avise o Gabriel que a senha do script não está configurada; nunca peça a senha no chat nem a grave no repositório.

Comandos:
- `resumo`: corte em andamento, cortado sem costura, em mãos de cada costureira (com ids), aguardando revisão, a pagar
- `auditoria`: tudo que está inconsistente
- `codigo R0035`, `costureira Mariani`, `json config|fornecedores|insumosExtras|perdas|producao`
- `simular job.json`: mostra o resultado SEM gravar
- `gravar job.json`: grava (backup e histórico automáticos)
- `backups`: últimos lançamentos; `desfazer <id>`: volta producao/perdas ao estado anterior daquele lançamento

`job.json` = `{"op":"...","params":{...},"mensagem":"texto original que ele mandou"}`. Escreva o arquivo fora do repositório (ex.: /tmp) e nunca faça commit dele.

## Operações (`op` e `params`)

| op | quando | params |
|---|---|---|
| `envioCorte` | mandou bobinas pro cortador | `funcionario`, `data?`, `cores:[{cor, fornecedor, precoTecido?, precoRibana?, numeroPedido, bobinas:[{produto, sistema:"adulto"/"infantil", peso, pesoRibana, meta, tamanhos:["P","M"], valorUnit?}]}]` |
| `retornoCorte` | voltou do corte | `codigo` (ou `id`), `tamanhos:{"P":60}`, `data?`, `pago?` (padrão true), `enviarPara?:"Mariani"` (já manda pra costureira) |
| `envioCostura` | mandou um corte pra costureira | `funcionario`, `codigo` do corte, `tamanhos?` (padrão = o que foi cortado), `valorUnit?`, `data?` |
| `retornoCostura` | costureira trouxe peças | `funcionario`, `codigo?`, `tamanhos:{"4":52}`, `perdas?:{"6":2}` (não vão mais voltar), `pesoNaoCosturado?`, `data?`, `pago?` |
| `revisao` | conferiu quantas prestaram | `id` (ou `codigo` se só houver um retorno aguardando), `aproveitaveis`, `pesoDescartado?` |
| `pagamento` | pagou alguém | `funcionario`, `data?`, `aplicarCredito?` (padrão true) |
| `corrigirValor` | valor por peça errado/R$ 0 | `ids:[...]` ou `codigo`+`funcionario`, `valorUnit?` (sem ele usa a tabela do Cadastro, por faixa de tamanho quando houver) |

Padrões: data = hoje (Brasília); pago na retirada = sim, a menos que ele diga que não; preço do tecido = cadastro do fornecedor; valor por peça = tabela da pessoa no Cadastro. A Mariani tem preço por faixa no infantil ("2 ao 8" R$ 4, "10 ao 16" R$ 5): o script divide sozinho. Nunca invente peso, meta, tamanhos ou quantidades: se faltar, pergunte numa linha só.

Áudio em arquivo você não ouve: peça para ele ditar pelo microfone do teclado e mandar como texto. Foto: leia a imagem e transcreva os números; se algum número estiver ilegível, pergunte.

## Fluxo obrigatório

1. `resumo` (de onde vêm códigos, ids, o que cada costureira tem em mãos e nomes exatos).
2. Monte o job e rode `simular`. Se der ERRO, explique em uma linha e pergunte o que falta.
3. Mostre o resultado da simulação resumido (código, quem, tamanhos, total, valor a pagar, avisos) e pergunte "Lanço?". Só grave depois do sim.
4. `gravar`. Se vier CONFLITO, rode de novo a partir do passo 1.
5. Confirme com `codigo <R00XX>` e responda em 2–3 linhas. Guarde o id do backup na resposta.

## Cuidados

- Nada de excluir registro ou rodar `desfazer` sem ele confirmar o item exato.
- Mudanças no `index.html`: edições pontuais, checar sintaxe, e só publicar com ele de acordo.
- Nunca coloque token, senha ou dado pessoal de cliente/costureira em commit, PR ou mensagem.
- Pendências conhecidas: `auditoria` lista. Corrigir só com o ok dele, item a item.
