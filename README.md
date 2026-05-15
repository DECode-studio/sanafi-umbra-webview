# Sanafi Umbra WebView

React + Vite web adapter untuk private transfer Umbra yang dijalankan di dalam React Native WebView.

## Product Requirements (PRD)

## 1. Product Goal
- Menjalankan flow private transfer Umbra tanpa ketergantungan runtime RN untuk ZK proving.
- Menjaga alur recording transaksi tetap lewat `sanafi-api` (single source of truth transaksi).

## 2. Problem Statement
- Library proving Umbra (`@umbra-privacy/web-zk-prover`) tidak stabil jika dijalankan langsung di RN runtime.
- Dibutuhkan runtime web untuk build/sign flow, tetapi tetap terintegrasi dengan wallet dan backend Sanafi.

## 3. Scope
- In-scope:
  - Umbra client init di web runtime.
  - Sender registration check.
  - Build private create UTXO.
  - Scan + claim-all.
  - Signing dan broadcast via bridge ke RN, lalu relay ke BE.
- Out-of-scope:
  - Wallet custody di web.
  - Broadcast langsung dari web tanpa backend.

## 4. User Flow (E2E)
1. User buka confirmation private di app.
2. RN membuka webview adapter ini.
3. Handshake bridge (`PING`, `INIT_SESSION`).
4. RN kirim `START_PRIVATE_FLOW`.
5. Web build Umbra flow dan minta sign/broadcast via bridge.
6. RN menandatangani via Privy wallet provider.
7. RN kirim signed tx ke BE `/api/transfer/signed-transaction`.
8. Web emit `FLOW_RESULT` / `FLOW_ERROR`.
9. RN update UI + mark claim state ke BE jika claim sukses.

## 5. Success Metrics
- Private flow success rate > 95%.
- Bridge handshake success > 99%.
- Tidak ada private key/secret terekspos di web layer.

---

## Technical Solution Design (TSD)

## 1. Architecture
`RN App <-> WebView Bridge <-> sanafi-umbra-webview <-> Umbra SDK`

Backend path tetap:
`RN App -> sanafi-api (/private-context, /signed-transaction, /mark-private-claimed)`

## 2. Core Modules
- `src/app/useApp.ts`
  - Business logic Umbra flow.
  - Bridge request handlers (`START_PRIVATE_FLOW`, `PING`, `INIT_SESSION`).
  - Progress/status state.
- `src/app/index.tsx`
  - UI confirmation style parity.
- `src/bridge/sanafiUmbraBridge.ts`
  - Request-response queue.
  - Timeout/cancel handling.
  - Origin guard (optional via env).
- `src/bridge/protocol.ts`
  - Envelope type + constants.

## 3. Bridge Contract (High-Level)
- `REQUEST`: `PING`, `INIT_SESSION`, `START_PRIVATE_FLOW`, `SIGN_MESSAGE`, `SIGN_TRANSACTION`, `BROADCAST_SIGNED_TX`
- `EVENT`: `FLOW_PROGRESS`, `FLOW_RESULT`, `FLOW_ERROR`
- Channel: `sanafi-umbra-bridge`

## 4. Security Controls
- No private key persistence.
- Optional parent origin allowlist via env.
- Payload validation untuk `START_PRIVATE_FLOW`.
- Structured error mapping untuk observability.

## 5. Retry & Robustness
- Retry build transaction pada error blockhash-expired/transient.
- Timeout dan correlation id per request bridge.

---

## Environment Configuration

Copy template:
```bash
cp .env.example .env
```

Key utama:
- `VITE_SOLANA_RPC_HTTP_URL`
- `VITE_SOLANA_RPC_WS_URL`
- `VITE_UMBRA_INDEXER_API`
- `VITE_UMBRA_RELAYER_API`
- `VITE_ALLOWED_PARENT_ORIGINS` (comma-separated, optional)
- `VITE_BRIDGE_PROTOCOL_VERSION`

Contoh multiple origins:
```env
VITE_ALLOWED_PARENT_ORIGINS=https://app.sanafi.com,https://staging.sanafi.com
```

---

## Local Development

Install:
```bash
npm install
```

Run dev:
```bash
npm run dev
```

Build:
```bash
npm run build
```

---

## Integration With Mobile App

RN app akan memuat URL deployment web ini melalui:
- `EXPO_PUBLIC_UMBRA_WEBVIEW_URL`

Back navigation di web tidak dipakai; navigation di-handle native app.

---

## Deployment

Disarankan deploy ke Vercel/Netlify dengan HTTPS.

Checklist deploy:
1. Set env vars production.
2. Set domain final di mobile env.
3. Verify handshake + private flow end-to-end.
4. Monitor bridge error telemetry.

---

## Testing & Validation

Minimal validation:
1. Handshake: `PING` dan `INIT_SESSION` success.
2. `START_PRIVATE_FLOW` payload valid/invalid behavior.
3. Sign + broadcast bridge roundtrip.
4. Flow result success path + error path.

---

## Known Notes
- Bundle size besar karena Umbra SDK + prover dependency.
- Warning `crypto externalized` dari dependency chain dapat muncul di build output; monitor runtime behavior di target WebView.
