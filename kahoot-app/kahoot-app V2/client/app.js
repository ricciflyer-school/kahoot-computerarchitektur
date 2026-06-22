/*
 * app.js
 * ============================================================
 * Gemeinsame Hilfsfunktionen, die sowohl von host.html als auch
 * von player.html genutzt werden:
 *   - Soundeffekte (synthetisch erzeugt, keine externen Dateien)
 *   - Dunkelmodus (per localStorage gemerkt)
 *   - CSV-Export im Browser (Download anstoßen)
 *   - kleine Formatierungshelfer
 *
 * Die eigentliche Spiel-/Echtzeitlogik liegt in host.html und
 * player.html jeweils in einem eigenen <script>-Block, da sie
 * sich stark unterscheiden (Host steuert, Spieler reagiert).
 * ============================================================ */

// ---------- Soundeffekte (Web Audio API, keine Dateien nötig) ----------
function isSoundEnabled() {
  return localStorage.getItem("quiz_sound_enabled") === "true";
}

function setSoundEnabled(enabled) {
  localStorage.setItem("quiz_sound_enabled", enabled ? "true" : "false");
}

function playSound(type) {
  if (!isSoundEnabled()) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    let freq = 440, duration = 0.15;
    switch (type) {
      case "correct": freq = 880; duration = 0.25; break;
      case "wrong": freq = 180; duration = 0.3; break;
      case "tick": freq = 600; duration = 0.05; break;
      case "start": freq = 523; duration = 0.4; break;
      case "join": freq = 700; duration = 0.1; break;
    }
    osc.frequency.value = freq;
    osc.type = "sine";
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch (e) {
    // Manche Browser blockieren Audio ohne Nutzerinteraktion - das ist hier unkritisch
    console.warn("Sound konnte nicht abgespielt werden:", e);
  }
}

// ---------- Dunkelmodus ----------
function applyDarkModeFromStorage() {
  const dark = localStorage.getItem("quiz_dark_mode") === "true";
  document.body.classList.toggle("dark", dark);
}

function toggleDarkMode() {
  const current = localStorage.getItem("quiz_dark_mode") === "true";
  localStorage.setItem("quiz_dark_mode", (!current).toString());
  applyDarkModeFromStorage();
}

// ---------- CSV-Export im Browser ----------
// Erwartet ein Array wie [{name, score}, ...] (bereits sortiert)
function downloadLeaderboardAsCSV(leaderboard) {
  let csv = "Platz;Name;Punkte\n";
  leaderboard.forEach((p, i) => {
    csv += `${i + 1};${p.name};${p.score}\n`;
  });
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "quiz-ergebnisse.csv";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ---------- Vollbildmodus (für den Host-Beamer-Betrieb) ----------
function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch((e) => console.warn(e));
  } else {
    document.exitFullscreen();
  }
}

// ---------- Kleine Formatierungshelfer ----------
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Ordinalzahlen-Suffix für die Anzeige des eigenen Rangs (1., 2., 3. ...)
function formatRank(rank) {
  return rank + ".";
}
