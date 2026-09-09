#!/usr/bin/env node
// Jornal da Pururuca Bowl — gera a edição semanal.
//
// Roda na terça de manhã pela GitHub Action, depois do Monday Night.
// Baixa a rodada que fechou, calcula os prêmios com a MESMA lógica do site
// (processaRodada em index.html), monta o contexto por confronto, chama a API
// da Anthropic e salva data/jornal/2026-rodada-NN.json.
//
// Uso:
//   node scripts/jornal.mjs              # rodada fechada, ciclo completo
//   node scripts/jornal.mjs --dry-run    # só o contexto, sem chamar a IA nem o Telegram
//   SEMANA=3 node scripts/jornal.mjs     # força uma semana específica
//   FORCE=1 node scripts/jornal.mjs      # regrava uma edição que já existe
//   node scripts/jornal.mjs --draft      # edição especial do draft, só quando ele fecha
//   node scripts/jornal.mjs --jogadores  # atualiza o mapa de nomes que o site usa
//   node scripts/jornal.mjs --previa     # prévia de quinta, antes de a rodada começar

import fs from "node:fs";
import path from "node:path";
// O SDK da Anthropic é carregado sob demanda, para o --dry-run rodar sem instalar nada.

// LEAGUE_ID pode ser sobrescrito por env para testar contra temporadas antigas.
const LEAGUE_ID = process.env.LEAGUE_ID || "1389719862191849472";
const API = "https://api.sleeper.app/v1";
const DIR = "data/jornal";
const SITE = "https://pururucabowl.com.br/";
const MODELO = "claude-opus-5";

// Precisa bater com o ROTULO de index.html: é assim que o modelo aprende
// como o prêmio se chama. Mandar o nome interno faria ele escrever "o Alface da semana".
const ROTULO = {
  alface: "Cemitério de Craques",
  cadeirada: "O Choro é Livre",
  vexame: "Vexame",
  pefrio: "Várzea",
  canhao: "Bola Cheia",
};

const DRY = process.argv.includes("--dry-run");
const FORCE = !!process.env.FORCE;

// Comentaristas convidados, um por rodada, em rodízio determinístico pela semana.
// Só personagens de ficção — nada de pessoa real. Ver CLAUDE.md.
const CONVIDADOS = [
  {
    nome: "Michael Scott",
    persona:
      "Michael Scott, o gerente regional de The Office. Acha que é o cara mais engraçado " +
      "da sala, faz analogias que não fecham, se emociona sem motivo, cita 'negócios' e " +
      "'liderança' fora de hora, e às vezes diz uma verdade dura sem perceber o peso dela.",
  },
  {
    nome: "Seu Barriga",
    persona:
      "Seu Barriga, o dono da vila do Chaves. Vive cobrando aluguel atrasado e nunca recebe, " +
      "leva pancada na cabeça e continua cobrando. Trata pontos deixados no banco como dívida, " +
      "faz conta de prejuízo em voz alta e mistura cobrança com autopiedade.",
  },
  {
    nome: "Ted Mosby",
    persona:
      "Ted Mosby, de How I Met Your Mother. Arquiteto, romântico insuportável, transforma " +
      "qualquer coisa em uma história longa com moral no fim, corrige gramática dos outros, " +
      "e insiste que o destino explica o que foi só sorte.",
  },
  {
    nome: "Capitão Nascimento",
    persona:
      "Capitão Nascimento, de Tropa de Elite. Grita, trata escalação como operação tática e " +
      "erro como indisciplina. Fala em missão, coluna e cadeia de comando. Manda quem não " +
      "aguenta pedir pra sair. Não tem a menor paciência para desculpa.",
  },
  {
    nome: "Dona Florinda",
    persona:
      "Dona Florinda, do Chaves. Esnobe, se acha acima de todos, chama os outros de gentalha " +
      "e culpa sempre o vizinho. Protege o favorito da rodada como se fosse o filho dela, e " +
      "trata quem venceu por sorte como praga do bairro.",
  },
  {
    nome: "Darth Vader",
    persona:
      "Darth Vader. Fala pouco e pesado, trata fantasy football como assunto imperial, " +
      "despreza fraqueza, usa metáforas de Força e destino, e ameaça consequências " +
      "desproporcionais para erros de escalação.",
  },
  {
    nome: "Odorico Paraguaçu",
    persona:
      "Odorico Paraguaçu, o prefeito de O Bem-Amado. Discurso empolado e pomposo, inventa " +
      "palavras terminadas em -idade e -ismo, promete obras que nunca saem, e transforma " +
      "qualquer resultado medíocre em feito histórico do município.",
  },
  {
    nome: "Thor",
    persona:
      "Thor, o deus nórdico do trovão da mitologia viking. Fala em tom épico e arcaico, " +
      "com 'vós' e 'haveis', trata a rodada como batalha por glória, promete Valhalla a " +
      "quem venceu e desprezo eterno a quem errou a escalação, e não entende metade das " +
      "regras modernas do fantasy football.",
  },
  {
    nome: "O Comissário",
    persona:
      "O Comissário, vilão inventado da própria Pururuca Bowl: um lorde sombrio de armadura " +
      "que administra a liga e se acha dono do destino de todos. Fala baixo e ameaçador, cita " +
      "regulamento e cláusulas como se fossem sentenças, trata derrota como falha de caráter " +
      "e insinua punições que não existem.",
  },
  {
    nome: "Gollum",
    persona:
      "Gollum, de O Senhor dos Anéis. Fala de si na terceira pessoa, sibila, chama o que " +
      "deseja de 'meu precioso' e briga consigo mesmo: uma metade bajula, a outra destrói. " +
      "Use essa divisão nos dois vereditos de cada confronto.",
  },
  {
    nome: "Dwight Schrute",
    persona:
      "Dwight Schrute, de The Office. Corrige todo mundo, cita fatos que ninguém pediu, adora " +
      "hierarquia e procedimento, se acha o melhor em tudo e mede o mundo por critérios " +
      "próprios e absurdos. Menospreza quem não segue regra.",
  },
  {
    nome: "Sherlock Holmes",
    persona:
      "Sherlock Holmes. Dedução minuciosa e arrogante: encadeia observações microscópicas com " +
      "ar de gênio para chegar, com enorme pompa, a conclusões óbvias. Trata cada derrota " +
      "como caso criminal e o manager como suspeito.",
  },
  {
    nome: "Mestre Yoda",
    persona:
      "Mestre Yoda. Inverte a ordem das frases, fala pouco e devagar, entrega sabedoria antiga " +
      "que não ajuda ninguém a escalar melhor, e enxerga em cada derrota uma lição sobre medo, " +
      "apego e paciência.",
  },
  {
    nome: "O Narrador",
    persona:
      "Um narrador de documentário de natureza — personagem inventado, não uma pessoa real. " +
      "Fala baixo e solene, observa os managers como fauna em habitat: comportamento de manada, " +
      "disputa territorial, ritual de dominância. Nunca interfere no que vê.",
  },
];

// Arredonda para 2 casas. Sem isso o JSON do prompt vai cheio de 19.599999999999994.
const r2 = (n) => Math.round((n || 0) * 100) / 100;

const fmt = (n) =>
  (Math.round(n * 100) / 100).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Sleeper ${r.status} em ${url}`);
  return r.json();
}

const sleeper = (p) => getJSON(`${API}${p}`);

function montaNomes(users, rosters) {
  const n = {};
  for (const r of rosters) {
    const u = users.find((x) => x.user_id === r.owner_id) || {};
    n[r.roster_id] = {
      manager: u.display_name || `Roster ${r.roster_id}`,
      // O Sleeper devolve nome de time com espaço sobrando nas pontas.
      time: (u.metadata?.team_name || "").trim() || u.display_name || `Time ${r.roster_id}`,
    };
  }
  return n;
}

// Espelha processaRodada() de index.html. Se mudar lá, muda aqui.
function processaRodada(semana, ms, nomes) {
  if (!ms || !ms.length) return null;
  if (!ms.some((m) => (m.points || 0) > 0)) return null;

  const times = ms.map((m) => {
    const pp = m.players_points || {};
    const starters = new Set(m.starters || []);
    const banco = (m.players || [])
      .filter((p) => !starters.has(p))
      .reduce((s, p) => s + (pp[p] || 0), 0);
    return { roster: m.roster_id, matchup: m.matchup_id, pontos: m.points || 0, banco };
  });

  const porMatchup = {};
  for (const t of times) (porMatchup[t.matchup] ||= []).push(t);
  const jogos = Object.values(porMatchup)
    .filter((p) => p.length === 2)
    .map(([a, b]) => {
      const [v, d] = a.pontos >= b.pontos ? [a, b] : [b, a];
      return {
        vencedor: v.roster,
        perdedor: d.roster,
        pv: v.pontos,
        pd: d.pontos,
        margem: v.pontos - d.pontos,
      };
    });

  const alface = [...times].sort((a, b) => b.banco - a.banco)[0];
  const canhao = [...times].sort((a, b) => b.pontos - a.pontos)[0];
  const pefrio = [...times].sort((a, b) => a.pontos - b.pontos)[0];
  const cadeirada = [...jogos].sort((a, b) => a.margem - b.margem)[0];
  const vexame = [...jogos].sort((a, b) => b.margem - a.margem)[0];

  const premios = [];
  premios.push({
    tipo: "alface",
    roster: alface.roster,
    texto: `Deixou ${fmt(alface.banco)} pontos apodrecendo no banco.`,
  });
  if (cadeirada)
    premios.push({
      tipo: "cadeirada",
      roster: cadeirada.perdedor,
      texto: `Perdeu por ${fmt(cadeirada.margem)} para ${nomes[cadeirada.vencedor].manager}. Ninguém merece.`,
    });
  if (vexame)
    premios.push({
      tipo: "vexame",
      roster: vexame.perdedor,
      texto: `Levou ${fmt(vexame.pv)} a ${fmt(vexame.pd)} de ${nomes[vexame.vencedor].manager}. Placar de amistoso contra escolinha.`,
    });
  premios.push({
    tipo: "pefrio",
    roster: pefrio.roster,
    texto: `Menor pontuação da rodada: ${fmt(pefrio.pontos)}. Estava jogando?`,
  });
  premios.push({
    tipo: "canhao",
    roster: canhao.roster,
    texto: `Maior pontuação da rodada: ${fmt(canhao.pontos)}. O único prêmio bom daqui.`,
  });

  return { semana, times, jogos, premios, alface, canhao, pefrio, cadeirada, vexame };
}

// Descobre qual rodada fechou. Na terça o /state/nfl já pode ter virado a semana,
// então o alvo é week - 1 — mas só vale se a semana realmente pontuou.
async function achaRodadaFechada(league, nomes) {
  const state = await sleeper("/state/nfl");
  const playoffStart = league.settings?.playoff_week_start || 15;
  const forcada = process.env.SEMANA ? Number(process.env.SEMANA) : null;

  const candidatas = forcada
    ? [forcada]
    : [state.week - 1, state.week - 2].filter((w) => w >= 1);

  for (const semana of candidatas) {
    const ms = await sleeper(`/league/${LEAGUE_ID}/matchups/${semana}`).catch(() => []);
    const r = processaRodada(semana, ms, nomes);
    if (r) return { ...r, playoffs: semana >= playoffStart };
  }
  return null;
}

// Campanha e sequência de cada roster até a semana da edição.
async function campanhaAte(semana, nomes) {
  const semanas = [];
  for (let w = 1; w <= semana; w++) semanas.push(w);
  const todas = await Promise.all(
    semanas.map((w) => sleeper(`/league/${LEAGUE_ID}/matchups/${w}`).catch(() => [])),
  );

  const tab = {};
  for (const id of Object.keys(nomes))
    tab[id] = { roster: Number(id), v: 0, d: 0, pf: 0, pa: 0, seq: [] };

  todas.forEach((ms, i) => {
    const r = processaRodada(semanas[i], ms, nomes);
    if (!r) return;
    for (const t of r.times) tab[t.roster].pf += t.pontos;
    for (const j of r.jogos) {
      tab[j.vencedor].v++;
      tab[j.perdedor].d++;
      tab[j.vencedor].pa += j.pd;
      tab[j.perdedor].pa += j.pv;
      tab[j.vencedor].seq.push("V");
      tab[j.perdedor].seq.push("D");
    }
  });

  const ordem = Object.values(tab).sort((a, b) => b.v - a.v || b.pf - a.pf);
  ordem.forEach((c, i) => (c.posicao = i + 1));
  return Object.fromEntries(ordem.map((c) => [c.roster, c]));
}

// Head-to-head entre dois rosters, somando todas as temporadas encadeadas.
// Retorna um mapa "userA|userB" -> {a, b}, indexado por user_id (o roster_id muda de ano).
export async function historicoH2H(league) {
  const placar = {};
  const conta = (ua, ub) => {
    const k = [ua, ub].sort().join("|");
    (placar[k] ||= {})[ua] = (placar[k][ua] || 0) + 1;
    placar[k][ub] = placar[k][ub] || 0;
  };

  let id = league.previous_league_id;
  const vistos = new Set([LEAGUE_ID]);
  while (id && !vistos.has(id)) {
    vistos.add(id);
    try {
      const [lg, us, ro] = await Promise.all([
        sleeper(`/league/${id}`),
        sleeper(`/league/${id}/users`),
        sleeper(`/league/${id}/rosters`),
      ]);
      const nm = montaNomes(us, ro);
      const donoDe = Object.fromEntries(ro.map((r) => [r.roster_id, r.owner_id]));
      const ps = lg.settings?.playoff_week_start || 15;
      for (let w = 1; w < ps; w++) {
        const ms = await sleeper(`/league/${id}/matchups/${w}`).catch(() => []);
        const r = processaRodada(w, ms, nm);
        if (!r) continue;
        for (const j of r.jogos) conta(donoDe[j.vencedor], donoDe[j.perdedor]);
      }
      id = lg.previous_league_id;
    } catch {
      break;
    }
  }
  return placar;
}

const nomeJogador = (players, id) => {
  const p = players[id];
  if (!p) return `jogador ${id}`;
  const n = p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim() || id;
  return p.position ? `${n} (${p.position})` : n;
};

// Monta o dossiê que vai para o modelo: um bloco por confronto.
function montaContexto({ rodada, matchups, nomes, players, campanha, h2h, donoDe, transacoes }) {
  const porRoster = Object.fromEntries(matchups.map((m) => [m.roster_id, m]));

  const lado = (rosterId) => {
    const m = porRoster[rosterId] || {};
    const pp = m.players_points || {};
    const starters = (m.starters || []).filter((p) => p && p !== "0");
    const ord = [...starters].sort((a, b) => (pp[b] || 0) - (pp[a] || 0));
    const banco = (m.players || [])
      .filter((p) => !starters.includes(p))
      .sort((a, b) => (pp[b] || 0) - (pp[a] || 0))
      .slice(0, 3);
    const t = rodada.times.find((x) => x.roster === rosterId);

    return {
      manager: nomes[rosterId].manager,
      time: nomes[rosterId].time,
      pontos: r2(t?.pontos),
      heroi: ord[0]
        ? { jogador: nomeJogador(players, ord[0]), pontos: r2(pp[ord[0]]) }
        : null,
      vilao: ord.length
        ? {
            jogador: nomeJogador(players, ord[ord.length - 1]),
            pontos: r2(pp[ord[ord.length - 1]]),
          }
        : null,
      pontos_no_banco: r2(t?.banco),
      banco_destaques: banco.map((p) => ({
        jogador: nomeJogador(players, p),
        pontos: r2(pp[p]),
      })),
      posicao_na_tabela: campanha[rosterId]?.posicao,
      campanha: `${campanha[rosterId]?.v || 0}–${campanha[rosterId]?.d || 0}`,
      sequencia: (campanha[rosterId]?.seq || []).slice(-4).join(""),
    };
  };

  const confrontos = rodada.jogos.map((j, i) => {
    const ua = donoDe[j.vencedor];
    const ub = donoDe[j.perdedor];
    const k = [ua, ub].sort().join("|");
    const hist = h2h[k] || {};
    const envolvidos = transacoes.filter((t) =>
      (t.roster_ids || []).some((r) => r === j.vencedor || r === j.perdedor),
    );

    return {
      id: `confronto-${i + 1}`,
      vencedor: lado(j.vencedor),
      perdedor: lado(j.perdedor),
      margem: r2(j.margem),
      retrospecto_anterior: `${nomes[j.vencedor].time} ${hist[ua] || 0} × ${hist[ub] || 0} ${nomes[j.perdedor].time} (temporadas anteriores)`,
      movimentacoes: envolvidos.map((t) => ({
        tipo: t.type,
        manager: nomes[(t.roster_ids || [])[0]]?.manager || "?",
        chegaram: Object.keys(t.adds || {}).map((p) => nomeJogador(players, p)),
        sairam: Object.keys(t.drops || {}).map((p) => nomeJogador(players, p)),
      })),
    };
  });

  return {
    semana: rodada.semana,
    playoffs: rodada.playoffs,
    premios: rodada.premios.map((p) => ({
      premio: ROTULO[p.tipo] || p.tipo,
      time: nomes[p.roster].time,
      manager: nomes[p.roster].manager,
      detalhe: p.texto,
    })),
    tabela: Object.values(campanha)
      .sort((a, b) => a.posicao - b.posicao)
      .map((c) => ({
        posicao: c.posicao,
        time: nomes[c.roster].time,
        manager: nomes[c.roster].manager,
        campanha: `${c.v}–${c.d}`,
        pontos_feitos: r2(c.pf),
      })),
    confrontos,
  };
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["manchete", "coluna", "confrontos"],
  properties: {
    manchete: {
      type: "string",
      description: "Manchete da edição, curta e ácida. Máximo 80 caracteres.",
    },
    coluna: {
      type: "object",
      additionalProperties: false,
      required: ["titulo", "texto", "vitima"],
      properties: {
        titulo: { type: "string" },
        texto: {
          type: "string",
          description:
            "A coluna do Seu Pururuca sobre a rodada inteira, 3 a 5 parágrafos separados por \\n\\n.",
        },
        vitima: {
          type: "string",
          description: "Nome do TIME escolhido como vítima da semana.",
        },
      },
    },
    confrontos: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "titulo", "resumo", "momento_decisivo", "vereditos"],
        properties: {
          id: { type: "string" },
          titulo: { type: "string" },
          resumo: { type: "string" },
          momento_decisivo: { type: "string" },
          vereditos: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["manager", "texto"],
              properties: {
                manager: { type: "string", description: "Nome do TIME que recebe o veredito." },
                texto: { type: "string", description: "Veredito curto, uma ou duas frases." },
              },
            },
          },
        },
      },
    },
  },
};

function systemPrompt(convidado) {
  return `Você escreve o Jornal da Pururuca Bowl, uma liga de fantasy football entre dez amigos brasileiros. Tudo em português do Brasil.

O tom é zoeira ácida entre amigos de longa data. Pode ser cruel com as decisões, nunca com a pessoa: ataque escalações, trades, teimosia e sorte — nunca aparência, família, trabalho ou qualquer coisa de fora da liga. Sem palavrão pesado. Sem elogio sem ressalva.

Você escreve duas coisas nesta edição.

1. A COLUNA DO SEU PURURUCA — o colunista fixo. É um porco velho e rabugento de boteco: sarcástico, cansado, odeia todos os dez igualmente, fala como quem já viu essa liga fazer besteira demais. Ele comenta a rodada inteira, entrega os prêmios com deboche, cutuca a tabela e escolhe uma vítima da semana. Nunca elogia sem estragar o elogio na frase seguinte.

2. A ANÁLISE DOS CONFRONTOS — feita pelo comentarista convidado da semana, que é ${convidado.nome}. Incorpore o personagem: ${convidado.persona} Escreva cada confronto na voz dele, em português, mesmo sendo um personagem estrangeiro. Ele não é o Seu Pururuca e não deve soar como ele.

Chame cada participante pelo NOME DO TIME, não pelo usuário do Sleeper: escreva "o Custelinha perdeu", nunca "o DanielBrankito perdeu". O campo "manager" existe só para você saber quem é quem; quem aparece no texto é o time. Nos vereditos, o campo "manager" recebe o nome do time.

Em cada confronto, use os dados que receber: o placar e a margem, o herói e o vilão de cada lado, os pontos deixados no banco com o nome de quem ficou sentado, o retrospecto entre os dois, a posição na tabela, a sequência e as movimentações da semana. Cite números e nomes de jogador — é o que dá graça. Não invente nada que não esteja nos dados: sem lance, sem lesão, sem declaração que você não recebeu.`;
}

async function chamaModelo(contexto, convidado) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const resp = await client.beta.messages.create({
    model: MODELO,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: systemPrompt(convidado),
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    messages: [
      {
        role: "user",
        content: `Dados da rodada ${contexto.semana}:\n\n${JSON.stringify(contexto, null, 2)}`,
      },
    ],
  });

  if (resp.stop_reason === "refusal")
    throw new Error(`Modelo recusou (${resp.stop_details?.category || "sem categoria"}).`);

  const texto = resp.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  const jornal = JSON.parse(texto);
  const u = resp.usage;
  console.log(`Tokens: ${u.input_tokens} entrada, ${u.output_tokens} saída.`);
  return jornal;
}

// Telegram em HTML, não em Markdown: o texto vem do modelo e um asterisco
// solto derruba a mensagem inteira com 400. Em HTML basta escapar três caracteres.
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

export function paraTexto(jornal, semana) {
  const p = [];
  p.push(`<b>JORNAL DA PURURUCA BOWL — Rodada ${semana}</b>`);
  p.push(`<i>${esc(jornal.manchete)}</i>`);
  p.push(`\n<b>${esc(jornal.coluna.titulo)}</b>\n${esc(jornal.coluna.texto)}`);
  for (const c of jornal.confrontos) {
    const v = c.vereditos.map((x) => `• <b>${esc(x.manager)}:</b> ${esc(x.texto)}`).join("\n");
    p.push(`\n<b>${esc(c.titulo)}</b>\n${esc(c.resumo)}\n\n<i>${esc(c.momento_decisivo)}</i>\n\n${v}`);
  }
  p.push(`\n<a href="${SITE}">Ler no jornal, com as ilustrações ›</a>`);
  return p.join("\n");
}

// Quebra por linha inteira: uma tag HTML nunca fica partida entre mensagens,
// e o link do rodapé sempre cai na última.
export function quebraEmMensagens(texto) {
  const pedacos = [];
  for (const bloco of texto.split("\n")) {
    if (!pedacos.length || pedacos.at(-1).length + bloco.length + 1 > 3800) pedacos.push(bloco);
    else pedacos[pedacos.length - 1] += "\n" + bloco;
  }
  return pedacos;
}

// O Telegram corta em 4096 caracteres, então mandamos em pedaços.
async function telegram(texto) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (process.env.SEM_TELEGRAM) {
    console.log("SEM_TELEGRAM ligado; não enviei nada no grupo.");
    return;
  }
  if (!token || !chat) {
    console.log("Telegram não configurado; pulando o envio.");
    return;
  }

  const pedacos = quebraEmMensagens(texto);

  for (const parte of pedacos) {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: parte, parse_mode: "HTML" }),
    });
    // Nunca imprimir o corpo da resposta: a URL da chamada carrega o token.
    if (!r.ok) throw new Error(`Telegram respondeu ${r.status}.`);
  }
  console.log(`Telegram: ${pedacos.length} mensagem(ns) enviada(s).`);
}

// GitHub Pages não lista diretório, então o site precisa de um manifesto.
function atualizaIndice(entrada) {
  const caminho = path.join(DIR, "index.json");
  const atual = fs.existsSync(caminho) ? JSON.parse(fs.readFileSync(caminho, "utf8")) : [];
  const lista = atual.filter((e) => !(e.temporada === entrada.temporada && e.semana === entrada.semana));
  lista.push(entrada);
  lista.sort((a, b) => b.temporada - a.temporada || b.semana - a.semana);
  fs.writeFileSync(caminho, JSON.stringify(lista, null, 2) + "\n");
}

// ---------- Edição especial: o draft ----------
// Não existe desempenho ainda, então nada aqui é "boa" ou "má" escolha: é
// montagem de elenco. O que dá para medir sem chutar: distribuição por
// posição, concentração num time da NFL, quando cada um foi atrás das
// posições que ninguém quer, e a distância entre a pick e o search_rank do
// Sleeper — que é consenso de mercado, não desempenho.
// bye_week existe no schema do Sleeper mas vem VAZIO para os 12 mil jogadores;
// não dá para analisar colisão de bye, e campo sempre nulo só convida a chute.
function montaContextoDraft({ draft, picks, nomes, players, liga_roster_positions }) {
  const porRoster = {};
  for (const pk of picks) (porRoster[pk.roster_id] ||= []).push(pk);

  const info = (pk) => {
    const p = players[pk.player_id] || {};
    return {
      nome: `${pk.metadata?.first_name || ""} ${pk.metadata?.last_name || ""}`.trim() || pk.player_id,
      pos: pk.metadata?.position || p.position || "?",
      time_nfl: pk.metadata?.team || p.team || "FA",
      rank: p.search_rank && p.search_rank < 9999 ? p.search_rank : null,
      anos: Number(pk.metadata?.years_exp ?? p.years_exp ?? 0),
      lesao: (pk.metadata?.injury_status || "").trim(),
      rodada: pk.round,
      pick: pk.pick_no,
    };
  };

  const times = Object.entries(porRoster).map(([rid, ps]) => {
    const js = ps.map(info).sort((a, b) => a.pick - b.pick);
    const conta = (chave) => js.reduce((m, j) => (j[chave] ? ((m[j[chave]] = (m[j[chave]] || 0) + 1), m) : m), {});
    const pos = conta("pos");
    const nfl = Object.entries(conta("time_nfl")).sort((a, b) => b[1] - a[1])[0];
    // pick − rank: positivo = caiu no colo mais tarde que o consenso; negativo = foi buscar cedo.
    const comRank = js.filter((j) => j.rank).map((j) => ({ ...j, delta: j.pick - j.rank }));
    const sobrou = [...comRank].sort((a, b) => b.delta - a.delta)[0];
    const antecipou = [...comRank].sort((a, b) => a.delta - b.delta)[0];
    const primeira = (p) => js.find((j) => j.pos === p);
    const q = primeira("QB"), te = primeira("TE"), k = primeira("K"), df = primeira("DEF");

    return {
      time: nomes[rid].time,
      manager: nomes[rid].manager,
      elenco_por_posicao: pos,
      primeira_escolha: `${js[0].nome} (${js[0].pos}, ${js[0].time_nfl}) na pick ${js[0].pick}`,
      ultima_escolha: `${js.at(-1).nome} (${js.at(-1).pos}) na pick ${js.at(-1).pick}`,
      primeiro_qb: q ? `rodada ${q.rodada} (${q.nome})` : "não pegou QB",
      primeiro_te: te ? `rodada ${te.rodada} (${te.nome})` : "não pegou TE",
      kicker: k ? `rodada ${k.rodada}` : "não pegou kicker",
      defesa: df ? `rodada ${df.rodada}` : "não pegou defesa",
      mais_do_mesmo_time_nfl: nfl && nfl[1] > 1 ? `${nfl[1]} jogadores do ${nfl[0]}` : null,
      caiu_no_colo: sobrou && sobrou.delta > 15
        ? `${sobrou.nome} (${sobrou.pos}): consenso ${sobrou.rank}, pegou na ${sobrou.pick}`
        : null,
      foi_buscar_cedo: antecipou && antecipou.delta < -15
        ? `${antecipou.nome} (${antecipou.pos}): consenso ${antecipou.rank}, pegou na ${antecipou.pick}`
        : null,
      novatos: js.filter((j) => j.anos === 0).length,
      veteranos_8_anos_ou_mais: js.filter((j) => j.anos >= 8).length,
      escolhidos_machucados: js.filter((j) => j.lesao).map((j) => `${j.nome} (${j.lesao})`),
    };
  });

  const ordenadas = [...picks].sort((a, b) => a.pick_no - b.pick_no);
  const primeira = info(ordenadas[0]);
  const ultima = info(ordenadas.at(-1));
  const corrida = {};
  for (const pk of ordenadas) {
    const p = pk.metadata?.position;
    if (!p) continue;
    (corrida[p] ||= { primeira_rodada: pk.round, total: 0 }).total++;
  }

  const todosComRank = ordenadas.map(info).filter((j) => j.rank).map((j) => ({ ...j, delta: j.pick - j.rank }));
  const maiorEspera = [...todosComRank].sort((a, b) => b.delta - a.delta).slice(0, 3)
    .map((j) => `${j.nome} (${j.pos}): consenso ${j.rank}, saiu na ${j.pick}`);
  const maiorAntecipacao = [...todosComRank].sort((a, b) => a.delta - b.delta).slice(0, 3)
    .map((j) => `${j.nome} (${j.pos}): consenso ${j.rank}, saiu na ${j.pick}`);

  return {
    escalacao_da_liga: liga_roster_positions,
    nao_existe_vaga_de_defesa_de_time: true,
    o_que_e_consenso: "search_rank é a ordem de procura do Sleeper, um proxy de consenso de mercado. Não é desempenho e não prova nada sobre o futuro.",
    maior_espera_do_draft: maiorEspera,
    maior_antecipacao_do_draft: maiorAntecipacao,
    rodadas: draft.settings?.rounds,
    times_na_liga: draft.settings?.teams,
    total_de_picks: picks.length,
    primeira_pick_do_draft: `${primeira.nome} (${primeira.pos}, ${primeira.time_nfl}), por ${nomes[ordenadas[0].roster_id].time}`,
    mr_irrelevant: `${ultima.nome} (${ultima.pos}), por ${nomes[ordenadas.at(-1).roster_id].time}`,
    posicoes_no_geral: corrida,
    times,
  };
}

const SCHEMA_DRAFT = {
  type: "object",
  additionalProperties: false,
  required: ["manchete", "coluna", "times"],
  properties: {
    manchete: { type: "string", description: "Manchete da edição especial do draft. Máximo 80 caracteres." },
    coluna: {
      type: "object",
      additionalProperties: false,
      required: ["titulo", "texto", "vitima"],
      properties: {
        titulo: { type: "string" },
        texto: { type: "string", description: "A coluna do Seu Pururuca sobre o draft inteiro, 4 a 6 parágrafos separados por \\n\\n." },
        vitima: { type: "string", description: "Nome do TIME que fez o draft mais duvidoso." },
      },
    },
    times: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["time", "titulo", "resumo", "veredito"],
        properties: {
          time: { type: "string", description: "Nome do time." },
          titulo: { type: "string", description: "Título curto para o elenco montado." },
          resumo: { type: "string", description: "Análise do elenco, 2 a 4 frases." },
          veredito: { type: "string", description: "Veredito curto, uma frase." },
        },
      },
    },
  },
};

function systemPromptDraft() {
  return `Você escreve a edição especial do Jornal da Pururuca Bowl sobre o draft de 2026, uma liga de fantasy football entre dez amigos brasileiros. Tudo em português do Brasil.

O tom é zoeira ácida entre amigos. Ataque escalação, teimosia e montagem de elenco — nunca aparência, família ou trabalho. Sem palavrão pesado.

Quem assina é o SEU PURURUCA, colunista fixo: porco velho e rabugento de boteco, sarcástico, cansado, que já viu essa liga errar demais. Ele escreve a coluna sobre o draft inteiro e depois um bloco curto sobre o elenco de cada time.

Chame cada participante pelo NOME DO TIME, não pelo usuário: "o Custelinha montou", nunca "o DanielBrankito montou".

REGRA QUE NÃO PODE SER QUEBRADA: a temporada ainda não começou e ninguém pontuou nada. Você NÃO SABE se uma escolha foi boa ou ruim, não sabe se um jogador vai render, e não existe ranking de draft aqui. Nunca diga que alguém "fez o melhor draft" ou "levou o maior roubo" com base em desempenho — não há desempenho. ATENÇÃO À ESCALAÇÃO DESTA LIGA, que vem nos dados: **não existe vaga de defesa de time (D/ST)**. São duas vagas de IDP, preenchidas por defensores individuais — DL, LB e DB. Portanto NÃO É ERRO ninguém ter draftado defesa de time: seria erro ter draftado. Nunca trate a ausência de D/ST como descuido, e nunca sugira que alguém deveria ter pego uma.

O que você pode julgar é o que está nos dados: quantos jogadores por posição contra as vagas que existem, concentração de jogadores do mesmo time da NFL, gastar pick cedo em kicker, demorar demais para pegar QB, e apostar em novato ou em veterano.

Você também recebe um "consenso" por jogador, que é a ordem de procura do Sleeper. Ele mostra quem o mercado achava que valia mais, e serve para apontar quem foi buscado antes da hora e quem sobrou até tarde. NÃO é desempenho e não prova que a escolha foi certa ou errada — trate como fofoca de mercado, não como fato.

Se quiser prever, deixe claro que é palpite de boteco, não informação.`;
}

async function chamaModeloDraft(contexto) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const resp = await client.beta.messages.create({
    model: MODELO,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: systemPromptDraft(),
    output_config: { format: { type: "json_schema", schema: SCHEMA_DRAFT } },
    messages: [{ role: "user", content: `Draft de 2026, encerrado:\n\n${JSON.stringify(contexto, null, 2)}` }],
  });
  if (resp.stop_reason === "refusal")
    throw new Error(`Modelo recusou (${resp.stop_details?.category || "sem categoria"}).`);
  const texto = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  console.log(`Tokens: ${resp.usage.input_tokens} entrada, ${resp.usage.output_tokens} saída.`);
  return JSON.parse(texto);
}

export function textoDraft(jornal) {
  const p = [`<b>JORNAL DA PURURUCA BOWL — EDIÇÃO ESPECIAL: O DRAFT</b>`, `<i>${esc(jornal.manchete)}</i>`];
  p.push(`\n<b>${esc(jornal.coluna.titulo)}</b>\n${esc(jornal.coluna.texto)}`);
  for (const t of jornal.times) p.push(`\n<b>${esc(t.time)} — ${esc(t.titulo)}</b>\n${esc(t.resumo)}\n\n• ${esc(t.veredito)}`);
  p.push(`\n<a href="${SITE}">Ler no jornal, com as ilustrações ›</a>`);
  return p.join("\n");
}

async function edicaoDoDraft(league, nomes) {
  const temporada = Number(league.season);
  const arquivo = path.join(DIR, `${temporada}-draft.json`);
  if (fs.existsSync(arquivo) && !FORCE) {
    console.log(`${arquivo} já existe. Nada a fazer.`);
    return;
  }
  const draft = await sleeper(`/draft/${league.draft_id}`);
  if (draft.status !== "complete") {
    console.log(`Draft ainda ${draft.status}. Volto quando fechar.`);
    return;
  }
  const [picks, players] = await Promise.all([
    sleeper(`/draft/${league.draft_id}/picks`),
    getJSON("https://api.sleeper.app/v1/players/nfl"),
  ]);
  const contexto = montaContextoDraft({ draft, picks, nomes, players, liga_roster_positions: league.roster_positions.filter((x) => x !== "BN").join(", ") });
  if (DRY) {
    console.log(JSON.stringify(contexto, null, 2));
    console.log("\n--dry-run: não chamei a IA nem o Telegram.");
    return;
  }
  const jornal = await chamaModeloDraft(contexto);
  fs.mkdirSync(DIR, { recursive: true });
  const edicao = { temporada, tipo: "draft", gerado_em: new Date().toISOString(), ...jornal };
  fs.writeFileSync(arquivo, JSON.stringify(edicao, null, 2) + "\n");
  atualizaIndice({
    temporada, semana: 0, tipo: "draft", arquivo: path.basename(arquivo),
    manchete: jornal.manchete, rotulo: "Especial · o Draft",
  });
  console.log(`Gravei ${arquivo}.`);
  await telegram(textoDraft(jornal));
}

// ---------- Mapa de nomes ----------
// O site precisa mostrar nome de jogador nas movimentações, mas a lista do
// Sleeper tem 5 MB e não pode ser baixada no navegador. Aqui, no servidor,
// a gente recorta só quem está em algum elenco da liga: uns 200 registros.
async function mapaDeJogadores(league) {
  const [rosters, picks, players] = await Promise.all([
    sleeper(`/league/${LEAGUE_ID}/rosters`),
    sleeper(`/draft/${league.draft_id}/picks`).catch(() => []),
    getJSON("https://api.sleeper.app/v1/players/nfl"),
  ]);
  const ids = new Set();
  for (const r of rosters) for (const id of [...(r.players || []), ...(r.taxi || []), ...(r.reserve || [])]) ids.add(id);
  // Enquanto o draft não fecha, roster.players vem vazio: as picks são a fonte.
  for (const pk of picks || []) if (pk.player_id) ids.add(String(pk.player_id));

  // E todo jogador ativo com time e posição de fantasy. Sem isto, quem é pescado
  // no mercado depois da última geração do mapa aparece como "jogador 9500" no
  // site até o dia seguinte — foi o que aconteceu com Josh Downs e Tyjae Spears.
  // São ~2.100 nomes, uns 99 KB, contra os 8 KB da versão só com os elencos.
  const POSICOES = new Set(["QB", "RB", "WR", "TE", "K", "DL", "DE", "DT", "LB", "DB", "CB", "S"]);
  for (const p of Object.values(players))
    if (p.active && p.team && POSICOES.has(p.position)) ids.add(String(p.player_id));

  // Quem entrou ou saiu por transação também precisa de nome, mesmo já dispensado.
  const ps = league.settings?.playoff_week_start || 15;
  const semanas = await Promise.all(
    Array.from({ length: ps + 3 }, (_, i) => sleeper(`/league/${LEAGUE_ID}/transactions/${i + 1}`).catch(() => [])),
  );
  for (const lote of semanas)
    for (const tr of lote || [])
      for (const id of [...Object.keys(tr.adds || {}), ...Object.keys(tr.drops || {})]) ids.add(id);

  const mapa = {};
  for (const id of ids) {
    const p = players[id];
    if (!p) continue;
    mapa[id] = {
      n: p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim() || id,
      p: p.position || "?",
      t: p.team || "FA",
    };
  }
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/jogadores.json", JSON.stringify(mapa) + "\n");
  console.log(`data/jogadores.json: ${Object.keys(mapa).length} jogadores.`);
}

// ---------- Prévia de quinta ----------
// A edição de terça olha para trás. Esta olha para a frente: quem joga contra
// quem, quem está pendurado no boletim médico, e um palpite para errar em
// público. Os alertas de lesão são calculados aqui, no código — o modelo
// escreve o texto, mas não inventa quem está machucado.
function montaContextoPrevia({ semana, matchups, nomes, rosters, players, h2h, donoDe, campanha }) {
  const tabela = Object.values(campanha)
    .sort((a, b) => a.posicao - b.posicao)
    .map((c) => ({
      roster: c.roster, time: nomes[c.roster].time, posicao: c.posicao,
      v: c.v, d: c.d, pf: r2(c.pf), pa: r2(c.pa),
      sequencia: (c.seq || []).slice(-4).join("") || "—",
    }));
  const pos = Object.fromEntries(tabela.map((c) => [c.roster, c]));

  const machucados = (rosterId) => {
    const r = rosters.find((x) => x.roster_id === rosterId) || {};
    return (r.players || [])
      .map((id) => players[id])
      .filter((p) => p && p.injury_status)
      .map((p) => `${p.full_name} (${p.position}) — ${p.injury_status}`);
  };

  const por = {};
  for (const m of matchups || []) if (m.matchup_id) (por[m.matchup_id] ||= []).push(m);

  const confrontos = Object.values(por).filter((x) => x.length === 2).map(([a, b], i) => {
    const ua = donoDe[a.roster_id], ub = donoDe[b.roster_id];
    const hist = h2h[[ua, ub].sort().join("|")] || {};
    const lado = (m) => ({
      time: nomes[m.roster_id].time,
      posicao: pos[m.roster_id]?.posicao,
      campanha: `${pos[m.roster_id]?.v}–${pos[m.roster_id]?.d}`,
      sequencia: pos[m.roster_id]?.sequencia,
      pontos_feitos: pos[m.roster_id]?.pf,
      no_boletim_medico: machucados(m.roster_id),
    });
    return {
      id: `jogo-${i + 1}`,
      a: lado(a), b: lado(b),
      retrospecto: `${nomes[a.roster_id].time} ${hist[ua] || 0} × ${hist[ub] || 0} ${nomes[b.roster_id].time}`,
    };
  });

  return { semana, tabela, confrontos };
}

const SCHEMA_PREVIA = {
  type: "object",
  additionalProperties: false,
  required: ["manchete", "coluna", "palpites"],
  properties: {
    manchete: { type: "string", description: "Manchete curta sobre a rodada que vem. Máximo 80 caracteres." },
    coluna: { type: "string", description: "2 a 3 parágrafos do Seu Pururuca sobre a rodada que vem, separados por \\n\\n." },
    palpites: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["confronto", "favorito", "porque"],
        properties: {
          confronto: { type: "string", description: "Time A × Time B." },
          favorito: { type: "string", description: "Nome do time favorito." },
          porque: { type: "string", description: "Uma frase curta e debochada justificando." },
        },
      },
    },
  },
};

function systemPromptPrevia() {
  return `Você escreve a prévia de quinta-feira do Jornal da Pururuca Bowl, uma liga de fantasy football entre dez amigos brasileiros. Tudo em português do Brasil.

Quem assina é o SEU PURURUCA: porco velho e rabugento de boteco, sarcástico, cansado, que já viu essa liga errar demais. Zoeira ácida entre amigos — ataque escalação e teimosia, nunca aparência, família ou trabalho.

Chame cada participante pelo NOME DO TIME, nunca pelo usuário.

Esta edição olha para FRENTE: a rodada ainda não aconteceu. Você não sabe o resultado e não pode fingir que sabe. Pode provocar, cutucar quem está mal na tabela e dar palpite — mas palpite é palpite, e o graça é justamente você poder errar na terça seguinte.

Duas regras que não podem ser quebradas:
1. Não invente lesão. Você recebe a lista de quem está no boletim médico; só fale de quem está nela, e do jeito que está escrito.
2. Não invente número. Campanha, posição e pontos vêm nos dados.

Feche a coluna lembrando que a escalação trava quando o jogo começa. É o motivo prático de a mensagem existir.`;
}

async function chamaModeloPrevia(contexto) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const resp = await client.beta.messages.create({
    model: MODELO,
    max_tokens: 8000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: systemPromptPrevia(),
    output_config: { format: { type: "json_schema", schema: SCHEMA_PREVIA } },
    messages: [{ role: "user", content: `Rodada ${contexto.semana}, que começa hoje à noite:\n\n${JSON.stringify(contexto, null, 2)}` }],
  });
  if (resp.stop_reason === "refusal")
    throw new Error(`Modelo recusou (${resp.stop_details?.category || "sem categoria"}).`);
  const texto = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  console.log(`Tokens: ${resp.usage.input_tokens} entrada, ${resp.usage.output_tokens} saída.`);
  return JSON.parse(texto);
}

function textoPrevia(previa, contexto) {
  const p = [`<b>PURURUCA BOWL — A RODADA ${contexto.semana} COMEÇA HOJE</b>`, `<i>${esc(previa.manchete)}</i>`];
  p.push(`\n${esc(previa.coluna)}`);
  const doentes = contexto.confrontos.flatMap((c) => [c.a, c.b]).filter((x) => x.no_boletim_medico.length);
  if (doentes.length) {
    p.push(`\n<b>NO BOLETIM MÉDICO</b>`);
    for (const t of doentes) p.push(`• <b>${esc(t.time)}:</b> ${esc(t.no_boletim_medico.join(", "))}`);
  }
  p.push(`\n<b>PALPITES DO PORCO</b>`);
  for (const g of previa.palpites) p.push(`• <b>${esc(g.confronto)}</b> — ${esc(g.favorito)}. ${esc(g.porque)}`);
  p.push(`\n<a href="${SITE}">Ver a tabela no jornal ›</a>`);
  return p.join("\n");
}

async function edicaoPrevia(league, nomes, rosters, users) {
  const state = await sleeper("/state/nfl");
  const semana = process.env.SEMANA ? Number(process.env.SEMANA)
    : (state.season === league.season ? state.week : null);
  if (!semana) { console.log("Fora de temporada. Sem prévia."); return; }

  const matchups = await sleeper(`/league/${LEAGUE_ID}/matchups/${semana}`).catch(() => []);
  const pares = new Set((matchups || []).filter((m) => m.matchup_id).map((m) => m.matchup_id));
  if (!pares.size) { console.log(`A tabela de jogos da rodada ${semana} ainda não saiu.`); return; }
  if ((matchups || []).some((m) => (m.points || 0) > 0) && !FORCE) {
    console.log(`A rodada ${semana} já começou a pontuar. Prévia não faz sentido.`);
    return;
  }

  const [players, h2h, campanha] = await Promise.all([
    getJSON("https://api.sleeper.app/v1/players/nfl"),
    historicoH2H(league),
    campanhaAte(semana - 1, nomes),
  ]);
  const donoDe = Object.fromEntries(rosters.map((r) => [r.roster_id, r.owner_id]));
  const contexto = montaContextoPrevia({ semana, matchups, nomes, rosters, players, h2h, donoDe, campanha });

  if (DRY) {
    console.log(JSON.stringify(contexto, null, 2));
    console.log("\n--dry-run: não chamei a IA nem o Telegram.");
    return;
  }
  const previa = await chamaModeloPrevia(contexto);
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/previa.json", JSON.stringify({
    temporada: Number(league.season), semana, gerado_em: new Date().toISOString(),
    ...previa,
    boletim: contexto.confrontos.flatMap((c) => [c.a, c.b])
      .filter((x) => x.no_boletim_medico.length)
      .map((x) => ({ time: x.time, jogadores: x.no_boletim_medico })),
  }, null, 2) + "\n");
  console.log("Gravei data/previa.json.");
  await telegram(textoPrevia(previa, contexto));
}

async function main() {
  const [league, users, rosters] = await Promise.all([
    sleeper(`/league/${LEAGUE_ID}`),
    sleeper(`/league/${LEAGUE_ID}/users`),
    sleeper(`/league/${LEAGUE_ID}/rosters`),
  ]);
  const nomes = montaNomes(users, rosters);
  const donoDe = Object.fromEntries(rosters.map((r) => [r.roster_id, r.owner_id]));

  if (process.argv.includes("--previa")) {
    await edicaoPrevia(league, nomes, rosters, users);
    return;
  }

  if (process.argv.includes("--jogadores")) {
    await mapaDeJogadores(league);
    return;
  }

  if (process.argv.includes("--draft")) {
    await edicaoDoDraft(league, nomes);
    return;
  }

  const rodada = await achaRodadaFechada(league, nomes);
  if (!rodada) {
    console.log("Nenhuma rodada fechada com pontuação. Nada a fazer.");
    return;
  }

  const semana = rodada.semana;
  const temporada = Number(league.season);
  const arquivo = path.join(DIR, `${temporada}-rodada-${String(semana).padStart(2, "0")}.json`);

  // O --dry-run não grava nada, então não faz sentido barrá-lo por já existir.
  if (fs.existsSync(arquivo) && !FORCE && !DRY) {
    console.log(`${arquivo} já existe. Use FORCE=1 para regravar.`);
    return;
  }

  console.log(`Rodada ${semana} da temporada ${temporada}${rodada.playoffs ? " (playoffs)" : ""}.`);

  const [matchups, transacoes, players, campanha, h2h] = await Promise.all([
    sleeper(`/league/${LEAGUE_ID}/matchups/${semana}`),
    sleeper(`/league/${LEAGUE_ID}/transactions/${semana}`).catch(() => []),
    getJSON("https://api.sleeper.app/v1/players/nfl"),
    campanhaAte(semana, nomes),
    historicoH2H(league),
  ]);

  const contexto = montaContexto({
    rodada,
    matchups,
    nomes,
    players,
    campanha,
    h2h,
    donoDe,
    transacoes: (transacoes || []).filter((t) => t.status === "complete"),
  });

  const convidado = CONVIDADOS[(semana - 1) % CONVIDADOS.length];
  console.log(`Comentarista da semana: ${convidado.nome}.`);

  if (DRY) {
    console.log(JSON.stringify(contexto, null, 2));
    console.log("\n--dry-run: não chamei a IA nem o Telegram.");
    return;
  }

  const jornal = await chamaModelo(contexto, convidado);

  fs.mkdirSync(DIR, { recursive: true });
  const edicao = {
    temporada,
    semana,
    playoffs: rodada.playoffs,
    comentarista: convidado.nome,
    gerado_em: new Date().toISOString(),
    ...jornal,
    premios: contexto.premios,
  };
  fs.writeFileSync(arquivo, JSON.stringify(edicao, null, 2) + "\n");
  atualizaIndice({
    temporada, semana,
    arquivo: path.basename(arquivo),
    manchete: jornal.manchete,
    comentarista: convidado.nome,
    rotulo: `Rodada ${semana}`,
  });
  console.log(`Gravei ${arquivo}.`);

  await telegram(paraTexto(jornal, semana));
}

// Só roda o ciclo quando chamado direto; assim dá para importar as funções em testes.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((e) => {
    // A mensagem de erro do SDK nunca contém a chave, mas a stack pode citar env.
    console.error("Falhou:", e.message);
    process.exit(1);
  });
}
