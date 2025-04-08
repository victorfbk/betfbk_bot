import "dotenv/config";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import axios from "axios";

puppeteer.use(StealthPlugin());

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;
const CHAT_ID = process.env.CHAT_ID;
const SEEN_MATCHES = new Map();

function calcularMediaAtaquesPorMinuto(ataques, minuto) {
  if (!ataques || !minuto || minuto < 55) return 0;
  return Number((ataques / minuto).toFixed(2));
}

function gerarMensagem(match, headerData, eventos = []) {
  const fogoHome = match.dangerHomeTeam > match.dangerAwayTeam ? "🔥" : "";
  const fogoAway = match.dangerAwayTeam > match.dangerHomeTeam ? "🔥" : "";

  const header = `
🏆 ${match.league}
⚔️ ${match.homeTeam} ${fogoHome} vs ${fogoAway} ${match.awayTeam}
⏱️ Minuto: ${match.minute}
📊 Placar Inicial: ${headerData.placarInicial}
🚀 Ataques perigosos: ${headerData.danger}
`.trim();

  const eventosTexto = eventos
    .map((ev) => `${ev.tipo} ${ev.minuto} ${ev.placar} ✅`)
    .join("\n");

  return eventos.length ? `${header}\n\n${eventosTexto}` : header;
}

async function buscarPartidas() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 600 });

  console.log("🔍 Buscando partidas em andamento...");
  await page.goto("https://www.totalcorner.com/match/today");

  const partidas = await page.evaluate(() => {
    const rows = document.querySelectorAll("tbody.tbody_match > tr");

    return Array.from(rows).map((row) => {
      const getText = (selector) =>
        row.querySelector(selector)?.textContent.trim() ?? null;

      const minute = parseInt(getText(".match_status_minutes")) || null;
      const homeTeam = getText(".match_home a > span");
      const awayTeam = getText(".match_away a > span");
      const scoreText = getText(".match_goal") ?? "0 - 0";
      const [scoreHomeTeam, scoreAwayTeam] = scoreText.split(" - ").map(Number);

      const dangerText = getText(".match_dangerous_attacks_div") ?? "0 - 0";
      const [dangerHomeTeam, dangerAwayTeam] = dangerText
        .split(" - ")
        .map(Number);

      const league =
        row.querySelector(".td_league a")?.textContent.trim() ?? "Desconhecida";

      const cornerText = getText(".match_corner") ?? "0 - 0";
      const [cornerHome, cornerAway] = cornerText.split(" - ").map(Number);

      return {
        minute,
        homeTeam,
        awayTeam,
        scoreHomeTeam,
        scoreAwayTeam,
        dangerHomeTeam,
        dangerAwayTeam,
        cornerHome,
        cornerAway,
        league,
      };
    });
  });

  console.log(`⚙️ Analisando ${partidas.length} partidas...`);

  for (const match of partidas) {
    const {
      homeTeam,
      awayTeam,
      minute,
      scoreHomeTeam,
      scoreAwayTeam,
      dangerHomeTeam,
      dangerAwayTeam,
      cornerHome,
      cornerAway,
      league,
    } = match;

    if (!minute || !homeTeam || !awayTeam) continue;

    const matchKey = `${homeTeam}-${awayTeam}-${league}`;
    const matchData = SEEN_MATCHES.get(matchKey);

    // ===> BLOCO DE ENVIO
    if (!matchData && minute >= 64 && minute <= 71) {
      const mediaHome = calcularMediaAtaquesPorMinuto(dangerHomeTeam, minute);
      const mediaAway = calcularMediaAtaquesPorMinuto(dangerAwayTeam, minute);

      const isEmpate = scoreHomeTeam === scoreAwayTeam;
      const isDiferencaUmGol = Math.abs(scoreHomeTeam - scoreAwayTeam) === 1;

      if (
        (isEmpate && (mediaHome >= 0.8 || mediaAway >= 0.8)) ||
        (isDiferencaUmGol &&
          ((scoreHomeTeam < scoreAwayTeam && mediaHome >= 0.8) ||
            (scoreAwayTeam < scoreHomeTeam && mediaAway >= 0.8)))
      ) {
        const placarInicial = `${scoreHomeTeam} x ${scoreAwayTeam}`;
        const headerData = {
          placarInicial,
          danger: `${dangerHomeTeam} - ${dangerAwayTeam}`,
        };

        const msg = gerarMensagem(match, headerData, []);

        const res = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: CHAT_ID,
          text: msg,
          parse_mode: "Markdown",
        });

        console.log("📩 Partida enviada:", homeTeam, "vs", awayTeam);

        SEEN_MATCHES.set(matchKey, {
          headerData,
          scoreHomeTeam,
          scoreAwayTeam,
          cornerHome,
          cornerAway,
          messageId: res.data.result.message_id,
          eventos: [],
        });
      }
    }

    // ===> BLOCO DE ATUALIZAÇÃO
    else if (matchData) {
      const anterior = matchData;
      const novosEventos = [];
      let mudou = false;

      if (
        scoreHomeTeam !== anterior.scoreHomeTeam ||
        scoreAwayTeam !== anterior.scoreAwayTeam
      ) {
        novosEventos.push({
          tipo: "⚽",
          minuto,
          placar: `${scoreHomeTeam} x ${scoreAwayTeam}`,
        });
        mudou = true;
      }

      if (
        cornerHome > anterior.cornerHome ||
        cornerAway > anterior.cornerAway
      ) {
        novosEventos.push({
          tipo: "🚩",
          minuto,
          placar: "",
        });
        mudou = true;
      }

      if (mudou) {
        const eventos = [...anterior.eventos, ...novosEventos];
        const eventosUnicos = [];
        const vistos = new Set();

        for (const ev of eventos) {
          const chave = `${ev.tipo}-${ev.minuto}-${ev.placar}`;
          if (!vistos.has(chave)) {
            eventosUnicos.push(ev);
            vistos.add(chave);
          }
        }

        const msg = gerarMensagem(match, anterior.headerData, eventosUnicos);

        try {
          await axios.post(`${TELEGRAM_API}/editMessageText`, {
            chat_id: CHAT_ID,
            message_id: anterior.messageId,
            text: msg,
            parse_mode: "Markdown",
          });

          console.log("✏️ Mensagem atualizada:", homeTeam, "vs", awayTeam);

          SEEN_MATCHES.set(matchKey, {
            ...anterior,
            scoreHomeTeam,
            scoreAwayTeam,
            cornerHome,
            cornerAway,
            eventos: eventosUnicos,
          });
        } catch (error) {
          console.error(
            "❌ Erro ao editar mensagem:",
            error.response?.data || error.message
          );
        }
      }
    }
  }

  await browser.close();
}

// 🔁 Executar a cada 1 minuto
buscarPartidas();
setInterval(buscarPartidas, 1 * 60 * 1000);
