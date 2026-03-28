// Agent Skill/Plugin System — dynamic tool loading from skill directories

import { readFileSync, readdirSync, existsSync, statSync, watch } from 'fs';
import { resolve, join } from 'path';
import { parse as parseYaml } from 'yaml';
import { logger } from '../shared/logger';
import { toolRegistry } from '../tools/registry';
import type { ToolDefinition } from '../shared/types';

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  /** Tools provided by this skill (file names without extension) */
  tools: string[];
  /** Dependencies on other skills */
  depends?: string[];
  /** Config schema for user-provided settings */
  configSchema?: Record<string, unknown>;
  /** Default config values */
  defaultConfig?: Record<string, unknown>;
}

interface LoadedSkill {
  manifest: SkillManifest;
  dir: string;
  tools: Map<string, ToolDefinition>;
  enabled: boolean;
  loadedAt: number;
  config: Record<string, unknown>;
}

class SkillManager {
  private skillsDir: string;
  private skills = new Map<string, LoadedSkill>();
  private watchers: Array<ReturnType<typeof watch>> = [];
  private config: Record<string, Record<string, unknown>> = {}; // skillName -> config overrides

  constructor(skillsDir?: string) {
    this.skillsDir = skillsDir || resolve(process.cwd(), 'skills');
  }

  /** Set config overrides for a skill */
  setSkillConfig(skillName: string, config: Record<string, unknown>): void {
    this.config[skillName] = config;
    const loaded = this.skills.get(skillName);
    if (loaded) {
      loaded.config = { ...loaded.manifest.defaultConfig, ...config };
    }
  }

  /** Load all skills from the skills directory */
  async loadAll(): Promise<void> {
    if (!existsSync(this.skillsDir)) {
      logger.warn({ dir: this.skillsDir }, 'Skills directory not found');
      return;
    }

    const entries = readdirSync(this.skillsDir).filter((f) => {
      const full = join(this.skillsDir, f);
      return statSync(full).isDirectory();
    });

    for (const entry of entries) {
      await this.loadSkill(entry);
    }

    logger.info({ count: this.skills.size, dir: this.skillsDir }, 'Skills loaded');
  }

  /** Load a single skill by directory name */
  async loadSkill(dirName: string): Promise<boolean> {
    const skillDir = join(this.skillsDir, dirName);
    const manifestPath = join(skillDir, 'manifest.yaml');

    if (!existsSync(manifestPath)) {
      logger.warn({ skill: dirName }, 'No manifest.yaml found, skipping');
      return false;
    }

    try {
      const raw = readFileSync(manifestPath, 'utf-8');
      const manifest = parseYaml(raw) as SkillManifest;

      if (!manifest.name || !manifest.tools) {
        logger.warn({ skill: dirName }, 'Invalid manifest: missing name or tools');
        return false;
      }

      // Check dependencies
      if (manifest.depends) {
        for (const dep of manifest.depends) {
          if (!this.skills.has(dep)) {
            logger.warn({ skill: manifest.name, dependency: dep }, 'Missing dependency');
            return false;
          }
        }
      }

      const skillConfig = { ...manifest.defaultConfig, ...(this.config[manifest.name] || {}) };
      const loaded: LoadedSkill = {
        manifest,
        dir: skillDir,
        tools: new Map(),
        enabled: true,
        loadedAt: Date.now(),
        config: skillConfig,
      };

      // Load tool definitions from skill tools
      for (const toolName of manifest.tools) {
        try {
          const tool = await this.loadTool(skillDir, toolName, skillConfig);
          if (tool) {
            loaded.tools.set(tool.name, tool);
          }
        } catch (err) {
          logger.error({ skill: manifest.name, tool: toolName, error: (err as Error).message }, 'Failed to load skill tool');
        }
      }

      this.skills.set(manifest.name, loaded);
      logger.info({ skill: manifest.name, tools: loaded.tools.size }, 'Skill loaded');
      return true;
    } catch (err) {
      logger.error({ skill: dirName, error: (err as Error).message }, 'Failed to load skill');
      return false;
    }
  }

  /** Load a tool from a skill directory */
  private async loadTool(
    skillDir: string,
    toolName: string,
    config: Record<string, unknown>,
  ): Promise<ToolDefinition | null> {
    const toolPath = join(skillDir, `${toolName}.ts`);
    if (!existsSync(toolPath)) {
      logger.warn({ tool: toolName, dir: skillDir }, 'Tool file not found');
      return null;
    }

    try {
      // Dynamic import of the tool module
      const module = await import(toolPath);
      const toolDef: ToolDefinition = module.default || module[toolName];

      if (!toolDef || !toolDef.name || !toolDef.execute) {
        logger.warn({ tool: toolName }, 'Tool module does not export a valid ToolDefinition');
        return null;
      }

      // Inject config into tool if it has a configure method
      if (typeof (toolDef as any).configure === 'function') {
        (toolDef as any).configure(config);
      }

      return toolDef;
    } catch (err) {
      logger.error({ tool: toolName, error: (err as Error).message }, 'Failed to import tool');
      return null;
    }
  }

  /** Register all loaded skill tools with the tool registry */
  registerAll(): void {
    for (const [skillName, skill] of this.skills) {
      if (!skill.enabled) continue;
      for (const [toolName, tool] of skill.tools) {
        try {
          toolRegistry.register(tool);
        } catch (err) {
          // Tool already registered (from builtin or another skill)
          logger.warn({ tool: toolName, skill: skillName }, 'Tool already registered, skipping');
        }
      }
    }
  }

  /** Get a loaded skill */
  get(name: string): LoadedSkill | undefined {
    return this.skills.get(name);
  }

  /** List all skills */
  list(): Array<{ name: string; version: string; description: string; toolCount: number; enabled: boolean }> {
    return [...this.skills.values()].map((s) => ({
      name: s.manifest.name,
      version: s.manifest.version,
      description: s.manifest.description,
      toolCount: s.tools.size,
      enabled: s.enabled,
    }));
  }

  /** Enable/disable a skill */
  setEnabled(name: string, enabled: boolean): boolean {
    const skill = this.skills.get(name);
    if (!skill) return false;
    skill.enabled = enabled;

    if (enabled) {
      // Register tools
      for (const [toolName, tool] of skill.tools) {
        try { toolRegistry.register(tool); } catch { /* already registered */ }
      }
    } else {
      // Note: current ToolRegistry doesn't support unregistering
      logger.warn({ skill: name }, 'Skill disabled but tools remain registered (unregister not supported)');
    }

    return true;
  }

  /** Reload a skill (hot reload) */
  async reload(name: string): Promise<boolean> {
    const skill = this.skills.get(name);
    if (!skill) return false;
    const dirName = skill.dir.split('/').pop()!;
    this.skills.delete(name);
    return this.loadSkill(dirName);
  }

  /** Watch skills directory for changes and auto-reload */
  watch(): void {
    if (!existsSync(this.skillsDir)) return;

    const watcher = watch(this.skillsDir, { recursive: true }, (event, filename) => {
      if (!filename) return;
      // Find which skill this belongs to
      const skillName = filename.split('/')[0];
      if (skillName && this.skills.has(skillName)) {
        logger.info({ skill: skillName, file: filename }, 'Skill file changed, reloading');
        this.reload(skillName).catch((err) => {
          logger.error({ skill: skillName, error: (err as Error).message }, 'Failed to reload skill');
        });
      }
    });

    this.watchers.push(watcher);
    logger.info('Watching skills directory for changes');
  }

  /** Stop watching */
  stopWatching(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }
}

export const skillManager = new SkillManager();
