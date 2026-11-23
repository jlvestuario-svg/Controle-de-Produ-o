# Controle de Produção JL Vestuário

App de controle de produção de moletons (corte, costura, revisão, pagamentos, financeiro). Dono: Gabriel. Idioma: português do Brasil; respostas curtas e diretas.

- `index.html`: o app inteiro (HTML + CSS + JS), publicado pelo GitHub Pages em https://jlvestuario-svg.github.io/Controle-de-Produ-o/
- Dados: Firebase Firestore, projeto `controle-cfe01`, coleção `controle_producao_dados` (docs `producao`, `perdas`, `config`, `fornecedores`, `insumosExtras`, …; cada um com o campo `value` = JSON em texto). Backups em `controle_producao_backups`, histórico em `controle_producao_log`.
- `ferramentas/jl.js`: lançamentos e conferência sem abrir o app.

**Quando o Gabriel mandar qualquer informação de produção (corte, costura, retorno, revisão, pagamento, foto de caderno), use a skill `jl-producao` (`.claude/skills/jl-producao/SKILL.md`).** Ele quer só mandar a informação e ter tudo lançado e conferido.

Regras de negócio: pagamento sobre a quantidade retornada (não a enviada), pago na retirada; crédito da costureira = só o valor da costura; preços travados na entrada do lote; código de rastreio R00XX nasce no corte e a costura herda.

Ao mexer no código: edições pontuais, sem reescrever; não commitar arquivos de teste nem dados.
