// Zod-Validated Tool Builder
// Creates tools with Zod schemas, auto-generates JSON Schema for AI SDK compatibility,
// and registers them into the existing toolRegistry.

import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from '../shared/types';
import { toolRegistry } from './registry';
import { logger } from '../shared/logger';

// Zod v4 compatibility: zod v4 uses toJsonSchema, v3 uses zodToJsonSchema
// We'll do manual conversion for maximum compatibility

function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // Use the built-in toJsonSchema if available (zod v4), otherwise manual
  if (typeof (schema as any).toJsonSchema === 'function') {
    return (schema as any).toJsonSchema();
  }
  // Fallback: basic conversion for common types
  return zodSchemaToJson(schema);
}

function zodSchemaToJson(schema: z.ZodType): Record<string, unknown> {
  const def = (schema as any)._def;
  if (!def) return { type: 'object' };

  switch (def.typeName) {
    case 'ZodObject': {
      const shape = def.shape();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodSchemaToJson(value as z.ZodType);
        if (!(value as any).isOptional) {
          required.push(key);
        }
      }
      return {
        type: 'object',
        properties,
        required: required.length > 0 ? required : undefined,
      };
    }
    case 'ZodString':
      return {
        type: 'string',
        description: def.description,
      };
    case 'ZodNumber':
      return {
        type: 'number',
        description: def.description,
      };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodArray':
      return {
        type: 'array',
        items: zodSchemaToJson(def.type),
      };
    case 'ZodEnum':
      return { type: 'string', enum: def.values };
    case 'ZodOptional':
      return zodSchemaToJson(def.innerType);
    case 'ZodDefault':
      const inner = zodSchemaToJson(def.innerType);
      if (def.defaultValue !== undefined) {
        (inner as any).default = typeof def.defaultValue === 'function' ? def.defaultValue() : def.defaultValue;
      }
      return inner;
    case 'ZodLiteral':
      return { type: 'string', const: def.value };
    case 'ZodUnion':
      return { oneOf: def.options.map((o: z.ZodType) => zodSchemaToJson(o)) };
    case 'ZodRecord':
      return {
        type: 'object',
        additionalProperties: zodSchemaToJson(def.valueType),
      };
    default:
      return { type: 'string' };
  }
}

export interface ZodToolDefinition<
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> {
  name: string;
  description: string;
  inputSchema: TInput;
  outputSchema?: TOutput;
  execute: (input: z.infer<TInput>, ctx: ToolContext) => Promise<z.infer<TOutput>>;
  beforeExecute?: (input: z.infer<TInput>, ctx: ToolContext) => Promise<void>;
  afterExecute?: (output: z.infer<TOutput>, ctx: ToolContext) => Promise<void>;
  onError?: (error: Error, input: z.infer<TInput>, ctx: ToolContext) => Promise<void>;
  category?: string;
  timeoutMs?: number;
  cacheable?: boolean;
  cacheTtlMs?: number;
}

/**
 * Create a Zod-validated tool and register it in the toolRegistry.
 * Returns the ToolDefinition for backward compatibility.
 */
export function createTool<
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
>(def: ZodToolDefinition<TInput, TOutput>): ToolDefinition {
  const parameters = zodToJsonSchema(def.inputSchema);

  const toolDef: ToolDefinition = {
    name: def.name,
    description: def.description,
    parameters,
    category: def.category,
    timeoutMs: def.timeoutMs,
    cacheable: def.cacheable,
    cacheTtlMs: def.cacheTtlMs,
    execute: async (params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
      // Validate input with Zod
      const parsed = def.inputSchema.safeParse(params);
      if (!parsed.success) {
        const errorMsg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        logger.warn({ tool: def.name, errors: errorMsg }, 'Tool input validation failed');
        return { content: '', error: `Validation error: ${errorMsg}` };
      }

      const validatedInput = parsed.data;

      // beforeExecute hook
      if (def.beforeExecute) {
        try {
          await def.beforeExecute(validatedInput, ctx);
        } catch (err) {
          logger.warn({ tool: def.name, error: (err as Error).message }, 'beforeExecute hook failed');
        }
      }

      try {
        const result = await def.execute(validatedInput, ctx);

        // Validate output if schema provided
        if (def.outputSchema) {
          const outputParsed = def.outputSchema.safeParse(result);
          if (!outputParsed.success) {
            logger.warn({ tool: def.name, errors: outputParsed.error.message }, 'Tool output validation failed');
          }
        }

        // afterExecute hook
        if (def.afterExecute) {
          try {
            await def.afterExecute(result, ctx);
          } catch (err) {
            logger.warn({ tool: def.name, error: (err as Error).message }, 'afterExecute hook failed');
          }
        }

        return {
          content: typeof result === 'string' ? result : JSON.stringify(result),
          metadata: def.outputSchema ? { validated: true } : undefined,
        };
      } catch (err) {
        // onError hook
        if (def.onError) {
          try {
            await def.onError(err as Error, validatedInput, ctx);
          } catch {}
        }
        return { content: '', error: (err as Error).message };
      }
    },
  };

  // Register into the global registry
  toolRegistry.register(toolDef);

  return toolDef;
}
