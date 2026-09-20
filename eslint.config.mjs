import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginVue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'

export default defineConfig(
  // `out-*.cjs` is the bundle produced by `npm run smoke`; linting a build
  // artifact only produced thousands of false errors (require(), return types).
  { ignores: ['**/node_modules', '**/dist', '**/out', '**/out-*.cjs', '**/*.log'] },
  tseslint.configs.recommended,
  eslintPluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        },
        extraFileExtensions: ['.vue'],
        parser: tseslint.parser
      }
    }
  },
  {
    files: ['**/*.{ts,mts,tsx,vue}'],
    rules: {
      // TypeScript + vue-tsc handle type checking; no-undef is a false-positive
      // source for type-only identifiers (e.g. the global tunnel API types).
      'no-undef': 'off',
      'vue/require-default-prop': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/block-lang': [
        'error',
        {
          script: {
            lang: 'ts'
          }
        }
      ]
    }
  },
  {
    // `src/core` must stay platform agnostic so the same domain logic runs on
    // desktop, web and mobile. Anything that touches the OS belongs in
    // `src/platforms/*`, behind the ConfigStore / SecretStore / TunnelTransport
    // interfaces.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'fs', message: 'src/core must stay platform agnostic — use ConfigStore.' },
            { name: 'path', message: 'src/core must stay platform agnostic — see ConfigStore.' },
            { name: 'os', message: 'src/core must stay platform agnostic.' },
            { name: 'net', message: 'src/core must stay platform agnostic — use TunnelTransport.' },
            {
              name: 'child_process',
              message: 'src/core must stay platform agnostic — use TunnelTransport.'
            },
            { name: 'string_decoder', message: 'src/core must stay platform agnostic.' },
            { name: 'electron', message: 'src/core must not depend on Electron.' }
          ],
          patterns: [
            { group: ['node:*'], message: 'src/core must stay platform agnostic.' },
            {
              group: ['**/platforms/**', '**/main/**', '**/preload/**'],
              message: 'src/core must not depend on a platform or shell layer.'
            }
          ]
        }
      ]
    }
  },
  eslintConfigPrettier
)
