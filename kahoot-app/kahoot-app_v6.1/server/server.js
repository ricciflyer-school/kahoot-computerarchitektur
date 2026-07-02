/*
 * server.js
 * ============================================================
 * Backend für das Kahoot-ähnliche Quiz "Computerarchitektur".
 * Neu in dieser Version:
 *   - Antwortergebnis wird ERST verschickt, wenn alle geantwortet haben
 *     oder die Zeit abgelaufen ist (kein sofortiges Feedback mehr)
 *   - Powerups: 50/50, Extra-Zeit, Doppelte Punkte, Schutzschild
 *   - Streak-Multiplikator für mehrere richtige Antworten in Folge
 *   - Risikomodus (doppelte Punkte / doppelter Abzug)
 *   - Live-Reaktionen (Emojis) während einer Frage
 *   - Geheime Missionen mit Bonuspunkten
 *   - Bild-Upload für den Fragen-Editor (Base64 -> Datei in /client/images)
 * ============================================================ */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const QUIZ_DATA_PATH = path.join(__dirname, "quiz-data.json");
const RESULTS_DIR = path.join(__dirname, "results");
const IMAGES_DIR = path.join(__dirname, "..", "client", "images");

if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingTimeout: 20000, pingInterval: 10000 });

app.use(express.static(path.join(__dirname, "..", "client")));
app.use(express.json({ limit: "8mb" }));

// ------------------------------------------------------------
// Fragenkatalog laden / speichern
// ------------------------------------------------------------
function loadQuestions() {
  try {
    return JSON.parse(fs.readFileSync(QUIZ_DATA_PATH, "utf-8")).questions;
  } catch (err) {
    console.error("Fehler beim Laden der Fragen:", err);
    return [];
  }
}
function saveQuestions(questions) {
  try {
    fs.writeFileSync(QUIZ_DATA_PATH, JSON.stringify({ questions }, null, 2), "utf-8");
    return true;
  } catch (err) {
    console.error("Fehler beim Speichern der Fragen:", err);
    return false;
  }
}

app.get("/api/questions", (req, res) => res.json(loadQuestions()));

// ---------- Bild-Upload für den Editor ----------
app.post("/api/upload-image", (req, res) => {
  try {
    const { filename, dataBase64 } = req.body;
    if (!filename || !dataBase64) {
      return res.status(400).json({ success: false, error: "Dateiname oder Daten fehlen." });
    }
    const safeName = path.basename(filename).replace(/[^a-zA-Z0-9_.-]/g, "_");
    if (!/\.(png|jpe?g|gif|webp|svg)$/i.test(safeName)) {
      return res.status(400).json({ success: false, error: "Nur Bildformate erlaubt (png, jpg, gif, webp, svg)." });
    }
    const base64Data = dataBase64.replace(/^data:image\/\w+;base64,/, "");
    fs.writeFileSync(path.join(IMAGES_DIR, safeName), Buffer.from(base64Data, "base64"));
    res.json({ success: true, path: "images/" + safeName });
  } catch (err) {
    console.error("Upload-Fehler:", err);
    res.status(500).json({ success: false, error: "Serverfehler beim Hochladen." });
  }
});

app.get("/api/images", (req, res) => {
  try {
    const files = fs.readdirSync(IMAGES_DIR).filter((f) => /\.(png|jpe?g|gif|webp|svg)$/i.test(f));
    res.json(files);
  } catch {
    res.json([]);
  }
});

app.get("/api/sounds", (req, res) => {
  try {
    const dir = path.join(__dirname, "..", "client", "sounds");
    if (!fs.existsSync(dir)) return res.json([]);
    const files = fs.readdirSync(dir).filter((f) => /\.(mp3|ogg|wav)$/i.test(f));
    res.json(files);
  } catch {
    res.json([]);
  }
});

// ------------------------------------------------------------
// Spielverwaltung
// ------------------------------------------------------------
const games = {};

function generateGameCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = "";
    for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  } while (games[code]);
  return code;
}

function baseScore(isCorrect, timeUsedMs, timeLimitMs) {
  if (!isCorrect) return 0;
  const fraction = Math.max(0, 1 - timeUsedMs / timeLimitMs);
  return Math.round(100 + fraction * 900);
}

function getLeaderboard(game) {
  return Object.entries(game.players)
    .map(([socketId, p]) => ({ socketId, name: p.name, avatar: p.avatar, score: p.score, streak: p.streak }))
    .sort((a, b) => b.score - a.score);
}

function publicQuestion(question) {
  return {
    id: question.id,
    title: question.title,
    description: question.description,
    image: question.image,
    answers: question.answers,
    timeLimit: question.timeLimit
  };
}

function persistResultsToDisk(game) {
  const leaderboard = getLeaderboard(game);
  let csv = "Platz;Name;Punkte\n";
  leaderboard.forEach((p, i) => (csv += `${i + 1};${p.name};${p.score}\n`));
  const filename = `ergebnis_${game.code}_${Date.now()}.csv`;
  fs.writeFileSync(path.join(RESULTS_DIR, filename), "\uFEFF" + csv, "utf-8");
  return filename;
}

function resetPerQuestionFlags(player) {
  player.answeredCurrent = false;
  player.currentAnswer = null;
  player.doublePointsActiveThisQuestion = false;
  player.shieldActiveThisQuestion = false;
  player.riskModeActiveThisQuestion = false;
}

io.on("connection", (socket) => {
  socket.on("host:createGame", (_, callback) => {
    const code = generateGameCode();
    const game = {
      code,
      hostSocketId: socket.id,
      status: "lobby",
      questions: loadQuestions(),
      currentQuestionIndex: -1,
      questionStartedAt: null,
      players: {},
      timer: null,
      missionFastestAwardedThisQuestion: false
    };
    games[code] = game;
    socket.join(code);
    socket.data.role = "host";
    socket.data.gameCode = code;
    callback && callback({ success: true, code, questionCount: game.questions.length });
  });

  socket.on("host:saveQuestions", (questions, callback) => {
    if (!Array.isArray(questions) || questions.length === 0) {
      return callback && callback({ success: false, error: "Keine Fragen übergeben." });
    }
    for (const q of questions) {
      if (
        !q.title || !q.description ||
        !Array.isArray(q.answers) || q.answers.length !== 4 ||
        q.answers.some((a) => !a || a.trim() === "") ||
        typeof q.correctIndex !== "number" || q.correctIndex < 0 || q.correctIndex > 3 ||
        typeof q.timeLimit !== "number" || q.timeLimit < 5
      ) {
        return callback && callback({ success: false, error: "Ungültige Frage erkannt: " + (q.title || "(ohne Titel)") });
      }
    }
    const ok = saveQuestions(questions);
    const code = socket.data.gameCode;
    if (code && games[code]) games[code].questions = questions;
    callback && callback({ success: ok });
  });

  socket.on("host:getQuestions", (_, callback) => callback && callback(loadQuestions()));

  socket.on("player:joinGame", ({ code, name, avatar }, callback) => {
    try {
      code = (code || "").toString().toUpperCase().trim();
      name = (name || "").toString().trim().replace(/[<>]/g, "");
      avatar = (avatar || "🙂").toString();

      if (!code || !games[code]) return callback({ success: false, error: "Spielcode nicht gefunden." });
      if (!name || name.length < 2 || name.length > 18) {
        return callback({ success: false, error: "Name muss 2-18 Zeichen lang sein." });
      }

      const game = games[code];
      if (game.status !== "lobby") return callback({ success: false, error: "Dieses Spiel läuft bereits oder ist beendet." });
      if (Object.keys(game.players).length >= 28) return callback({ success: false, error: "Maximale Teilnehmerzahl (28) erreicht." });

      const nameTaken = Object.values(game.players).some((p) => p.name.toLowerCase() === name.toLowerCase());
      if (nameTaken) return callback({ success: false, error: "Dieser Name ist bereits vergeben." });

      game.players[socket.id] = {
        name,
        avatar,
        score: 0,
        streak: 0,
        answeredCurrent: false,
        currentAnswer: null,
        history: [],
        powerupsUsed: { fiftyFifty: false, extraTime: false, doublePoints: false, shield: false },
        doublePointsActiveThisQuestion: false,
        shieldActiveThisQuestion: false,
        riskModeActiveThisQuestion: false,
        missions: { threeStreak: false, fastest: false }
      };

      socket.join(code);
      socket.data.role = "player";
      socket.data.gameCode = code;

      io.to(game.hostSocketId).emit("host:playerJoined", {
        players: Object.entries(game.players).map(([id, p]) => ({ id, name: p.name, avatar: p.avatar }))
      });

      callback({ success: true, code, name });
    } catch (err) {
      console.error("Fehler beim Beitreten:", err);
      callback({ success: false, error: "Unbekannter Serverfehler." });
    }
  });

  socket.on("host:startGame", (_, callback) => {
    const game = getGameForSocket(socket);
    if (!game) return callback && callback({ success: false, error: "Kein Spiel gefunden." });
    if (Object.keys(game.players).length === 0) {
      return callback && callback({ success: false, error: "Es sind noch keine Spieler beigetreten." });
    }
    game.status = "starting";
    io.to(game.code).emit("game:starting");
    callback && callback({ success: true });
    setTimeout(() => startNextQuestion(game), 1500);
  });

  socket.on("host:nextQuestion", () => {
    const game = getGameForSocket(socket);
    if (game) startNextQuestion(game);
  });

  socket.on("player:usePowerup", ({ type }) => {
    const game = getGameForSocket(socket);
    if (!game || game.status !== "question") return;
    const player = game.players[socket.id];
    if (!player || player.answeredCurrent) return;
    if (!player.powerupsUsed.hasOwnProperty(type) || player.powerupsUsed[type]) return;

    player.powerupsUsed[type] = true;

    if (type === "fiftyFifty") {
      const question = game.questions[game.currentQuestionIndex];
      const wrongIndices = [0, 1, 2, 3].filter((i) => i !== question.correctIndex);
      const shuffled = wrongIndices.sort(() => Math.random() - 0.5);
      socket.emit("player:powerupResult", { type, hideIndices: shuffled.slice(0, 2) });
    } else if (type === "extraTime") {
      extendQuestionTimer(game, 10);
      io.to(game.code).emit("game:extraTime", { by: player.name, seconds: 10 });
      socket.emit("player:powerupResult", { type });
    } else if (type === "doublePoints") {
      player.doublePointsActiveThisQuestion = true;
      socket.emit("player:powerupResult", { type });
    } else if (type === "shield") {
      player.shieldActiveThisQuestion = true;
      socket.emit("player:powerupResult", { type });
    }
  });

  socket.on("player:setRiskMode", ({ enabled }) => {
    const game = getGameForSocket(socket);
    if (!game || game.status !== "question") return;
    const player = game.players[socket.id];
    if (!player || player.answeredCurrent) return;
    player.riskModeActiveThisQuestion = !!enabled;
  });

  socket.on("player:sendReaction", ({ emoji }) => {
    const game = getGameForSocket(socket);
    if (!game) return;
    const player = game.players[socket.id];
    if (!player) return;
    const allowed = ["👍", "😂", "😮", "❤️", "🔥"];
    if (!allowed.includes(emoji)) return;
    io.to(game.code).emit("game:reaction", { name: player.name, avatar: player.avatar, emoji });
  });

  socket.on("player:submitAnswer", ({ answerIndex }) => {
    const game = getGameForSocket(socket);
    if (!game || game.status !== "question") return;
    const player = game.players[socket.id];
    if (!player || player.answeredCurrent) return;

    const question = game.questions[game.currentQuestionIndex];
    const timeUsedMs = Date.now() - game.questionStartedAt;
    const timeLimitMs = question.timeLimit * 1000;
    if (timeUsedMs > timeLimitMs + 300) return;

    player.answeredCurrent = true;
    player.currentAnswer = { answerIndex, timeUsedMs };

    socket.emit("player:answerReceived");

    const answeredCount = Object.values(game.players).filter((p) => p.answeredCurrent).length;
    io.to(game.hostSocketId).emit("host:answerProgress", {
      answeredCount,
      totalPlayers: Object.keys(game.players).length
    });

    if (answeredCount === Object.keys(game.players).length) {
      clearTimeout(game.timer);
      endCurrentQuestion(game);
    }
  });

  socket.on("host:exportResults", (_, callback) => {
    const game = getGameForSocket(socket);
    if (!game) return callback && callback({ success: false });
    const filename = persistResultsToDisk(game);
    callback && callback({ success: true, filename, leaderboard: getLeaderboard(game) });
  });

  socket.on("disconnect", () => {
    const code = socket.data.gameCode;
    const role = socket.data.role;
    if (!code || !games[code]) return;
    const game = games[code];
    if (role === "host") {
      io.to(code).emit("game:hostDisconnected");
    } else if (role === "player" && game.players[socket.id]) {
      io.to(game.hostSocketId).emit("host:playerLeft", { id: socket.id });
    }
  });

  function getGameForSocket(s) {
    const code = s.data.gameCode;
    return code ? games[code] : null;
  }
});

// ------------------------------------------------------------
// Fragenfluss
// ------------------------------------------------------------
function startNextQuestion(game) {
  clearTimeout(game.timer);
  game.currentQuestionIndex++;

  if (game.currentQuestionIndex >= game.questions.length) {
    finishGame(game);
    return;
  }

  Object.values(game.players).forEach(resetPerQuestionFlags);
  game.missionFastestAwardedThisQuestion = false;

  const question = game.questions[game.currentQuestionIndex];
  game.status = "question";
  game.questionStartedAt = Date.now();

  io.to(game.code).emit("game:newQuestion", {
    index: game.currentQuestionIndex,
    total: game.questions.length,
    question: publicQuestion(question)
  });

  game.timer = setTimeout(() => endCurrentQuestion(game), question.timeLimit * 1000 + 300);
}

function extendQuestionTimer(game, extraSeconds) {
  if (game.status !== "question") return;
  clearTimeout(game.timer);
  const question = game.questions[game.currentQuestionIndex];
  const elapsed = Date.now() - game.questionStartedAt;
  const remaining = question.timeLimit * 1000 - elapsed + extraSeconds * 1000;
  game.timer = setTimeout(() => endCurrentQuestion(game), Math.max(remaining, 1000));
}

function endCurrentQuestion(game) {
  if (game.status !== "question") return;
  game.status = "reveal";
  const question = game.questions[game.currentQuestionIndex];
  const timeLimitMs = question.timeLimit * 1000;

  let fastestSocketId = null;
  let fastestTime = Infinity;
  Object.entries(game.players).forEach(([id, p]) => {
    if (p.currentAnswer && p.currentAnswer.answerIndex === question.correctIndex) {
      if (p.currentAnswer.timeUsedMs < fastestTime) {
        fastestTime = p.currentAnswer.timeUsedMs;
        fastestSocketId = id;
      }
    }
  });

  Object.entries(game.players).forEach(([id, player]) => {
    const answer = player.currentAnswer;
    const isCorrect = !!answer && answer.answerIndex === question.correctIndex;
    const timeUsedMs = answer ? answer.timeUsedMs : timeLimitMs;

    let points = baseScore(isCorrect, timeUsedMs, timeLimitMs);

    if (isCorrect) {
      player.streak++;
      const multiplier = 1 + Math.min(player.streak - 1, 5) * 0.1;
      points = Math.round(points * multiplier);
    } else {
      player.streak = 0;
    }

    if (player.doublePointsActiveThisQuestion) points *= 2;

    let missionMessages = [];
    if (player.riskModeActiveThisQuestion) {
      if (isCorrect) {
        points *= 2;
      } else if (!player.shieldActiveThisQuestion) {
        points = -Math.abs(baseScore(true, 0, timeLimitMs));
      } else {
        points = 0;
        missionMessages.push("🛡️ Schutzschild hat dich vor Punktabzug bewahrt!");
      }
    } else {
      // Außerhalb des Risikomodus dürfen NIEMALS Punkte abgezogen werden
      points = Math.max(0, points);
    }

    player.score = Math.max(0, player.score + points);

    if (!player.missions.threeStreak && player.streak >= 3) {
      player.missions.threeStreak = true;
      player.score += 150;
      missionMessages.push("🎯 Geheime Mission erfüllt: 3 in Folge richtig! +150 Bonuspunkte");
    }
    if (!player.missions.fastest && id === fastestSocketId && !game.missionFastestAwardedThisQuestion) {
      player.missions.fastest = true;
      player.score += 100;
      missionMessages.push("⚡ Geheime Mission erfüllt: Schneller als alle anderen! +100 Bonuspunkte");
    }

    player.history.push({ correct: isCorrect, points });

    io.to(id).emit("player:answerResult", {
      correct: isCorrect,
      pointsEarned: points,
      totalScore: player.score,
      streak: player.streak,
      missionMessages
    });
  });

  if (fastestSocketId) game.missionFastestAwardedThisQuestion = true;

  io.to(game.code).emit("game:revealAnswer", { correctIndex: question.correctIndex });

  setTimeout(() => {
    game.status = "leaderboard";
    const leaderboard = getLeaderboard(game);
    io.to(game.code).emit("game:leaderboard", {
      leaderboard,
      isFinal: game.currentQuestionIndex === game.questions.length - 1
    });
  }, 2500);
}

function finishGame(game) {
  game.status = "finished";
  io.to(game.code).emit("game:finished", { leaderboard: getLeaderboard(game) });
  persistResultsToDisk(game);
}

server.listen(PORT, () => {
  console.log(`Quiz-Server läuft auf Port ${PORT}`);
});
