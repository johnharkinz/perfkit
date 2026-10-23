import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // stdout is reserved for MCP protocol traffic; log through infra/logger.
      'no-console': ['error', { allow: ['error'] }],
    },
  },
  {
    // The core (including tool definitions) must stay transport-independent:
    // only the MCP adapter and stdio startup may import the MCP SDK.
    files: ['src/**/*.ts'],
    ignores: ['src/server.ts', 'src/start.ts', 'src/main.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['@modelcontextprotocol/*'], message: 'Core modules must not import the MCP SDK.' }] },
      ],
    },
  },
);
