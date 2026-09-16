# Deploying Sweep + CISD (one service: API + dashboard)

The whole app ships as **one Docker image** (React build served by FastAPI). Deploy anywhere that runs Docker.

## Option A — Render (easiest, ~5 minutes)
1. Push this folder to a GitHub repo.
2. https://dashboard.render.com → **New → Blueprint** → pick the repo. `render.yaml` is detected automatically.
3. Render generates `BRIDGE_TOKEN` and `DASHBOARD_PASSWORD` for you → copy them from *Environment* after deploy.
4. Your URL: `https://sweep-cisd.onrender.com` (dashboard) · `/docs` (API docs).

> Use the **Starter ($7/mo)** plan or the free instance sleeps after 15 min and MT5 heartbeats will fail.

## Option B — Railway
1. https://railway.app → New Project → Deploy from GitHub repo.
2. Variables: `BRIDGE_TOKEN`, `DASHBOARD_PASSWORD` (long random strings). Add a Volume mounted at `/data`.
3. Settings → Networking → Generate Domain.

## Option C — Fly.io (CLI)
```bash
fly launch --copy-config --no-deploy
fly volumes create data --size 1 --region sin
fly secrets set BRIDGE_TOKEN=$(openssl rand -hex 24) DASHBOARD_PASSWORD=$(openssl rand -hex 12)
fly deploy
```

## Option D — Any VPS (Docker)
```bash
cp .env.example .env   # edit secrets
docker compose up -d --build     # http://YOUR_IP:8000
```
Put nginx/Caddy with HTTPS in front for a public domain.

## After deploy: connect MT5
1. MT5 → Tools → Options → Expert Advisors → tick *Allow WebRequest for listed URL* → add `https://YOUR-APP-URL`
2. EA inputs: `ServerURL = https://YOUR-APP-URL` (no trailing slash), `BridgeToken = <BRIDGE_TOKEN>`
3. Dashboard → Live: green "EA connected" within ~10 s.

## Where does the EA itself run?
The EA **must** run inside MetaTrader 5, 24/5. Options:
- Your friend's Windows PC left on (simplest for demo testing)
- A **Forex VPS** (e.g. the broker's built-in MT5 VPS, ~$10–15/mo, or any Windows VPS). Recommended for real money.

The web app only *monitors and controls* it; if the web app is down, the EA keeps trading on its own rules.
