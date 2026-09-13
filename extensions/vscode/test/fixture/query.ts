import { sql } from "@sqlbraid/template";

type UserRow = { id: number };

export const query = sql.rows<UserRow>`SELECT id FROM public.users`;
