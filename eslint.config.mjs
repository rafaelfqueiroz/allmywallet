import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import prettier from 'eslint-config-prettier';

/**
 * AR-05: the layering rules in ARCHITECTURE.md §3 are enforced here, not by review.
 * A violation fails CI.
 */

/** Packages `core/` must never see. AR-01: core is plain TypeScript, runnable without a database. */
const FRAMEWORK_PACKAGES = [
  { name: 'next', message: 'AR-01: core/ imports nothing from next/*.' },
  { name: 'react', message: 'AR-01: core/ is framework-free.' },
  { name: 'drizzle-orm', message: 'AR-01: core/ declares ports; adapters/db implements them.' },
  { name: 'pg', message: 'AR-01: core/ never talks to a database driver.' },
  { name: 'pg-boss', message: 'AR-01: core/ never touches the job queue directly.' },
  { name: 'next-auth', message: 'AR-01: core/ never touches the auth framework.' },
  { name: 'next-intl', message: 'AR-44: core/ produces error codes; i18n renders them.' },
];

const FRAMEWORK_PATTERNS = [
  { group: ['next/*', 'next/**'], message: 'AR-01: core/ imports nothing from next/*.' },
  { group: ['drizzle-orm/*'], message: 'AR-01: core/ declares ports; adapters implement them.' },
  { group: ['@/adapters/*', '@/adapters/**'], message: 'AR-01: core/ must not import adapters.' },
  { group: ['@/db/*', '@/db/**'], message: 'AR-01: core/ must not import the database layer.' },
  { group: ['@/app/*', '@/app/**'], message: 'AR-04: core/ must not import the web entrypoint.' },
  { group: ['@/worker/*', '@/worker/**'], message: 'AR-04: core/ must not import the worker.' },
];

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'dist/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'src/db/migrations/**',
      'next-env.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx,mts,mjs}'],
    plugins: { import: importPlugin },
    languageOptions: {
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    settings: {
      'import/resolver': {
        typescript: { alwaysTryTypes: true },
        node: { extensions: ['.ts', '.tsx', '.js', '.jsx'] },
      },
    },
    rules: {
      // DV-02: `any` is banned. `unknown` + a Zod parse is the escape hatch.
      '@typescript-eslint/no-explicit-any': 'error',
      // DV-03: no non-null assertions. If a value can be absent, handle it.
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],

      // DV-14: `@/` alias from src/, never `../../../`.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../../*'],
              message: 'DV-14: use the `@/` alias from src/ instead of a deep relative path.',
            },
          ],
        },
      ],

      // DV-18: no commented-out code — git remembers it.
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],

      // AR-05, named form. Zones are directional: core/ is the protected zone,
      // and adapters/db/app/worker are the callers that may depend on it but not
      // the other way round.
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './src/core',
              from: './src/adapters',
              message: 'AR-01: core/ declares ports; adapters implement them, never the reverse.',
            },
            { target: './src/core', from: './src/db', message: 'AR-01: core/ has no database.' },
            {
              target: './src/core',
              from: './src/app',
              message: 'AR-04: core/ is entrypoint-free.',
            },
            {
              target: './src/core',
              from: './src/worker',
              message: 'AR-04: core/ is entrypoint-free.',
            },
            {
              target: './src/adapters',
              from: './src/app',
              message: 'AR-04: adapters are below the entrypoints.',
            },
            {
              target: './src/adapters',
              from: './src/worker',
              message: 'AR-04: adapters are below the entrypoints.',
            },
          ],
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // AR-01 — the boundary that keeps the calculation engine testable without a database.
  // ---------------------------------------------------------------------------
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: FRAMEWORK_PACKAGES, patterns: FRAMEWORK_PATTERNS },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // AR-04 — app/ and worker/ are thin. Business rules live in core/.
  // Adapters may not reach into the web or worker entrypoints either.
  // ---------------------------------------------------------------------------
  {
    files: ['src/adapters/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/app/*', '@/app/**'],
              message: 'AR-04: adapters must not import the web entrypoint.',
            },
            {
              group: ['@/worker/*', '@/worker/**'],
              message: 'AR-04: adapters must not import the worker entrypoint.',
            },
          ],
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // AR-06/AR-08 — money never becomes a JS number. Domain code uses Money, not
  // Decimal directly, and never the float-producing built-ins.
  // ---------------------------------------------------------------------------
  {
    files: ['src/core/**/*.ts', 'src/adapters/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message: 'AR-06: money is never a JS number. Use Money.fromString / Decimal.',
        },
        {
          name: 'parseInt',
          message: 'AR-06: parse quantities through Money/Decimal, not parseInt.',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Number',
          property: 'parseFloat',
          message: 'AR-06: money is never a JS number.',
        },
        {
          object: 'Math',
          property: 'round',
          message: 'AR-09: rounding happens only at display, in the i18n formatter.',
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // SPEC-001 BR-001-08 / SPEC-003 BR-003-04 — tenant identity comes from the
  // authenticated session (src/lib/session.ts's requireUserId()) only. A
  // user/tenant id read out of a request body, query string, params or
  // header anywhere else is a security defect, not a style issue — this is
  // the mechanical backstop for that rule, scoped to the layers that
  // actually see request input (app/ and adapters/) and excluding
  // session.ts itself, which is the one sanctioned place this pattern is
  // allowed to appear (it reads `session.user.id`, not request input, but is
  // excluded so the rule never has to special-case its own source).
  // ---------------------------------------------------------------------------
  {
    files: ['src/app/**/*.{ts,tsx}', 'src/adapters/**/*.ts', 'src/worker/**/*.ts'],
    ignores: ['src/lib/session.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'MemberExpression[object.name=/^(body|params|query|input|searchParams|req|request)$/i][property.name=/^(userId|user_id)$/i]',
          message:
            'BR-001-08: tenant id must come from requireUserId() (src/lib/session.ts), never read directly from request input.',
        },
        {
          selector:
            'VariableDeclarator[init.name=/^(body|params|query|input|searchParams|req|request)$/i] Property[key.name=/^(userId|user_id)$/i]',
          message:
            'BR-001-08: tenant id must come from requireUserId() (src/lib/session.ts), never destructured from request input.',
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // AR-35 / AR-44 — components hold no business logic and no string literals.
  // ---------------------------------------------------------------------------
  {
    files: ['src/app/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'decimal.js',
              message:
                'AR-35: a component that computes a portfolio figure is a defect. Compute in core/.',
            },
          ],
          patterns: [
            {
              group: ['@/db/*', '@/db/**'],
              message:
                'AR-31: Server Components call use cases in core/, not the database directly.',
            },
          ],
        },
      ],
      // SPEC-016 AR-44/BR-016-17 — TESTING §6's "static check: no string
      // literals in components." Flags a JSX text node containing a letter
      // (Latin or accented pt-BR), which is what next-intl's `t(...)` should
      // have produced instead — whitespace-only text nodes (indentation
      // between elements) are unaffected, and non-JSX string literals
      // (`className`, `href`, config keys used as map lookups) are
      // deliberately out of scope, since those are not user-facing prose.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXText[value=/[A-Za-zÀ-ÿ]/]',
          message:
            'AR-44: no string literals in components — route user-facing text through next-intl.',
        },
      ],
    },
  },

  // Tests may reach further than production code — fakes, fixtures and harnesses
  // legitimately cross layers.
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'tests/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-console': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // Config files at the repo root run in Node and legitimately read process.env.
  {
    files: ['*.config.ts', '*.config.mts', '*.config.mjs', 'scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },

  prettier,
);
