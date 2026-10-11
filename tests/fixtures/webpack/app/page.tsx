import { probe } from '../query';
import Client from './client';
import { execute } from './server';
export const dynamic = 'force-dynamic';
export default async function Page() {
  const row = await execute();
  return <main><pre>{JSON.stringify({ inactive: probe(), active: probe({ id: 3 }), row })}</pre><Client /></main>;
}
