import type { AnorionClient } from "../client.js";
import type { ApiResponse, Channel } from "../types.js";

export class ChannelsResource {
  constructor(private readonly client: AnorionClient) {}

  list(): Promise<ApiResponse<Channel[]>> {
    return this.client.get<ApiResponse<Channel[]>>("/channels");
  }

  enable(name: string): Promise<ApiResponse<Channel>> {
    return this.client.post<ApiResponse<Channel>>(`/channels/${name}/enable`);
  }

  disable(name: string): Promise<ApiResponse<Channel>> {
    return this.client.post<ApiResponse<Channel>>(`/channels/${name}/disable`);
  }
}
