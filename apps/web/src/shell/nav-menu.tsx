'use client';

import {
  ApartmentOutlined,
  AuditOutlined,
  BranchesOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  FilterOutlined,
  GlobalOutlined,
  KeyOutlined,
  MailOutlined,
  PartitionOutlined,
  TableOutlined,
  TagsOutlined,
  TeamOutlined,
  UserSwitchOutlined,
} from '@ant-design/icons';
import { Menu, type MenuProps } from 'antd';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { itemForPath, type ShellActor, visibleSections } from './navigation.ts';

const ICONS: Readonly<Record<string, ReactNode>> = {
  dashboard: <DashboardOutlined />,
  repositories: <DatabaseOutlined />,
  waves: <PartitionOutlined />,
  endpoints: <GlobalOutlined />,
  identities: <UserSwitchOutlined />,
  teams: <TeamOutlined />,
  invitations: <MailOutlined />,
  naming: <TagsOutlined />,
  webhookAllowlist: <FilterOutlined />,
  overlays: <BranchesOutlined />,
  capabilities: <TableOutlined />,
  actors: <KeyOutlined />,
  audit: <AuditOutlined />,
};

// Keeps icons for ids a later task adds from breaking the menu.
const FALLBACK_ICON: ReactNode = <ApartmentOutlined />;

/** The sidebar sections of UI-010, limited to what the Actor's role can use. */
export function NavMenu({
  actor,
  onNavigate,
}: {
  readonly actor: ShellActor;
  readonly onNavigate?: () => void;
}) {
  const t = useTranslations('nav');
  const label = useTranslations('shell');
  const pathname = usePathname();
  const selected = itemForPath(pathname)?.id;
  const items: MenuProps['items'] = visibleSections(actor).map((section) => ({
    type: 'group' as const,
    key: section.id,
    label: t(`section.${section.id}`),
    children: section.items.map((item) => ({
      key: item.id,
      icon: ICONS[item.id] ?? FALLBACK_ICON,
      label: (
        <Link href={item.href} onClick={onNavigate}>
          {t(`item.${item.id}`)}
        </Link>
      ),
    })),
  }));
  return (
    <nav aria-label={label('navigation')}>
      <Menu
        mode="inline"
        items={items}
        selectedKeys={selected === undefined ? [] : [selected]}
        className="border-e-0"
      />
    </nav>
  );
}
