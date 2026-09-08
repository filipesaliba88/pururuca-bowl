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

import fs from "node:fs";
import path from "node:path";
// O SDK da Anthropic é carregado sob demanda, para o --dry-run rodar sem instalar nada.

// LEAGUE_ID pode ser sobrescrito por env para testar contra temporadas antigas.
const LEAGUE_ID = process.env.LEAGUE_ID || "1389719862191849472";
const API = "https://api.sleeper.app/v1";
const DIR = "data/jornal";
const MODELO = "claude-opus-5";

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
      time: u.metadata?.team_name || u.display_name || `Time ${r.roster_id}`,
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
      retrospecto_anterior: `${nomes[j.vencedor].manager} ${hist[ua] || 0} × ${hist[ub] || 0} ${nomes[j.perdedor].manager} (temporadas anteriores)`,
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
      premio: p.tipo,
      manager: nomes[p.roster].manager,
      detalhe: p.texto,
    })),
    tabela: Object.values(campanha)
      .sort((a, b) => a.posicao - b.posicao)
      .map((c) => ({
        posicao: c.posicao,
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
          description: "Nome do manager escolhido como vítima da semana.",
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
                manager: { type: "string" },
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

function paraTexto(jornal, semana) {
  const p = [];
  p.push(`*JORNAL DA PURURUCA BOWL — Rodada ${semana}*`);
  p.push(`_${jornal.manchete}_`);
  p.push(`\n*${jornal.coluna.titulo}*\n${jornal.coluna.texto}`);
  for (const c of jornal.confrontos) {
    const v = c.vereditos.map((x) => `• *${x.manager}:* ${x.texto}`).join("\n");
    p.push(`\n*${c.titulo}*\n${c.resumo}\n\n_${c.momento_decisivo}_\n\n${v}`);
  }
  return p.join("\n");
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

  const pedacos = [];
  for (const bloco of texto.split("\n")) {
    if (!pedacos.length || pedacos.at(-1).length + bloco.length + 1 > 3800) pedacos.push(bloco);
    else pedacos[pedacos.length - 1] += "\n" + bloco;
  }

  for (const parte of pedacos) {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: parte, parse_mode: "Markdown" }),
    });
    // Nunca imprimir o corpo da resposta: a URL da chamada carrega o token.
    if (!r.ok) throw new Error(`Telegram respondeu ${r.status}.`);
  }
  console.log(`Telegram: ${pedacos.length} mensagem(ns) enviada(s).`);
}

// GitHub Pages não lista diretório, então o site precisa de um manifesto.
function atualizaIndice(arquivo, jornal, semana, temporada, convidado) {
  const caminho = path.join(DIR, "index.json");
  const atual = fs.existsSync(caminho) ? JSON.parse(fs.readFileSync(caminho, "utf8")) : [];
  const entrada = {
    temporada,
    semana,
    arquivo: path.basename(arquivo),
    manchete: jornal.manchete,
    comentarista: convidado.nome,
  };
  const lista = atual.filter((e) => !(e.temporada === temporada && e.semana === semana));
  lista.push(entrada);
  lista.sort((a, b) => b.temporada - a.temporada || b.semana - a.semana);
  fs.writeFileSync(caminho, JSON.stringify(lista, null, 2) + "\n");
}

async function main() {
  const [league, users, rosters] = await Promise.all([
    sleeper(`/league/${LEAGUE_ID}`),
    sleeper(`/league/${LEAGUE_ID}/users`),
    sleeper(`/league/${LEAGUE_ID}/rosters`),
  ]);
  const nomes = montaNomes(users, rosters);
  const donoDe = Object.fromEntries(rosters.map((r) => [r.roster_id, r.owner_id]));

  const rodada = await achaRodadaFechada(league, nomes);
  if (!rodada) {
    console.log("Nenhuma rodada fechada com pontuação. Nada a fazer.");
    return;
  }

  const semana = rodada.semana;
  const temporada = Number(league.season);
  const arquivo = path.join(DIR, `${temporada}-rodada-${String(semana).padStart(2, "0")}.json`);

  if (fs.existsSync(arquivo) && !FORCE) {
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
  atualizaIndice(arquivo, jornal, semana, temporada, convidado);
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
