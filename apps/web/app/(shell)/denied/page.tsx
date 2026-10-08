import { DeniedView } from '../../../src/shell/denied-view.tsx';

export default async function DeniedPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly required?: string }>;
}) {
  const { required } = await searchParams;
  return <DeniedView required={required} />;
}
