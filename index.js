import "dotenv/config";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import axios from "axios";

puppeteer.use(StealthPlugin());

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;
const CHAT_ID = process.env.CHAT_ID;
const SEEN_MATCHES = new Map();

let browser = null;
let page = null;
let ciclos = 0;
let consecutiveErrors = 0;
let executando = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function calcularMediaAtaquesPorMinuto(ataques, minuto) {
  if (!ataques || !minuto || minuto < 58) return 0;
  return Number((ataques / minuto).toFixed(2));
}

function gerarMensagem(match, dadosFixos, eventos = []) {
  const { placarInicial, minuto, ataquesIniciais, escanteiosIniciais } = dadosFixos;
  const fogoHome = match.dangerHomeTeam > match.dangerAwayTeam ? "🔥" : "";
  const fogoAway = match.dangerAwayTeam > match.dangerHomeTeam ? "🔥" : "";

  const header = `🏆 ${match.league}
⚔️ ${match.homeTeam} ${fogoHome} vs ${fogoAway} ${match.awayTeam}
⏱️ Minuto: ${minuto}
📊 Placar Inicial: ${placarInicial}
🚀 Ataques perigosos: ${ataquesIniciais}
🚩 Escanteios Iniciais: ${escanteiosIniciais}`.trim();

  const eventosTexto = eventos
    .map((ev) => `${ev.tipo} ${ev.minuto} ${ev.placar} ✅`)
    .join("\n");
  return eventosTexto ? `${header}\n\n${eventosTexto}` : header;
}

async function fecharBrowser() {
  try {
    if (page && !page.isClosed()) await page.close();
  } catch (_) {}
  try {
    if (browser) await browser.close();
  } catch (_) {}
  browser = null;
  page = null;
}

async function iniciarBrowser() {
  const morto =
    !browser ||
    !browser.process() ||
    browser.process().exitCode !== null;

  if (morto) {
    await fecharBrowser();
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
  }

  try {
    if (page && !page.isClosed()) await page.close();
  } catch (_) {}

  page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
  );
  await page.setViewport({ width: 1366, height: 768 });
}

async function buscarPartidas() {
  if (executando) {
    console.log("⏳ Ciclo anterior ainda em execução, pulando...");
    return;
  }
  executando = true;

  try {
    console.log(`[${new Date().toLocaleTimeString()}] 🔍 Buscando partidas...`);
    await iniciarBrowser();

    try {
      await page.goto("https://www.totalcorner.com/match/today", {
        waitUntil: ["domcontentloaded", "networkidle2"],
        timeout: 120000,
      });
    } catch (e) {
      console.warn("⚠️ goto falhou, tentando reload:", e.message);
      await page.reload({
        waitUntil: ["domcontentloaded", "networkidle2"],
        timeout: 120000,
      });
    }

    const inicio = Date.now();
    let encontrou = false;
    while (Date.now() - inicio < 30000) {
      const el = await page.$("tbody.tbody_match > tr");
      if (el) { encontrou = true; break; }
      await sleep(1000);
    }

    if (!encontrou) {
      throw new Error("Seletor não encontrado após 30s");
    }

    const partidas = await page.evaluate(() => {
      try {
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
          const [dangerHomeTeam, dangerAwayTeam] = dangerText.split(" - ").map(Number);
          const league = row.querySelector(".td_league a")?.textContent.trim() ?? "Desconhecida";
          const cornerText = row.querySelector(".span_match_corner")?.textContent.trim() ?? "0 - 0";
          const [cornerHome, cornerAway] = cornerText.split(" - ").map(Number);

          return {
            minute, homeTeam, awayTeam,
            scoreHomeTeam, scoreAwayTeam,
            dangerHomeTeam, dangerAwayTeam,
            cornerHome, cornerAway, league,
          };
        });
      } catch (_) { return []; }
    });

    console.log(`⚙️ Analisando ${partidas.length} partidas...`);
    const currentMatchKeys = new Set();

    for (const match of partidas) {
      const {
        homeTeam, awayTeam, minute,
        scoreHomeTeam, scoreAwayTeam,
        dangerHomeTeam, dangerAwayTeam,
        cornerHome, cornerAway, league,
      } = match;

      const matchKey = `${homeTeam}-${awayTeam}-${league}`;
      currentMatchKeys.add(matchKey);
      const matchData = SEEN_MATCHES.get(matchKey);

      if (!matchData) {
        if (!minute || minute < 26 || minute > 85) continue;

        const mediaHome = calcularMediaAtaquesPorMinuto(dangerHomeTeam, minute);
        const mediaAway = calcularMediaAtaquesPorMinuto(dangerAwayTeam, minute);
        const isEmpate = scoreHomeTeam === scoreAwayTeam;
        const isDiferencaUmGol = Math.abs(scoreHomeTeam - scoreAwayTeam) === 1;

        if (
          (isEmpate && (mediaHome >= 0.85 || mediaAway >= 0.85)) ||
          (isDiferencaUmGol &&
            ((scoreHomeTeam < scoreAwayTeam && mediaHome >= 0.85) ||
              (scoreAwayTeam < scoreHomeTeam && mediaAway >= 0.85)))
        ) {
          const dadosFixos = {
            placarInicial: `${scoreHomeTeam} x ${scoreAwayTeam}`,
            minuto: minute,
            ataquesIniciais: `${dangerHomeTeam} - ${dangerAwayTeam}`,
            escanteiosIniciais: `${cornerHome} - ${cornerAway}`,
          };

          const msg = gerarMensagem(match, dadosFixos, []);
          const res = await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: CHAT_ID,
            text: msg,
          });

          console.log("📩 Enviado:", homeTeam, "vs", awayTeam);
          SEEN_MATCHES.set(matchKey, {
            ...match,
            messageId: res.data.result.message_id,
            eventos: [],
            dadosFixos,
          });
        }
      } else {
        if (minute === null || minute > 100) {
          SEEN_MATCHES.delete(matchKey);
          console.log("🗑️ Finalizada:", matchKey);
          continue;
        }

        const anterior = matchData;
        const novosEventos = [];
        let mudou = false;

        if (scoreHomeTeam !== anterior.scoreHomeTeam || scoreAwayTeam !== anterior.scoreAwayTeam) {
          novosEventos.push({ tipo: "⚽", minuto: minute, placar: `${scoreHomeTeam} x ${scoreAwayTeam}` });
          mudou = true;
        }

        const novosEscanteiosHome = cornerHome - anterior.cornerHome;
        const novosEscanteiosAway = cornerAway - anterior.cornerAway;
        for (let i = 0; i < novosEscanteiosHome; i++) {
          novosEventos.push({ tipo: "🚩", minuto: minute, placar: "" });
          mudou = true;
        }
        for (let i = 0; i < novosEscanteiosAway; i++) {
          novosEventos.push({ tipo: "🚩", minuto: minute, placar: "" });
          mudou = true;
        }

        if (mudou) {
          const eventos = [...anterior.eventos, ...novosEventos];
          const msg = gerarMensagem(match, anterior.dadosFixos, eventos);

          await axios.post(`${TELEGRAM_API}/editMessageText`, {
            chat_id: CHAT_ID,
            message_id: anterior.messageId,
            text: msg,
          });

          SEEN_MATCHES.set(matchKey, {
            ...match,
            messageId: anterior.messageId,
            dadosFixos: anterior.dadosFixos,
            eventos,
          });

          console.log("✏️ Atualizado:", homeTeam, "vs", awayTeam);
        }
      }
    }

    SEEN_MATCHES.forEach((_, key) => {
      if (!currentMatchKeys.has(key)) {
        SEEN_MATCHES.delete(key);
        console.log("🗑️ Removida:", key);
      }
    });

    consecutiveErrors = 0;
    ciclos++;

    if (ciclos >= 50) {
      console.log("🔁 Reiniciando browser para liberar memória...");
      await fecharBrowser();
      ciclos = 0;
    }

  } catch (error) {
    console.error("❌ Erro:", error.message);
    consecutiveErrors++;

    if (consecutiveErrors >= 3) {
      console.error("🚨 3 erros seguidos — reiniciando browser...");
      await fecharBrowser();
      consecutiveErrors = 0;
      ciclos = 0;
    }
  } finally {
    executando = false;
  }
}

(async () => {
  console.log("🚀 Bot iniciado!");
  while (true) {
    await buscarPartidas();
    await sleep(60000);
  }
})();