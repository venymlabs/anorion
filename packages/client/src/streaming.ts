import type { StreamChunk } from "./types.js";

/**
 * Parse an SSE stream from a fetch Response into an AsyncIterable of StreamChunks.
 */
export async function* parseSSEStream(
  response: Response,
): AsyncGenerator<StreamChunk> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response body is not readable");

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Keep the last incomplete line in the buffer
      buffer = lines.pop() ?? "";

      let eventType = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim();
          continue;
        }
        if (line.startsWith("data: ")) {
          const raw = line.slice(6);
          if (raw === "[DONE]") return;
          try {
            const chunk = JSON.parse(raw) as StreamChunk;
            yield chunk;
          } catch {
            // If the data isn't valid JSON, yield it as a text delta
            if (eventType === "" || eventType === "delta") {
              yield { type: "delta", content: raw };
            }
          }
          eventType = "";
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
