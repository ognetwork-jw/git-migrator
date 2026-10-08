import type { ReactNode } from 'react';
import { AppShell } from '../../src/shell/app-shell.tsx';

export default function ShellLayout({ children }: { readonly children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
