# System Status Monitor - Setup Guide

## Overview

SentryXP Status Monitor checks the health of your projects and sends alerts via **email** (SendGrid) and **Slack** when issues are detected. It also supports on-demand health report emails from the dashboard.

---

## Prerequisites

- [GitHub](https://github.com) repository (for Actions workflow)
- [Netlify](https://netlify.com) account (for hosting dashboard & serverless functions)
- [SendGrid](https://sendgrid.com) account (for email delivery - free tier: 100 emails/day)
- [Slack](https://slack.com) workspace (optional, for Slack alerts)
- [Airtable](https://airtable.com) account (for project data storage)

---

## Environment Variables / Secrets

### GitHub Actions Secrets

Go to your repo **Settings > Secrets and variables > Actions > New repository secret** and add:

| Secret Name | Required | Description |
|---|---|---|
| `AIRTABLE_BASE_ID` | Yes | Your Airtable base ID (starts with `app...`) |
| `AIRTABLE_TOKEN` | Yes | Airtable personal access token (starts with `pat...`) |
| `SENDGRID_API_KEY` | Yes | SendGrid API key for sending emails (starts with `SG.`) |
| `ALERT_FROM_EMAIL` | Yes | Verified sender email address in SendGrid |
| `SLACK_WEBHOOK_URL` | No | Slack Incoming Webhook URL for down alerts |
| `ADMIN_PASSWORD` | Yes | Password used for API authentication |

### Netlify Environment Variables

Go to your Netlify site **Site settings > Environment variables** and add:

| Variable Name | Required | Description |
|---|---|---|
| `AIRTABLE_BASE_ID` | Yes | Same as GitHub secret |
| `AIRTABLE_TOKEN` | Yes | Same as GitHub secret |
| `SENDGRID_API_KEY` | Yes | Same as GitHub secret |
| `ALERT_FROM_EMAIL` | Yes | Same as GitHub secret |
| `ADMIN_PASSWORD` | Yes | Same as GitHub secret |

> **Note:** `SLACK_WEBHOOK_URL` is only needed in GitHub Actions, not Netlify.

---

## SendGrid Setup

### 1. Create Account
- Sign up at [sendgrid.com](https://sendgrid.com) (free tier: 100 emails/day)

### 2. Create Sender Identity
- Go to **Settings > Sender Authentication**
- Choose **Single Sender Verification**
- Fill in your sender email (this becomes your `ALERT_FROM_EMAIL`)
- Verify by clicking the confirmation link sent to that email

### 3. Create API Key
- Go to **Settings > API Keys**
- Click **Create API Key**
- Name it (e.g. `system-status-monitor`)
- Select **Full Access** or **Custom Access** with only **Mail Send** enabled
- Click **Create & View**
- **Copy the key immediately** (starts with `SG.`) - you can only see it once!

### 4. Add to Secrets
- Add the API key as `SENDGRID_API_KEY` in both GitHub and Netlify
- Add your verified sender email as `ALERT_FROM_EMAIL` in both GitHub and Netlify

### Troubleshooting
- **401 "authorization grant is invalid"**: API key is wrong, expired, or revoked. Create a new one in SendGrid.
- **403 "forbidden"**: Sender email is not verified. Complete sender verification first.
- **Emails not arriving**: Check SendGrid **Activity** feed. Also check spam folders.

---

## Slack Setup (Optional)

### 1. Create Slack App
- Go to [api.slack.com/apps](https://api.slack.com/apps)
- Click **Create New App > From scratch**
- Name it (e.g. `SentryXP Monitor`)
- Select your workspace

### 2. Enable Incoming Webhooks
- In the app settings, go to **Incoming Webhooks** in the left sidebar
- Toggle **Activate Incoming Webhooks** to ON
- Click **Add New Webhook to Workspace**
- Select the channel for alerts (e.g. `#project-health-monitoring`)
- Click **Allow**
- Copy the Webhook URL (starts with `https://hooks.slack.com/services/...`)

### 3. Add to GitHub Secrets
- Add the webhook URL as `SLACK_WEBHOOK_URL` in GitHub Actions secrets

### How Slack Alerts Work
- Alerts are sent only when a site has **2 consecutive failures** (confirmed down)
- If `SLACK_WEBHOOK_URL` is not set, Slack alerts are silently skipped

---

## Local Development

### Prerequisites

- **Node.js 20+** — [Download](https://nodejs.org)
- **Netlify CLI** — Install globally: `npm install -g netlify-cli`

### 1. Install Dependencies

```bash
cd system-status-monitor
npm install
npx playwright install chromium --with-deps
```

### 2. Configure Environment Variables

Create a `.env` file in the project root with your real values:

```
AIRTABLE_BASE_ID=your_base_id
AIRTABLE_TOKEN=your_airtable_token
ADMIN_PASSWORD=your_admin_password
SENDGRID_API_KEY=SG.your_sendgrid_api_key
ALERT_FROM_EMAIL=your_verified_sender@example.com
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
```

> **Important:** The `.env` file is in `.gitignore` and should never be committed.

### 3. Run Dashboard + Functions Locally

```bash
netlify dev
```

This starts a local server at `http://localhost:8888` that serves:
- The dashboard UI (from `dashboard/`)
- All Netlify functions (from `netlify/functions/`)

> **Troubleshooting:** If you get `EADDRINUSE: address already in use`, a previous session is still running. Find and kill it:
> ```bash
> netstat -ano | findstr :3999
> taskkill /PID <THE_PID_NUMBER> /F
> ```
> Or use a different port: `netlify dev --port 8899`

You can log in via the **Manage** button, add/edit projects, and send health reports — all hitting local functions with your `.env` values.

### 4. Run Health Checks (Monitor Script)

```bash
npm run monitor
```

This runs the full health check cycle:
- Fetches project list from Airtable
- Runs Playwright-based health checks on each project
- Updates `dashboard/status.json` and `dashboard/history.json`
- Sends email alerts (via SendGrid) and Slack alerts (via webhook) if sites are confirmed down

> **Note:** Slack alerts only fire when a site has 2 consecutive failures. On the first local run, no alerts will be sent.

---

## Testing

### Test Email (without affecting live data)

Send a test health report with dummy data using curl (Windows-compatible, single line):

```bash
curl -X POST "https://projecthealthmonitoring.netlify.app/.netlify/functions/send-report" -H "Authorization: Bearer YOUR_ADMIN_PASSWORD" -H "Content-Type: application/json" -d "{\"recipientEmail\": \"jonathantubay@ymail.com\", \"ccEmails\": [\"jonathan.tubay@sentrystrategy.com\"], \"bodyMessage\": \"Hi,\\n\\nHere is your website health report for the selected period. Everything is being monitored to ensure your site stays fast, secure, and available for your customers.\\n\\nBest regards,\\nSentryXP Team\", \"projectName\": \"Test Project\", \"projectType\": \"Website\", \"projectUrl\": \"https://example.com\", \"dateRange\": {\"from\": \"2026-02-01\", \"to\": \"2026-03-01\"}, \"stats\": {\"uptimePercent\": \"99.5\", \"avgResponseMs\": 450, \"minResponseMs\": 200, \"maxResponseMs\": 1200, \"incidentCount\": 1, \"totalChecks\": 100}, \"components\": [{\"name\": \"Homepage\", \"operationalPercent\": 99.5}], \"incidents\": [{\"timestamp\": \"2026-02-15 08:30\", \"status\": \"down\", \"error\": \"Test incident\"}]}"
```

Replace `YOUR_ADMIN_PASSWORD` with your actual admin password (the `ADMIN_PASSWORD` value from your `.env` or Netlify environment variables).

### Test Slack Webhook

**Basic connection test:**
```bash
curl -X POST "https://hooks.slack.com/services/YOUR/WEBHOOK/URL" -H "Content-Type: application/json" -d "{\"text\": \"Test alert from SentryXP Monitor - Slack integration is working!\n\nhttps://projecthealthmonitoring.netlify.app/\"}"
```

**Single site down alert:**
```bash
curl -X POST "https://hooks.slack.com/services/YOUR/WEBHOOK/URL" -H "Content-Type: application/json" -d "{\"text\": \"*Health Alert*\nJordan Ranch Portal is DOWN (confirmed - 2 consecutive failures)\n\nhttps://projecthealthmonitoring.netlify.app/\"}"
```

**Multiple sites down alert:**
```bash
curl -X POST "https://hooks.slack.com/services/YOUR/WEBHOOK/URL" -H "Content-Type: application/json" -d "{\"text\": \"*Health Alert*\nJordan Ranch Portal is DOWN (confirmed - 2 consecutive failures)\nKingdomlandkids is DOWN (confirmed - 2 consecutive failures)\n\nhttps://projecthealthmonitoring.netlify.app/\"}"
```

**Site recovered alert:**
```bash
curl -X POST "https://hooks.slack.com/services/YOUR/WEBHOOK/URL" -H "Content-Type: application/json" -d "{\"text\": \"*Recovery*\nJordan Ranch Portal is back UP and operational.\n\nhttps://projecthealthmonitoring.netlify.app/\"}"
```

Replace the webhook URL with your actual Slack webhook URL.

---

## Architecture

```
GitHub Actions (monitor.yml)
  └── scripts/monitor.js        # Runs health checks on all projects
       ├── Airtable              # Reads project list & stores results
       ├── SendGrid              # Sends alert emails on failures
       └── Slack Webhook         # Sends Slack alerts on confirmed-down

Netlify Functions
  ├── send-report.js             # On-demand health report emails
  ├── get-projects.js            # API: list projects
  ├── add-project.js             # API: add project
  ├── update-project.js          # API: update project
  └── delete-project.js          # API: delete project
```

---

## Common Issues

| Issue | Cause | Fix |
|---|---|---|
| SendGrid 401 error | Invalid/expired API key | Create new API key in SendGrid, update in GitHub & Netlify |
| SendGrid 403 error | Sender not verified | Complete sender verification in SendGrid |
| Slack alerts not sending | Webhook URL not set or invalid | Verify URL in GitHub secrets |
| No email received | Check spam folder or SendGrid Activity | Review SendGrid dashboard for delivery status |
| Netlify function 401 | Wrong ADMIN_PASSWORD | Verify password matches in Netlify env vars |
