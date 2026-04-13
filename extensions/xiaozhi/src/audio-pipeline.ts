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
import { readXiaozhiCompactionConfig } from "./config.js";
import { maybeRotateSession } from "./context-manager.js";
import { loadCoreAgentDeps } from "./core-bridge.js";
import { buildLlm, buildStt, buildTts } from "./protocol.js";
import { AdaUiState, buildUiState } from "./ui-state.js";

// ─── Agent prompts ────────────────────────────────────────────────────────────

/** Injected as extraSystemPrompt in every voice agent call.
 *  Keeps voice-specific rules in one place; takes priority over workspace files. */
const VOICE_EXTRA_SYSTEM_PROMPT = `MODALITÀ VOCALE — priorità assoluta su tutto il resto:
- Rispondi in MASSIMO 20-30 parole. Vai dritto al punto.
- Se l'utente chiede un approfondimento, puoi allungare fino a 4-5 frasi.
- Se esegui un'azione (modifica file, cerca, ecc.), rispondi SOLO con il risultato. NON spiegare cosa hai fatto, quale file hai toccato, o perché. Esempio: "Fatto, prova adesso" oppure "Ecco il risultato: ...".
- VIETATO usare markdown: niente **, *, \`, #, elenchi con - o numeri. Rispondi SOLO in prosa fluente.
- VIETATO premesse, intro, recap o riassunti — vai diretto alla risposta.
- Il tuo output viene letto ad alta voce da un sintetizzatore TTS. Scrivi come parleresti a voce.
- Se non sai qualcosa, dillo in una frase. Non elencare alternative.

GESTIONE MEMORIA — quando l'utente chiede di salvare/ricordare/memorizzare qualcosa:
- Usa il tool "write" per scrivere nel file ~/.openclaw/workspace/memory/YYYY-MM-DD.md (data odierna).
- Formato: una riga per evento, prefissata con "- " (es. "- Mi è caduto un bicchiere").
- Se il file esiste già, prima leggilo con "read", poi riscrivi tutto il contenuto aggiungendo la nuova riga in fondo.
- Se non esiste, crealo con header "# Memoria YYYY-MM-DD" seguito dalla riga.
- Conferma brevemente a voce dopo aver scritto.
- Quando l'utente chiede cosa è successo o vuole ricordare eventi passati, usa "memory_search" per cercare nei file di memoria, poi "memory_get" per leggere i dettagli.
- NON fingere di aver salvato: devi SEMPRE chiamare il tool "write". Se non lo fai, l'utente perde il dato.`;

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

// ─── Instant routing (bypass LLM) ───────────────────────────────────────────

/** Normalize text for pattern matching: lowercase, strip punctuation. */
function normalizeForRouting(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:'"…\-–—()[\]{}]/g, "")
    .trim();
}

type InstantPattern = { re: RegExp; responses: string[] };

const INSTANT_PATTERNS: InstantPattern[] = [
  {
    // "ciao", "ehi ciao", "ciao a tutti", "oh ciao come va"
    re: /^(ciao|hey|ehi|salve|buongiorno|buonasera|ehilà|oh ciao)(\s|$)/,
    responses: ["Ciao!", "Ehi, ciao!", "Ciao, dimmi tutto!", "Eccomi, dimmi!"],
  },
  {
    re: /^(grazie|ti ringrazio|perfetto grazie)/,
    responses: ["Di niente!", "Figurati!", "Prego!", "Non c'è di che!"],
  },
  {
    re: /^(arrivederci|ciao ciao|ci vediamo|a presto|a dopo|addio|buonanotte)(\s|$)/,
    responses: ["Ciao, a presto!", "A dopo!", "Ci vediamo!", "Buonanotte!"],
  },
  {
    // "chi sei", "come ti chiami", "qual è il tuo nome", "come ti chiami qual è il tuo nome"
    re: /(chi sei|come ti chiami|qual è il tuo nome|il tuo nome)/,
    responses: ["Sono Ada la tua assistente vocale!", "Sono Ada, la tua assistente!"],
  },
  {
    re: /^(come stai|tutto bene|come va)/,
    responses: [
      "Tutto bene, grazie! Tu come stai?",
      "Alla grande! Dimmi come posso aiutarti.",
      "Benissimo! Tu?",
    ],
  },
  {
    // "che ore sono", "che ora è", "dimmi l'ora", "sai l'ora"
    re: /(che ora è|che ore sono|dimmi lora|lora attuale|sai lora)/,
    responses: [], // dynamic — filled at runtime
  },
  {
    re: /(che giorno è|che data è|data di oggi|che giorno è oggi)/,
    responses: [], // dynamic — filled at runtime
  },
];

/**
 * Instant routing: matches simple greetings, time, farewells etc.
 * Returns a response string if matched, null otherwise (fall through to LLM).
 */
function routeToInstant(text: string): string | null {
  const norm = normalizeForRouting(text);
  // Skip instant routing for long inputs — likely complex questions
  if (norm.split(/\s+/).length > 12) {
    console.log(`[XZ INSTANT] ⏭ skip (${norm.split(/\s+/).length} words): "${text.slice(0, 60)}"`);
    return null;
  }
  for (const pat of INSTANT_PATTERNS) {
    if (!pat.re.test(norm)) continue;

    // Dynamic: time
    if (norm.includes("ora") || norm.includes("ore")) {
      const time = new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
      const response = `Sono le ${time}.`;
      console.log(`[XZ INSTANT] ✅ MATCH ora: "${text}" → "${response}"`);
      return response;
    }
    // Dynamic: date
    if (norm.includes("giorno") || norm.includes("data")) {
      const date = new Date().toLocaleDateString("it-IT", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      });
      const response = `Oggi è ${date}.`;
      console.log(`[XZ INSTANT] ✅ MATCH data: "${text}" → "${response}"`);
      return response;
    }
    // Static responses — pick random
    const response = pat.responses[Math.floor(Math.random() * pat.responses.length)];
    console.log(`[XZ INSTANT] ✅ MATCH: "${text}" → "${response}"`);
    return response;
  }
  console.log(`[XZ INSTANT] ❌ no match: "${text}" → passa a LLM`);
  return null;
}

// ─── Tool intent detection (conversation router) ────────────────────────────

const TOOL_INTENT_KEYWORDS = [
  "cerca",
  "trova",
  "google",
  "manda",
  "scrivi",
  "invia",
  "messaggio",
  "leggi",
  "ricorda",
  "salva",
  "memorizza",
  "memoria",
  "segna",
  "annota",
  "appunta",
  "calendario",
  "promemoria",
  "esegui",
  "scatta",
  "foto",
  "apri",
  "chiudi",
  "accendi",
  "spegni",
  "timer",
  "sveglia",
  "alarm",
];

// ─── TTS text sanitizer ─────────────────────────────────────────────────────

/** Strip markdown/special chars that cause Mistral TTS 500 errors. */
function sanitizeForTts(text: string): string {
  return (
    text
      // Code blocks: ```...```
      .replace(/```[\s\S]*?```/g, "")
      // Bold/italic: **text** / *text* / __text__ / _text_
      .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
      .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
      // Stray asterisks/underscores left after bold/italic removal
      .replace(/[*_]/g, "")
      // Inline code: `text`
      .replace(/`([^`]+)`/g, "$1")
      // Markdown headers: ## Header
      .replace(/^#{1,6}\s+/gm, "")
      // Markdown list items: - item / * item / 1. item
      .replace(/^[\s]*[-*]\s+/gm, "")
      .replace(/^[\s]*\d+\.\s+/gm, "")
      // Curly/smart quotes → straight
      .replace(/[""«»]/g, '"')
      .replace(/['']/g, "'")
      // Links: [text](url) → text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      // Horizontal rules: ---, ***, ___
      .replace(/^[-*_]{3,}\s*$/gm, "")
      // HTML tags: <br>, <b>, etc.
      .replace(/<[^>]+>/g, "")
      // Stray markdown chars
      .replace(/[~>`]/g, "")
      // Collapse multiple spaces/newlines
      .replace(/\n+/g, " ")
      .replace(/ {2,}/g, " ")
      .trim()
  );
}

/**
 * Detects tool intent from user text.
 * Returns true if the text likely needs tools, false for pure conversation.
 */
function hasToolIntent(text: string): boolean {
  const norm = normalizeForRouting(text);
  const words = norm.split(/\s+/);
  for (const kw of TOOL_INTENT_KEYWORDS) {
    if (words.some((w) => w.startsWith(kw))) {
      console.log(`[XZ ROUTER] 🔧 tool intent detected: keyword="${kw}" in "${text}"`);
      return true;
    }
  }
  console.log(`[XZ ROUTER] 💬 conversation only (no tool intent): "${text}" → disableTools=true`);
  return false;
}

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
  /**
   * Plan 12 — Trigger B: closure set by runAgent() that fires a fire-and-forget
   * compaction. Consumed AFTER the TTS audio finished streaming to the device,
   * never during the voice turn. Set to null after consumption.
   */
  private pendingCompaction: (() => void) | null = null;

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
    this.sendJson(buildUiState(AdaUiState.LISTENING));
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
    this.sendJson(buildUiState(AdaUiState.THINKING, { text: "Sto pensando..." }));
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
    this.sendJson(buildUiState(AdaUiState.IDLE));
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

      // 2.4 + 2.5 + 2.6 — P1C streaming + prefetch: Agent tokens → sentence splitter → TTS → Opus → device
      console.log(`[XZ 2.4] Agent streaming: input="${text}"`);
      const t0 = Date.now();

      // Producer: onPartialReply pushes complete sentences into speakQueue (synchronous, fast).
      // Consumer (consumeLoop below) uses 1-ahead TTS prefetch to overlap network wait with send.
      const speakQueue: string[] = [];
      let agentDone = false;
      let sentBuf = "";
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
        // Flush remainder into queue before marking done — consumeLoop handles it.
        const remainderText = sentBuf.trim();
        if (remainderText) speakQueue.push(remainderText);
        sentBuf = "";
        agentDone = true;
        return response;
      });

      // Consumer with 1-ahead TTS prefetch:
      // While sending chunk N (rate-controlled, takes audio_duration ms),
      // TTS for chunk N+1 runs concurrently → zero inter-chunk TTS wait.
      let firstChunk = true;
      let spokenSomething = false;

      let nextFetch: { text: string; promise: Promise<{ frames: Buffer[] } | null> } | null = null;

      // Start TTS for the next queued sentence unless a prefetch is already in flight.
      const kickPrefetch = (): void => {
        if (nextFetch !== null || speakQueue.length === 0) return;
        const t = speakQueue.shift()!;
        nextFetch = { text: t, promise: this.fetchAndEncodeChunk(t, gen) };
      };

      const consumeLoop = async (): Promise<void> => {
        kickPrefetch();
        while (true) {
          if (gen !== this.generation) return;
          if (nextFetch === null) {
            if (agentDone && speakQueue.length === 0) break;
            await new Promise<void>((r) => setTimeout(r, 10));
            kickPrefetch();
            continue;
          }
          const { text: chunkText, promise } = nextFetch;
          nextFetch = null;
          // Start TTS for next sentence before awaiting current — runs concurrently.
          kickPrefetch();
          const encoded = await promise;
          if (gen !== this.generation) return;
          // Kick again: more sentences may have arrived during TTS wait.
          kickPrefetch();
          if (encoded) {
            // Send takes audio_duration ms; next TTS prefetch runs concurrently.
            const ok = await this.sendPrefetchedChunk(encoded, chunkText, gen, firstChunk);
            if (ok) {
              firstChunk = false;
              spokenSomething = true;
            }
          }
          // Kick again: more sentences may have arrived during rate-controlled send.
          kickPrefetch();
        }
      };

      const [response] = await Promise.all([agentPromise, consumeLoop()]);

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
      this.sendJson(buildUiState(AdaUiState.IDLE));
      this.state = "idle";
      // device will automatically send listen:start (dialog mode)

      // Plan 12 — Trigger B: fire pending compaction AFTER full voice response
      // has been streamed to the device. Fire-and-forget; consume closure.
      const pending = this.pendingCompaction;
      this.pendingCompaction = null;
      if (pending) pending();
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
    this.sendJson(buildUiState(AdaUiState.IDLE));
    this.state = "idle";
  }

  /**
   * Prefetch Phase 1 — TTS + PCM processing + Opus encode.
   * Pure compute: no WS sends. Designed to run concurrently with sendPrefetchedChunk
   * for the previous chunk to eliminate inter-sentence TTS latency (1-ahead prefetch).
   */
  private async fetchAndEncodeChunk(
    text: string,
    gen: number,
  ): Promise<{ frames: Buffer[] } | null> {
    const clean = sanitizeForTts(text);
    if (gen !== this.generation || !clean) return null;

    console.log(`[XZ 2.5] TTS prefetch (${clean.length} chars): "${clean.slice(0, 60)}"`);
    let result: Awaited<ReturnType<typeof this.deps.runtime.tts.textToSpeechTelephony>>;
    try {
      result = await this.deps.runtime.tts.textToSpeechTelephony({
        text: clean,
        cfg: this.deps.config,
      });
    } catch (err) {
      console.error("[XZ 2.5] TTS prefetch ERROR:", err);
      return null;
    }

    if (gen !== this.generation) return null;

    if (!result.success || !result.audioBuffer || !result.sampleRate) {
      console.error("[XZ 2.5] TTS prefetch FAILED:", result.error);
      return null;
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

    // Reset encoder state per chunk to avoid Opus predictor bleed/chirp artifacts.
    this.encoder.applyEncoderCTL(OPUS_RESET_STATE_REQUEST, 0);

    // Encode PCM → Opus frames (60ms each)
    const frames: Buffer[] = [];
    for (let i = 0; i < pcm24k.length; i += DOWNLOAD_FRAME_BYTES) {
      const chunk = pcm24k.subarray(i, i + DOWNLOAD_FRAME_BYTES);
      // Pad last frame to exactly 60ms
      const padded =
        chunk.length < DOWNLOAD_FRAME_BYTES
          ? Buffer.concat([chunk, Buffer.alloc(DOWNLOAD_FRAME_BYTES - chunk.length)])
          : chunk;
      try {
        frames.push(this.encoder.encode(padded));
      } catch (err) {
        console.error("[XZ 2.5] Opus encode frame error:", err);
      }
    }

    if (gen !== this.generation || frames.length === 0) return null;

    return { frames };
  }

  /**
   * Prefetch Phase 2 — send pre-encoded Opus frames to device (rate-controlled).
   * Handles B9 (WS closed during send), state transition to "speaking", tts:start/sentence_start.
   */
  private async sendPrefetchedChunk(
    chunk: { frames: Buffer[] },
    text: string,
    gen: number,
    isFirst: boolean,
  ): Promise<boolean> {
    if (gen !== this.generation) return false;

    // B9: WS closed — queue first chunk frames for next reconnect, skip subsequent chunks.
    if (this.ws.readyState !== this.ws.OPEN) {
      if (isFirst) {
        console.log(`[XZ B9] WS closed — queuing ${chunk.frames.length} TTS frames for reconnect`);
        this.onTtsReady?.(chunk.frames);
      }
      this.state = "idle";
      return false;
    }

    // First chunk: transition to speaking state and open TTS stream on device.
    if (isFirst) {
      this.state = "speaking";
      this.sendJson(buildUiState(AdaUiState.SPEAKING));
      this.sendJson(buildTts("start"));
    }

    this.sendJson(buildTts("sentence_start", text));
    console.log(`[XZ 2.6] Rate-ctrl chunk: ${chunk.frames.length} frames`);
    await this.sendFramesRateControlled(chunk.frames, gen);

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
    // Clear any stale pending compaction from a previous aborted turn — the
    // current runAgent call will (re)assign it if compaction is enabled.
    this.pendingCompaction = null;

    // Step 2 — Instant routing: disabled. The canned responses were too
    // rigid (wrong meteo reply, stale greetings). The LLM handles all
    // queries better, including greetings and time.
    // const instant = routeToInstant(text);

    // Step 3 — Tools always enabled: the keyword router caused too many
    // false negatives (blocked memory, web search, etc). If token usage
    // becomes a problem, reimplement with inverse logic (block only greetings).
    const needsTools = true;

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
    const sessionKey = "agent:main:voice";

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

    // Resolve provider/model from agents.defaults.model (string or {primary})
    const rawModel = (() => {
      const m = (cfg as Record<string, unknown>).agents as Record<string, unknown> | undefined;
      const d = m?.defaults as Record<string, unknown> | undefined;
      const val = d?.model;
      if (typeof val === "string") return val.trim();
      if (val && typeof val === "object" && "primary" in val)
        return String((val as Record<string, unknown>).primary ?? "").trim();
      return "";
    })();
    const slashIdx = rawModel.indexOf("/");
    const cfgProvider = slashIdx > 0 ? rawModel.slice(0, slashIdx) : undefined;
    const cfgModel = slashIdx > 0 ? rawModel.slice(slashIdx + 1) : rawModel || undefined;

    try {
      const result = await deps.runEmbeddedPiAgent({
        sessionId: entry.sessionId,
        sessionKey,
        messageProvider: "xiaozhi",
        sessionFile,
        workspaceDir,
        config: cfg,
        prompt: text,
        provider: cfgProvider,
        model: cfgModel,
        thinkLevel,
        verboseLevel: "off",
        timeoutMs,
        runId,
        lane: "xiaozhi",
        agentDir,
        disableTools: !needsTools,
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

      // Plan 12 TODO 3 — Trigger B: post-response session rotation safety net.
      // Save a closure to be fired later (after buildTts("stop")) so rotation
      // runs AFTER the TTS audio finished streaming to the device. Running it
      // here would start the reset during TTS streaming, racing with the
      // session file write and impacting subsequent turns.
      const compactionCfg = readXiaozhiCompactionConfig(this.deps.config);
      if (compactionCfg.enabled && compactionCfg.threshold.enabled) {
        this.pendingCompaction = () => {
          void maybeRotateSession({
            deps,
            cfg,
            sessionId: entry.sessionId,
            sessionKey,
            sessionFile,
            workspaceDir,
            agentDir,
            provider: cfgProvider,
            model: cfgModel,
            thinkLevel,
            minTokens: compactionCfg.threshold.maxTokens,
            ws: this.ws,
            origin: "threshold",
          });
        };
      }

      return response;
    } catch (err) {
      console.error("[xiaozhi] agent error:", err);
      return null;
    }
  }

  private sendJson(msg: string): void {
    if (this.ws.readyState === this.ws.OPEN) {
      if (msg.includes('"SET_UI"')) {
        console.log(`[XZ UI] → ${msg}`);
      }
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
