import type { AnorionClient } from "../client.js";
import type { ApiResponse, ConfigEntry } from "../types.js";

export class ConfigResource {
  constructor(private readonly client: AnorionClient) {}

  get(): Promise<ApiResponse<ConfigEntry[]>> {
    return this.client.get<ApiResponse<ConfigEntry[]>>("/config");
  }

  set(key: string, value: unknown): Promise<ApiResponse<ConfigEntry>> {
    return this.client.post<ApiResponse<ConfigEntry>>("/config", { key, value });
  }
}
