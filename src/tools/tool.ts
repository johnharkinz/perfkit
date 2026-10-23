/**
 * Transport-independent tool definition. Tool modules export one of these;
 * only src/server.ts adapts them to the MCP SDK, so the same tools could be
 * served over another transport later.
 */
import type * as z from 'zod';
import type { AppDeps } from '../app.js';
import type { ErrorInfo } from '../domain/errors.js';
import type { Logger } from '../infra/logger.js';

export interface ToolContext {
  deps: AppDeps;
  /** Logger bound to this call's correlationId. */
  logger: Logger;
  /** Fires when the client cancels the call. */
  signal?: AbortSignal;
  /** When this call started (used as collectedAt). */
  startedAt: Date;
}

export interface ToolDefinition<I extends z.ZodObject = z.ZodObject, O extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  inputSchema: I;
  outputSchema: O;
  /**
   * Produces the result. Expected failures (invalid input, upstream errors)
   * should be returned as `status: "error"` results; anything thrown is
   * passed to `errorResult`.
   */
  run(args: z.infer<I>, ctx: ToolContext): Promise<z.infer<O>>;
  /** Builds this tool's error envelope for an error thrown by `run`. */
  errorResult(args: z.infer<I>, error: ErrorInfo, ctx: ToolContext): z.infer<O>;
}
