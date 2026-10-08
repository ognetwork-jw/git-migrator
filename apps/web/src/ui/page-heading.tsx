'use client';

import { Typography } from 'antd';
import type { ReactNode } from 'react';

/** The page title (an `h1`). Server pages use this wrapper: antd's compound parts are client-only. */
export function PageHeading({ children }: { readonly children: ReactNode }) {
  return (
    <Typography.Title level={1} className="mb-2 text-2xl">
      {children}
    </Typography.Title>
  );
}

/** Secondary body text under a heading. */
export function PageText({ children }: { readonly children: ReactNode }) {
  return <Typography.Paragraph type="secondary">{children}</Typography.Paragraph>;
}
