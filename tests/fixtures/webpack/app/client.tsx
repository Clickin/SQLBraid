'use client';
import { useState } from 'react';
import { sql } from 'sqlbraid/sqlite';
export default function Client() {
  const [count, setCount] = useState<number>(0);
  const q = sql`SELECT 1 /*@braid if ${false}*/ , ${(() => { throw new Error('client inactive'); })()} /*@braid end*/`;
  return <button onClick={() => setCount(count + 1)}>client:{count}:{q.render().segments.join('').trim()}</button>;
}
