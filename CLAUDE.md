# Pururuca Bowl — site de zoeira da liga de fantasy football

Contexto de passagem: este projeto começou no app do Claude e continua no Claude Code.
Leia tudo antes de tocar em qualquer arquivo.

## Quem e o quê

- Dono: Filipe (usuário Sleeper `filipesaliba`, GitHub `filipesaliba88`). Programa, mas o site
  tem que exigir **zero manutenção** dele durante a temporada. Tudo que depende de alguém
  atualizar na mão morre na semana 5 — isso é regra de design, não preferência.
- Liga: **Pururuca Bowl**, no Sleeper. 10 managers, grupo de amigos. Temporada 2026 é a
  segunda no Sleeper; a de 2025 está encadeada via `previous_league_id` (confirmado: o site
  mostrou "2 temporadas no histórico").
- League ID atual: `1389719862191849472`. Draft de 2026 estava em andamento em 07/09/2026;
  temporada regular da NFL começa 10/09/2026.
- Repositório: `github.com/filipesaliba88/pururuca-bowl`, publicado via GitHub Pages em
  `https://filipesaliba88.github.io/pururuca-bowl/` (branch `main`, raiz).
- Tom do site: zoeira ácida entre amigos. Prêmios são majoritariamente de vergonha.

## Estado atual (o que já existe e funciona)

Dois arquivos HTML estáticos, sem build, sem backend, sem framework. Cada um busca os dados
diretamente da API pública do Sleeper no navegador ao carregar. **Confirmado em produção:**
a API aceita chamadas de navegador (CORS aberto), então essa arquitetura está validada.

### `index.html` (chamado de `liga.html` no chat)
Página principal, "Hall da Vergonha". Abas:
- **Draft** — status do draft, prêmios em tempo real (Colecionador de RB, Rei dos WR,
  Acumulador de QB com 3+ na posição; Kicker/Defesa precoce até 60% das rodadas do draft;
  Torcedor declarado com 3+ jogadores do mesmo time NFL; Mr. Irrelevant quando fechar),
  tabela de posições por manager, últimas 15 picks.
- **Rodada** — seletor de semana e 5 prêmios: Mão de Alface (mais pontos no banco),
  Cadeirada (derrota pela menor margem), Vexame (derrota pela maior margem), Pé Frio
  (menor pontuação), Canhão (maior pontuação).
- **Jornal** — manchetes montadas por regras a partir dos prêmios. Vai ser substituído
  (ver "Próxima fase").
- **Ranking da vergonha** — acumulado anual. Pesos: Alface 2, Cadeirada 1, Vexame 2,
  Pé Frio 3.
- **Rivalidades** — head-to-head acumulado entre todas as temporadas encontradas, com
  placar quebrado por ano. Só temporada regular.
- **Fichas** — campanha, pontos, banco, trades, campanhas por temporada, antecedentes.
- Link "2025" no menu para a página de temporada.

Detalhes de implementação relevantes:
- Constante `LEAGUE_IDS_ANTERIORES = []` no topo: lista manual para ligas antigas não
  encadeadas. Hoje vazia porque a cadeia funciona.
- `processaRodada(semana, matchups, nomes)` é a função central de cálculo. Reutilize a
  lógica no script do Action em vez de reescrever — os prêmios têm que bater com o site.
- "Mão de Alface" = soma de `players_points` dos não-titulares. **Não** é escalação ótima
  (isso exigiria regras de posição/flex; fica para depois se alguém pedir).
- Sem nomes de jogador nas abas de rodada: a lista de jogadores do Sleeper tem ~5 MB e não
  faz sentido baixar no cliente. Nomes só aparecem no Draft (vêm no `metadata` da pick).
- Semana considerada pontuada = algum matchup com `points > 0`. Regular = semanas
  `< settings.playoff_week_start`.

### `temporada-2025.html`
Resumo da temporada 2025. Acha a liga sozinha seguindo `previous_league_id` até
`season === "2025"`. Seções: pódio (campeão/vice/3º via `winners_bracket`, entradas com
`p === 1` e `p === 3`; lanterna = pior campanha regular, **não** o toilet bowl),
classificação com coluna "Sorte" (posição por pontos menos posição na tabela), prêmios do
ano acumulados, recordes, rivalidades do ano, movimentações (trades e waivers por
manager), draft 2025 (primeira pick, Mr. Irrelevant, melhor pick, bust até a 3ª rodada,
roubo a partir da 8ª — pontos por jogador = soma de `players_points` dentro da liga),
memória (bloco `MEMORIA` no topo do script, preenchido à mão; seção some se vazio),
ficha por manager.

**Ainda não validado por Filipe no momento da passagem:** se o campeão bateu com a
realidade e se os nomes de jogador do draft aparecem. Pergunte a ele antes de assumir.

### Visual
- Fontes Google: Archivo Black (display) + Archivo. Paleta: grama `#0F3D2E`, cal
  `#F3EFE4`, amarelo `#F5C518`, vermelho `#D0342C`, asfalto `#1C1C1C`, cinza `#6B6B63`.
- Fundo verde com listras finas de "linha de jarda". Cards creme, selos amarelos
  (vermelhos para prêmios ruins). Layout mobile-first; a liga acessa pelo celular.
- Logo da liga: escudo tijolo com porco e pururuca, texto "PURURUCA BOWL" em creme
  (arquivo do Filipe, ainda não está no repositório).

### Assets do personagem (Filipe já gerou, precisa subir em `assets/`)
"Seu Pururuca": porco velho rabugento, boina, óculos redondos na ponta do focinho, camisa
laranja de mangas dobradas, colete tijolo; estilo flat retrô, contorno preto grosso, fundo
creme com faixa laranja de balcão. Arquivos combinados:
`pururuca-avatar.png` (só o rosto), `pururuca-alface.png` (facepalm com celular),
`pururuca-vexame.png` (rindo, batendo na mesa), `pururuca-cadeirada.png` (susto, boina
voando), `pururuca-canhao.png` (joinha a contragosto), `pururuca-draft.png` (prancheta).
Use cada um na seção/prêmio correspondente.

## Próxima fase: Jornal com IA + relatório no Telegram

Decidido com Filipe:

1. **GitHub Action semanal**, toda terça às 10h de Brasília (13:00 UTC), depois do Monday
   Night. O Sleeper não tem webhook; é por horário. Na terça, `/state/nfl` já pode apontar
   para a semana seguinte — usar `week - 1` como a rodada que fechou, e conferir que ela
   tem pontos.
2. **Script** (Node, sem dependências pesadas) que: baixa a rodada fechada, os matchups,
   transações da semana, rosters, users, e a lista de jogadores (`/players/nfl`, ok no
   servidor) para citar nomes; calcula os prêmios com a **mesma lógica do site**; monta o
   contexto por confronto; chama a API da Anthropic; salva
   `data/jornal/2026-rodada-NN.json`; commita; envia versão texto ao Telegram.
3. **Site** passa a ler `data/jornal/*.json` no Jornal, com seletor de edição (igual ao da
   aba Rodada). Nada é sobrescrito: na semana 7 dá para reler a semana 2. Enquanto não
   houver JSON da semana, cai no Jornal por regras que já existe.
4. **Segredos** em Settings → Secrets do repositório: `ANTHROPIC_API_KEY`,
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Filipe ficou de criar a chave (console da
   Anthropic, crédito pré-pago) e o bot (@BotFather). Nunca colocar chave no HTML.
5. **WhatsApp está descartado** como envio automático — decisão reafirmada em 08/09/2026,
   depois de avaliar as duas rotas a fundo:
   - **API oficial (Cloud API):** não manda para grupo (é 1:1 empresa↔cliente) e exige
     modelo pré-aprovado pela Meta, o que inviabiliza uma coluna de 8 mil caracteres.
     O preço é irrelevante porque a ferramenta não faz o que se precisa.
   - **Baileys / whatsapp-web.js:** funcionam e o código é simples, mas exigem sessão
     24h numa VPS, arriscam banir o número e caem algumas vezes por ano exigindo ler
     QR code na mão. Filipe tem VPS, então o custo não era o problema — o problema era
     virar a peça que morre na semana 5.
   **Telegram é o canal.** Para levar ao WhatsApp existe o botão "copiar para o WhatsApp"
   no Jornal e na retrospectiva, que converte a edição para *negrito* e _itálico_ do
   WhatsApp numa mensagem só.

### Formato editorial do Jornal (decidido)
- **Seu Pururuca é o colunista fixo** toda semana: coluna curta e ácida sobre a rodada
  inteira — entrega os prêmios com comentário, cutuca a tabela, escolhe uma vítima.
  Personalidade: velho de boteco, rabugento, sarcástico, odeia todo mundo igual, nunca
  elogia sem ressalva.
- **Comentarista convidado em rodízio**, um por semana, analisa cada confronto no
  personagem. Elenco inicial: Michael Scott, Ted Mosby, Darth Vader. Pode ampliar.
  **Não usar pessoas reais** (Galvão, Datena etc.) — decisão consciente: nada de fala
  inventada na boca de gente de verdade, mesmo em zoeira. Só personagens ficcionais ou
  inventados da liga.
- **Tudo em português**, inclusive personagens gringos.
- Por confronto, o comentarista recebe e aborda: placar e margem; herói e vilão de cada
  lado (titular que mais e que menos pontuou); pontos deixados no banco com nome de quem
  ficou sentado; retrospecto entre os dois (incluindo 2025), posição na tabela, sequência;
  trades/waivers da semana envolvendo os dois. Entrega: resumo, momento decisivo, veredito
  curto para cada lado.
- Saída do modelo em JSON estruturado (por confronto + coluna), para o site renderizar e
  o Telegram receber só o texto.

## Ideias aprovadas para depois (não construir agora)
Tribunal de trades (liga vota "assalto" ou "justa"), punição do lanterna com enquete e
galeria, cassino com moeda fictícia. Todas dependem de participação do grupo; só entram se
a fase automática engajar.

## Como Filipe quer trabalhar
- Explicite premissas antes de construir; se houver mais de uma interpretação, pergunte ou
  mostre as opções.
- Correções pontuais em vez de regenerar arquivo inteiro.
- Se existir caminho mais simples, diga. Discorde quando for o caso.
- Só afirme com convicção; se não souber, diga "não sei".
- Não ofereça "site espetacular com tudo": priorize o que roda sem esforço humano.
- Ele testa no celular e manda print. Peça o print quando algo depender de dado real.
