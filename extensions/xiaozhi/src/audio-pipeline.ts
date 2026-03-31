/**
 * AudioPipeline — Phase 2
 * Per-session state machine: IDLE → LISTENING → PROCESSING → SPEAKING → IDLE
 *
 * Upload  (device → server): Opus 16kHz mono 60ms/frame, protocol v1 (raw, no header)
 * Download (server → device): Opus 24kHz mono 60ms/frame, 48kbps, complexity 10
 */

import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { OpusEncoder } from "@discordjs/opus";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import type { WebSocket } from "ws";
import { loadCoreAgentDeps } from "./core-bridge.js";
import { buildLlm, buildStt, buildTts } from "./protocol.js";

// ─── Agent prompts ────────────────────────────────────────────────────────────

/** Injected as extraSystemPrompt in every voice agent call.
 *  Keeps voice-specific rules in one place; takes priority over workspace files. */
const VOICE_EXTRA_SYSTEM_PROMPT = `MODALITÀ VOCALE — priorità assoluta su tutto il resto:
- La lunghezza della risposta dipende dalla domanda: domanda semplice → 1-2 frasi; domanda complessa → quanto serve, max 6-7 frasi
- MAI markdown, emoji, elenchi puntati o numerati — parla sempre in prosa fluente
- MAI premesse, intro o recap — vai diretto alla risposta
- Tono conversazionale naturale, come se stessi parlando ad alta voce`;

/** Builds the extra system prompt with current date/time injected at runtime. */
function buildExtraSystemPrompt(): string {
  const now = new Date().toLocaleString("it-IT", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Data e ora attuale: ${now}\n\n${VOICE_EXTRA_SYSTEM_PROMPT}`;
}

/** JSONL trace log for debugging LLM input/output — /tmp, non persistente */
const LLM_TRACE_FILE = "/tmp/xiaozhi-llm-trace.jsonl";

// ─── Audio constants ──────────────────────────────────────────────────────────

const UPLOAD_RATE = 16_000; // mic: device → server
const DOWNLOAD_RATE = 24_000; // speaker: server → device
const DOWNLOAD_BITRATE = 48_000; // 48 kbps
const FRAME_MS = 60;
const DOWNLOAD_FRAME_SAMPLES = (DOWNLOAD_RATE * FRAME_MS) / 1000; // 1440
const BYTES_PER_SAMPLE = 2; // 16-bit signed LE
const DOWNLOAD_FRAME_BYTES = DOWNLOAD_FRAME_SAMPLES * BYTES_PER_SAMPLE; // 2880

// Opus encoder CTL codes
const OPUS_SET_COMPLEXITY_REQUEST = 4010;
const OPUS_RESET_STATE_REQUEST = 4028;

// ─── Types ────────────────────────────────────────────────────────────────────

type PipelineState = "idle" | "listening" | "processing" | "speaking";

export type AudioPipelineDeps = {
  config: OpenClawConfig;
  runtime: PluginRuntime;
};

// ─── AudioPipeline ────────────────────────────────────────────────────────────

export class AudioPipeline {
  private state: PipelineState = "idle";
  private opusFrames: Buffer[] = [];
  /** Incremented on every abort/listen-start to invalidate in-flight process(). */
  private generation = 0;
  private speakingTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while injectTts() runs — device sends listen:start automatically on connect; ignore it. */
  private isInjectingB9 = false;
  private decoder: OpusEncoder;
  private encoder: OpusEncoder;

  constructor(
    private ws: WebSocket,
    private deps: AudioPipelineDeps,
    /** B9: called with encoded TTS frames when WS is closed during speak(). */
    private onTtsReady?: (frames: Buffer[]) => void,
  ) {
    this.decoder = new OpusEncoder(UPLOAD_RATE, 1);
    this.encoder = new OpusEncoder(DOWNLOAD_RATE, 1);
    this.encoder.setBitrate(DOWNLOAD_BITRATE);
    this.encoder.applyEncoderCTL(OPUS_SET_COMPLEXITY_REQUEST, 10);
  }

  /** Called for every binary Opus frame received from the device. */
  onAudioFrame(frame: Buffer): void {
    if (this.state === "listening") {
      this.opusFrames.push(frame);
    }
  }

  /** Device pressed button: start buffering audio. Interrupts any active state. */
  onListenStart(mode?: string): void {
    // During B9 injection, auto-sent listen:start (mode="auto" or no mode) is ignored.
    // A real manual press (mode="manual") is NOT ignored — user explicitly interrupted.
    if (this.isInjectingB9 && mode !== "manual") return;
    const prev = this.state;
    // Interrupt: if speaking, tell device to stop playback immediately
    if (prev === "speaking") {
      this.sendJson(buildTts("stop"));
    }
    // generation++ cancels any in-flight process() / sendFramesRateControlled()
    this.generation++;
    this.clearSpeakingTimer();
    this.state = "listening";
    this.opusFrames = [];
    const modeTag = mode ? ` mode=${mode}` : "";
    const tag = prev === "idle" ? "start" : `interrupt (era: ${prev})`;
    console.log(`[XZ listen] ${tag}${modeTag}`);
  }

  /** Device released button (VAD stop): run the pipeline. */
  onListenStop(mode?: string): void {
    const totalBytes = this.opusFrames.reduce((s, f) => s + f.length, 0);
    const modeTag = mode ? ` mode=${mode}` : "";
    console.log(
      `[XZ listen] stop — ${this.opusFrames.length} frames (${totalBytes} bytes)${modeTag}`,
    );
    if (this.state !== "listening") return;
    this.state = "processing";
    const frames = this.opusFrames;
    this.opusFrames = [];
    void this.process(frames, this.generation);
  }

  /** Abort from device in any state: cancel everything, go idle. */
  onAbort(): void {
    this.isInjectingB9 = false; // allow listen:start after abort, even if B9 was running
    this.generation++;
    this.clearSpeakingTimer();
    if (this.state === "speaking") {
      this.sendJson(buildTts("stop"));
    }
    this.state = "idle";
    this.opusFrames = [];
  }

  /**
   * B9: inject pending TTS from a previous B8 session into this (new) WS.
   * Called by bridge right after hello when device reconnects with same deviceId.
   * Blocks listen:start via state guard until playback completes.
   */
  async injectTts(frames: Buffer[]): Promise<void> {
    if (this.state !== "idle" || frames.length === 0) return;
    const gen = this.generation;
    this.state = "speaking";
    this.isInjectingB9 = true;
    console.log(`[XZ B9] injecting pending TTS (${frames.length} frames) into new session`);
    this.sendJson(buildTts("start"));
    await this.sendFramesRateControlled(frames, gen);
    this.isInjectingB9 = false; // always clear after await (even if interrupted)
    if (gen === this.generation) {
      this.sendJson(buildTts("stop"));
      this.state = "idle";
      console.log(`[XZ B9] pending TTS playback complete`);
    }
  }

  /**
   * B8: called on WS close — if we were listening, trigger implicit stop so
   * STT+agent still run (TTS will silently fail on closed WS, but session
   * history is updated for next reconnect).
   */
  flushOnDisconnect(): void {
    if (this.state === "listening" && this.opusFrames.length > 0) {
      const n = this.opusFrames.length;
      console.log(`[XZ B8] disconnect during listen — implicit stop (${n} frames buffered)`);
      // onListenStop transitions state and fires process(); TTS sends will
      // silently no-op because ws.readyState !== OPEN.
      this.onListenStop("auto");
    } else {
      this.generation++;
      this.clearSpeakingTimer();
      this.state = "idle";
    }
  }

  // ─── Internal pipeline ──────────────────────────────────────────────────────

  private async process(frames: Buffer[], gen: number): Promise<void> {
    try {
      // 2.1 — Opus → PCM (16kHz mono)
      const pcmChunks: Buffer[] = [];
      let decodeErrors = 0;
      for (const frame of frames) {
        try {
          pcmChunks.push(this.decoder.decode(frame));
        } catch (err) {
          decodeErrors++;
          console.error("[XZ 2.1] Opus decode frame error:", err);
        }
      }
      const pcm16k = Buffer.concat(pcmChunks);
      console.log(
        `[XZ 2.1] Opus decode: ${frames.length} frames → ${pcm16k.length} bytes PCM` +
          (decodeErrors ? ` (${decodeErrors} errors)` : ""),
      );

      if (gen !== this.generation) return;

      // 2.3 — Voxtral STT (Mistral EU)
      const sttApiKey = process.env.MISTRAL_API_KEY;
      if (!sttApiKey) {
        console.warn("[XZ 2.3] Voxtral STT: MISTRAL_API_KEY not set — silent ack");
        this.silentAck();
        return;
      }
      if (pcm16k.length === 0) {
        console.warn("[XZ 2.3] Voxtral STT: 0 bytes PCM — silent ack");
        this.silentAck();
        return;
      }

      const wav = buildWav(pcm16k, UPLOAD_RATE, 1);
      console.log(`[XZ 2.3] Voxtral STT: invio ${wav.length} bytes WAV...`);
      const sttT0 = Date.now();
      let text: string | null;
      try {
        text = await whisperTranscribe(wav, sttApiKey);
      } catch (err) {
        console.error("[XZ 2.3] Voxtral STT: ERROR:", err);
        this.silentAck();
        return;
      }
      const sttMs = Date.now() - sttT0;
      console.log(
        text?.trim()
          ? `[XZ 2.3] Voxtral STT: "${text}" (${sttMs}ms)`
          : `[XZ 2.3] Voxtral STT: null — silenzio (${sttMs}ms)`,
      );

      if (gen !== this.generation) return;

      if (!text?.trim()) {
        this.silentAck();
        return;
      }

      // Show transcription on device screen
      this.sendJson(buildStt(text));

      // 2.4 + 2.5 + 2.6 — P1C streaming: Agent tokens → sentence splitter → TTS → Opus → device
      console.log(`[XZ 2.4] Agent streaming: input="${text}"`);
      const t0 = Date.now();

      // Producer: onPartialReply pushes complete sentences into speakQueue (synchronous, fast).
      // Consumer (consumeLoop below) runs in parallel and calls speakChunk() per sentence.
      const speakQueue: string[] = [];
      let agentDone = false;
      let sentBuf = ""; // tokens not yet flushed as a sentence
      // onPartialReply sends cumulative text (not delta) — track last length to compute delta.
      let lastPartialLen = 0;

      const agentPromise = this.runAgent(text, (cumulativeText) => {
        const delta = cumulativeText.slice(lastPartialLen);
        lastPartialLen = cumulativeText.length;
        sentBuf += delta;
        const { sentences, remainder } = extractSentences(sentBuf);
        sentBuf = remainder;
        speakQueue.push(...sentences);
      }).then((response) => {
        agentDone = true;
        return response;
      });

      // Consumer: dequeue and speak sentences as they arrive, then flush remainder.
      let firstChunk = true;
      let spokenSomething = false;

      const consumeLoop = async (): Promise<void> => {
        while (true) {
          if (gen !== this.generation) return;
          if (speakQueue.length > 0) {
            const sentence = speakQueue.shift()!;
            const ok = await this.speakChunk(sentence, gen, firstChunk);
            if (ok) {
              firstChunk = false;
              spokenSomething = true;
            }
          } else if (agentDone) {
            break;
          } else {
            // Brief yield while waiting for more tokens from LLM
            await new Promise<void>((r) => setTimeout(r, 10));
          }
        }
      };

      const [response] = await Promise.all([agentPromise, consumeLoop()]);

      if (gen !== this.generation) return;

      // Flush any remainder (last partial sentence not ended with punctuation)
      const remainderText = sentBuf.trim();
      if (remainderText) {
        const ok = await this.speakChunk(remainderText, gen, firstChunk);
        if (ok) {
          firstChunk = false;
          spokenSomething = true;
        }
      }

      if (gen !== this.generation) return;

      console.log(
        response?.trim()
          ? `[XZ 2.4] Agent: risposta="${response}" (${response.length} chars, ${Date.now() - t0}ms)`
          : `[XZ 2.4] Agent: null`,
      );

      if (!spokenSomething) {
        this.silentAck();
        return;
      }

      // 2.7 — Emotion/text display on device screen (sent after voice, full response available)
      if (response?.trim()) {
        this.sendJson(buildLlm(response, "happy"));
      }

      this.sendJson(buildTts("stop"));
      this.state = "idle";
      // device will automatically send listen:start (dialog mode)
    } catch (err) {
      console.error("[xiaozhi] pipeline error:", err);
      if (gen === this.generation) {
        this.silentAck();
      }
    }
  }

  /** Send tts:start + tts:stop with no audio — tells device the turn is over. */
  private silentAck(): void {
    this.sendJson(buildTts("start"));
    this.sendJson(buildTts("stop"));
    this.state = "idle";
  }

  /**
   * P1C: TTS a single sentence chunk, encode to Opus and send rate-controlled.
   * Returns true if all frames were sent successfully with this generation.
   * isFirst=true → sends tts:start and transitions state to "speaking".
   */
  private async speakChunk(text: string, gen: number, isFirst: boolean): Promise<boolean> {
    if (gen !== this.generation || !text.trim()) return false;

    console.log(`[XZ 2.5] TTS chunk (${text.length} chars): "${text.slice(0, 60)}"`);
    let result: Awaited<ReturnType<typeof this.deps.runtime.tts.textToSpeechTelephony>>;
    try {
      result = await this.deps.runtime.tts.textToSpeechTelephony({
        text,
        cfg: this.deps.config,
      });
    } catch (err) {
      console.error("[XZ 2.5] TTS chunk ERROR:", err);
      return false;
    }

    if (gen !== this.generation) return false;

    if (!result.success || !result.audioBuffer || !result.sampleRate) {
      console.error("[XZ 2.5] TTS chunk FAILED:", result.error);
      return false;
    }

    // Voxtral returns JSON {"audio_data":"<base64>"} — unwrap first
    const pcmRaw = maybeUnwrapVoxtralResponse(result.audioBuffer);
    // Convert float32→int16 if provider returns float32 (e.g. Voxtral)
    const pcmInt16 = maybeFloat32ToInt16(pcmRaw);
    // Resample to 24kHz if TTS provider returned a different rate
    const pcmResampled = resamplePcm(pcmInt16, result.sampleRate, DOWNLOAD_RATE);
    // XIAOZHI_TTS_GAIN: target peak 0.1–1.0, default 0.85. Tune per voice in env.
    const ttsGain = Math.min(
      1.0,
      Math.max(0.1, parseFloat(process.env.XIAOZHI_TTS_GAIN ?? "0.85")),
    );
    const pcm24k = normalizePcm(pcmResampled, ttsGain);

    // Reset encoder state between chunks to avoid Opus predictor bleed/chirp artifacts.
    this.encoder.applyEncoderCTL(OPUS_RESET_STATE_REQUEST, 0);

    // Encode PCM → Opus frames (60ms each)
    const opusFrames: Buffer[] = [];
    for (let i = 0; i < pcm24k.length; i += DOWNLOAD_FRAME_BYTES) {
      const chunk = pcm24k.subarray(i, i + DOWNLOAD_FRAME_BYTES);
      // Pad last frame to exactly 60ms
      const padded =
        chunk.length < DOWNLOAD_FRAME_BYTES
          ? Buffer.concat([chunk, Buffer.alloc(DOWNLOAD_FRAME_BYTES - chunk.length)])
          : chunk;
      try {
        opusFrames.push(this.encoder.encode(padded));
      } catch (err) {
        console.error("[XZ 2.5] Opus encode frame error:", err);
      }
    }

    if (gen !== this.generation || opusFrames.length === 0) return false;

    // B9: WS closed — queue first chunk frames for next reconnect, skip subsequent chunks.
    if (this.ws.readyState !== this.ws.OPEN) {
      if (isFirst) {
        console.log(`[XZ B9] WS closed — queuing ${opusFrames.length} TTS frames for reconnect`);
        this.onTtsReady?.(opusFrames);
      }
      this.state = "idle";
      return false;
    }

    // First chunk: transition to speaking state and open TTS stream on device.
    if (isFirst) {
      this.state = "speaking";
      this.sendJson(buildTts("start"));
    }

    this.sendJson(buildTts("sentence_start", text));
    console.log(`[XZ 2.6] Rate-ctrl chunk: ${opusFrames.length} frames`);
    await this.sendFramesRateControlled(opusFrames, gen);

    return gen === this.generation;
  }

  /** Send Opus frames one at a time, one per FRAME_MS.
   * Uses drift-corrected scheduling: each delay is computed from the absolute
   * start time so setTimeout jitter does not accumulate across frames. */
  private sendFramesRateControlled(frames: Buffer[], gen: number): Promise<void> {
    return new Promise((resolve) => {
      let i = 0;
      const startTime = Date.now();
      const sendNext = () => {
        if (gen !== this.generation || i >= frames.length) {
          resolve();
          return;
        }
        if (this.ws.readyState === this.ws.OPEN) {
          this.ws.send(frames[i]);
        }
        i++;
        // Schedule next frame relative to start, not relative to "now",
        // so accumulated setTimeout drift doesn't cause buffer underruns.
        const delay = Math.max(0, startTime + i * FRAME_MS - Date.now());
        this.speakingTimer = setTimeout(sendNext, delay);
      };
      sendNext();
    });
  }

  private clearSpeakingTimer(): void {
    if (this.speakingTimer !== null) {
      clearTimeout(this.speakingTimer);
      this.speakingTimer = null;
    }
  }

  // ─── Agent ───────────────────────────────────────────────────────────────────

  /**
   * Runs the embedded agent. onToken (optional) is called synchronously with
   * each partial-reply delta as the LLM streams tokens — used for P1C streaming TTS.
   */
  private async runAgent(text: string, onToken?: (token: string) => void): Promise<string | null> {
    let deps: Awaited<ReturnType<typeof loadCoreAgentDeps>>;
    try {
      deps = await loadCoreAgentDeps();
    } catch (err) {
      console.error("[xiaozhi] core deps unavailable:", err);
      return null;
    }

    // Cast to CoreConfig — OpenClawConfig is a superset
    type CoreCfg = Parameters<typeof deps.resolveAgentDir>[0];
    const cfg = this.deps.config as unknown as CoreCfg;

    const agentId = "main";
    const sessionKey = "main";

    const storePath = deps.resolveStorePath(
      (cfg as { session?: { store?: string } }).session?.store,
      { agentId },
    );
    const agentDir = deps.resolveAgentDir(cfg, agentId);
    const workspaceDir = deps.resolveAgentWorkspaceDir(cfg, agentId);

    await deps.ensureAgentWorkspace({ dir: workspaceDir });

    const sessionStore = deps.loadSessionStore(storePath);
    type SessionEntry = { sessionId: string; updatedAt: number };
    let entry = sessionStore[sessionKey] as SessionEntry | undefined;

    if (!entry) {
      entry = { sessionId: randomUUID(), updatedAt: Date.now() };
      sessionStore[sessionKey] = entry;
      await deps.saveSessionStore(storePath, sessionStore);
    }

    const sessionFile = deps.resolveSessionFilePath(entry.sessionId, entry, { agentId });
    const timeoutMs = deps.resolveAgentTimeoutMs({ cfg });
    const thinkLevel = deps.resolveThinkingDefault({ cfg });
    const runId = `xiaozhi:${entry.sessionId}:${Date.now()}`;
    const t0 = Date.now();

    try {
      const result = await deps.runEmbeddedPiAgent({
        sessionId: entry.sessionId,
        sessionKey,
        messageProvider: "xiaozhi",
        sessionFile,
        workspaceDir,
        config: cfg,
        prompt: text,
        thinkLevel,
        verboseLevel: "off",
        timeoutMs,
        runId,
        lane: "xiaozhi",
        agentDir,
        extraSystemPrompt: buildExtraSystemPrompt(),
        // P1C: fire-and-forget partial reply tokens into caller's buffer
        onPartialReply: onToken
          ? (payload) => {
              if (payload.text) onToken(payload.text);
            }
          : undefined,
      });

      const texts = (result.payloads ?? [])
        .filter((p) => p.text && !p.isError)
        .map((p) => p.text?.trim())
        .filter(Boolean);

      const response = texts.join(" ") || null;

      // Trace LLM input/output to JSONL for debugging
      try {
        const traceEntry = JSON.stringify({
          ts: new Date().toISOString(),
          ms: Date.now() - t0,
          input: text,
          output: response,
          sessionFile, // full conversation + system prompt context
        });
        appendFileSync(LLM_TRACE_FILE, traceEntry + "\n");
      } catch {
        // trace failure must never break the pipeline
      }

      return response;
    } catch (err) {
      console.error("[xiaozhi] agent error:", err);
      return null;
    }
  }

  private sendJson(msg: string): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(msg);
    }
  }
}

// ─── WAV builder ──────────────────────────────────────────────────────────────

function buildWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const byteRate = sampleRate * channels * BYTES_PER_SAMPLE;
  const blockAlign = channels * BYTES_PER_SAMPLE;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM subchunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

// ─── Whisper STT ──────────────────────────────────────────────────────────────

async function whisperTranscribe(wav: Buffer, apiKey: string): Promise<string | null> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
  form.append("model", "voxtral-mini-latest");
  form.append("language", "it");

  let res: Response;
  try {
    res = await fetch("https://api.mistral.ai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } catch (err) {
    console.error("[xiaozhi] Voxtral STT fetch error:", err);
    return null;
  }

  if (!res.ok) {
    console.error(`[xiaozhi] Voxtral STT HTTP ${res.status}:`, await res.text());
    return null;
  }

  const json = (await res.json()) as { text?: string };
  return json.text ?? null;
}

// ─── Voxtral JSON unwrap ──────────────────────────────────────────────────────

/**
 * Voxtral non-streaming endpoint returns JSON: {"audio_data": "<base64>"}.
 * Unwrap and decode to raw bytes before any PCM processing.
 * No-op for all other endpoints (binary response).
 */
function maybeUnwrapVoxtralResponse(buf: Buffer): Buffer {
  const baseUrl = (process.env.OPENAI_TTS_BASE_URL ?? "").toLowerCase();
  if (!baseUrl.includes("mistral")) return buf;
  if (buf[0] !== 0x7b) return buf; // not JSON
  try {
    const json = JSON.parse(buf.toString("utf8")) as { audio_data?: string };
    if (json.audio_data) return Buffer.from(json.audio_data, "base64");
  } catch {
    // not valid JSON, return as-is
  }
  return buf;
}

// ─── Float32→Int16 converter ─────────────────────────────────────────────────

/**
 * Voxtral (api.mistral.ai) returns float32 LE PCM; all other providers (OpenAI,
 * ElevenLabs) return int16 LE. Detects Voxtral via OPENAI_TTS_BASE_URL and
 * converts accordingly. No-op for all other endpoints.
 */
function maybeFloat32ToInt16(buf: Buffer): Buffer {
  const baseUrl = (process.env.OPENAI_TTS_BASE_URL ?? "").toLowerCase();
  if (!baseUrl.includes("mistral")) return buf;
  const samples = Math.floor(buf.length / 4); // float32 = 4 bytes/sample
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const f = Math.max(-1, Math.min(1, buf.readFloatLE(i * 4)));
    out.writeInt16LE(Math.round(f * 32767), i * 2);
  }
  return out;
}

// ─── PCM peak normalizer ──────────────────────────────────────────────────────

/**
 * Normalizes PCM peak to targetPeak (0–1): amplifies if too quiet, attenuates
 * if too loud. Caps at targetPeak to prevent Opus pre-echo on loud vowels.
 */
function normalizePcm(pcm: Buffer, targetPeak = 0.707): Buffer {
  // Floor in case provider returns odd-length buffer (e.g. Voxtral)
  const samples = Math.floor(pcm.length / BYTES_PER_SAMPLE);
  let maxAbs = 0;
  for (let i = 0; i < samples; i++) {
    maxAbs = Math.max(maxAbs, Math.abs(pcm.readInt16LE(i * BYTES_PER_SAMPLE)));
  }
  const limit = targetPeak * 32767;
  if (maxAbs === 0 || maxAbs === limit) return pcm; // already at target
  const gain = limit / maxAbs;
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < samples; i++) {
    const sample = Math.round(pcm.readInt16LE(i * BYTES_PER_SAMPLE) * gain);
    out.writeInt16LE(sample, i * BYTES_PER_SAMPLE);
  }
  return out;
}

// ─── Sentence splitter ────────────────────────────────────────────────────────

/**
 * Extracts complete sentences from a growing token buffer.
 * Splits on sentence-ending punctuation (. ! ?) followed by whitespace/end, or newlines.
 * Sentences shorter than minLen chars are merged into the next one to avoid
 * excessive TTS micro-calls (e.g. "Sì!" alone would be wasteful).
 * Returns extracted sentences and the unprocessed remainder for the next call.
 */
function extractSentences(text: string, minLen = 20): { sentences: string[]; remainder: string } {
  const sentences: string[] = [];
  // Find all sentence-boundary end positions
  const re = /[.!?]+(?:\s+|$)|\n+/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const end = m.index + m[0].length;
    const sentence = text.slice(start, end).trim();
    if (sentence.length >= minLen) {
      sentences.push(sentence);
      start = end;
    }
    // If too short, don't advance start: next boundary will merge this fragment
    // with subsequent text, producing a longer combined sentence.
  }
  return { sentences, remainder: text.slice(start) };
}

// ─── PCM resampler (linear interpolation) ─────────────────────────────────────

function resamplePcm(input: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return input;

  const inputSamples = Math.floor(input.length / BYTES_PER_SAMPLE);
  if (inputSamples === 0) return Buffer.alloc(0);

  const ratio = fromRate / toRate;
  const outputSamples = Math.floor(inputSamples / ratio);
  const output = Buffer.alloc(outputSamples * BYTES_PER_SAMPLE);

  for (let i = 0; i < outputSamples; i++) {
    const srcPos = i * ratio;
    const srcIdx = Math.floor(srcPos);
    const frac = srcPos - srcIdx;
    const s0 = input.readInt16LE(srcIdx * BYTES_PER_SAMPLE);
    const s1 = input.readInt16LE(Math.min(srcIdx + 1, inputSamples - 1) * BYTES_PER_SAMPLE);
    const sample = Math.round(s0 + frac * (s1 - s0));
    output.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * BYTES_PER_SAMPLE);
  }

  return output;
}
