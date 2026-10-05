// Flat ESLint config (ESLint 9). Shared across the monorepo.
// 硬约束：packages/core 是纯逻辑包，禁止任何浏览器 DOM 全局 / DOM 类型运行时访问。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * 浏览器/DOM 运行时全局黑名单。core 包中出现这些即报错。
 * 注意：仅禁运行时全局；core 的 tsconfig 也不引用 DOM lib，类型层面同样不可见。
 */
const BROWSER_RUNTIME_GLOBALS = [
  'window',
  'document',
  'HTMLElement',
  'HTMLDivElement',
  'HTMLSpanElement',
  'HTMLAnchorElement',
  'Node',
  'Element',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'PointerEvent',
  'FocusEvent',
  'CustomEvent',
  'location',
  'navigator',
  'history',
  'localStorage',
  'sessionStorage',
  'IndexedDB',
  'indexedDB',
  'IDBFactory',
  'Blob',
  'File',
  'FileReader',
  'URL',
  'URLSearchParams',
  'fetch',
  'Request',
  'Response',
  'Headers',
  'AbortController',
  'AbortSignal',
  'structuredClone',
  'crypto',
  'console',
]
  .map((name) => ({
    name,
    message: `[core DOM-free] 禁止在 @drawpaper/core 中访问浏览器运行时全局 '${name}'。平台能力必须经由 HostAdapter / StorageAdapter 注入。`,
  }));

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'packages/web/src/components/ui/**', // shadcn 生成代码，不强制 lint
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // ---- Node 构建/校验脚本（*.mjs/*.cjs，如 PWA precache 校验）----
  {
    files: ['**/*.mjs', '**/*.cjs', '**/scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },
  // ---- packages/web: React hooks 规则（仅 web；core 是 DOM-free 纯逻辑，不加载）----
  // 只启用经典两条（rules-of-hooks / exhaustive-deps），不引入 React Compiler 的
  // set-state-in-effect / immutability 等新门禁——后者会要求重写 Wave1 既有组件。
  {
    plugins: { 'react-hooks': reactHooks },
    files: ['packages/web/**/*.{ts,tsx}'],
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  // ---- packages/core: 纯 TS，零 DOM/React/浏览器全局 ----
  {
    files: ['packages/core/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-restricted-globals': ['error', ...BROWSER_RUNTIME_GLOBALS],
      // core 不得出现任何 React / JSX
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'react', message: 'core 禁止依赖 react。' },
            { name: 'react-dom', message: 'core 禁止依赖 react-dom。' },
            { name: '@tiptap/react', message: 'core 不得依赖 @tiptap/*。' },
            { name: '@tiptap/html', message: 'core 不得依赖 @tiptap/*。' },
            { name: 'vite', message: 'core 不得依赖 vite。' },
          ],
        },
      ],
    },
  },
);
