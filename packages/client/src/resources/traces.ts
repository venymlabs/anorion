import type { AnorionClient } from "../client.js";
import type { ApiResponse, Trace, TraceListParams } from "../types.js";

export class TracesResource {
  constructor(private readonly client: AnorionClient) {}

  list(params?: TraceListParams): Promise<ApiResponse<Trace[]>> {
    return this.client.get<ApiResponse<Trace[]>>("/traces", params as Record<string, string | number | boolean | undefined>);
  }

  get(id: string): Promise<ApiResponse<Trace>> {
    return this.client.get<ApiResponse<Trace>>(`/traces/${id}`);
  }
}
