-- 005: stop the old Edge Function ingest.
-- pdf_ingest_trigger called the `ingest-pdf` Edge Function on every storage upload. It wrote
-- fixed-size chunks with no agent_id and no chunker tag (e.g. rows 391–405), racing the real
-- ingest (backend -> agent /internal/knowledge/ingest). The agent is now the only writer.
drop trigger if exists pdf_ingest_trigger on storage.objects;

-- Backstop for files deleted straight from the Storage UI: drop that file's chunks.
-- Was `metadata::text LIKE '%' || name || '%'`, which treated "_" as a wildcard, matched
-- substrings of other files' names and scanned every row. Now: exact source match.
create or replace function public.handle_storage_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.zryth_knowledge where metadata->>'source' = old.name;
  return old;
end;
$$;

-- Makes that delete (and the agent's lookups by source) an index lookup
create index if not exists zryth_knowledge_source_idx on public.zryth_knowledge ((metadata->>'source'));
