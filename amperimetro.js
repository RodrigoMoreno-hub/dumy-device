// amperimetro.js
// Dummy "Amperímetro" para io7dummy-device
// - Mide corriente entre 0 y 200 A
// - Controles: ↑/↓ (o w/s) para subir/bajar A; f = modo auto (onda + ruido); r = reset; q/ESC/Ctrl+C = salir
// - Publica evt/status con { amps, mode, minA, maxA, overload }
// - Acepta comandos MQTT (dentro de msg.d): setamps, mode ('auto'|'manual'), rate_amps_per_s, setmax

import { Device, clearCursor } from './io7device.js';

const cursorUp = '\x1B[A';

const MIN_A = 0;
let MAX_A = 200;        // Ajustable por comando
let amps = 10;          // Valor inicial (A)
let mode = 'manual';    // 'manual' | 'auto'
let rateAperS = 5;      // Velocidad de cambio en manual con teclas (A/s aplicada por dtSec)
let autoHz = 0.2;       // Frecuencia de la señal auto (Hz)
let autoAmp = 80;       // Amplitud de la señal auto (A pico)
let autoOffset = 60;    // Offset DC (A)
let t = 0;              // tiempo acumulado (s) para onda

// ---------- Utilidades ----------
function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

function drawPanel() {
  clearCursor();
  console.log('Use ↑/↓ (o w/s) para cambiar el nivel | f: modo auto | r: reset | q: salir');
  console.log('');
  // Dibujar barra vertical simple (0..200 A => 0..20 filas)
  const rows = 20;
  const filled = Math.round((amps / MAX_A) * rows);
  const empty = rows - filled;
  console.log('       +-----+');
  for (let i = 0; i < empty; i++) console.log('       |     |');
  for (let i = 0; i < filled; i++) console.log('       |█████|');
  console.log('       +-----+');
  const ov = amps >= MAX_A;
  console.log(`\n    Corriente: ${amps.toFixed(1)} A   Modo: ${mode}   Rango: ${MIN_A}–${MAX_A} A   ${ov ? '⚠️ OVERLOAD' : ''}`);
}

function setAmps(a) {
  amps = clamp(a, MIN_A, MAX_A);
  drawPanel();
}

function toggleMode() {
  mode = (mode === 'manual') ? 'auto' : 'manual';
  drawPanel();
}

function publishStatus(device, quiet=false) {
  const payload = {
    d: {
      amps: parseFloat(amps.toFixed(1)),
      mode,
      minA: MIN_A,
      maxA: MAX_A,
      overload: amps >= MAX_A
    }
  };
  device.publishEvent('status', JSON.stringify(payload));
  if (!quiet) console.log(`${cursorUp}\x1B[0m  -> evt/status ${JSON.stringify(payload)}`);
}

// ---------- Dispositivo ----------
export function init(device) {
  // Entrada por teclado
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  stdin.on('data', function (key) {
    if (key === '\u0003' || key === '\u001b' || key === 'q') process.exit();         // Ctrl+C / ESC / q
    if (key === '\x1B[A' || key === 'w') { setAmps(amps + rateAperS); }              // ↑ / w
    else if (key === '\x1B[B' || key === 's') { setAmps(amps - rateAperS); }         // ↓ / s
    else if (key === 'f') { toggleMode(); }
    else if (key === 'r') { setAmps(0); }
    publishStatus(device);
  });

  // Comandos desde MQTT
  device.setUserCommand((topic, msg) => {
    try {
      const cmd = JSON.parse(msg);
      if (cmd && cmd.d) {
        if (typeof cmd.d.setamps === 'number') setAmps(cmd.d.setamps);
        if (typeof cmd.d.mode === 'string') {
          const m = cmd.d.mode.toLowerCase();
          if (['auto','manual'].includes(m)) { mode = m; drawPanel(); }
        }
        if (typeof cmd.d.rate_amps_per_s === 'number') {
          rateAperS = clamp(cmd.d.rate_amps_per_s, 0, 1000);
        }
        if (typeof cmd.d.setmax === 'number') {
          MAX_A = clamp(cmd.d.setmax, 1, 10000);
          amps = clamp(amps, MIN_A, MAX_A);
          drawPanel();
        }
        // Confirmamos estado
        publishStatus(device);
      }
    } catch (e) {
      console.error('Error parsing command:', e.message);
    }
  });

  // Lazo principal
  device.loop = () => {
    const dt = device.meta?.dtSec ?? 1;
    if (mode === 'auto') {
      // Señal pseudo-rms: offset + seno + pequeño ruido
      t += dt;
      const omega = 2 * Math.PI * autoHz;
      let a = autoOffset + autoAmp * Math.sin(omega * t);
      a += (Math.random() - 0.5) * 2.0; // ruido ±1 A
      setAmps(a);
      publishStatus(device, true);
    } else {
      // En manual solo republicamos
      publishStatus(device, true);
    }
  };

  drawPanel();
  device.connect();
  device.run();
}
