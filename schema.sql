-- ================================================================
-- NOVA COMUNIDAD — esquema Supabase (V1)
--
-- Cómo usarlo:
--   1. Crear un proyecto nuevo en supabase.com
--   2. Authentication > Sign In / Providers > habilitar "Anonymous Sign-Ins"
--   3. SQL Editor > pegar este archivo completo > Run
--   4. Storage > confirmar que se creó el bucket "event-media" (lo crea este script)
--   5. Project Settings > API > copiar "Project URL" y "anon public key"
--      y pegarlos en js/config.js del proyecto de la app
--
-- Idempotente: se puede volver a correr sin romper nada si ya existe
-- (usa IF NOT EXISTS / ON CONFLICT donde corresponde).
-- ================================================================

create extension if not exists pgcrypto;

-- ================================================================
-- TABLAS
-- ================================================================

create table if not exists events (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique not null,                 -- identifica al evento en la URL (?event=martina-2026)
  host_token    text not null default encode(gen_random_bytes(9), 'base64'), -- secreto del link del panel de anfitrión
  name          text not null,                         -- ej. "Cumpleaños de Martina"
  honoree_name  text,                                   -- "Martina"
  event_type    text,                                   -- infantil | baby-shower | casamiento | 15-anos
  event_date    date,
  event_time    time,
  cover_url     text,
  message       text,                                   -- "Bienvenidos a mi fiesta"
  status        text not null default 'draft' check (status in ('draft','live','archived')),
  plan_tier     text default 'premium',
  created_at    timestamptz not null default now()
);

create table if not exists event_settings (
  event_id            uuid primary key references events(id) on delete cascade,
  who_can_post        text not null default 'all' check (who_can_post in ('all','approved_only','admin_only')),
  require_approval    boolean not null default false,
  who_can_view_album   text not null default 'all_members',
  location_text       text,
  map_url             text,
  dress_code          text,
  gift_info           text,
  contact_info         text
);

create table if not exists event_members (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references events(id) on delete cascade,
  user_id       uuid not null,                          -- auth.uid() de la sesión anónima del invitado
  role          text not null default 'guest' check (role in ('owner','coadmin','guest')),
  display_name  text not null,
  avatar_url    text,
  relation      text,                                   -- "Tía", "Familia Gómez" (opcional)
  rsvp_status   text not null default 'pending' check (rsvp_status in ('yes','no','maybe','pending')),
  guest_count   int not null default 0,
  blocked       boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (event_id, user_id)
);

create table if not exists posts (
  id                uuid primary key default gen_random_uuid(),
  event_id          uuid not null references events(id) on delete cascade,
  author_member_id  uuid not null references event_members(id) on delete cascade,
  type              text not null check (type in ('photo','video','text')),
  caption           text,
  status            text not null default 'approved' check (status in ('pending','approved','rejected','hidden')),
  created_at        timestamptz not null default now()
);

create table if not exists media (
  id             uuid primary key default gen_random_uuid(),
  post_id        uuid not null references posts(id) on delete cascade,
  url            text not null,
  thumbnail_url  text,
  media_type     text not null check (media_type in ('image','video')),
  width          int,
  height         int,
  size_bytes     bigint
);

-- Tabla lista desde V1; la interfaz de comentarios llega en V2 (ver documento de producto).
create table if not exists comments (
  id                uuid primary key default gen_random_uuid(),
  post_id           uuid not null references posts(id) on delete cascade,
  author_member_id  uuid not null references event_members(id) on delete cascade,
  body              text not null,
  status            text not null default 'approved' check (status in ('approved','hidden')),
  created_at        timestamptz not null default now()
);

create table if not exists reactions (
  id             uuid primary key default gen_random_uuid(),
  post_id        uuid not null references posts(id) on delete cascade,
  member_id      uuid not null references event_members(id) on delete cascade,
  reaction_type  text not null check (reaction_type in ('heart','wow','party','touched')),
  created_at     timestamptz not null default now(),
  unique (post_id, member_id, reaction_type)
);

create table if not exists reports (
  id                   uuid primary key default gen_random_uuid(),
  event_id             uuid not null references events(id) on delete cascade,
  target_type          text not null check (target_type in ('post','comment','member')),
  target_id            uuid not null,
  reporter_member_id   uuid not null references event_members(id),
  reason               text,
  status               text not null default 'open' check (status in ('open','reviewed','dismissed')),
  created_at           timestamptz not null default now()
);

create table if not exists moderation_actions (
  id                uuid primary key default gen_random_uuid(),
  event_id          uuid not null references events(id) on delete cascade,
  actor_member_id   uuid not null references event_members(id),
  action            text not null,
  target_type       text,
  target_id         uuid,
  created_at        timestamptz not null default now()
);

-- ================================================================
-- ÍNDICES
-- ================================================================
create index if not exists idx_events_slug on events(slug);
create index if not exists idx_members_event on event_members(event_id);
create index if not exists idx_posts_event_created on posts(event_id, created_at desc);
create index if not exists idx_media_post on media(post_id);
create index if not exists idx_comments_post on comments(post_id, created_at);
create index if not exists idx_reactions_post on reactions(post_id);
create index if not exists idx_reports_event_status on reports(event_id, status);

-- ================================================================
-- FUNCIONES DE APOYO (security definer para poder usarse dentro de las policies)
-- ================================================================

-- Todas las funciones "security definer" fijan search_path explícito: es la
-- protección estándar contra hijacking de search_path en funciones que corren
-- con privilegios elevados (si no, alguien podría crear un objeto con el mismo
-- nombre en otro schema y hacer que la función lo use en su lugar).

create or replace function is_event_member(p_event_id uuid)
returns boolean language sql stable security definer
set search_path = public, pg_temp as $$
  select exists (
    select 1 from event_members
    where event_id = p_event_id and user_id = auth.uid() and blocked = false
  );
$$;

create or replace function is_event_admin(p_event_id uuid)
returns boolean language sql stable security definer
set search_path = public, pg_temp as $$
  select exists (
    select 1 from event_members
    where event_id = p_event_id and user_id = auth.uid()
      and role in ('owner','coadmin') and blocked = false
  );
$$;

create or replace function event_id_of_post(p_post_id uuid)
returns uuid language sql stable security definer
set search_path = public, pg_temp as $$
  select event_id from posts where id = p_post_id;
$$;

-- El anfitrión "reclama" su rol con el host_token que viaja en el link privado del panel
-- (index.html?event=slug&host=TOKEN). Es la única vía para volverse owner: nadie puede
-- insertarse con role='owner' directamente (ver policy members_insert_self más abajo).
create or replace function claim_host(p_event_id uuid, p_token text, p_display_name text default 'Anfitrión')
returns void language plpgsql security definer
set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from events where id = p_event_id and host_token = p_token) then
    raise exception 'token de anfitrión inválido';
  end if;
  insert into event_members (event_id, user_id, role, display_name)
  values (p_event_id, auth.uid(), 'owner', p_display_name)
  on conflict (event_id, user_id) do update set role = 'owner';
end;
$$;

-- Un post nunca confía en el "status" que manda el cliente: este trigger lo
-- recalcula siempre server-side según la configuración real del evento.
-- Cierra dos huecos: (1) un invitado no puede forzar que su publicación
-- aparezca como aprobada cuando el anfitrión pidió aprobación previa, y
-- (2) si who_can_post = 'admin_only', un invitado directamente no puede publicar.
create or replace function enforce_post_policy()
returns trigger language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_who_can_post text;
  v_require_approval boolean;
  v_is_admin boolean;
begin
  select who_can_post, require_approval into v_who_can_post, v_require_approval
  from event_settings where event_id = new.event_id;

  select exists (
    select 1 from event_members
    where id = new.author_member_id and role in ('owner','coadmin')
  ) into v_is_admin;

  if coalesce(v_who_can_post, 'all') = 'admin_only' and not v_is_admin then
    raise exception 'Solo el anfitrión puede publicar en este evento';
  end if;

  if v_is_admin then
    new.status := 'approved';
  elsif coalesce(v_require_approval, false) then
    new.status := 'pending';
  else
    new.status := 'approved';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_post_policy on posts;
create trigger trg_enforce_post_policy
before insert on posts
for each row execute function enforce_post_policy();

-- Igual que con los posts: el cliente nunca decide el estado de moderación
-- de un comentario. Todo comentario nace 'approved'; solo un admin puede
-- pasarlo a 'hidden' después (vía reportes o moderación directa).
create or replace function enforce_comment_status()
returns trigger language plpgsql security definer
set search_path = public, pg_temp as $$
begin
  new.status := 'approved';
  return new;
end;
$$;

drop trigger if exists trg_enforce_comment_status on comments;
create trigger trg_enforce_comment_status
before insert on comments
for each row execute function enforce_comment_status();

-- ================================================================
-- ROW LEVEL SECURITY
-- ================================================================
alter table events enable row level security;
alter table event_settings enable row level security;
alter table event_members enable row level security;
alter table posts enable row level security;
alter table media enable row level security;
alter table comments enable row level security;
alter table reactions enable row level security;
alter table reports enable row level security;
alter table moderation_actions enable row level security;

drop policy if exists events_select on events;
create policy events_select on events for select using (true); -- datos no sensibles (nombre, fecha) para la bienvenida pre-identificación
drop policy if exists events_update_owner on events;
create policy events_update_owner on events for update using (is_event_admin(id));

drop policy if exists settings_select on event_settings;
create policy settings_select on event_settings for select using (true);
drop policy if exists settings_upsert_owner on event_settings;
create policy settings_upsert_owner on event_settings for all using (is_event_admin(event_id)) with check (is_event_admin(event_id));

drop policy if exists members_select on event_members;
create policy members_select on event_members for select using (is_event_member(event_id));
drop policy if exists members_insert_self on event_members;
create policy members_insert_self on event_members for insert
  with check (user_id = auth.uid() and role = 'guest');
-- OJO: sin el "with check", cualquier invitado podría auto-promoverse a
-- owner actualizando su propia fila (Postgres usa el USING como WITH CHECK
-- por defecto si no se especifica). El with check de abajo obliga a que,
-- salvo que ya seas admin, el update propio nunca pueda tocar role/blocked.
drop policy if exists members_update_self on event_members;
create policy members_update_self on event_members for update
  using (user_id = auth.uid() or is_event_admin(event_id))
  with check (
    (user_id = auth.uid() and role = 'guest' and blocked = false)
    or is_event_admin(event_id)
  );

-- Antes de esta vuelta, posts_select no filtraba por status en absoluto:
-- la privacidad de "pending" dependía únicamente de que el cliente pidiera
-- bien los datos (ver API.listPosts). Cualquiera con la consola del
-- navegador podía pedir sb.from('posts').select('*') y ver publicaciones
-- pendientes/ocultas/rechazadas ajenas. Ahora la RLS lo hace cumplir de
-- verdad: el admin ve todo, cualquier otro miembro solo ve lo aprobado
-- más lo propio (para poder seguir el estado de lo que mandó).
drop policy if exists posts_select on posts;
create policy posts_select on posts for select
  using (
    is_event_admin(event_id)
    or (
      is_event_member(event_id)
      and (
        status = 'approved'
        or author_member_id in (select id from event_members where event_id = posts.event_id and user_id = auth.uid())
      )
    )
  );
drop policy if exists posts_insert on posts;
create policy posts_insert on posts for insert
  with check (
    is_event_member(event_id)
    and author_member_id in (select id from event_members where event_id = posts.event_id and user_id = auth.uid())
  );
drop policy if exists posts_update_owner on posts;
create policy posts_update_owner on posts for update using (is_event_admin(event_id));
drop policy if exists posts_delete_owner on posts;
create policy posts_delete_owner on posts for delete using (is_event_admin(event_id));

drop policy if exists media_select on media;
create policy media_select on media for select using (is_event_member(event_id_of_post(post_id)));
drop policy if exists media_insert on media;
create policy media_insert on media for insert with check (is_event_member(event_id_of_post(post_id)));

-- Un comentario oculto (status='hidden', tras un reporte) deja de ser visible
-- para el resto de los invitados, pero el admin lo sigue viendo para poder
-- revertir la decisión.
drop policy if exists comments_select on comments;
create policy comments_select on comments for select
  using (
    is_event_member(event_id_of_post(post_id))
    and (status = 'approved' or is_event_admin(event_id_of_post(post_id)))
  );
drop policy if exists comments_insert on comments;
create policy comments_insert on comments for insert with check (is_event_member(event_id_of_post(post_id)));
drop policy if exists comments_update_admin on comments;
create policy comments_update_admin on comments for update
  using (is_event_admin(event_id_of_post(post_id)))
  with check (is_event_admin(event_id_of_post(post_id)));
drop policy if exists comments_delete on comments;
create policy comments_delete on comments for delete
  using (
    author_member_id in (select id from event_members where user_id = auth.uid())
    or is_event_admin(event_id_of_post(post_id))
  );

drop policy if exists reactions_select on reactions;
create policy reactions_select on reactions for select using (is_event_member(event_id_of_post(post_id)));
drop policy if exists reactions_insert on reactions;
create policy reactions_insert on reactions for insert with check (is_event_member(event_id_of_post(post_id)));
drop policy if exists reactions_delete_own on reactions;
create policy reactions_delete_own on reactions for delete
  using (member_id in (select id from event_members where user_id = auth.uid()));

drop policy if exists reports_insert on reports;
create policy reports_insert on reports for insert with check (is_event_member(event_id));
drop policy if exists reports_select_admin on reports;
create policy reports_select_admin on reports for select using (is_event_admin(event_id));
drop policy if exists reports_update_admin on reports;
create policy reports_update_admin on reports for update using (is_event_admin(event_id));

drop policy if exists moderation_select_admin on moderation_actions;
create policy moderation_select_admin on moderation_actions for select using (is_event_admin(event_id));
drop policy if exists moderation_insert_admin on moderation_actions;
create policy moderation_insert_admin on moderation_actions for insert with check (is_event_admin(event_id));

-- ================================================================
-- STORAGE — bucket privado para fotos y videos
-- Convención de ruta: events/{event_id}/posts/{post_id}/{archivo}
-- ================================================================
insert into storage.buckets (id, name, public)
values ('event-media', 'event-media', false)
on conflict (id) do nothing;

drop policy if exists storage_insert_event_media on storage.objects;
create policy storage_insert_event_media on storage.objects for insert
  with check (
    bucket_id = 'event-media'
    and is_event_member((storage.foldername(name))[2]::uuid)
  );

drop policy if exists storage_select_event_media on storage.objects;
create policy storage_select_event_media on storage.objects for select
  using (
    bucket_id = 'event-media'
    and is_event_member((storage.foldername(name))[2]::uuid)
  );

drop policy if exists storage_delete_event_media on storage.objects;
create policy storage_delete_event_media on storage.objects for delete
  using (
    bucket_id = 'event-media'
    and is_event_admin((storage.foldername(name))[2]::uuid)
  );

-- ================================================================
-- REALTIME — sin esto el feed en vivo (Realtime.subscribe en el cliente)
-- nunca recibe nada: hay que sumar la tabla a la publicación primero.
-- ================================================================
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'posts'
  ) then
    alter publication supabase_realtime add table posts;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'comments'
  ) then
    alter publication supabase_realtime add table comments;
  end if;
end $$;

-- ================================================================
-- EVENTO DE PRUEBA (opcional — comentado; descomentar para tener algo
-- con qué probar la app apenas conectada). Anotá el host_token que
-- devuelve el SELECT del final: es tu link de panel de anfitrión.
-- ================================================================
-- insert into events (slug, name, honoree_name, event_type, event_date, event_time, message, status)
-- values ('martina-2026', 'Cumpleaños de Martina', 'Martina', 'infantil', '2026-10-12', '17:00', 'Bienvenidos a mi fiesta', 'live');
--
-- insert into event_settings (event_id, location_text, dress_code, gift_info)
-- select id, 'Salón a confirmar', 'Casual', 'Tu presencia es el regalo' from events where slug = 'martina-2026';
--
-- select slug, host_token from events where slug = 'martina-2026';
