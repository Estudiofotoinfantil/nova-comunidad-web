/* ================================================================
   NOVA COMUNIDAD — app.js (V1)
   Vanilla JS, sin build step. Abrir index.html?event=SLUG directamente
   (o servido desde cualquier hosting estático).

   Secciones: UTIL · STORE · API · ROUTER · SCREENS · MODAL · VIEWER · BOOT
   ================================================================ */
(function () {
  'use strict';

  const { createClient } = window.supabase;
  const sb = createClient(window.NC_CONFIG.SUPABASE_URL, window.NC_CONFIG.SUPABASE_ANON_KEY);

  // ==============================================================
  // UTIL
  // ==============================================================
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) => (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 2600);
  }

  function initials(name) {
    if (!name) return '?';
    return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  }

  function timeAgo(iso) {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'recién';
    if (s < 3600) return Math.floor(s / 60) + ' min';
    if (s < 86400) return Math.floor(s / 3600) + ' hs';
    return Math.floor(s / 86400) + ' d';
  }

  function qs(name) {
    return new URLSearchParams(location.search).get(name);
  }

  // Comprime una imagen del lado del cliente antes de subirla (lado más
  // largo a MAX_IMAGE_DIM, JPEG calidad ~0.82). Los invitados suelen estar
  // con datos móviles en el salón — esto es central, no un detalle.
  function compressImage(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) { height = Math.round((height * maxDim) / width); width = maxDim; }
        else if (height > maxDim) { width = Math.round((width * maxDim) / height); height = maxDim; }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url);
          blob ? resolve({ blob, width, height }) : reject(new Error('No se pudo procesar la imagen'));
        }, 'image/jpeg', quality || 0.82);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Imagen inválida')); };
      img.src = url;
    });
  }

  // ==============================================================
  // STORE
  // ==============================================================
  const STORE = {
    slug: null,
    hostToken: null,
    event: null,
    settings: null,
    member: null,          // mi fila en event_members
    members: [],
    posts: [],
    reactionsByPost: {},   // postId -> { heart:{count,mine}, wow:{...}, ... }
    commentsByPost: {},    // postId -> [ {id, author_member_id, body, created_at}, ... ]
    route: 'home',
    signedUrlCache: new Map(),
    postCountThisHour: 0,
  };

  const REACTION_TYPES = [
    { type: 'heart', icon: '❤️' },
    { type: 'wow', icon: '😍' },
    { type: 'party', icon: '🎉' },
    { type: 'touched', icon: '🥹' },
  ];

  // ==============================================================
  // API — toda llamada a Supabase vive acá
  // ==============================================================
  const API = {
    async ensureSession() {
      const { data: { session } } = await sb.auth.getSession();
      if (session) return session;
      const { data, error } = await sb.auth.signInAnonymously();
      if (error) throw error;
      return data.session;
    },

    async fetchEventBySlug(slug) {
      const { data, error } = await sb.from('events').select('*').eq('slug', slug).maybeSingle();
      if (error) throw error;
      return data;
    },

    async fetchSettings(eventId) {
      const { data, error } = await sb.from('event_settings').select('*').eq('event_id', eventId).maybeSingle();
      if (error) throw error;
      return data;
    },

    async fetchMyMembership(eventId, userId) {
      const { data, error } = await sb.from('event_members').select('*').eq('event_id', eventId).eq('user_id', userId).maybeSingle();
      if (error) throw error;
      return data;
    },

    async createMembership(eventId, userId, displayName, relation) {
      const { data, error } = await sb.from('event_members')
        .insert({ event_id: eventId, user_id: userId, display_name: displayName, relation: relation || null })
        .select().single();
      if (error) throw error;
      return data;
    },

    async claimHost(eventId, token, displayName) {
      const { error } = await sb.rpc('claim_host', { p_event_id: eventId, p_token: token, p_display_name: displayName || 'Anfitrión' });
      if (error) throw error;
    },

    async listMembers(eventId) {
      const { data, error } = await sb.from('event_members').select('*').eq('event_id', eventId).order('created_at');
      if (error) throw error;
      return data;
    },

    async updateMyMember(memberId, fields) {
      const { data, error } = await sb.from('event_members').update(fields).eq('id', memberId).select().single();
      if (error) throw error;
      return data;
    },

    // Un invitado no-admin NUNCA debe ver publicaciones "pending" de otros —
    // el feed le muestra las aprobadas + las propias (para ver "enviado,
    // esperando aprobación"). El anfitrión sí ve todo lo pendiente, porque
    // es quien tiene que aprobarlo o rechazarlo desde el panel.
    async listPosts(eventId, memberId, isAdmin) {
      let q = sb.from('posts').select('*, media(*)').eq('event_id', eventId);
      q = isAdmin
        ? q.neq('status', 'hidden').neq('status', 'rejected')
        : q.or(`status.eq.approved,and(status.eq.pending,author_member_id.eq.${memberId})`);
      const { data, error } = await q.order('created_at', { ascending: false }).limit(200);
      if (error) throw error;
      return data;
    },

    async createPost({ eventId, memberId, type, caption, file }) {
      // El status NO se manda desde acá — lo decide siempre el trigger
      // enforce_post_policy() en el servidor, según event_settings. Mandarlo
      // desde el cliente sería confiar en algo que un invitado podría falsear.
      const { data: post, error } = await sb.from('posts')
        .insert({ event_id: eventId, author_member_id: memberId, type, caption: caption || null })
        .select().single();
      if (error) throw error;

      if (file && (type === 'photo' || type === 'video')) {
        let uploadBlob = file, contentType = file.type, ext = 'jpg', width = null, height = null;
        if (type === 'photo') {
          const { blob, width: w, height: h } = await compressImage(file, window.NC_CONFIG.MAX_IMAGE_DIM, 0.82);
          uploadBlob = blob; contentType = 'image/jpeg'; width = w; height = h;
        } else {
          ext = (file.name.split('.').pop() || 'mp4').toLowerCase();
        }
        const path = `events/${eventId}/posts/${post.id}/${type}_${Date.now()}.${type === 'photo' ? 'jpg' : ext}`;
        const { error: upErr } = await sb.storage.from('event-media').upload(path, uploadBlob, { contentType, upsert: false });
        if (upErr) throw upErr;
        const { error: mediaErr } = await sb.from('media').insert({
          post_id: post.id, url: path, media_type: type === 'photo' ? 'image' : 'video',
          width, height, size_bytes: uploadBlob.size || null,
        });
        if (mediaErr) throw mediaErr;
      }
      const { data: full, error: fullErr } = await sb.from('posts').select('*, media(*)').eq('id', post.id).single();
      if (fullErr) throw fullErr;
      return full;
    },

    async listReactions(postIds) {
      if (!postIds.length) return [];
      const { data, error } = await sb.from('reactions').select('*').in('post_id', postIds);
      if (error) throw error;
      return data;
    },

    async toggleReaction(postId, memberId, type) {
      const { data: existing } = await sb.from('reactions').select('id')
        .eq('post_id', postId).eq('member_id', memberId).eq('reaction_type', type).maybeSingle();
      if (existing) {
        await sb.from('reactions').delete().eq('id', existing.id);
        return false;
      }
      await sb.from('reactions').insert({ post_id: postId, member_id: memberId, reaction_type: type });
      return true;
    },

    async submitRsvp(memberId, status, guestCount) {
      return API.updateMyMember(memberId, { rsvp_status: status, guest_count: guestCount || 0 });
    },

    async getSignedUrl(path) {
      if (STORE.signedUrlCache.has(path)) return STORE.signedUrlCache.get(path);
      const { data, error } = await sb.storage.from('event-media').createSignedUrl(path, 3600);
      if (error) { console.error(error); return null; }
      STORE.signedUrlCache.set(path, data.signedUrl);
      return data.signedUrl;
    },

    async hostDeletePost(postId) {
      const { error } = await sb.from('posts').delete().eq('id', postId);
      if (error) throw error;
    },

    async hostSetPostStatus(postId, status) {
      const { error } = await sb.from('posts').update({ status }).eq('id', postId);
      if (error) throw error;
    },

    // Trae TODO lo publicado en el evento (incluye pending/rejected/hidden) —
    // solo para el panel del anfitrión. El feed normal sigue usando
    // listPosts de arriba, que a propósito no muestra lo oculto/rechazado.
    async listAllPostsForModeration(eventId) {
      const { data, error } = await sb.from('posts').select('*, media(*)').eq('event_id', eventId)
        .order('created_at', { ascending: false }).limit(300);
      if (error) throw error;
      return data;
    },

    async hidePost(postId) {
      return API.hostSetPostStatus(postId, 'hidden');
    },

    async hideComment(commentId) {
      const { error } = await sb.from('comments').update({ status: 'hidden' }).eq('id', commentId);
      if (error) throw error;
    },

    async blockMember(memberId) {
      const { error } = await sb.from('event_members').update({ blocked: true }).eq('id', memberId);
      if (error) throw error;
    },

    async reportContent(eventId, reporterMemberId, targetType, targetId, reason) {
      const { error } = await sb.from('reports').insert({
        event_id: eventId, target_type: targetType, target_id: targetId,
        reporter_member_id: reporterMemberId, reason: reason || null,
      });
      if (error) throw error;
    },

    // Trae los reportes abiertos de un evento junto con una vista rápida
    // del contenido reportado (para que el anfitrión no tenga que andar
    // buscando el post/comentario por separado).
    async listReports(eventId) {
      const { data: reports, error } = await sb.from('reports').select('*')
        .eq('event_id', eventId).eq('status', 'open').order('created_at', { ascending: false });
      if (error) throw error;
      const postIds = reports.filter((r) => r.target_type === 'post').map((r) => r.target_id);
      const commentIds = reports.filter((r) => r.target_type === 'comment').map((r) => r.target_id);
      const [postsRes, commentsRes] = await Promise.all([
        postIds.length ? sb.from('posts').select('id, caption, type, author_member_id').in('id', postIds) : Promise.resolve({ data: [] }),
        commentIds.length ? sb.from('comments').select('id, body, author_member_id').in('id', commentIds) : Promise.resolve({ data: [] }),
      ]);
      const postMap = new Map((postsRes.data || []).map((p) => [p.id, p]));
      const commentMap = new Map((commentsRes.data || []).map((c) => [c.id, c]));
      return reports.map((r) => ({
        ...r,
        target: r.target_type === 'post' ? postMap.get(r.target_id) : r.target_type === 'comment' ? commentMap.get(r.target_id) : null,
      }));
    },

    async resolveReport(reportId, status) {
      const { error } = await sb.from('reports').update({ status }).eq('id', reportId);
      if (error) throw error;
    },

    // El log de moderación es informativo — si falla, no queremos que
    // frene la acción principal (ocultar/bloquear) que ya se hizo.
    async logModeration(eventId, actorMemberId, action, targetType, targetId) {
      const { error } = await sb.from('moderation_actions').insert({
        event_id: eventId, actor_member_id: actorMemberId, action,
        target_type: targetType || null, target_id: targetId || null,
      });
      if (error) console.error(error);
    },

    async listComments(postIds) {
      if (!postIds.length) return [];
      const { data, error } = await sb.from('comments').select('*').eq('status', 'approved').in('post_id', postIds).order('created_at');
      if (error) throw error;
      return data;
    },

    async addComment(postId, memberId, body) {
      const { data, error } = await sb.from('comments').insert({ post_id: postId, author_member_id: memberId, body }).select().single();
      if (error) throw error;
      return data;
    },

    async deleteComment(commentId) {
      const { error } = await sb.from('comments').delete().eq('id', commentId);
      if (error) throw error;
    },

    // Nota: "comments" no tiene columna event_id (solo post_id), así que el
    // filtro server-side de Realtime no puede acotar por evento acá — se
    // recibe el INSERT global y se descarta del lado del cliente si el post
    // no pertenece al feed ya cargado. Para la escala de V1/V2 (un evento
    // por sesión de invitado) es un costo aceptable; si hiciera falta más
    // adelante, se puede sumar event_id a comments para filtrar en el server.
    subscribeComments(eventId, onNewComment) {
      return sb.channel('comments-' + eventId)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'comments' },
          (payload) => {
            if (payload.new.author_member_id === (STORE.member && STORE.member.id)) return;
            const stillTracked = STORE.posts.some((p) => p.id === payload.new.post_id);
            if (stillTracked) onNewComment(payload.new);
          })
        .subscribe();
    },

    async hostUpdateSettings(eventId, fields) {
      const { error } = await sb.from('event_settings').update(fields).eq('event_id', eventId);
      if (error) throw error;
    },

    subscribeFeed(eventId, onNewPost) {
      return sb.channel('posts-' + eventId)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'posts', filter: `event_id=eq.${eventId}` },
          async (payload) => {
            if (payload.new.author_member_id === (STORE.member && STORE.member.id)) return; // ya lo agregué yo al publicar
            const { data } = await sb.from('posts').select('*, media(*)').eq('id', payload.new.id).single();
            if (data && data.status === 'approved') onNewPost(data);
          })
        .subscribe();
    },
  };

  // ==============================================================
  // ROUTER
  // ==============================================================
  const ROUTER = {
    go(route) {
      STORE.route = route;
      location.hash = '#/' + route;
      SCREENS.renderMain();
      $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.route === route));
      $('#screen-content').scrollTop = 0;
    },
  };

  // ==============================================================
  // FASE DEL EVENTO (pre / durante / post)
  // ==============================================================
  function eventDateTime() {
    if (!STORE.event || !STORE.event.event_date) return null;
    return new Date(`${STORE.event.event_date}T${STORE.event.event_time || '00:00:00'}`);
  }
  function eventPhase() {
    const dt = eventDateTime();
    if (!dt) return 'pre';
    const now = new Date();
    if (now.toDateString() === dt.toDateString()) return 'during';
    return now < dt ? 'pre' : 'post';
  }
  function updateTopbar() {
    const phase = eventPhase();
    const dt = eventDateTime();
    $('#topbarHonoree').textContent = STORE.event.honoree_name || STORE.event.name;
    const cd = $('#topbarCountdown'), ph = $('#topbarPhase');
    if (phase === 'pre' && dt) {
      cd.hidden = false; ph.textContent = 'Faltan…';
      const diff = Math.max(0, dt - new Date());
      $('#cdDays').textContent = String(Math.floor(diff / 86400000)).padStart(2, '0');
      $('#cdHours').textContent = String(Math.floor((diff / 3600000) % 24)).padStart(2, '0');
      $('#cdMins').textContent = String(Math.floor((diff / 60000) % 60)).padStart(2, '0');
    } else if (phase === 'during') {
      cd.hidden = true; ph.textContent = '¡Hoy es el día! ✨';
    } else {
      cd.hidden = true; ph.textContent = 'Gracias por ser parte ❤️';
    }
  }

  // ==============================================================
  // SCREENS
  // ==============================================================
  const SCREENS = {

    renderWelcome() {
      const e = STORE.event;
      $('#welcomeType').textContent = ({ infantil: 'Cumpleaños infantil', 'baby-shower': 'Baby shower', casamiento: 'Casamiento', '15-anos': '15 años' })[e.event_type] || 'Estás invitado';
      $('#welcomeName').textContent = e.honoree_name || e.name;
      const dt = eventDateTime();
      $('#welcomeSub').textContent = dt ? dt.toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
      $('#welcomeMsg').textContent = e.message ? `“${e.message}”` : '';
      $('#welcomeCover').style.background = e.cover_url
        ? `center/cover url(${e.cover_url})`
        : 'linear-gradient(160deg,#241D12,#0E0B08 70%)';
      show('#screen-welcome');
    },

    renderIdentify() { show('#screen-identify'); },

    renderError(msg) {
      $('#errorMsg').textContent = msg || 'Revisá el link o pedile al anfitrión que te lo reenvíe.';
      show('#screen-error');
    },

    async renderMain() {
      updateTopbar();
      const c = $('#screen-content');
      const route = (location.hash.replace('#/', '') || 'home');
      STORE.route = route;
      $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.route === route));
      if (route === 'home') return SCREENS.home(c);
      if (route === 'album') return SCREENS.album(c);
      if (route === 'info') return SCREENS.info(c);
      if (route === 'guests') return SCREENS.guests(c);
      if (route === 'profile') return SCREENS.profile(c);
      if (route === 'host') return SCREENS.host(c);
      return SCREENS.home(c);
    },

    async home(c) {
      if (!STORE.posts.length) {
        c.innerHTML = `<div class="empty-state"><b>Todavía no hay recuerdos</b>Sé el primero en compartir algo de ${esc(STORE.event.honoree_name || 'este evento')}.</div>`;
        return;
      }
      c.innerHTML = STORE.posts.map(postCardHTML).join('');
      await hydrateMedia(c);
      wireReactions(c);
      wireCommentButtons(c);
      wireReportButtons(c);
    },

    async album(c) {
      const items = [];
      STORE.posts.forEach((p) => (p.media || []).forEach((m) => items.push({ post: p, media: m })));
      if (!items.length) {
        c.innerHTML = `<div class="sc-head"><h2>Recuerdos</h2><p>El álbum colaborativo de todos los invitados.</p></div>
          <div class="empty-state"><b>Álbum vacío por ahora</b>Las fotos y videos que se compartan van a aparecer acá.</div>`;
        return;
      }
      c.innerHTML = `<div class="sc-head"><h2>Recuerdos</h2><p>${items.length} recuerdo${items.length === 1 ? '' : 's'} compartidos</p></div>
        <div class="album-grid">${items.map((it, i) => `
          <div class="album-cell ${it.media.media_type === 'video' ? 'video' : ''}" data-i="${i}"></div>`).join('')}</div>`;
      const cells = $$('.album-cell', c);
      for (let i = 0; i < items.length; i++) {
        const url = await API.getSignedUrl(items[i].media.url);
        if (!url) continue;
        cells[i].innerHTML = items[i].media.media_type === 'video'
          ? `<video src="${url}" muted playsinline></video>` : `<img src="${url}" loading="lazy" alt="">`;
        cells[i].addEventListener('click', () => VIEWER.open(items, i));
      }
    },

    info(c) {
      const s = STORE.settings || {};
      const dt = eventDateTime();
      const m = STORE.member;
      c.innerHTML = `
        <div class="sc-head"><h2>Información</h2></div>
        ${infoRow('📅', 'Fecha', dt ? dt.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' }) : '—')}
        ${infoRow('⏰', 'Horario', STORE.event.event_time ? STORE.event.event_time.slice(0, 5) + ' hs' : '—')}
        ${infoRow('📍', 'Ubicación', s.location_text || '—')}
        ${s.map_url ? infoRow('🗺️', 'Cómo llegar', `<a href="${esc(s.map_url)}" target="_blank" rel="noopener" style="color:var(--accent)">Ver mapa</a>`) : ''}
        ${infoRow('👗', 'Dress code', s.dress_code || '—')}
        ${infoRow('🎁', 'Regalos', s.gift_info || '—')}
        ${s.contact_info ? infoRow('📞', 'Contacto', s.contact_info) : ''}
        <div class="rsvp-box">
          <p class="eyebrow">RSVP</p>
          <h3 style="margin-top:6px;font-size:17px;">¿Vas a acompañarnos?</h3>
          <div class="rsvp-options">
            <button class="rsvp-opt ${m.rsvp_status === 'yes' ? 'active' : ''}" data-status="yes">Sí, voy</button>
            <button class="rsvp-opt ${m.rsvp_status === 'no' ? 'active' : ''}" data-status="no">No podré</button>
            <button class="rsvp-opt ${m.rsvp_status === 'maybe' ? 'active' : ''}" data-status="maybe">Todavía no sé</button>
          </div>
          <div class="rsvp-guests" ${m.rsvp_status === 'yes' ? '' : 'hidden'} id="rsvpGuestsBox">
            <label class="eyebrow" style="display:block;margin-bottom:6px;">Acompañantes</label>
            <input type="number" min="0" max="10" class="field" id="rsvpGuests" style="margin-top:0" value="${m.guest_count || 0}">
          </div>
        </div>`;
      $$('.rsvp-opt', c).forEach((btn) => btn.addEventListener('click', async () => {
        $$('.rsvp-opt', c).forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        $('#rsvpGuestsBox').hidden = btn.dataset.status !== 'yes';
        const guestCount = btn.dataset.status === 'yes' ? Number($('#rsvpGuests').value || 0) : 0;
        STORE.member = await API.submitRsvp(m.id, btn.dataset.status, guestCount);
        toast('Confirmación guardada');
      }));
      const gInput = $('#rsvpGuests', c);
      if (gInput) gInput.addEventListener('change', async () => {
        STORE.member = await API.submitRsvp(m.id, 'yes', Number(gInput.value || 0));
        toast('Confirmación guardada');
      });
    },

    guests(c) {
      const yes = STORE.members.filter((g) => g.rsvp_status === 'yes').length;
      c.innerHTML = `<div class="sc-head"><h2>Quiénes están acá</h2><p>${STORE.members.length} invitados · ${yes} confirmados</p></div>
        ${STORE.members.map((g) => `
          <div class="guest-row">
            <div class="avatar">${esc(initials(g.display_name))}</div>
            <div><div class="name">${esc(g.display_name)}</div>${g.relation ? `<div class="rel">${esc(g.relation)}</div>` : ''}</div>
            <span class="rsvp-chip ${g.rsvp_status}">${({ yes: 'Confirmó', no: 'No va', maybe: 'Tal vez', pending: 'Pendiente' })[g.rsvp_status]}</span>
          </div>`).join('')}`;
    },

    profile(c) {
      const m = STORE.member;
      c.innerHTML = `
        <div class="sc-head"><h2>Mi perfil</h2></div>
        <div class="profile-avatar">${esc(initials(m.display_name))}</div>
        <input class="field" id="pfName" value="${esc(m.display_name)}" maxlength="40">
        <input class="field" id="pfRelation" placeholder="Relación (opcional)" value="${esc(m.relation || '')}" maxlength="40">
        <button class="btn-primary btn-block" id="pfSave">Guardar cambios</button>
        ${m.role !== 'guest' ? `<button class="btn-ghost btn-block" id="pfHostPanel">Panel del anfitrión</button>` : ''}
      `;
      $('#pfSave', c).addEventListener('click', async () => {
        STORE.member = await API.updateMyMember(m.id, { display_name: $('#pfName').value.trim() || m.display_name, relation: $('#pfRelation').value.trim() || null });
        toast('Perfil actualizado');
        SCREENS.renderMain();
      });
      const hp = $('#pfHostPanel', c);
      if (hp) hp.addEventListener('click', () => ROUTER.go('host'));
    },

    async host(c) {
      if (!STORE.member || STORE.member.role === 'guest') {
        c.innerHTML = `<div class="empty-state"><b>Solo para el anfitrión</b>Esta sección no está disponible para invitados.</div>`;
        return;
      }
      const yes = STORE.members.filter((g) => g.rsvp_status === 'yes').length;
      const no = STORE.members.filter((g) => g.rsvp_status === 'no').length;
      const rsvpPending = STORE.members.length - yes - no - STORE.members.filter((g) => g.rsvp_status === 'maybe').length;
      const pending = STORE.posts.filter((p) => p.status === 'pending');
      const photos = STORE.posts.reduce((n, p) => n + (p.media || []).filter((m) => m.media_type === 'image').length, 0);
      const videos = STORE.posts.reduce((n, p) => n + (p.media || []).filter((m) => m.media_type === 'video').length, 0);
      const link = `${location.origin}${location.pathname}?event=${encodeURIComponent(STORE.slug)}`;
      const s = STORE.settings || {};
      // Estas dos se traen aparte porque el panel necesita ver TODO —
      // incluida lo oculto/rechazado, que el feed normal nunca muestra.
      const [reports, modPosts] = await Promise.all([
        API.listReports(STORE.event.id).catch(() => []),
        API.listAllPostsForModeration(STORE.event.id).catch(() => STORE.posts),
      ]);
      const statusLabel = { pending: 'pendiente', rejected: 'rechazada', hidden: 'oculta' };
      c.innerHTML = `
        <div class="sc-head"><h2>Panel del anfitrión</h2><p>Solo vos y los co-anfitriones ven esta sección.</p></div>
        <p class="eyebrow" style="margin-bottom:6px;">Link para compartir</p>
        <div class="host-link-box">${esc(link)}</div>
        <div class="host-stats">
          <div class="stat-tile"><b>${STORE.members.length}</b><span>Invitados</span></div>
          <div class="stat-tile"><b>${yes}</b><span>Confirmados</span></div>
          <div class="stat-tile"><b>${no}</b><span>No van</span></div>
          <div class="stat-tile"><b>${rsvpPending}</b><span>Pendientes</span></div>
          <div class="stat-tile"><b>${photos}</b><span>Fotos</span></div>
          <div class="stat-tile"><b>${videos}</b><span>Videos</span></div>
        </div>
        <p class="eyebrow" style="margin-bottom:6px;">Configuración</p>
        <div class="rsvp-box" style="margin-top:0;">
          <label style="display:flex;align-items:center;gap:8px;font-size:13.5px;">
            <input type="checkbox" id="cfgApproval" ${s.require_approval ? 'checked' : ''}> Requerir aprobación antes de publicar
          </label>
          <label class="eyebrow" style="display:block;margin:14px 0 6px;">¿Quién puede publicar?</label>
          <select id="cfgWhoPost" class="field" style="margin-top:0;">
            <option value="all" ${s.who_can_post === 'all' ? 'selected' : ''}>Todos los invitados</option>
            <option value="approved_only" ${s.who_can_post === 'approved_only' ? 'selected' : ''}>Solo aprobados por mí</option>
            <option value="admin_only" ${s.who_can_post === 'admin_only' ? 'selected' : ''}>Solo el anfitrión</option>
          </select>
        </div>
        ${pending.length ? `
        <p class="eyebrow" style="margin:20px 0 6px;">Pendientes de aprobación (${pending.length})</p>
        ${pending.map((p) => `
          <div class="host-post-row">
            <div class="txt">${esc(memberName(p.author_member_id))} · ${p.type === 'text' ? esc((p.caption || '').slice(0, 40)) : p.type}</div>
            <button class="btn-ghost" style="padding:6px 12px;font-size:11.5px;" data-approve="${p.id}">Aprobar</button>
            <button class="btn-del" data-reject="${p.id}">Rechazar</button>
          </div>`).join('')}` : ''}
        ${reports.length ? `
        <p class="eyebrow" style="margin:20px 0 6px;">Reportes abiertos (${reports.length})</p>
        ${reports.map((r) => {
          const authorId = r.target && r.target.author_member_id;
          const snippet = r.target ? (r.target.body || r.target.caption || '(sin texto)') : '(este contenido ya no existe)';
          return `
          <div class="host-post-row" style="flex-wrap:wrap;">
            <div class="txt">
              <div>${r.target_type === 'post' ? 'Publicación' : 'Comentario'} de ${esc(memberName(authorId))}</div>
              <div class="muted" style="font-size:12px;margin:2px 0;">"${esc(String(snippet).slice(0, 70))}"</div>
              ${r.reason ? `<div class="muted" style="font-size:11.5px;">Motivo: ${esc(r.reason)}</div>` : ''}
            </div>
            ${r.target ? `<button class="btn-ghost" style="padding:6px 12px;font-size:11.5px;" data-report-hide="${r.id}" data-report-type="${r.target_type}" data-report-target="${r.target_id}">Ocultar</button>` : ''}
            ${authorId ? `<button class="btn-ghost" style="padding:6px 12px;font-size:11.5px;" data-report-block="${r.id}" data-report-member="${authorId}">Bloquear</button>` : ''}
            <button class="btn-del" data-report-dismiss="${r.id}">Descartar</button>
          </div>`;
        }).join('')}` : ''}
        <p class="eyebrow" style="margin:20px 0 6px;">Publicaciones (${modPosts.length})</p>
        ${modPosts.map((p) => `
          <div class="host-post-row">
            <div class="txt">${esc(memberName(p.author_member_id))} · ${p.type === 'text' ? esc((p.caption || '').slice(0, 40)) : p.type}${p.status !== 'approved' ? ` <span class="status-tag ${p.status}">${statusLabel[p.status] || p.status}</span>` : ''}</div>
            ${p.status === 'hidden' || p.status === 'rejected' ? `<button class="btn-ghost" style="padding:6px 12px;font-size:11.5px;" data-restore="${p.id}">Restaurar</button>` : ''}
            <button class="btn-del" data-post="${p.id}">Eliminar</button>
          </div>`).join('') || '<p class="muted">Todavía no hay publicaciones.</p>'}
      `;
      $('#cfgApproval', c).addEventListener('change', async (e) => {
        await API.hostUpdateSettings(STORE.event.id, { require_approval: e.target.checked });
        STORE.settings.require_approval = e.target.checked;
        toast('Guardado');
      });
      $('#cfgWhoPost', c).addEventListener('change', async (e) => {
        await API.hostUpdateSettings(STORE.event.id, { who_can_post: e.target.value });
        STORE.settings.who_can_post = e.target.value;
        toast('Guardado');
      });
      $$('[data-approve]', c).forEach((btn) => btn.addEventListener('click', async () => {
        const id = btn.dataset.approve;
        await API.hostSetPostStatus(id, 'approved');
        const p = STORE.posts.find((x) => x.id === id);
        if (p) p.status = 'approved';
        toast('Publicación aprobada');
        SCREENS.host(c);
      }));
      $$('[data-reject]', c).forEach((btn) => btn.addEventListener('click', async () => {
        const id = btn.dataset.reject;
        await API.hostSetPostStatus(id, 'rejected');
        const p = STORE.posts.find((x) => x.id === id);
        if (p) p.status = 'rejected';
        toast('Publicación rechazada');
        SCREENS.host(c);
      }));
      $$('[data-post]', c).forEach((btn) => btn.addEventListener('click', async () => {
        if (!confirm('¿Eliminar esta publicación?')) return;
        await API.hostDeletePost(btn.dataset.post);
        STORE.posts = STORE.posts.filter((p) => p.id !== btn.dataset.post);
        SCREENS.host(c);
      }));
      $$('[data-restore]', c).forEach((btn) => btn.addEventListener('click', async () => {
        const id = btn.dataset.restore;
        await API.hostSetPostStatus(id, 'approved');
        await API.logModeration(STORE.event.id, STORE.member.id, 'restore_post', 'post', id);
        toast('Publicación restaurada');
        SCREENS.host(c);
      }));
      $$('[data-report-hide]', c).forEach((btn) => btn.addEventListener('click', async () => {
        const type = btn.dataset.reportType, targetId = btn.dataset.reportTarget, reportId = btn.dataset.reportHide;
        try {
          if (type === 'post') {
            await API.hidePost(targetId);
            const p = STORE.posts.find((x) => x.id === targetId);
            if (p) p.status = 'hidden';
          } else {
            await API.hideComment(targetId);
            const list = STORE.commentsByPost[Object.keys(STORE.commentsByPost).find((pid) => (STORE.commentsByPost[pid] || []).some((cm) => cm.id === targetId))];
            if (list) STORE.commentsByPost[list] = list.filter((cm) => cm.id !== targetId);
          }
          await API.resolveReport(reportId, 'reviewed');
          await API.logModeration(STORE.event.id, STORE.member.id, type === 'post' ? 'hide_post' : 'hide_comment', type, targetId);
          toast('Contenido ocultado');
        } catch (err) { console.error(err); toast('No se pudo ocultar'); }
        SCREENS.host(c);
      }));
      $$('[data-report-block]', c).forEach((btn) => btn.addEventListener('click', async () => {
        const memberId = btn.dataset.reportMember, reportId = btn.dataset.reportBlock;
        if (!confirm('¿Bloquear a esta persona? No va a poder ver ni publicar más en este evento.')) return;
        try {
          await API.blockMember(memberId);
          await API.resolveReport(reportId, 'reviewed');
          await API.logModeration(STORE.event.id, STORE.member.id, 'block_member', 'member', memberId);
          STORE.members = STORE.members.map((m) => (m.id === memberId ? { ...m, blocked: true } : m));
          toast('Persona bloqueada');
        } catch (err) { console.error(err); toast('No se pudo bloquear'); }
        SCREENS.host(c);
      }));
      $$('[data-report-dismiss]', c).forEach((btn) => btn.addEventListener('click', async () => {
        const reportId = btn.dataset.reportDismiss;
        await API.resolveReport(reportId, 'dismissed');
        await API.logModeration(STORE.event.id, STORE.member.id, 'dismiss_report', null, null);
        toast('Reporte descartado');
        SCREENS.host(c);
      }));
    },
  };

  function infoRow(icon, label, val) {
    return `<div class="info-row"><div class="ic">${icon}</div><div><div class="lbl">${label}</div><div class="val">${val}</div></div></div>`;
  }
  function memberName(id) {
    const m = STORE.members.find((x) => x.id === id);
    return m ? m.display_name : 'Invitado';
  }
  function postCardHTML(p) {
    const author = memberName(p.author_member_id);
    const reactions = STORE.reactionsByPost[p.id] || {};
    const nComments = (STORE.commentsByPost[p.id] || []).length;
    return `
      <article class="post-card" data-post="${p.id}">
        <div class="post-head">
          <div class="avatar">${esc(initials(author))}</div>
          <div><div class="post-author">${esc(author)}</div><div class="post-time">${timeAgo(p.created_at)}${p.status === 'pending' ? ' · <span style="color:var(--accent)">esperando aprobación</span>' : ''}</div></div>
          <button class="icon-btn" data-report-post="${p.id}" aria-label="Reportar publicación" title="Reportar">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4a1 1 0 0 1 1-1h11l-2 5 2 5H8a1 1 0 0 0-1 1v7"/></svg>
          </button>
        </div>
        ${p.caption ? `<div class="post-caption">${esc(p.caption)}</div>` : ''}
        ${(p.media || []).map(() => `<div class="post-media" data-media></div>`).join('')}
        <div class="post-reactions">
          ${REACTION_TYPES.map((r) => `
            <button class="reaction-btn ${reactions[r.type] && reactions[r.type].mine ? 'mine' : ''}" data-post="${p.id}" data-type="${r.type}">
              ${r.icon} <span>${(reactions[r.type] && reactions[r.type].count) || ''}</span>
            </button>`).join('')}
        </div>
        <button class="comment-count-btn" data-open-comments="${p.id}">${nComments ? `${nComments} comentario${nComments === 1 ? '' : 's'}` : 'Comentar'}</button>
      </article>`;
  }
  async function hydrateMedia(root) {
    for (const card of $$('.post-card', root)) {
      const post = STORE.posts.find((p) => p.id === card.dataset.post);
      const slots = $$('[data-media]', card);
      for (let i = 0; i < slots.length; i++) {
        const m = post.media[i];
        const url = await API.getSignedUrl(m.url);
        if (!url) continue;
        slots[i].innerHTML = m.media_type === 'video'
          ? `<video src="${url}" controls playsinline></video>` : `<img src="${url}" loading="lazy" alt="">`;
      }
    }
  }
  function wireReactions(root) {
    $$('.reaction-btn', root).forEach((btn) => btn.addEventListener('click', async () => {
      const postId = btn.dataset.post, type = btn.dataset.type;
      const mine = await API.toggleReaction(postId, STORE.member.id, type);
      const bucket = (STORE.reactionsByPost[postId] = STORE.reactionsByPost[postId] || {});
      const entry = (bucket[type] = bucket[type] || { count: 0, mine: false });
      entry.count += mine ? 1 : -1;
      entry.mine = mine;
      btn.classList.toggle('mine', mine);
      btn.querySelector('span').textContent = entry.count || '';
    }));
  }

  function wireCommentButtons(root) {
    $$('[data-open-comments]', root).forEach((btn) => btn.addEventListener('click', () => COMMENTS.open(btn.dataset.openComments)));
  }
  function wireReportButtons(root) {
    $$('[data-report-post]', root).forEach((btn) => btn.addEventListener('click', () => REPORT_UI.open('post', btn.dataset.reportPost)));
  }

  function show(id) {
    ['#screen-welcome', '#screen-identify', '#screen-error'].forEach((s) => { $(s).hidden = s !== id; });
    $('#app-main').hidden = true;
  }

  // ==============================================================
  // MODAL: publicar recuerdo
  // ==============================================================
  const MODAL = {
    type: 'photo',
    file: null,

    open() {
      MODAL.type = 'photo'; MODAL.file = null;
      $('#publishCaption').value = '';
      $('#publishPreview').hidden = true; $('#publishPreview').innerHTML = '';
      $$('.ptype').forEach((b) => b.classList.toggle('active', b.dataset.type === 'photo'));
      $('#publishFile').accept = 'image/*'; $('#publishFile').value = '';
      $('#publishSheet').hidden = false;
    },
    close() { $('#publishSheet').hidden = true; },
  };

  function wireModal() {
    $$('.ptype').forEach((btn) => btn.addEventListener('click', () => {
      MODAL.type = btn.dataset.type;
      $$('.ptype').forEach((b) => b.classList.toggle('active', b === btn));
      $('#publishFile').hidden = MODAL.type === 'text';
      $('#publishFile').accept = MODAL.type === 'video' ? 'video/*' : 'image/*';
      $('#publishCaption').placeholder = MODAL.type === 'text' ? 'Tu mensaje…' : 'Escribí algo (opcional)…';
      MODAL.file = null; $('#publishPreview').hidden = true; $('#publishPreview').innerHTML = '';
    }));
    $('#publishFile').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (!f) return;
      if (MODAL.type === 'video' && f.size > window.NC_CONFIG.MAX_VIDEO_MB * 1024 * 1024) {
        toast(`El video no puede superar ${window.NC_CONFIG.MAX_VIDEO_MB}MB`); e.target.value = ''; return;
      }
      MODAL.file = f;
      const url = URL.createObjectURL(f);
      $('#publishPreview').hidden = false;
      $('#publishPreview').innerHTML = MODAL.type === 'video' ? `<video src="${url}" controls></video>` : `<img src="${url}">`;
    });
    $('#fabPublish').addEventListener('click', MODAL.open);
    $('#btnCancelPublish').addEventListener('click', MODAL.close);
    $('#publishSheet').addEventListener('click', (e) => { if (e.target === $('#publishSheet')) MODAL.close(); });

    $('#btnPublish').addEventListener('click', async () => {
      if (MODAL.type !== 'text' && !MODAL.file) { toast('Elegí un archivo primero'); return; }
      if (MODAL.type === 'text' && !$('#publishCaption').value.trim()) { toast('Escribí un mensaje'); return; }
      const btn = $('#btnPublish'); btn.disabled = true; btn.textContent = 'Publicando…';
      try {
        const post = await API.createPost({
          eventId: STORE.event.id, memberId: STORE.member.id, type: MODAL.type,
          caption: $('#publishCaption').value.trim(), file: MODAL.file,
        });
        if (post.status === 'approved') STORE.posts.unshift(post);
        MODAL.close();
        toast(post.status === 'pending' ? 'Enviado — el anfitrión lo va a aprobar' : 'Recuerdo compartido ✨');
        if (STORE.route === 'home') SCREENS.renderMain();
      } catch (err) {
        console.error(err); toast('No se pudo publicar, probá de nuevo');
      } finally {
        btn.disabled = false; btn.textContent = 'Publicar recuerdo';
      }
    });
  }

  // ==============================================================
  // COMENTARIOS (bottom sheet)
  // ==============================================================
  const COMMENTS = {
    postId: null,

    open(postId) {
      COMMENTS.postId = postId;
      COMMENTS.render();
      $('#commentsSheet').hidden = false;
      $('#commentInput').value = '';
      $('#commentInput').focus();
    },
    close() { $('#commentsSheet').hidden = true; COMMENTS.postId = null; },

    render() {
      const list = STORE.commentsByPost[COMMENTS.postId] || [];
      const box = $('#commentsList');
      if (!list.length) {
        box.innerHTML = `<div class="comments-empty">Todavía no hay comentarios. Sé el primero.</div>`;
        return;
      }
      box.innerHTML = list.map((cm) => {
        const author = memberName(cm.author_member_id);
        const mine = STORE.member && cm.author_member_id === STORE.member.id;
        const canDelete = mine || iAmAdmin();
        return `
          <div class="comment-item" data-comment="${cm.id}">
            <div class="avatar">${esc(initials(author))}</div>
            <div class="c-body">
              <div class="c-head">
                <span class="c-name">${esc(author)}</span>
                <span class="c-time">${timeAgo(cm.created_at)}</span>
                <span class="c-actions">
                  ${!mine ? `<button class="c-del" data-report-comment="${cm.id}">reportar</button>` : ''}
                  ${canDelete ? `<button class="c-del" data-del-comment="${cm.id}">eliminar</button>` : ''}
                </span>
              </div>
              <div class="c-text">${esc(cm.body)}</div>
            </div>
          </div>`;
      }).join('');
      $$('[data-del-comment]', box).forEach((btn) => btn.addEventListener('click', async () => {
        const id = btn.dataset.delComment;
        await API.deleteComment(id);
        STORE.commentsByPost[COMMENTS.postId] = (STORE.commentsByPost[COMMENTS.postId] || []).filter((x) => x.id !== id);
        COMMENTS.render();
        if (STORE.route === 'home') SCREENS.renderMain();
      }));
      $$('[data-report-comment]', box).forEach((btn) => btn.addEventListener('click', () => REPORT_UI.open('comment', btn.dataset.reportComment)));
    },

    async send() {
      const input = $('#commentInput');
      const body = input.value.trim();
      if (!body || !COMMENTS.postId) return;
      const btn = $('#btnSendComment'); btn.disabled = true;
      try {
        const cm = await API.addComment(COMMENTS.postId, STORE.member.id, body);
        (STORE.commentsByPost[COMMENTS.postId] = STORE.commentsByPost[COMMENTS.postId] || []).push(cm);
        input.value = '';
        COMMENTS.render();
        if (STORE.route === 'home') SCREENS.renderMain();
      } catch (err) {
        console.error(err); toast('No se pudo enviar el comentario');
      } finally {
        btn.disabled = false;
      }
    },
  };
  function wireComments() {
    $('#commentsSheet').addEventListener('click', (e) => { if (e.target === $('#commentsSheet')) COMMENTS.close(); });
    $('#btnSendComment').addEventListener('click', COMMENTS.send);
    $('#commentInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') COMMENTS.send(); });
  }

  // ==============================================================
  // REPORTAR (bottom sheet con motivos) — sirve para posts y comentarios
  // ==============================================================
  const REPORT_UI = {
    target: null, // { type: 'post'|'comment', id }
    open(type, id) {
      REPORT_UI.target = { type, id };
      $('#reportSheet').hidden = false;
    },
    close() { $('#reportSheet').hidden = true; REPORT_UI.target = null; },
    async send(reason) {
      if (!REPORT_UI.target) return;
      const { type, id } = REPORT_UI.target;
      REPORT_UI.close();
      try {
        await API.reportContent(STORE.event.id, STORE.member.id, type, id, reason);
        toast('Gracias — el anfitrión lo va a revisar');
      } catch (err) {
        console.error(err); toast('No se pudo enviar el reporte');
      }
    },
  };
  function wireReport() {
    $('#reportSheet').addEventListener('click', (e) => { if (e.target === $('#reportSheet')) REPORT_UI.close(); });
    $('#btnCancelReport').addEventListener('click', REPORT_UI.close);
    $$('.report-reason').forEach((btn) => btn.addEventListener('click', () => REPORT_UI.send(btn.dataset.reason)));
  }

  // ==============================================================
  // VISOR FULLSCREEN
  // ==============================================================
  const VIEWER = {
    items: [], i: 0,
    async open(items, i) {
      VIEWER.items = items; VIEWER.i = i;
      $('#viewer').hidden = false;
      await VIEWER.render();
    },
    async render() {
      const it = VIEWER.items[VIEWER.i];
      const url = await API.getSignedUrl(it.media.url);
      $('#viewerContent').innerHTML = it.media.media_type === 'video'
        ? `<video src="${url}" controls autoplay playsinline></video>` : `<img src="${url}">`;
    },
    close() { $('#viewer').hidden = true; VIEWER.items = []; },
    prev() { VIEWER.i = (VIEWER.i - 1 + VIEWER.items.length) % VIEWER.items.length; VIEWER.render(); },
    next() { VIEWER.i = (VIEWER.i + 1) % VIEWER.items.length; VIEWER.render(); },
  };
  function wireViewer() {
    $('#viewerClose').addEventListener('click', VIEWER.close);
    $('#viewerPrev').addEventListener('click', VIEWER.prev);
    $('#viewerNext').addEventListener('click', VIEWER.next);
  }

  // ==============================================================
  // BOOT
  // ==============================================================
  function iAmAdmin() {
    return !!STORE.member && (STORE.member.role === 'owner' || STORE.member.role === 'coadmin');
  }

  async function loadEventData() {
    STORE.settings = await API.fetchSettings(STORE.event.id);
    STORE.members = await API.listMembers(STORE.event.id);
    STORE.posts = await API.listPosts(STORE.event.id, STORE.member.id, iAmAdmin());
    const ids = STORE.posts.map((p) => p.id);
    const reactions = await API.listReactions(ids);
    STORE.reactionsByPost = {};
    reactions.forEach((r) => {
      const bucket = (STORE.reactionsByPost[r.post_id] = STORE.reactionsByPost[r.post_id] || {});
      const entry = (bucket[r.reaction_type] = bucket[r.reaction_type] || { count: 0, mine: false });
      entry.count++;
      if (r.member_id === STORE.member.id) entry.mine = true;
    });

    const comments = await API.listComments(ids);
    STORE.commentsByPost = {};
    comments.forEach((cm) => {
      (STORE.commentsByPost[cm.post_id] = STORE.commentsByPost[cm.post_id] || []).push(cm);
    });
  }

  function enterApp() {
    $('#screen-welcome').hidden = true; $('#screen-identify').hidden = true; $('#screen-error').hidden = true;
    $('#app-main').hidden = false;
    ROUTER.go((location.hash.replace('#/', '')) || 'home');
    setInterval(updateTopbar, 30000);
    API.subscribeFeed(STORE.event.id, (post) => {
      STORE.posts.unshift(post);
      if (STORE.route === 'home') SCREENS.renderMain();
    });
    API.subscribeComments(STORE.event.id, (cm) => {
      (STORE.commentsByPost[cm.post_id] = STORE.commentsByPost[cm.post_id] || []).push(cm);
      if (STORE.route === 'home') SCREENS.renderMain();
      if (COMMENTS.postId === cm.post_id) COMMENTS.render();
    });
  }

  async function boot() {
    wireModal(); wireViewer(); wireComments(); wireReport();
    $$('.nav-btn').forEach((b) => b.addEventListener('click', () => ROUTER.go(b.dataset.route)));
    window.addEventListener('hashchange', () => SCREENS.renderMain());

    STORE.slug = qs('event');
    STORE.hostToken = qs('host');
    if (!STORE.slug) { SCREENS.renderError('Este link no tiene un evento asociado.'); return; }

    try {
      await API.ensureSession();
      const { data: { session } } = await sb.auth.getSession();
      const userId = session.user.id;

      STORE.event = await API.fetchEventBySlug(STORE.slug);
      if (!STORE.event) { SCREENS.renderError(); return; }

      if (STORE.hostToken) {
        await API.claimHost(STORE.event.id, STORE.hostToken);
      }

      STORE.member = await API.fetchMyMembership(STORE.event.id, userId);

      if (STORE.member) {
        await loadEventData();
        enterApp();
        return;
      }

      // sin identidad todavía
      SCREENS.renderWelcome();
      $('#btnEnter').addEventListener('click', () => { $('#screen-welcome').hidden = true; SCREENS.renderIdentify(); });
      $('#btnContinue').addEventListener('click', async () => {
        const name = $('#inputName').value.trim();
        if (!name) { toast('Escribí tu nombre'); return; }
        const btn = $('#btnContinue'); btn.disabled = true; btn.textContent = 'Entrando…';
        try {
          STORE.member = await API.createMembership(STORE.event.id, userId, name, $('#inputRelation').value.trim());
          if (STORE.hostToken) STORE.member = await API.fetchMyMembership(STORE.event.id, userId); // por si claim_host ya la subió a owner
          await loadEventData();
          enterApp();
        } catch (err) {
          console.error(err); toast('Algo salió mal, probá de nuevo'); btn.disabled = false; btn.textContent = 'Continuar';
        }
      });
    } catch (err) {
      console.error(err);
      SCREENS.renderError('No pudimos conectar con el evento. Probá de nuevo en un momento.');
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
