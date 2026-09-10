/* ============================================================
   NOVA COMUNIDAD — configuración
   Completar después de correr supabase/schema.sql en tu proyecto:
   Project Settings > API > Project URL / anon public key
   ============================================================ */
window.NC_CONFIG = {
  SUPABASE_URL: 'https://qesqzuhwfzspmqxfpyxp.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_3nCb3ddp8W6QRBx3WXJoVg_BQzEyyjQ',

  // límites V1
  MAX_IMAGE_DIM: 1600,       // px, lado más largo, tras compresión
  MAX_VIDEO_MB: 25,
  MAX_POSTS_PER_HOUR: 20,    // guardrail anti-spam simple, del lado del cliente
};
