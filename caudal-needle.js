// caudal-needle.js (versión gauge aguja mejorado)
// Sensor de Caudal (m3/h) con gauge semicircular ASCII + aguja dinámica.
// Rango por defecto: 0..300 m3/h (ajustable). Publica evt/status y acepta comandos tipo io7dummy.
// Controles: ↑/↓ (o w/s) para subir/bajar | f: modo auto | r: reset | q/ESC/Ctrl+C: salir

import { Device, clearCursor } from './io7device.js';

const cursorUp = '\x1B[A';

// ---- Parámetros base ----
let MIN = 0;           // m3/h
let MAX = 300;         // m3/h
let flow = 30;         // valor inicial
let mode = 'manual';   // 'manual' | 'auto'

// Manual: incremento por tecla (aplicado a cada dibujado)
let rate_m3h_per_s = 12;

// Auto: onda + ruido
let autoHz = 0.12;     // Hz
let autoAmp = 110;     // m3/h
let autoOffset = 120;  // m3/h
let t = 0;

// ---- Canvas del dial (ASCII) ----
const W = 43;           // ancho (pares para que quede simétrico)
const H = 15;           // alto total del área de dial
const CX = Math.floor(W / 2);
const CY = H - 2;       // centro de la elipse (casi abajo)
const A = Math.floor(W / 2) - 3; // radio horizontal
const B = Math.floor(H / 2) + 1; // radio vertical (aplana la cúpula)

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bright: '\x1b[1m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  gray: '\x1b[90m'
};

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function pct() {
  if (MAX <= MIN) return 0;
  return (flow - MIN) / (MAX - MIN);
}

// Dibuja una elipse superior punteada (semicírculo del dial)
function drawArc(buf) {
  // Malla de puntos en la elipse (theta: π → 0)
  for (let deg = 180; deg >= 0; deg -= 2) {
    const th = (deg * Math.PI) / 180;
    const x = Math.round(CX + A * Math.cos(th));
    const y = Math.round(CY - B * Math.sin(th));
    if (y >= 0 && y < H && x >= 0 && x < W) buf[y][x] = '·';
  }

  // Marcas cada 10%
  for (let k = 0; k <= 10; k++) {
    const pp = k / 10; // 0..1
    const th = Math.PI - pp * Math.PI; // 180°..0°
    const x = Math.round(CX + A * Math.cos(th));
    const y = Math.round(CY - B * Math.sin(th));
    if (inBounds(x, y)) buf[y][x] = (k % 5 === 0) ? '│' : '┊';
  }
}

function inBounds(x, y) { return y >= 0 && y < H && x >= 0 && x < W; }

// Dibuja la aguja desde el centro al borde segun porcentaje
function drawNeedle(buf, perc) {
  const th = Math.PI - clamp(perc, 0, 1) * Math.PI; // 180° (izq) .. 0° (der)
  const x2 = CX + A * Math.cos(th);
  const y2 = CY - B * Math.sin(th);
  drawLine(buf, CX, CY, Math.round(x2), Math.round(y2), '▲'); // punta
  // cuerpo: dibuja desde el centro al 90% de la longitud con caracteres finos
  const x1 = CX, y1 = CY;
  const nx = Math.round(CX + (A * 0.9) * Math.cos(th));
  const ny = Math.round(CY - (B * 0.9) * Math.sin(th));
  drawLine(buf, x1, y1, nx, ny, '─');
  // centro
  if (inBounds(CX, CY)) buf[CY][CX] = '●';
}

// Bresenham simple sobre la matriz
function drawLine(buf, x0, y0, x1, y1, ch) {
  let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  while (true) {
    if (inBounds(x0, y0)) buf[y0][x0] = ch;
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

function drawGauge() {
  clearCursor();

  const percent = pct();
  const overload = flow >= MAX;

  // Cabecera de ayuda
  console.log(`${ANSI.dim}Use ↑/↓ (o w/s) para cambiar el caudal | f: modo auto | r: reset | q: salir${ANSI.reset}\n`);

  // Construir buffer
  const buf = Array.from({ length: H }, () => Array.from({ length: W }, () => ' '));

  // 1) Arco y marcas
  drawArc(buf);

  // 2) Aguja
  drawNeedle(buf, percent);

  // 3) Etiquetas % bajo el dial
  const lbl = `0%              50%              100%`;
  writeText(buf, H - 1, Math.max(0, Math.floor((W - lbl.length) / 2)), lbl);

  // 4) Render buffer
  const lines = buf.map(row => row.join(''));
  for (const line of lines) console.log(line);

  // 5) Caja de valor digital y estado
  const ptxt = `${(percent * 100).toFixed(1)}%`;
  const ftxt = `${flow.toFixed(1)} m³/h`;
  const rng = `${MIN}–${MAX} m³/h`;
  const mtxt = `Modo: ${mode}`;

  const valueLine =
    `${ANSI.bright}${ftxt}${ANSI.reset}   ${ANSI.cyan}${ptxt}${ANSI.reset}   Rango: ${rng}   ${mtxt}   ` +
    (overload ? `${ANSI.red}⚠ OVER${ANSI.reset}` : `${ANSI.green}OK${ANSI.reset}`);

  console.log('\n' + valueLine);
}

// Escribe texto en la matriz con límites
function writeText(buf, y, x, text) {
  for (let i = 0; i < text.length; i++) {
    const xx = x + i;
    if (inBounds(xx, y)) buf[y][xx] = text[i];
  }
}

function publishStatus(device, quiet = false) {
  const payload = {
    d: {
      flow_m3h: parseFloat(flow.toFixed(1)),
      mode,
      min_m3h: MIN,
      max_m3h: MAX,
      percent: parseFloat((pct() * 100).toFixed(1)),
      overload: flow >= MAX
    }
  };
  device.publishEvent('status', JSON.stringify(payload));
  if (!quiet) console.log(`${cursorUp}${ANSI.dim} -> evt/status ${JSON.stringify(payload)}${ANSI.reset}`);
}

// ---- Dispositivo ----
export function init(device) {
  // Teclado
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  stdin.on('data', (key) => {
    if (key === '\u0003' || key === '\u001b' || key === 'q') process.exit();   // Ctrl+C / ESC / q
    if (key === '\x1B[A' || key === 'w') flow = clamp(flow + rate_m3h_per_s, MIN, MAX);     // ↑ / w
    else if (key === '\x1B[B' || key === 's') flow = clamp(flow - rate_m3h_per_s, MIN, MAX);// ↓ / s
    else if (key === 'f') mode = (mode === 'manual') ? 'auto' : 'manual';
    else if (key === 'r') flow = MIN;

    drawGauge();
    publishStatus(device);
  });

  // Comandos MQTT
  device.setUserCommand((topic, msg) => {
    try {
      const cmd = JSON.parse(msg);
      if (!cmd || !cmd.d) return;

      if (typeof cmd.d.setflow === 'number') flow = clamp(cmd.d.setflow, MIN, MAX);
      if (typeof cmd.d.mode === 'string') {
        const m = cmd.d.mode.toLowerCase();
        if (['auto', 'manual'].includes(m)) mode = m;
      }
      if (typeof cmd.d.rate_m3h_per_s === 'number') rate_m3h_per_s = clamp(cmd.d.rate_m3h_per_s, 0, 5000);
      if (typeof cmd.d.setrange === 'object') {
        const { min, max } = cmd.d.setrange;
        if (typeof min === 'number' && typeof max === 'number' && max > min) {
          MIN = min; MAX = max; flow = clamp(flow, MIN, MAX);
        }
      }
      if (typeof cmd.d.setauto === 'object') {
        const { hz, amp, offset } = cmd.d.setauto;
        if (typeof hz === 'number') autoHz = clamp(hz, 0, 5);
        if (typeof amp === 'number') autoAmp = clamp(amp, 0, 10000);
        if (typeof offset === 'number') autoOffset = clamp(offset, -10000, 10000);
      }

      drawGauge();
      publishStatus(device);
    } catch (e) {
      console.error('Error parsing command:', e.message);
    }
  });

  // Loop
  device.loop = () => {
    const dt = device.meta?.dtSec ?? 1;
    if (mode === 'auto') {
      t += dt;
      const omega = 2 * Math.PI * autoHz;
      let v = autoOffset + autoAmp * Math.sin(omega * t);
      v += (Math.random() - 0.5) * 2.0; // ruido ±1
      flow = clamp(v, MIN, MAX);
      drawGauge();
      publishStatus(device, true);
    } else {
      publishStatus(device, true);
    }
  };

  drawGauge();
  device.connect();
  device.run();
}
