import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Callout } from '../design/Callout.tsx';
import { PageHeader } from '../design/PageHeader.tsx';
import { ROUTES } from './routes.ts';

export function NotFoundPage(): ReactNode {
  return (
    <>
      <PageHeader title="Sayfa bulunamadı" />
      <Callout tone="warning">
        İstenen adres bu konsolda tanımlı değil. <Link to={ROUTES.overview}>Genel bakışa dön</Link>.
      </Callout>
    </>
  );
}
