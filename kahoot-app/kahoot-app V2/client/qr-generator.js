/*
 * qr-generator.js
 * ----------------------------------------------------
 * HINWEIS: Echte QR-Codes folgen einem komplexen Standard (ISO/IEC 18004).
 * Da hier AUSSCHLIESSLICH lokale Bordmittel ohne externe Bibliotheken oder
 * APIs erlaubt sind, erzeugen wir stattdessen ein deterministisches,
 * QR-ähnliches Punktmuster direkt aus dem Spielcode. Es dient als visueller
 * Beitritts-Hinweis (Bonus-Feature) und kann bei Bedarf später durch eine
 * echte QR-Bibliothek (z.B. lokal eingebundenes qrcode.js) ersetzt werden.
 *
 * Die Funktion zeichnet ein 9x9 Raster aus schwarzen/weißen Feldern
 * (inklusive fixer "Eckmarkierungen" wie bei echten QR-Codes) auf ein
 * <canvas>-Element. Das Muster ist reproduzierbar: derselbe Code erzeugt
 * immer dasselbe Muster.
 */

function drawPseudoQRCode(canvas, text) {
  const ctx = canvas.getContext("2d");
  const size = 9; // 9x9 Raster
  const cell = canvas.width / size;

  // Hintergrund weiß
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#1a1a2e";

  // Einfacher Hash aus dem Text, um ein reproduzierbares Muster zu erzeugen
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) % 100000;
  }

  // Pseudo-Zufallsgenerator basierend auf dem Hash (immer gleiches Ergebnis)
  function rand(seed) {
    const x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Die drei Ecken bekommen feste "Positionsmarkierungen" wie bei echten QR-Codes
      const isCorner =
        (x < 3 && y < 3) || (x > size - 4 && y < 3) || (x < 3 && y > size - 4);

      let filled;
      if (isCorner) {
        // Klassisches Schachbrett-Muster für Eckmarkierung
        filled = (x % 2 === 0 || y % 2 === 0) && !(x === 1 && y === 1) || isCornerRing(x, y, size);
        filled = isCornerBlock(x, y, size);
      } else {
        filled = rand(hash + x * 13 + y * 7) > 0.5;
      }

      if (filled) {
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
  }
}

// Hilfsfunktion: erzeugt das klassische "Auge" (Positionsmuster) eines QR-Codes
function isCornerBlock(x, y, size) {
  const corners = [
    { ox: 0, oy: 0 },
    { ox: size - 3, oy: 0 },
    { ox: 0, oy: size - 3 }
  ];
  for (const c of corners) {
    const lx = x - c.ox;
    const ly = y - c.oy;
    if (lx >= 0 && lx < 3 && ly >= 0 && ly < 3) {
      // Rand schwarz, Mitte weiß -> typisches Augenmuster
      const isEdge = lx === 0 || lx === 2 || ly === 0 || ly === 2;
      return isEdge;
    }
  }
  return false;
}

// (wird oben nicht mehr benötigt, aber als Platzhalter für Erweiterungen belassen)
function isCornerRing() { return false; }
