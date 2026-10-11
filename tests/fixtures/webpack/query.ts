import { sql } from 'sqlbraid/sqlite';

export const marker = 'initial';
export function probe(value?: { id: number }) {
  const events: string[] = [];
  const record = (name: string, n: number) => { events.push(name); return n; };
  const schema = { '~standard': { version: 1 as const, vendor: 'fixture', validate: (_input: unknown) => ({ value: { label: marker } }) } };
  const owner = {
    id: 7,
    make() {
      return sql.rows(schema)`SELECT ${record('first', this.id)}
        /*@braid if ${(events.push('condition'), value !== undefined)}*/
          , ${record('active', value.id)}
        /*@braid end*/
        /*@braid if ${false}*/ , ${(() => { throw new Error('inactive branch'); })()} /*@braid end*/
        , ${record('last', 9)}`;
    },
  };
  const query = owner.make();
  const output: NonNullable<typeof query.__row> = { label: marker };
  // @ts-expect-error The mapper output stays a string after lowering.
  const wrong: NonNullable<typeof query.__row> = { label: 1 };
  void wrong;
  const rendered = query.render();
  query.render();
  return { marker, events, text: rendered.segments.join("?").replace(/\s+/gu, " ").trim(), values: rendered.parameters.map(p => p.value), sameMapper: query.resultSchema === schema, output };
}
