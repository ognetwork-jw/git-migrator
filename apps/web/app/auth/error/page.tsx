import messages from '../../../messages/en.json' with { type: 'json' };
import { AuthErrorView } from '../../../src/auth/auth-error-view.tsx';
import { resolveAuthErrorCode } from '../../../src/auth/paths.ts';

export default async function AuthErrorPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly error?: string }>;
}) {
  const { error } = await searchParams;
  const code = resolveAuthErrorCode(error, Object.keys(messages.auth.error));
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <AuthErrorView code={code} />
    </main>
  );
}
