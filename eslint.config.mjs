import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'node_modules/**',
      'dist/**',
      'release/**',
      // 旧原型，仅作历史参考，不纳入 lint
      'OpenCode/**',
      'tools/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      // 解构剔除字段（omit）是常规写法，不应报错
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
);
