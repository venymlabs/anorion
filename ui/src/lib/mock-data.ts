import type { AgentSummary, SessionSummary, ToolSummary, CronJob, ActivityEvent, GatewayStatus } from '@/api/types'

export const mockGatewayStatus: GatewayStatus = {
  id: 'gw-bangkok-1',
  uptime: 1234567,
  version: '0.1.0-alpha',
  agentCount: 5,
  activeSessions: 23,
  status: 'healthy',
  cpu: 12,
  memory: 847,
  errors1h: 2,
}

export const mockAgents: AgentSummary[] = [
  { id: 'trader', name: 'Vex Capital', status: 'active', model: 'claude-sonnet-4-20250514', activeSessions: 3, tokensToday: 142000, lastActive: '2026-03-15T13:22:00Z', tags: ['trading'] },
  { id: 'hermes', name: 'Hermes', status: 'active', model: 'claude-sonnet-4-20250514', activeSessions: 5, tokensToday: 28000, lastActive: '2026-03-15T13:20:00Z', tags: ['communication'] },
  { id: 'coder', name: 'Coder', status: 'idle', model: 'openai/gpt-4o', activeSessions: 1, tokensToday: 67000, lastActive: '2026-03-15T13:19:00Z', tags: ['coding'] },
  { id: 'research', name: 'Research', status: 'suspended', model: 'claude-sonnet-4-20250514', activeSessions: 0, tokensToday: 0, lastActive: '2026-03-14T18:00:00Z', tags: ['research'] },
  { id: 'archiver', name: 'Archiver', status: 'error', model: 'openai/gpt-4o', activeSessions: 0, tokensToday: 5200, lastActive: '2026-03-15T12:00:00Z', tags: ['automation'] },
]

export const mockSessions: SessionSummary[] = [
  { id: 'trader:dm:12345', agentId: 'trader', agentName: 'Vex Capital', status: 'active', messageCount: 892, tokens: 142000, createdAt: '2026-03-01T00:00:00Z', lastActive: '2026-03-15T13:22:00Z' },
  { id: 'hermes:dm:67890', agentId: 'hermes', agentName: 'Hermes', status: 'active', messageCount: 234, tokens: 28000, createdAt: '2026-03-13T00:00:00Z', lastActive: '2026-03-15T13:20:00Z' },
  { id: 'coder:dm:11111', agentId: 'coder', agentName: 'Coder', status: 'idle', messageCount: 56, tokens: 67000, createdAt: '2026-03-15T05:00:00Z', lastActive: '2026-03-15T13:19:00Z' },
  { id: 'trader:dm:22222', agentId: 'trader', agentName: 'Vex Capital', status: 'active', messageCount: 45, tokens: 12000, createdAt: '2026-03-15T10:00:00Z', lastActive: '2026-03-15T13:10:00Z' },
]

export const mockTools: ToolSummary[] = [
  { name: 'hyperliquid.get_positions', description: 'Get current open positions on Hyperliquid', category: 'trading', boundAgents: ['trader'] },
  { name: 'hyperliquid.get_price', description: 'Get token price from Hyperliquid', category: 'trading', boundAgents: ['trader'] },
  { name: 'coingecko.price', description: 'Get cryptocurrency prices from CoinGecko', category: 'market-data', boundAgents: ['trader', 'hermes'] },
  { name: 'web.search', description: 'Search the web using Brave Search', category: 'external', boundAgents: ['trader', 'hermes', 'coder', 'research'] },
  { name: 'web.fetch', description: 'Fetch and extract content from a URL', category: 'external', boundAgents: ['trader', 'research'] },
  { name: 'shell.exec', description: 'Execute shell commands', category: 'system', boundAgents: ['coder'] },
  { name: 'file.read', description: 'Read file contents', category: 'system', boundAgents: ['coder', 'research'] },
  { name: 'file.write', description: 'Write content to files', category: 'system', boundAgents: ['coder'] },
]

export const mockJobs: CronJob[] = [
  { id: '1', name: 'Morning Checkin', agentId: 'trader', agentName: 'Vex Capital', schedule: '0 10 * * *', enabled: true, status: 'idle', lastRun: '2026-03-15T10:00:00Z', nextRun: '2026-03-16T10:00:00Z', task: { type: 'message', text: 'Good morning! Check portfolio and send summary.' } },
  { id: '2', name: 'Daily Audit', agentId: 'trader', agentName: 'Vex Capital', schedule: '0 1 * * *', enabled: true, status: 'idle', lastRun: '2026-03-15T01:00:00Z', nextRun: '2026-03-16T01:00:00Z', task: { type: 'message', text: 'Run daily trading audit.' } },
  { id: '3', name: 'Weekly Review', agentId: 'trader', agentName: 'Vex Capital', schedule: '0 10 * * 5', enabled: true, status: 'idle', lastRun: '2026-03-14T10:00:00Z', nextRun: '2026-03-21T10:00:00Z', task: { type: 'message', text: 'Generate weekly performance review.' } },
  { id: '4', name: 'Price Alerts', agentId: 'trader', agentName: 'Vex Capital', schedule: '*/30 * * * *', enabled: false, status: 'idle', lastRun: '2026-03-14T22:00:00Z', task: { type: 'message', text: 'Check price alerts.' } },
]

export const mockActivity: ActivityEvent[] = [
  { id: '1', timestamp: '2026-03-15T13:22:00Z', type: 'message', agentId: 'trader', agentName: 'Vex Capital', description: 'Sent trade alert to Telegram' },
  { id: '2', timestamp: '2026-03-15T13:21:00Z', type: 'tool_call', agentId: 'trader', agentName: 'Vex Capital', description: 'tool:hyperliquid.get_positions (42ms)' },
  { id: '3', timestamp: '2026-03-15T13:20:00Z', type: 'message', agentId: 'hermes', agentName: 'Hermes', description: 'New session from Discord #general' },
  { id: '4', timestamp: '2026-03-15T13:19:00Z', type: 'error', agentId: 'coder', agentName: 'Coder', description: 'Model fallback: gpt-4o (429)' },
  { id: '5', timestamp: '2026-03-15T13:18:00Z', type: 'spawn', agentId: 'trader', agentName: 'Vex Capital', description: 'Spawned sub-agent: research-child-1' },
  { id: '6', timestamp: '2026-03-15T13:15:00Z', type: 'message', description: 'User: "What\'s the ETH price?" via Telegram' },
  { id: '7', timestamp: '2026-03-15T13:10:00Z', type: 'cron', description: 'Cron: morning-checkin ran (success)' },
  { id: '8', timestamp: '2026-03-15T13:05:00Z', type: 'tool_call', agentId: 'coder', agentName: 'Coder', description: 'tool:shell.exec — git pull (1.2s)' },
]
