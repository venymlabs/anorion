# Anorion

An extensible agentic framework built with [Bun](https://bun.com).

Anorion provides a gateway for running AI agents with multi-channel support (Telegram, and more), persistent memory, scheduled tasks, and agent-to-agent bridging.

## Features

- **Agent Runtime** — Spin up agents with configurable models, timeouts, and sub-agent support
- **Multi-Channel** — Telegram integration out of the box, extensible to any platform
- **Persistent Memory** — File-based memory provider for agent context across sessions
- **Scheduler** — Cron-based task scheduling for automated agent workflows
- **Bridge Protocol** — Peer-to-peer agent communication across instances
- **Plugin System** — Extensible architecture for custom tools and skills

## Quick Start

```bash
# Install dependencies
bun install

# Copy environment template
cp .env.example .env

# Edit .env with your keys
# Run the gateway
bun run index.ts
```

## Configuration

Anorion is configured via `anorion.yaml`. Copy and customize:

```yaml
gateway:
  host: 0.0.0.0
  port: 4250
  apiKeys:
    - name: admin
      key: ${ANORION_ADMIN_KEY}
      scopes: ["*"]
  database: ./data/anorion.db

agents:
  dir: ./agents
  defaultModel: zai/glm-5
  defaultTimeoutMs: 120000
  maxSubagents: 5

channels:
  telegram:
    enabled: true
    botToken: ${TELEGRAM_BOT_TOKEN}
    allowedUsers:
      - ${TELEGRAM_ALLOWED_USER_ID}
```

See `.env.example` for all required environment variables.

## Architecture

```
anorion/
├── src/
│   ├── agents/       # Agent definitions and runtime
│   ├── bridge/       # Peer-to-peer agent bridge
│   ├── channels/     # Platform integrations (Telegram, etc.)
│   ├── gateway/      # HTTP API gateway
│   ├── llm/          # LLM provider abstractions
│   ├── memory/       # Persistent memory providers
│   ├── plugins/      # Plugin system
│   ├── scheduler/    # Cron-based task scheduler
│   ├── shared/       # Shared utilities
│   └── tools/        # Built-in tools
├── agents/           # Agent configuration files
├── skills/           # Agent skills
├── data/             # Runtime data (gitignored)
└── ui/               # Web UI components
```

## Requirements

- [Bun](https://bun.com) v1.3.10+

## License

MIT
