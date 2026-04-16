/**
 * Vision proxy HTTP handler for XiaoZhi device camera.
 *
 * The firmware captures a JPEG photo and POSTs it as multipart/form-data
 * to the gateway's /xiaozhi/vision endpoint. This handler:
 * 1. Parses the multipart body (fixed boundary format from firmware)
 * 2. Extracts the `question` field and `image` JPEG binary
 * 3. Base64-encodes the JPEG and sends it to Pixtral via runEmbeddedPiAgent
 * 4. Returns `{"success": true, "result": "..."}` to the firmware
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCoreAgentDeps } from "./core-bridge.js";

/** Create the /xiaozhi/vision HTTP handler. */
export function createVisionHandler(): (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void> {
  return async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, message: "Method not allowed" }));
      return;
    }

    try {
      const body = await collectBody(req);
      const contentType = req.headers["content-type"] ?? "";
      const { question, imageBuffer } = parseMultipart(body, contentType);

      if (!imageBuffer || imageBuffer.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, message: "No image data in request" }));
        return;
      }

      const base64 = imageBuffer.toString("base64");
      const prompt = question || "Describe what you see.";

      console.log(
        `[vision-proxy] Analyzing image (${imageBuffer.length}b) question="${prompt.slice(0, 80)}"`,
      );

      const description = await analyzeImageViaAgent(base64, prompt);

      if (description) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, result: description }));
      } else {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, message: "Vision analysis returned no result" }));
      }
    } catch (err) {
      console.error("[vision-proxy] Error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: false,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  };
}

/** Collect the full request body into a Buffer. */
function collectBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Parse multipart/form-data from the firmware's fixed format.
 * The firmware uses boundary "----ESP32_CAMERA_BOUNDARY" and sends
 * exactly two parts: `question` (text) and `image` (JPEG binary).
 */
function parseMultipart(
  body: Buffer,
  contentType: string,
): { question: string; imageBuffer: Buffer | null } {
  // Extract boundary from Content-Type header
  const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/);
  if (!boundaryMatch) {
    throw new Error("Missing multipart boundary in Content-Type");
  }
  const boundary = boundaryMatch[1].trim();
  const delimiterBuf = Buffer.from(`--${boundary}`);

  let question = "";
  let imageBuffer: Buffer | null = null;

  // Split body by boundary delimiter
  const bodyStr = body.toString("binary");
  const delimiterStr = delimiterBuf.toString("binary");
  const parts = bodyStr.split(delimiterStr);

  for (const part of parts) {
    // Skip empty parts and closing delimiter
    if (!part || part.startsWith("--")) continue;

    // Find the header/body separator (double CRLF)
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;

    const headers = part.slice(0, headerEnd);
    const content = part.slice(headerEnd + 4);
    // Remove trailing CRLF from content
    const trimmedContent = content.endsWith("\r\n") ? content.slice(0, -2) : content;

    const dispositionMatch = headers.match(/Content-Disposition:.*?name="([^"]+)"/i);
    if (!dispositionMatch) continue;
    const fieldName = dispositionMatch[1];

    if (fieldName === "question") {
      question = Buffer.from(trimmedContent, "binary").toString("utf8");
    } else if (fieldName === "image" || fieldName === "file") {
      imageBuffer = Buffer.from(trimmedContent, "binary");
    }
  }

  return { question, imageBuffer };
}

/** Analyze a base64 JPEG image using runEmbeddedPiAgent with Pixtral vision model. */
async function analyzeImageViaAgent(base64: string, question: string): Promise<string | null> {
  let deps: Awaited<ReturnType<typeof loadCoreAgentDeps>>;
  try {
    deps = await loadCoreAgentDeps();
  } catch (err) {
    console.error("[vision-proxy] core deps unavailable:", err);
    return null;
  }

  const sessionId = `vision-${Date.now()}`;
  const sessionFile = join(tmpdir(), `xiaozhi-vision-${sessionId}.jsonl`);

  try {
    const result = await deps.runEmbeddedPiAgent({
      sessionId,
      sessionFile,
      workspaceDir: process.cwd(),
      prompt: question,
      provider: "mistral",
      model: "pixtral-large-latest",
      images: [{ type: "image", data: base64, mimeType: "image/jpeg" }],
      timeoutMs: 15_000,
      runId: `photo-${randomUUID()}`,
      disableTools: true,
    });

    const texts = (result.payloads ?? [])
      .filter((p) => p.text && !p.isError)
      .map((p) => p.text?.trim())
      .filter(Boolean);

    const description = texts.join(" ") || null;
    console.log(`[vision-proxy] Pixtral analysis done (${description?.length ?? 0} chars)`);
    return description;
  } catch (err) {
    console.error("[vision-proxy] vision agent error:", err);
    return null;
  }
}
