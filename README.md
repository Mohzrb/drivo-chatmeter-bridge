# Chatmeter → Zendesk Bridge

This project pulls reviews from **Chatmeter v5 API** and creates or updates **Zendesk tickets** with internal notes.  
It also avoids duplicate comments and can be automated via **GitHub Actions** or **Vercel Cron**.

---

## 🚀 Quick Start

1. **Create a Vercel project** and import this repo.
2. In Vercel → **Settings → Environment Variables**, add values from `.env.example`.
3. Deploy the project.
4. Verify the endpoints:
   - `/api/ping`
   - `/api/selftest`
   - `/api/whoami`
   - `/api/poll-v2?minutes=60&max=5`

---

## 🔁 Automation Options

### Option 1: GitHub Actions
A workflow file is included at `.github/workflows/poll.yml`.  
Set these repository secrets:
- `BASE_URL` = your app URL (e.g., `https://drivo-chatmeter-bridge.vercel.app`)
- `CRON_SECRET` = the same value used in Vercel

### Option 2: Vercel Cron
Use the Vercel dashboard to call:
