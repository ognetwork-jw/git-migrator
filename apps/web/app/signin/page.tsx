import { safeNextPath } from '../../src/auth/paths.ts';
import { SignInPanel } from '../../src/auth/signin-panel.tsx';
import { loadWebSettings } from '../../src/server/settings.ts';

/** Reads the configuration on every request: the test form depends on the deployment's settings. */
export const dynamic = 'force-dynamic';

export default async function SignInPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly next?: string }>;
}) {
  const { next } = await searchParams;
  const { testSignIn } = loadWebSettings();
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <SignInPanel next={safeNextPath(next)} testSignIn={testSignIn} />
    </main>
  );
}
