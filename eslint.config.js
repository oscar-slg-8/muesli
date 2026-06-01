import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'node_modules/**',
      '**/worktrees/**',
      'build/**',
      'resources/**',
      'python/**',
      '*.config.js',
      '*.config.ts',
      'scripts/**'
    ]
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Main process + preload (Node environment)
  {
    files: ['electron/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node }
    }
  },

  // Renderer (browser environment + React)
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser }
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }]
    }
  },

  // Pragmatic relaxations for a single-author app.
  // no-undef is disabled because TypeScript's compiler already reports
  // undefined identifiers, and ESLint lacks the type information to do so reliably.
  {
    rules: {
      'no-undef': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  },

  prettier
)
