/**
 * MCP adapter: the only module (with main.ts) that imports the MCP SDK.
 * Registers every tool definition and turns its result into a CallToolResult
 * with structuredContent plus the same JSON as a text block.
 */
import { McpServer } from '@modelcontextprotocol/server';
import type { AppDeps } from './app.js';
import { toErrorInfo } from './domain/errors.js';
import { cruxCurrentTool } from './tools/crux-current.js';
import { cruxHistoryTool } from './tools/crux-history.js';
import type { ToolContext, ToolDefinition } from './tools/tool.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

// Add new tools here.
const TOOLS: readonly ToolDefinition[] = [
  cruxCurrentTool as unknown as ToolDefinition,
  cruxHistoryTool as unknown as ToolDefinition,
];

export function createServer(deps: AppDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });
  for (const tool of TOOLS) registerTool(server, deps, tool);
  return server;
}

function registerTool(server: McpServer, deps: AppDeps, tool: ToolDefinition): void {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    },
    async (args, mcpCtx) => {
      const startedAt = deps.now();
      const correlationId = deps.newCorrelationId();
      const logger = deps.logger.child({ correlationId, tool: tool.name });
      const ctx: ToolContext = { deps, logger, signal: mcpCtx.mcpReq.signal, startedAt };
      logger.info('tool call started');

      let result: Record<string, unknown>;
      try {
        result = await tool.run(args, ctx);
      } catch (err) {
        const info = toErrorInfo(err);
        logger.error('tool call failed', {
          code: info.code,
          source: info.source,
          ...(info.code === 'internal_error' && err instanceof Error ? { errorName: err.name } : {}),
        });
        result = tool.errorResult(args, info, ctx);
      }

      const status = result['status'];
      logger.info('tool call finished', { status, latencyMs: deps.now().getTime() - startedAt.getTime() });
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
        isError: status === 'error',
      };
    },
  );
}
