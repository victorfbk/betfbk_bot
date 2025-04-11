import "dotenv/config";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import axios from "axios";

puppeteer.use(StealthPlugin());

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;
const CHAT_ID = process.env.CHAT_ID;

const SEEN_MATCHES = new Map();

function calcularMediaAtaquesPorMinuto(ataques, minuto) {
  if (!ataques || !minuto || minuto < 58) return 0;
  return Number((ataques / minuto).toFixed(2));
}

function gerarMensagem(match, dadosFixos, eventos = []) {
  const { placarInicial, minuto, ataquesIniciais, escanteiosIniciais } =
    dadosFixos;
  const fogoHome = match.dangerHomeTeam > match.dangerAwayTeam ? "🔥" : "";
  const fogoAway = match.dangerAwayTeam > match.dangerHomeTeam ? "🔥" : "";

  const header = `
🏆 ${match.league}
⚔️ ${match.homeTeam} ${fogoHome} vs ${fogoAway} ${match.awayTeam}
⏱️ Minuto: ${minuto}
📊 Placar Inicial: ${placarInicial}
🚀 Ataques perigosos: ${ataquesIniciais}
🚩 Escanteios Iniciais: ${escanteiosIniciais}
`.trim();

  const eventosTexto = eventos
    .map((ev) => `${ev.tipo} ${ev.minuto} ${ev.placar} ✅`)
    .join("\n");

  return eventosTexto ? `${header}\n\n${eventosTexto}` : header;
}

async function buscarPartidas() {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600 });
    console.log("🔍 Buscando partidas em andamento...");

    await page.goto("https://www.totalcorner.com/match/today", {
      waitUntil: "domcontentloaded",
      timeout: 60000, // 60 segundos
    });

    const partidas = await page.evaluate(() => {
      const rows = document.querySelectorAll("tbody.tbody_match > tr");
      return Array.from(rows).map((row) => {
        const getText = (selector) =>
          row.querySelector(selector)?.textContent.trim() ?? null;

        const minute = parseInt(getText(".match_status_minutes")) || null;
        const homeTeam = getText(".match_home a > span");
        const awayTeam = getText(".match_away a > span");
        const scoreText = getText(".match_goal") ?? "0 - 0";
        const [scoreHomeTeam, scoreAwayTeam] = scoreText
          .split(" - ")
          .map(Number);

        const dangerText = getText(".match_dangerous_attacks_div") ?? "0 - 0";
        const [dangerHomeTeam, dangerAwayTeam] = dangerText
          .split(" - ")
          .map(Number);

        const league =
          row.querySelector(".td_league a")?.textContent.trim() ??
          "Desconhecida";

        const cornerText =
          row.querySelector(".span_match_corner")?.textContent.trim() ??
          "0 - 0";
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

      const minutoValor = minute;
      if (
        !minutoValor ||
        !homeTeam ||
        !awayTeam ||
        minutoValor < 63 ||
        minutoValor > 68
      )
        continue;

      const mediaHome = calcularMediaAtaquesPorMinuto(
        dangerHomeTeam,
        minutoValor
      );
      const mediaAway = calcularMediaAtaquesPorMinuto(
        dangerAwayTeam,
        minutoValor
      );

      const matchKey = `${homeTeam}-${awayTeam}-${league}`;
      const matchData = SEEN_MATCHES.get(matchKey);

      if (!matchData) {
        const isEmpate = scoreHomeTeam === scoreAwayTeam;
        const isDiferencaUmGol = Math.abs(scoreHomeTeam - scoreAwayTeam) === 1;

        if (
          (isEmpate && (mediaHome >= 0.8 || mediaAway >= 0.8)) ||
          (isDiferencaUmGol &&
            ((scoreHomeTeam < scoreAwayTeam && mediaHome >= 0.8) ||
              (scoreAwayTeam < scoreHomeTeam && mediaAway >= 0.8)))
        ) {
          const dadosFixos = {
            placarInicial: `${scoreHomeTeam} x ${scoreAwayTeam}`,
            minuto: minutoValor,
            ataquesIniciais: `${dangerHomeTeam} - ${dangerAwayTeam}`,
            escanteiosIniciais: `${cornerHome} - ${cornerAway}`,
          };

          const msg = gerarMensagem(match, dadosFixos, []);
          const res = await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: CHAT_ID,
            text: msg,
            parse_mode: "Markdown",
          });

          console.log("📩 Partida enviada:", homeTeam, "vs", awayTeam);

          SEEN_MATCHES.set(matchKey, {
            ...match,
            messageId: res.data.result.message_id,
            eventos: [],
            dadosFixos,
          });
        }
      } else {
        const anterior = matchData;
        const novosEventos = [];
        let mudou = false;

        if (
          scoreHomeTeam !== anterior.scoreHomeTeam ||
          scoreAwayTeam !== anterior.scoreAwayTeam
        ) {
          novosEventos.push({
            tipo: "⚽",
            minuto: match.minute,
            placar: `${scoreHomeTeam} x ${scoreAwayTeam}`,
          });
          mudou = true;
        }

        const novosEscanteiosHome = cornerHome - anterior.cornerHome;
        const novosEscanteiosAway = cornerAway - anterior.cornerAway;

        for (let i = 0; i < novosEscanteiosHome; i++) {
          novosEventos.push({ tipo: "🚩", minuto: match.minute, placar: "" });
          mudou = true;
        }
        for (let i = 0; i < novosEscanteiosAway; i++) {
          novosEventos.push({ tipo: "🚩", minuto: match.minute, placar: "" });
          mudou = true;
        }

        if (mudou) {
          const eventos = [...anterior.eventos, ...novosEventos];
          const msg = gerarMensagem(match, anterior.dadosFixos, eventos);

          await axios.post(`${TELEGRAM_API}/editMessageText`, {
            chat_id: CHAT_ID,
            message_id: anterior.messageId,
            text: msg,
            parse_mode: "Markdown",
          });

          SEEN_MATCHES.set(matchKey, {
            ...anterior,
            scoreHomeTeam,
            scoreAwayTeam,
            cornerHome,
            cornerAway,
            eventos,
          });

          console.log("✏️ Mensagem atualizada:", homeTeam, "vs", awayTeam);
        }
      }
    }
  } catch (error) {
    console.error("❌ Erro ao buscar partidas:", error.message);
  } finally {
    if (browser) await browser.close();
  }
}

buscarPartidas();
setInterval(buscarPartidas, 60 * 1000);
