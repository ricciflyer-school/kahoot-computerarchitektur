/*
 * server.js
 * ============================================================
 * Backend für das Kahoot-ähnliche Quiz "Computerarchitektur".
 *
 * Technik:
 *   - Express liefert die statischen Client-Dateien aus (/client)
 *   - Socket.IO sorgt für die Echtzeitkommunikation zwischen
 *     Host und Teilnehmern (Lobby, Fragen, Antworten, Rangliste)
 *   - Persistenz erfolgt über einfache JSON-Dateien (keine DB nötig):
 *       quiz-data.json  -> Fragenkatalog (vom Host editierbar)
 *       results/        -> Ergebnis-Dateien je abgeschlossenem Spiel
 *
 * Der Server verwaltet beliebig viele parallele Spiele ("rooms"),
 * jedes über einen eindeutigen 6-stelligen Code identifiziert.
 * Getestet/ausgelegt für mindestens 28 gleichzeitige Teilnehmer
 * pro Raum.
 * ============================================================
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

// ------------------------------------------------------------
// Grundkonfiguration
// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const QUIZ_DATA_PATH = path.join(__dirname, "quiz-data.json");
const RESULTS_DIR = path.join(__dirname, "results");

// Stelle sicher, dass der Ergebnis-Ordner existiert
if (!fs.existsSync(RESULTS_DIR)) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Großzügige Timeouts, damit kurze WLAN-Aussetzer bei 28+ Teilnehmern
  // nicht sofort zum Disconnect führen (unterstützt Auto-Reconnect)
  pingTimeout: 20000,
  pingInterval: 10000
});

// Statische Client-Dateien ausliefern (HTML/CSS/JS im /client Ordner)
app.use(express.static(path.join(__dirname, "..", "client")));
app.use(express.json());

// ------------------------------------------------------------
// Fragenkatalog laden / speichern
// ------------------------------------------------------------
function loadQuestions() {
  try {
    const raw = fs.readFileSync(QUIZ_DATA_PATH, "utf-8");
    return JSON.parse(raw).questions;
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

// Einfache REST-Route, falls der Client den Fragenkatalog ohne Socket
// abrufen möchte (z.B. für den Editor beim Laden der Seite)
app.get("/api/questions", (req, res) => {
  res.json(loadQuestions());
});

// ------------------------------------------------------------
// In-Memory Verwaltung aller laufenden Spiele ("rooms")
// Struktur eines Spiels:
// {
//   code, hostSocketId, status, questions, currentQuestionIndex,
//   questionStartedAt, questionTimeLimit, players: { socketId: {name, score, answeredCurrent, history:[]} },
//   timer: NodeJS.Timeout
// }
// ------------------------------------------------------------
const games = {};

// Erzeugt einen zufälligen, gut lesbaren 6-stelligen Code (ohne Verwechslungsbuchstaben)
function generateGameCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = "";
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (games[code]); // Sicherstellen, dass der Code noch nicht vergeben ist
  return code;
}

// Berechnet die Punktzahl nach Kahoot-Prinzip:
// Je schneller eine RICHTIGE Antwort gegeben wird, desto mehr Punkte (100 - 1000).
function calculateScore(isCorrect, timeUsedMs, timeLimitMs) {
  if (!isCorrect) return 0;
  const fraction = Math.max(0, 1 - timeUsedMs / timeLimitMs);
  return Math.round(100 + fraction * 900);
}

// Liefert die aktuelle Rangliste eines Spiels, absteigend sortiert
function getLeaderboard(game) {
  return Object.entries(game.players)
    .map(([socketId, p]) => ({ socketId, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
}

// Entfernt sensible/serverinterne Felder, bevor Daten an Clients gesendet werden
function publicQuestion(question) {
  return {
    id: question.id,
    title: question.title,
    description: question.description,
    image: question.image,
    answers: question.answers,
    timeLimit: question.timeLimit
    // correctIndex wird bewusst NICHT an die Spieler gesendet,
    // solange die Frage noch offen ist!
  };
}

// Speichert das Endergebnis eines Spiels als CSV-Datei auf dem Server
function persistResultsToDisk(game) {
  const leaderboard = getLeaderboard(game);
  let csv = "Platz;Name;Punkte\n";
  leaderboard.forEach((p, i) => {
    csv += `${i + 1};${p.name};${p.score}\n`;
  });
  const filename = `ergebnis_${game.code}_${Date.now()}.csv`;
  fs.writeFileSync(path.join(RESULTS_DIR, filename), "\uFEFF" + csv, "utf-8");
  return filename;
}

// ------------------------------------------------------------
// Socket.IO Hauptlogik
// ------------------------------------------------------------
io.on("connection", (socket) => {
  console.log(`Neue Verbindung: ${socket.id}`);

  // -------------------- HOST: Spiel erstellen --------------------
  socket.on("host:createGame", (_, callback) => {
    const code = generateGameCode();
    const game = {
      code,
      hostSocketId: socket.id,
      status: "lobby", // lobby | question | reveal | leaderboard | finished
      questions: loadQuestions(),
      currentQuestionIndex: -1,
      questionStartedAt: null,
      questionTimeLimit: 20,
      players: {},
      timer: null
    };
    games[code] = game;
    socket.join(code);
    socket.data.role = "host";
    socket.data.gameCode = code;

    console.log(`Spiel erstellt: ${code}`);
    if (typeof callback === "function") {
      callback({ success: true, code, questionCount: game.questions.length });
    }
  });

  // -------------------- HOST: Fragenkatalog aktualisieren (Editor) --------------------
  socket.on("host:saveQuestions", (questions, callback) => {
    // Validierung: jede Frage muss Titel, 4 Antworten und gültigen correctIndex haben
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
    if (code && games[code]) {
      games[code].questions = questions;
    }
    callback && callback({ success: ok });
  });

  socket.on("host:getQuestions", (_, callback) => {
    callback && callback(loadQuestions());
  });

  // -------------------- SPIELER: Spiel beitreten --------------------
  socket.on("player:joinGame", ({ code, name }, callback) => {
    try {
      code = (code || "").toString().toUpperCase().trim();
      name = (name || "").toString().trim();

      // ---- Validierung der Eingaben ----
      if (!code || !games[code]) {
        return callback({ success: false, error: "Spielcode nicht gefunden." });
      }
      if (!name || name.length < 2 || name.length > 18) {
        return callback({ success: false, error: "Name muss 2-18 Zeichen lang sein." });
      }
      // Einfache Bereinigung gegen HTML-Injection im Namen
      name = name.replace(/[<>]/g, "");

      const game = games[code];

      if (game.status !== "lobby") {
        return callback({ success: false, error: "Dieses Spiel läuft bereits oder ist beendet." });
      }

      // Maximal 28 Teilnehmer pro Spiel zulassen
      if (Object.keys(game.players).length >= 28) {
        return callback({ success: false, error: "Maximale Teilnehmerzahl (28) erreicht." });
      }

      // Doppelte Namen im selben Spiel verhindern (Groß/Kleinschreibung ignorieren)
      const nameTaken = Object.values(game.players).some(
        (p) => p.name.toLowerCase() === name.toLowerCase()
      );
      if (nameTaken) {
        return callback({ success: false, error: "Dieser Name ist bereits vergeben." });
      }

      game.players[socket.id] = {
        name,
        score: 0,
        answeredCurrent: false,
        history: [] // pro Frage: { correct, timeUsedMs, points }
      };

      socket.join(code);
      socket.data.role = "player";
      socket.data.gameCode = code;

      // Host über neuen Spieler informieren
      io.to(game.hostSocketId).emit("host:playerJoined", {
        players: Object.entries(game.players).map(([id, p]) => ({ id, name: p.name }))
      });

      callback({ success: true, code, name });
    } catch (err) {
      console.error("Fehler beim Beitreten:", err);
      callback({ success: false, error: "Unbekannter Serverfehler." });
    }
  });

  // -------------------- HOST: Quiz starten --------------------
  socket.on("host:startGame", (_, callback) => {
    const game = getGameForSocket(socket);
    if (!game) return callback && callback({ success: false, error: "Kein Spiel gefunden." });
    if (Object.keys(game.players).length === 0) {
      return callback && callback({ success: false, error: "Es sind noch keine Spieler beigetreten." });
    }
    game.status = "starting";
    io.to(game.code).emit("game:starting");
    callback && callback({ success: true });

    // Kurze Vorlaufzeit, dann erste Frage starten
    setTimeout(() => startNextQuestion(game), 1500);
  });

  // -------------------- HOST: Nächste Frage manuell anfordern --------------------
  socket.on("host:nextQuestion", () => {
    const game = getGameForSocket(socket);
    if (!game) return;
    startNextQuestion(game);
  });

  // -------------------- SPIELER: Antwort einreichen --------------------
  socket.on("player:submitAnswer", ({ answerIndex }) => {
    const code = socket.data.gameCode;
    const game = games[code];
    if (!game || game.status !== "question") return;

    const player = game.players[socket.id];
    if (!player) return;

    // Mehrfachantworten verhindern: wenn schon beantwortet, ignorieren
    if (player.answeredCurrent) return;

    const question = game.questions[game.currentQuestionIndex];
    const timeUsedMs = Date.now() - game.questionStartedAt;
    const timeLimitMs = question.timeLimit * 1000;

    // Antwort nach Ablauf der Zeit nicht mehr werten
    if (timeUsedMs > timeLimitMs) return;

    const isCorrect = answerIndex === question.correctIndex;
    const points = calculateScore(isCorrect, timeUsedMs, timeLimitMs);

    player.answeredCurrent = true;
    player.score += points;
    player.history.push({ correct: isCorrect, timeUsedMs, points });

    // Direktes Feedback an den Spieler (richtig/falsch + Punkte)
    socket.emit("player:answerResult", {
      correct: isCorrect,
      pointsEarned: points,
      totalScore: player.score,
      correctIndex: question.correctIndex
    });

    // Host über Antwortfortschritt informieren (z.B. "12/28 haben geantwortet")
    const answeredCount = Object.values(game.players).filter((p) => p.answeredCurrent).length;
    io.to(game.hostSocketId).emit("host:answerProgress", {
      answeredCount,
      totalPlayers: Object.keys(game.players).length
    });

    // Wenn ALLE Spieler geantwortet haben, Frage vorzeitig beenden
    if (answeredCount === Object.keys(game.players).length) {
      clearTimeout(game.timer);
      endCurrentQuestion(game);
    }
  });

  // -------------------- HOST: Ergebnisse als CSV exportieren --------------------
  socket.on("host:exportResults", (_, callback) => {
    const game = getGameForSocket(socket);
    if (!game) return callback && callback({ success: false });
    const filename = persistResultsToDisk(game);
    const leaderboard = getLeaderboard(game);
    callback && callback({ success: true, filename, leaderboard });
  });

  // -------------------- Verbindungsabbruch / Reconnect-Unterstützung --------------------
  socket.on("disconnect", () => {
    const code = socket.data.gameCode;
    const role = socket.data.role;
    if (!code || !games[code]) return;
    const game = games[code];

    if (role === "host") {
      // Host getrennt: Spieler informieren, Spiel nach kurzer Wartezeit ggf. beenden
      io.to(code).emit("game:hostDisconnected");
    } else if (role === "player" && game.players[socket.id]) {
      // Spieler getrennt: aus der Lobby-Anzeige entfernen, aber Punkte bleiben
      // gespeichert für den Fall einer kurzen Wiederverbindung (kein sofortiges Löschen).
      io.to(game.hostSocketId).emit("host:playerLeft", { id: socket.id });
    }
  });

  // Hilfsfunktion: findet das Spiel, zu dem dieser Host-Socket gehört
  function getGameForSocket(s) {
    const code = s.data.gameCode;
    return code ? games[code] : null;
  }
});

// ------------------------------------------------------------
// Zentrale Funktionen für den Fragenfluss
// ------------------------------------------------------------

// Startet die nächste Frage eines Spiels (oder beendet das Spiel, wenn keine mehr übrig ist)
function startNextQuestion(game) {
  clearTimeout(game.timer);
  game.currentQuestionIndex++;

  if (game.currentQuestionIndex >= game.questions.length) {
    finishGame(game);
    return;
  }

  // Antwortstatus aller Spieler zurücksetzen
  Object.values(game.players).forEach((p) => (p.answeredCurrent = false));

  const question = game.questions[game.currentQuestionIndex];
  game.status = "question";
  game.questionStartedAt = Date.now();
  game.questionTimeLimit = question.timeLimit;

  io.to(game.code).emit("game:newQuestion", {
    index: game.currentQuestionIndex,
    total: game.questions.length,
    question: publicQuestion(question)
  });

  // Server-seitiger Timer: nach Ablauf automatisch Frage beenden
  game.timer = setTimeout(() => {
    endCurrentQuestion(game);
  }, question.timeLimit * 1000 + 300); // kleiner Puffer für Netzwerklatenz
}

// Beendet die aktuelle Frage, zeigt die Lösung + Zwischenrangliste
function endCurrentQuestion(game) {
  if (game.status !== "question") return; // bereits beendet
  game.status = "reveal";
  const question = game.questions[game.currentQuestionIndex];

  io.to(game.code).emit("game:revealAnswer", {
    correctIndex: question.correctIndex
  });

  // Kurze Pause, dann Zwischenrangliste zeigen
  setTimeout(() => {
    game.status = "leaderboard";
    const leaderboard = getLeaderboard(game);
    io.to(game.code).emit("game:leaderboard", {
      leaderboard,
      isFinal: game.currentQuestionIndex === game.questions.length - 1
    });
  }, 2000);
}

// Beendet das gesamte Spiel und sendet die Endrangliste
function finishGame(game) {
  game.status = "finished";
  const leaderboard = getLeaderboard(game);
  io.to(game.code).emit("game:finished", { leaderboard });
  persistResultsToDisk(game);
}

// ------------------------------------------------------------
// Server starten
// ------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`Quiz-Server läuft auf Port ${PORT}`);
  console.log(`Host-Ansicht:    http://localhost:${PORT}/host.html`);
  console.log(`Spieler-Ansicht: http://localhost:${PORT}/player.html`);
});
