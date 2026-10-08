export interface ConnectionParts {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly sslmode: string;
  /** The `POSTGRES_PASSWORD` secret. Never logged, never placed in argv. */
  readonly password: string;
}

/**
 * Assembles the connection string from config `postgres.*` and the secret (DATA-010). Every part
 * is percent-encoded, so a password with `@`, `/` or `:` cannot change the host or database.
 */
export function buildConnectionString(parts: ConnectionParts): string {
  const enc = encodeURIComponent;
  const auth =
    parts.password === '' ? enc(parts.user) : `${enc(parts.user)}:${enc(parts.password)}`;
  const host = parts.host.includes(':') ? `[${parts.host}]` : parts.host;
  return `postgresql://${auth}@${host}:${parts.port}/${enc(parts.database)}?sslmode=${enc(parts.sslmode)}`;
}

/** The connection string with the password replaced, safe for logs and error messages. */
export function redactConnectionString(connectionString: string): string {
  return connectionString.replace(/^(postgres(?:ql)?:\/\/[^:@/]*):[^@]*@/, '$1:***@');
}
