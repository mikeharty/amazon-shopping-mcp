import type {
  CallToolResult,
  ReadResourceResult,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import { createMcpHandler } from "mcp-handler";

import type { Owner } from "../../packages/contracts/index.js";
import {
  bearerToken,
  boundedRequest,
  DEFAULT_MAX_REQUEST_BYTES,
  jsonError,
  unauthorizedResponse,
  validateLocalRequest,
  type Authenticate,
} from "./auth.js";

export type GatewayContext = Readonly<{
  owner: Owner;
  request: Request;
}>;

export type ToolDefinition = Readonly<{
  name: string;
  title?: string;
  description?: string;
  inputSchema: StandardSchemaWithJSON;
  outputSchema: StandardSchemaWithJSON;
  annotations: ToolAnnotations;
  handler: (
    input: unknown,
    context: GatewayContext,
  ) => CallToolResult | Promise<CallToolResult>;
}>;

export type ResourceDefinition = Readonly<{
  name: string;
  uri: string;
  title?: string;
  description?: string;
  mimeType?: string;
  handler: (
    uri: URL,
    context: GatewayContext,
  ) => ReadResourceResult | Promise<ReadResourceResult>;
}>;

export type GatewayOptions = Readonly<{
  tools: readonly ToolDefinition[];
  resources?: readonly ResourceDefinition[];
  authenticate: Authenticate;
  allowedHosts?: readonly string[];
  maxRequestBytes?: number;
  serverInfo?: Readonly<{ name: string; version: string }>;
  instructions?: string;
}>;

export function createGateway(
  options: GatewayOptions,
): (request: Request) => Promise<Response> {
  validateDefinitions(options.tools, options.resources ?? []);
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;

  return async (incomingRequest: Request): Promise<Response> => {
    try {
      const localRequestFailure = validateLocalRequest(
        incomingRequest,
        options.allowedHosts,
      );
      if (localRequestFailure) return localRequestFailure;

      if (!bearerToken(incomingRequest)) return unauthorizedResponse();

      let owner: Owner | undefined;
      try {
        owner = await options.authenticate(incomingRequest);
      } catch {
        return unauthorizedResponse();
      }
      if (!owner) return unauthorizedResponse();

      const bounded = await boundedRequest(incomingRequest, maxRequestBytes);
      if (bounded instanceof Response) return bounded;

      const handler = createMcpHandler(
        (server) => {
          const context: GatewayContext = Object.freeze({
            owner,
            request: bounded,
          });

          for (const tool of options.tools) {
            server.registerTool(
              tool.name,
              {
                title: tool.title,
                description: tool.description,
                inputSchema: tool.inputSchema,
                outputSchema: tool.outputSchema,
                annotations: tool.annotations,
              },
              async (input) => {
                try {
                  return await tool.handler(input, context);
                } catch {
                  return {
                    isError: true,
                    content: [{ type: "text", text: "Tool execution failed" }],
                  };
                }
              },
            );
          }

          for (const resource of options.resources ?? []) {
            server.registerResource(
              resource.name,
              resource.uri,
              {
                title: resource.title,
                description: resource.description,
                mimeType: resource.mimeType,
              },
              async (uri) => {
                try {
                  return await resource.handler(uri, context);
                } catch {
                  throw new Error("Resource read failed");
                }
              },
            );
          }
        },
        {
          serverInfo: options.serverInfo ?? {
            name: "amazon-shopping-mcp",
            version: "0.3.0-alpha",
          },
          maxSubscriptions: 0,
          instructions: options.instructions,
        },
      );

      return await handler(bounded);
    } catch {
      return jsonError(500, "Internal server error");
    }
  };
}

function validateDefinitions(
  tools: readonly ToolDefinition[],
  resources: readonly ResourceDefinition[],
): void {
  const toolNames = new Set<string>();
  for (const tool of tools) {
    if (!tool.name || toolNames.has(tool.name))
      throw new TypeError(`Duplicate or empty tool name: ${tool.name}`);
    toolNames.add(tool.name);
  }

  const resourceUris = new Set<string>();
  for (const resource of resources) {
    if (!resource.name || !resource.uri || resourceUris.has(resource.uri)) {
      throw new TypeError(`Duplicate or invalid resource URI: ${resource.uri}`);
    }
    new URL(resource.uri);
    resourceUris.add(resource.uri);
  }
}
