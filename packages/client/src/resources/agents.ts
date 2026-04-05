import type { AnorionClient } from "../client.js";
import type { Agent, AgentCreateParams, AgentUpdateParams, ApiResponse } from "../types.js";

export class AgentsResource {
  constructor(private readonly client: AnorionClient) {}

  list(): Promise<ApiResponse<Agent[]>> {
    return this.client.get<ApiResponse<Agent[]>>("/agents");
  }

  get(id: string): Promise<ApiResponse<Agent>> {
    return this.client.get<ApiResponse<Agent>>(`/agents/${id}`);
  }

  create(data: AgentCreateParams): Promise<ApiResponse<Agent>> {
    return this.client.post<ApiResponse<Agent>>("/agents", data);
  }

  update(id: string, data: AgentUpdateParams): Promise<ApiResponse<Agent>> {
    return this.client.patch<ApiResponse<Agent>>(`/agents/${id}`, data);
  }

  delete(id: string): Promise<void> {
    return this.client.del(`/agents/${id}`);
  }
}
