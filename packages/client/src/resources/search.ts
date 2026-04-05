import type { AnorionClient } from "../client.js";
import type { ApiResponse, SearchFilters, SearchResult } from "../types.js";

export class SearchResource {
  constructor(private readonly client: AnorionClient) {}

  query(q: string, filters?: SearchFilters): Promise<ApiResponse<SearchResult[]>> {
    return this.client.post<ApiResponse<SearchResult[]>>("/search", { q, ...filters });
  }
}
