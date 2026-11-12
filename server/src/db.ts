import postgres from 'postgres';
import { config } from './config.js';

export type Sql = postgres.Sql;

export function createDb(url = config.databaseUrl): Sql {
  return postgres(url, {
    max: 10,
    onnotice: () => {},
    transform: { undefined: null },
  });
}
