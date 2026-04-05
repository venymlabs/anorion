import type { AnorionClient } from "../client.js";
import type { HealthStatus } from "../types.js";

export class HealthResource {
  constructor(private readonly client: AnorionClient) {}

  check(): Promise<HealthStatus> {
    return this.client.get<HealthStatus>("/health");
  }
}
