// Velura-Konfiguration. Trage hier deine Supabase-Projektdaten ein.
//
// Diese Werte sind OEFFENTLICH und duerfen committet/deployed werden:
// der "anon key" ist genau dafuer gedacht; die Daten schuetzt die
// Row-Level-Security (RLS) in der Datenbank, nicht die Geheimhaltung des Keys.
//
// Du findest beide Werte in Supabase unter:
//   Project Settings -> API -> "Project URL" und "anon public" key.
window.VELURA_CONFIG = {
  supabaseUrl: 'https://DEIN-PROJEKT.supabase.co',
  supabaseAnonKey: 'DEIN-ANON-PUBLIC-KEY',

  // WebRTC: STUN reicht meist; fuer striktes NAT zusaetzlich einen TURN-Server
  // ergaenzen (z.B. { urls: 'turn:...', username: '...', credential: '...' }).
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};
