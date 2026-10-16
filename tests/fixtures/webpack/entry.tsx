'use client';
import React from 'react';
import { sql } from '@sqlbraid/sqlite';
import { probe } from './query';
const n: number = 1;
const query = sql`SELECT 1 /*@braid if ${false}*/ , ${(() => { throw new Error('tsx inactive'); })()} /*@braid end*/`;
export const view = <span>{query.render().segments.join('')}{n}</span>;
export const inactive = probe();
export const active = probe({ id: 3 });
