import type { AnorionClient } from "../client.js";
import type { ApiResponse, ToolExecuteParams, ToolExecuteResult, ToolInfo } from "../types.js";

export class ToolsResource {
  constructor(private readonly client: AnorionClient) {}

  list(): Promise<ApiResponse<ToolInfo[]>> {
    return this.client.get<ApiResponse<ToolInfo[]>>("/tools");
  }

  execute(name: string, params: ToolExecuteParams): Promise<ApiResponse<ToolExecuteResult>> {
    return this.client.post<ApiResponse<ToolExecuteResult>>(`/tools/${name}/execute`, params);
  }
}
