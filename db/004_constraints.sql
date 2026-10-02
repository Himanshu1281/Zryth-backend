-- 004: integrity for the shared-template tables + call deletes.
-- Safe to re-run. Run in the Supabase SQL editor after 002 (and 003 if used).

-- Attachments follow a renamed prompt/tool and disappear with a deleted one
-- (remove orphans first so the constraints can be added)
delete from public.agent_prompts ap where not exists (select 1 from public.prompts p where p.tag = ap.prompt_tag);
delete from public.agent_tools at where not exists (select 1 from public.tools t where t.name = at.tool_name);

alter table public.agent_prompts drop constraint if exists agent_prompts_prompt_tag_fkey;
alter table public.agent_prompts add constraint agent_prompts_prompt_tag_fkey
  foreign key (prompt_tag) references public.prompts(tag) on update cascade on delete cascade;

alter table public.agent_tools drop constraint if exists agent_tools_tool_name_fkey;
alter table public.agent_tools add constraint agent_tools_tool_name_fkey
  foreign key (tool_name) references public.tools(name) on update cascade on delete cascade;

-- Deleting a call takes its transcript and knowledge-gap entries with it
alter table public.messages drop constraint if exists messages_call_id_fkey;
alter table public.messages add constraint messages_call_id_fkey
  foreign key (call_id) references public.calls(id) on delete cascade;

alter table public.knowledge_gaps drop constraint if exists knowledge_gaps_call_id_fkey;
alter table public.knowledge_gaps add constraint knowledge_gaps_call_id_fkey
  foreign key (call_id) references public.calls(id) on delete cascade;

-- Agent knowledge goes with its agent (agents DELETE route relies on this)
alter table public.zryth_knowledge drop constraint if exists zryth_knowledge_agent_id_fkey;
alter table public.zryth_knowledge add constraint zryth_knowledge_agent_id_fkey
  foreign key (agent_id) references public.agents(id) on delete cascade;
