module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.spec.ts'],
  testTimeout: 30000,
  setupFiles: ['<rootDir>/tests/setupEnv.ts'],
};
