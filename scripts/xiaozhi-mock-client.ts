/**
 * xiaozhi-mock-client.ts — Simula un device XiaoZhi per test rapidi della pipeline.
 *
 * Ciclo:
 *   1. Connessione WS a ws://localhost:18789/xiaozhi/v1/
 *   2. Riceve hello dal server, risponde con hello device
 *   3. Invia listen:start
 *   4. Invia N frame Opus (silenzio sintetico, oppure audio da WAV 16kHz mono)
 *   5. Invia listen:stop
 *   6. Riceve e logga tutto (STT, LLM, TTS frames) con timestamp
 *   7. Salva frame Opus ricevuti su WAV per verifica ascolto
 *
 * Uso:
 *   bun scripts/xiaozhi-mock-client.ts [--url ws://...] [--wav path/to/audio.wav] [--out received.wav]
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import WebSocket from "ws";

// @discordjs/opus is a CJS native module installed in the xiaozhi extension
const _require = createRequire(
  path.join(fileURLToPath(import.meta.url), "../../extensions/xiaozhi/node_modules/"),
);
const { OpusEncoder } = _require("@discordjs/opus") as typeof import("@discordjs/opus");

// ─── Constants ────────────────────────────────────────────────────────────────

const UPLOAD_RATE = 16_000; // device mic: 16kHz mono
const DOWNLOAD_RATE = 24_000; // server TTS: 24kHz mono
const FRAME_MS = 60;
const UPLOAD_FRAME_SAMPLES = (UPLOAD_RATE * FRAME_MS) / 1000; // 960
const UPLOAD_FRAME_BYTES = UPLOAD_FRAME_SAMPLES * 2; // 1920 (16-bit LE)
const SILENCE_DURATION_MS = 2_000; // 2 seconds of audio to send
const SILENCE_FRAMES = Math.ceil(SILENCE_DURATION_MS / FRAME_MS); // ~33

// ─── CLI args ─────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    url: { type: "string", default: "ws://localhost:18789/xiaozhi/v1/" },
    wav: { type: "string" },
    out: { type: "string", default: "received-tts.wav" },
  },
  strict: false,
});

const WS_URL = values.url as string;
const WAV_INPUT = values.wav as string | undefined;
const WAV_OUTPUT = values.out as string;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString().substring(11, 23); // HH:MM:SS.mmm
}

function log(msg: string): void {
  console.log(`[${ts()}] ${msg}`);
}

/** Read PCM samples from a WAV file (16-bit signed LE). Returns Buffer of raw PCM. */
function readWavPcm(filePath: string): { pcm: Buffer; sampleRate: number; channels: number } {
  const buf = fs.readFileSync(filePath);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`Not a valid WAV file: ${filePath}`);
  }
  const sampleRate = buf.readUInt32LE(24);
  const channels = buf.readUInt16LE(22);
  const bitsPerSample = buf.readUInt16LE(34);
  if (bitsPerSample !== 16) {
    throw new Error(`WAV must be 16-bit PCM, got ${bitsPerSample}-bit`);
  }
  // Find "data" chunk
  let offset = 12;
  while (offset < buf.length - 8) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === "data") {
      return { pcm: buf.subarray(offset + 8, offset + 8 + chunkSize), sampleRate, channels };
    }
    offset += 8 + chunkSize;
  }
  throw new Error("No data chunk found in WAV file");
}

/** Resample PCM (linear interpolation). */
function resamplePcm(input: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) {
    return input;
  }
  const inputSamples = Math.floor(input.length / 2);
  if (inputSamples === 0) {
    return Buffer.alloc(0);
  }
  const ratio = fromRate / toRate;
  const outputSamples = Math.floor(inputSamples / ratio);
  const output = Buffer.alloc(outputSamples * 2);
  for (let i = 0; i < outputSamples; i++) {
    const srcPos = i * ratio;
    const srcIdx = Math.floor(srcPos);
    const frac = srcPos - srcIdx;
    const s0 = input.readInt16LE(srcIdx * 2);
    const s1 = input.readInt16LE(Math.min(srcIdx + 1, inputSamples - 1) * 2);
    const sample = Math.round(s0 + frac * (s1 - s0));
    output.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }
  return output;
}

/** Build WAV header + PCM data. */
function buildWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Build Opus upload frames from raw PCM (16kHz mono). */
function buildUploadFrames(pcm16k: Buffer): Buffer[] {
  const encoder = new OpusEncoder(UPLOAD_RATE, 1);
  const frames: Buffer[] = [];
  for (let i = 0; i < pcm16k.length; i += UPLOAD_FRAME_BYTES) {
    const chunk = pcm16k.subarray(i, i + UPLOAD_FRAME_BYTES);
    const padded =
      chunk.length < UPLOAD_FRAME_BYTES
        ? Buffer.concat([chunk, Buffer.alloc(UPLOAD_FRAME_BYTES - chunk.length)])
        : chunk;
    try {
      frames.push(encoder.encode(padded));
    } catch (err) {
      log(`WARN: Opus encode frame error: ${String(err)}`);
    }
  }
  return frames;
}

/** Build synthetic silence Opus frames (2 seconds). */
function buildSilenceFrames(): Buffer[] {
  const silentPcm = Buffer.alloc(UPLOAD_FRAME_BYTES); // all zeros = silence
  const encoder = new OpusEncoder(UPLOAD_RATE, 1);
  const frames: Buffer[] = [];
  for (let i = 0; i < SILENCE_FRAMES; i++) {
    try {
      frames.push(encoder.encode(silentPcm));
    } catch (err) {
      log(`WARN: Opus encode silence error: ${String(err)}`);
    }
  }
  return frames;
}

/** Decode received Opus frames → PCM and save as WAV. */
function saveReceivedAudio(opusFrames: Buffer[], outPath: string): void {
  if (opusFrames.length === 0) {
    log(`No TTS frames received — skipping WAV save`);
    return;
  }
  const decoder = new OpusEncoder(DOWNLOAD_RATE, 1);
  const pcmChunks: Buffer[] = [];
  for (const frame of opusFrames) {
    try {
      pcmChunks.push(decoder.decode(frame));
    } catch {
      // skip
    }
  }
  const pcm = Buffer.concat(pcmChunks);
  const wav = buildWav(pcm, DOWNLOAD_RATE, 1);
  fs.writeFileSync(outPath, wav);
  log(`Saved ${opusFrames.length} TTS frames → ${outPath} (${wav.length} bytes WAV)`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Prepare upload frames
  let uploadFrames: Buffer[];
  if (WAV_INPUT) {
    log(`Loading WAV: ${WAV_INPUT}`);
    const { pcm, sampleRate, channels } = readWavPcm(WAV_INPUT);
    log(`WAV: ${pcm.length} bytes PCM, ${sampleRate}Hz, ${channels}ch`);
    // Convert to mono if needed
    let mono = pcm;
    if (channels === 2) {
      mono = Buffer.alloc(pcm.length / 2);
      for (let i = 0; i < mono.length / 2; i++) {
        const l = pcm.readInt16LE(i * 4);
        const r = pcm.readInt16LE(i * 4 + 2);
        mono.writeInt16LE(Math.round((l + r) / 2), i * 2);
      }
    }
    // Resample to 16kHz
    const pcm16k = resamplePcm(mono, sampleRate, UPLOAD_RATE);
    log(`Resampled: ${pcm16k.length} bytes at 16kHz`);
    uploadFrames = buildUploadFrames(pcm16k);
    log(`Encoded: ${uploadFrames.length} Opus frames from WAV`);
  } else {
    log(
      `No --wav provided — using synthetic silence (${SILENCE_FRAMES} frames, ${SILENCE_DURATION_MS}ms)`,
    );
    uploadFrames = buildSilenceFrames();
    log(`Silence frames ready: ${uploadFrames.length}`);
  }

  // State
  const receivedOpusFrames: Buffer[] = [];
  let ttsStarted = false;
  let ttsStopped = false;

  log(`Connecting to ${WS_URL}...`);

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(WS_URL, {
      headers: {
        "device-id": "mock-xiaozhi-client",
        Authorization: "Bearer mock-token",
      },
    });

    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error("Connection timeout (60s)"));
    }, 60_000);

    ws.on("open", () => {
      log(`WebSocket open`);
    });

    ws.on("message", (data: Buffer | string) => {
      // Binary = Opus frame from TTS
      if (Buffer.isBuffer(data) && data[0] !== 0x7b) {
        receivedOpusFrames.push(data);
        if (receivedOpusFrames.length % 10 === 0) {
          log(`TTS: received ${receivedOpusFrames.length} Opus frames so far...`);
        }
        return;
      }

      const text = typeof data === "string" ? data : data.toString("utf8");
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(text) as Record<string, unknown>;
      } catch {
        log(`WARN: non-JSON message: ${text.substring(0, 200)}`);
        return;
      }

      const type = msg.type as string;
      log(`← ${type}: ${JSON.stringify(msg)}`);

      switch (type) {
        case "hello": {
          // Respond with device hello
          const deviceHello = JSON.stringify({
            type: "hello",
            version: 3,
            transport: "websocket",
            audio_params: {
              format: "opus",
              sample_rate: UPLOAD_RATE,
              channels: 1,
              frame_duration: FRAME_MS,
            },
          });
          ws.send(deviceHello);
          log(`→ hello (device)`);

          // Small delay before starting listen cycle
          setTimeout(() => {
            log(`→ listen:start`);
            ws.send(JSON.stringify({ type: "listen", state: "start", mode: "manual" }));

            // Send upload frames with realistic pacing
            let i = 0;
            const sendFrame = () => {
              if (i >= uploadFrames.length) {
                // All frames sent — send listen:stop
                log(`→ listen:stop (sent ${uploadFrames.length} frames)`);
                ws.send(JSON.stringify({ type: "listen", state: "stop" }));
                return;
              }
              ws.send(uploadFrames[i]);
              i++;
              setTimeout(sendFrame, FRAME_MS);
            };
            sendFrame();
          }, 300);
          break;
        }

        case "tts": {
          const state = msg.state as string;
          if (state === "start") {
            ttsStarted = true;
            log(`TTS started`);
          } else if (state === "stop") {
            ttsStopped = true;
            log(`TTS stopped — total ${receivedOpusFrames.length} Opus frames received`);
            // Save received audio then close
            saveReceivedAudio(receivedOpusFrames, WAV_OUTPUT);
            clearTimeout(timeout);
            ws.close();
            resolve();
          }
          break;
        }

        case "ping":
          // Ignore keepalive pings
          break;
      }
    });

    ws.on("close", (code, reason) => {
      clearTimeout(timeout);
      log(`WebSocket closed: code=${code} reason=${reason.toString()}`);
      if (!ttsStopped) {
        // Closed before TTS stop — save whatever we got
        if (receivedOpusFrames.length > 0) {
          saveReceivedAudio(receivedOpusFrames, WAV_OUTPUT);
        }
        log(
          `Summary: ttsStarted=${ttsStarted} ttsStopped=${ttsStopped} frames=${receivedOpusFrames.length}`,
        );
      }
      resolve();
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      log(`WebSocket error: ${err.message}`);
      reject(err);
    });
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
