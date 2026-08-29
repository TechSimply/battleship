/**
 * Firebase web config for the `battleship-p2p` project. These values are NOT
 * secrets — a web app ships them to every visitor by design; access is gated by
 * the Realtime Database security rules, not by hiding this config. Firebase is
 * used only for session bookkeeping (claiming Battle{n} ids, link liveness /
 * TTL, and remembering who is player 1 vs 2 — rule 9); actual gameplay still
 * flows peer-to-peer over PeerJS.
 */
export const firebaseConfig = {
  apiKey: 'AIzaSyC8lRTY1XatVL6r8YC73RFsk6qASj3_oxo',
  authDomain: 'battleship-p2p.firebaseapp.com',
  // Filled in once the Realtime Database is created (Console → Realtime
  // Database → Create Database). Region-specific: US default shown here; an EU
  // db is https://battleship-p2p-default-rtdb.europe-west1.firebasedatabase.app
  databaseURL: 'https://battleship-p2p-default-rtdb.firebaseio.com',
  projectId: 'battleship-p2p',
  storageBucket: 'battleship-p2p.firebasestorage.app',
  messagingSenderId: '990061034645',
  appId: '1:990061034645:web:92bfac9923794a4dd5af9c',
};
