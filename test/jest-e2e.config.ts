import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '..',
  testRegex: '.e2e-spec.ts$',
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  testEnvironment: 'node',
  testTimeout: 60000,
  moduleNameMapper: { '^src/(.*)$': '<rootDir>/src/$1' },
};

export default config;
