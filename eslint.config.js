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
    // The core must stay transport-independent: only the tool layer, the
    // server module and the entry point may import the MCP SDK.
    files: ['src/domain/**', 'src/providers/**', 'src/infra/**', 'src/security/**', 'src/core/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['@modelcontextprotocol/*'], message: 'Core modules must not import the MCP SDK.' }] },
      ],
    },
  },
);
