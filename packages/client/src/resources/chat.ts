import type { AnorionClient } from "../client.js";
import type { ApiResponse, ChatOptions, Message, StreamChunk } from "../types.js";
import { parseSSEStream } from "../streaming.js";

export class ChatResource {
  constructor(private readonly client: AnorionClient) {}

  async send(agentId: string, text: string, options?: ChatOptions): Promise<ApiResponse<Message>> {
    return this.client.post<ApiResponse<Message>>("/chat", {
      agentId,
      text,
      ...options,
    });
  }

  async *stream(agentId: string, text: string, options?: ChatOptions): AsyncGenerator<StreamChunk> {
    const response = await this.client.postRaw("/chat/stream", {
      agentId,
      text,
      stream: true,
      ...options,
    });

    if (!response.ok) {
      await this.client.handleError(response);
    }

    yield* parseSSEStream(response);
  }
}
