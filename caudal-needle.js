// caudal-needle.js
// Dummy "Sensor de Caudal" en m3/h con visual de aguja (gauge ASCII).
// Rango por defecto: 0 .. 300 m3/h (ajustable por comando setrange)
// Controles: ↑/↓ (o w/s) para subir/bajar caudal; f = modo auto; r = reset; q/ESC/Ctrl+C = salir
// MQTT:
//   - Publica evt/status con { flow_m3h, mode, min_m3h, max_m3h, percent, overload }
//   - Comandos (JSON en msg.d): setflow, mode('auto'|'manual'), rate_m3h_per_s, setrange{min,max}, setauto{hz,amp,offset}

import { Device, clearCursor } from './io7device.js';

const cursorUp = '\x1B[A';

// ---- Parámetros del instrumento ----
let MIN = 0;          // m3/h
let MAX = 300;        // m3/h  (puedes dejar 200 si lo prefieres)
let flow = 30;        // valor inicial
let mode = 'manual';  // 'manual' | 'auto'

// Velocidad de cambio en manual (al presionar teclas, aplicado por dtSec)
let rate_m3h_per_s = 10;

// Señal automática (onda) -> offset + seno + ruido
let autoHz = 0.1;     // Hz
let autoAmp = 100;    // amplitud en m3/h
let autoOffset = 120; // offset en m3/h
let t = 0;

// ---- Utilidades ----
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function setFlow(v) {
  flow = clamp(v, MIN, MAX);
  drawGauge();
}
function pct() {
  if (MAX <= MIN) return 0;
  return (flow - MIN) / (MAX - MIN);
}

// ---- Gauge ASCII con aguja ----
// Gauge semicircular de 0 a 180° con 25 “marcas”; la aguja apunta según el %.
const TICKS = 25;
function drawGauge() {
  clearCursor();
  console.log('Use ↑/↓ (o w/s) para cambiar el caudal | f: modo auto | r: reset | q: salir\n');

  // Construimos una semicircunferencia simplificada (tres líneas ASCII para aspecto de dial)
  console.log('            . . . . . . . . . . . .            ');
  console.log('         .                           .         ');
  console.log('       .                               .       ');
  console.log('      .          GAUGE DE CAUDAL         .    ');
  console.log('       .                               .       ');
  console.log('         .                           .         ');
  console.log('            . . . . . . . . . . . .            ');

  // Linea de marcas con aguja
  // Marcamos 0%........................100%
  const barLen = TICKS;
  let needlePos = Math.round(pct() * barLen);
  needlePos = clamp(needlePos, 0, barLen);

  let scale = '    ';
  for (let i = 0; i <= barLen; i++) {
    if (i === needlePos) scale += '▲';
    else if (i % 5 === 0) scale += '|';
    else scale += '·';
  }
  console.log('\n' + scale);
  const overload = flow >= MAX;
  console.log(
    `\n   Caudal: ${flow.toFixed(1)} m³/h   (${(pct()*100).toFixed(1)}%)   Rango: ${MIN}–${MAX} m³/h   Modo: ${mode}  ${overload ? '⚠️ OVERLOAD' : ''}`
  );
}

function publishStatus(device, quiet=false) {
  const payload = {
    d: {
      flow_m3h: parseFloat(flow.toFixed(1)),
      mode,
      min_m3h: MIN,
      max_m3h: MAX,
      percent: parseFloat((pct()*100).toFixed(1)),
      overload: flow >= MAX
    }
  };
  device.publishEvent('status', JSON.stringify(payload));
  if (!quiet) console.log(`${cursorUp}\x1B[0m  -> evt/status ${JSON.stringify(payload)}`);
}

// ---- Dispositivo ----
export function init(device) {
  // Entrada por teclado
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  stdin.on('data', function (key) {
    if (key === '\u0003' || key === '\u001b' || key === 'q') process.exit(); // Ctrl+C / ESC / q
    if (key === '\x1B[A' || key === 'w') setFlow(flow + rate_m3h_per_s);     // ↑ / w
    else if (key === '\x1B[B' || key === 's') setFlow(flow - rate_m3h_per_s);// ↓ / s
    else if (key === 'f') { mode = (mode === 'manual') ? 'auto' : 'manual'; drawGauge(); }
    else if (key === 'r') setFlow(MIN);
    publishStatus(device);
  });

  // Comandos MQTT
  device.setUserCommand((topic, msg) => {
    try {
      const cmd = JSON.parse(msg);
      if (!cmd || !cmd.d) return;

      if (typeof cmd.d.setflow === 'number') setFlow(cmd.d.setflow);
      if (typeof cmd.d.mode === 'string') {
        const m = cmd.d.mode.toLowerCase();
        if (['auto','manual'].includes(m)) { mode = m; drawGauge(); }
      }
      if (typeof cmd.d.rate_m3h_per_s === 'number') {
        rate_m3h_per_s = clamp(cmd.d.rate_m3h_per_s, 0, 5_000);
      }
      if (typeof cmd.d.setrange === 'object') {
        const { min, max } = cmd.d.setrange;
        if (typeof min === 'number' && typeof max === 'number' && max > min) {
          MIN = min; MAX = max; flow = clamp(flow, MIN, MAX); drawGauge();
        }
      }
      if (typeof cmd.d.setauto === 'object') {
        const { hz, amp, offset } = cmd.d.setauto;
        if (typeof hz === 'number') autoHz = clamp(hz, 0, 5);
        if (typeof amp === 'number') autoAmp = clamp(amp, 0, 10_000);
        if (typeof offset === 'number') autoOffset = clamp(offset, -10_000, 10_000);
      }

      publishStatus(device);
    } catch (e) {
      console.error('Error parsing command:', e.message);
    }
  });

  // Lazo principal
  device.loop = () => {
    const dt = device.meta?.dtSec ?? 1;
    if (mode === 'auto') {
      t += dt;
      const omega = 2 * Math.PI * autoHz;
      // Señal tipo proceso: offset + seno + ruido leve
      let v = autoOffset + autoAmp * Math.sin(omega * t);
      v += (Math.random() - 0.5) * 2.0; // ruido ±1 m3/h
      setFlow(v);
      publishStatus(device, true);
    } else {
      publishStatus(device, true);
    }
  };

  drawGauge();
  device.connect();
  device.run();
}
