# Satori — TMC Capability Intelligence (v2)

An AI-powered workforce + sales intelligence platform for TMC. Successor to the original
Satori; this version adds proper auth (JWT + 2FA), user-customisable dashboards, report
generation, and a sharper SAP-partner-ready demo posture.

## Stack
- **Backend:** FastAPI 0.135 · Python 3.11 · uv for deps · OpenTelemetry → Cloud Trace
- **Frontend:** React 19 + Vite 7 + recharts + lucide-react (single-file `Growgnition.jsx`)
- **Data:** BigQuery `ai-vertex-mahad.Satori_Project` (10 workforce + sales tables)
- **State:** Cloud SQL Postgres (users, dashboards, audit, reports) + Firestore (chat state)
- **AI:** Gemini 2.5 Flash (text) · Gemini Live API (voice — pending rebuild)
- **Hosting:** Cloud Run · distroless container · Cloud Build CI/CD on every push to `main`
- **Auth:** JWT + bcrypt + TOTP 2FA + backup codes

## Live URL
After running `HOSTING.md` bootstrap: `https://satori-v2-<hash>-uc.a.run.app`

## Local dev
```bash
# Backend
cd backend
pip install -r requirements.txt
export VERTEX_PROJECT=ai-vertex-mahad VERTEX_DATASET=Satori_Project GEMINI_API_KEY=...
uvicorn main:app --reload --port 8080

# Frontend
cd frontend
npm install
npm run dev   # opens http://localhost:5173
```

## Deploy
Just `git push origin main`. Cloud Build picks it up, builds the container,
deploys to Cloud Run. See `HOSTING.md` for the one-time bootstrap.

## v1 known gaps
- Voice agent: backend `/ws/voice` is a stub (text chat works fully).
- Persistent chat history: not wired (intentional for v1).
- Reports: API stubs return 501.
- A few admin endpoints (audit, retention sweep, GDPR export) are stubbed.

## Repo layout
```
backend/         FastAPI service, BigQuery client, auth, audit, redact
frontend/        Vite + React 19 single-file UI (Growgnition.jsx)
Dockerfile       3-stage build: node frontend → uv python → distroless runtime
cloudbuild.yaml  CI/CD: syntax check → build → push → deploy
HOSTING.md       One-time bootstrap runbook
```
