// Generates the two sounds of kit-notify from scratch (plain sine tones with a soft envelope; nothing is sampled or copied).
// Usage: node sounds/make-sounds.mjs sounds
import { writeFileSync, mkdirSync } from 'node:fs'
const RATE = 22050
function tone(parts) { // parts: [startSec, freqHz, durSec, gain]
  const total = Math.max(...parts.map(p => p[0] + p[2])) + 0.05
  const n = Math.ceil(total * RATE), out = new Float64Array(n)
  for (const [t0, f, d, g] of parts) {
    for (let i = 0; i < Math.floor(d * RATE); i++) {
      const t = i / RATE, at = Math.min(1, t / 0.008), env = at * Math.exp(-5 * t / d) * (1 - t / d)
      const s = Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t) + 0.1 * Math.sin(6 * Math.PI * f * t)
      out[Math.floor(t0 * RATE) + i] += s * env * g
    }
  }
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 2, 28)
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, out[i] * 0.3)) * 32767), 44 + i * 2)
  return buf
}
const dir = process.argv[2]
mkdirSync(dir, { recursive: true })
// done: a soft rising two-note chime. needs: three short, higher pings, more urgent.
writeFileSync(dir + '/done.wav', tone([[0, 659.25, 0.28, 1], [0.13, 987.77, 0.45, 1]]))
writeFileSync(dir + '/needs-you.wav', tone([[0, 1174.66, 0.12, 1], [0.17, 1174.66, 0.12, 1], [0.34, 1396.91, 0.2, 1]]))
