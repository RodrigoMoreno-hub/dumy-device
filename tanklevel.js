// tanklevel.js
// Dummy de Nivel de Tanque para io7dummy-device
// Publica nivel en % y metros; controla con teclado y por MQTT.
//
// Requiere: io7device.js en el mismo repo (io7lab/io7dummy-device)
// Ejecuta:  node io7dummy tanklevel.js
//
// Controles:
//  - Flechas ↑ / ↓  (o teclas 'w' / 's'): subir/bajar nivel manual
//  - 'f': alterna modo auto (llenando ↔ vaciando)
//  - 'r': reinicia a 0%
//  - 'q' o ESC o Ctrl+C: salir

import { Device, clearCursor } from './io7device.js';

const cursorUp = '\x1B[A';

// Parámetros del tanque (ajusta a tu caso)
const TANK_HEIGHT_M = 2.0;         // Altura física del tanque (m)
const DEFAULT_RATE_PCT_S = 5;       // % por segundo en modo auto
const DRAW_ROWS = 12;               // Altura ASCII del tanque

// Estado
let levelPct = 26;                  // % inicial (para lucir "lleno")
let autoMode = 'hold';              // 'fill' | 'drain' | 'hold'
let ratePctPerS = DEFAULT_RATE_PCT_S;

// ---------- Utilidades ----------
function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
function pctToMeters(p) { return (p / 100) * TANK_HEIGHT_M; }

function drawTank() {
  clearCursor();
  console.log('Use ↑/↓ (o w/s) para cambiar el nivel | f: modo auto | r: reset | q: salir');
  console.log('');

  const filledRows = Math.round((levelPct / 100) * DRAW_ROWS);
  const emptyRows  = DRAW_ROWS - filledRows;

  // techo
  console.log('         +-----+');
  // paredes
  for (let i = 0; i < emptyRows; i++) {
    console.log('         |     |');
  }
  for (let i = 0; i < filledRows; i++) {
    console.log('         |█████|');
  }
  // piso
  console.log('         +-----+');

  const levelM = pctToMeters(levelPct).toFixed(3);
  const modeLabel = autoMode === 'fill' ? 'llenando' :
                    autoMode === 'drain' ? 'vaciando' : 'manual';
  console.log(`\n    Nivel: ${levelPct.toFixed(1)}%  (${levelM} m)   Modo: ${modeLabel}`);
}

function setLevelPct(p) {
  levelPct = clamp(p, 0, 100);
  drawTank();
}

function toggleAuto() {
  if (autoMode === 'hold') autoMode = 'fill';
  else if (autoMode === 'fill') autoMode = 'drain';
  else autoMode = 'hold';
  drawTank();
}

// ---------- Dispositivo ----------
export function init(device) {
  // Entrada por teclado (terminal)
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  stdin.on('data', function (key) {
    // Salir: Ctrl+C, ESC, 'q'
    if (key === '\u0003' || key === '\u001b' || key === 'q') {
      process.exit();
    }
    // Flechas (escapes): ↑ \x1B[A , ↓ \x1B[B
    if (key === '\x1B[A' || key === 'w') { setLevelPct(levelPct + 1); }
    else if (key === '\x1B[B' || key === 's') { setLevelPct(levelPct - 1); }
    else if (key === 'f') { toggleAuto(); }
    else if (key === 'r') { setLevelPct(0); }

    // Publicamos estado al interactuar
    publishStatus(device);
  });

  // Comandos desde MQTT
  device.setUserCommand((topic, msg) => {
    try {
      const cmd = JSON.parse(msg);
      if (cmd && cmd.d) {
        if (typeof cmd.d.setlevel_pct === 'number') {
          setLevelPct(cmd.d.setlevel_pct);
        }
        if (typeof cmd.d.setlevel_m === 'number') {
          setLevelPct((cmd.d.setlevel_m / TANK_HEIGHT_M) * 100.0);
        }
        if (typeof cmd.d.mode === 'string') {
          const v = cmd.d.mode.toLowerCase();
          if (['fill', 'drain', 'hold'].includes(v)) {
            autoMode = v; drawTank();
          }
        }
        if (typeof cmd.d.rate_pct_per_s === 'number') {
          ratePctPerS = clamp(cmd.d.rate_pct_per_s, 0, 100);
        }
        // Confirma estado
        publishStatus(device);
      }
    } catch (e) {
      console.error('Error parsing command:', e.message);
    }
  });

  // Lógica periódica
  device.loop = () => {
    // Modo automático
    if (autoMode === 'fill') setLevelPct(levelPct + ratePctPerS * device.meta.dtSec);
    else if (autoMode === 'drain') setLevelPct(levelPct - ratePctPerS * device.meta.dtSec);

    publishStatus(device, /*quietLog*/ true);
  };

  // Dibujo inicial y arranque
  drawTank();
  device.connect();
  device.run();
}

function publishStatus(device, quietLog = false) {
  const payload = {
    d: {
      level_pct: parseFloat(levelPct.toFixed(1)),
      level_m: parseFloat(pctToMeters(levelPct).toFixed(3)),
      mode: autoMode,
      rate_pct_per_s: ratePctPerS,
      tank_height_m: TANK_HEIGHT_M
    }
  };
  device.publishEvent('status', JSON.stringify(payload));
  if (!quietLog) {
    console.log(`${cursorUp}\x1B[0m  -> evt/status ${JSON.stringify(payload)}`);
  }
}
