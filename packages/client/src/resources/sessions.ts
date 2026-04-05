import type { AnorionClient } from "../client.js";
import type {
  ApiResponse,
  Message,
  MessageListParams,
  Session,
  SessionListParams,
} from "../types.js";

export class SessionsResource {
  constructor(private readonly client: AnorionClient) {}

  list(params?: SessionListParams): Promise<ApiResponse<Session[]>> {
    return this.client.get<ApiResponse<Session[]>>("/sessions", params as Record<string, string | number | boolean | undefined>);
  }

  get(id: string): Promise<ApiResponse<Session>> {
    return this.client.get<ApiResponse<Session>>(`/sessions/${id}`);
  }

  getMessages(id: string, params?: MessageListParams): Promise<ApiResponse<Message[]>> {
    return this.client.get<ApiResponse<Message[]>>(`/sessions/${id}/messages`, params as Record<string, string | number | boolean | undefined>);
  }

  create(agentId: string): Promise<ApiResponse<Session>> {
    return this.client.post<ApiResponse<Session>>("/sessions", { agentId });
  }

  delete(id: string): Promise<void> {
    return this.client.del(`/sessions/${id}`);
  }

  sendMessage(id: string, text: string): Promise<ApiResponse<Message>> {
    return this.client.post<ApiResponse<Message>>(`/sessions/${id}/messages`, { text });
  }
}
