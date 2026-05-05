# Dental Motion

Landing page for selling dental motion graphic videos.

## Local preview

Open `index.html` directly, or run:

```bash
npm start
```

Then visit `http://127.0.0.1:4173`.

## Interaction checks

With the server running, run:

```bash
npm test
```

## Contact Form Email

Form submissions post to `/api/contact` and are sent to
`team@dentalmotiongraphic.com`. Each submission is also saved in a Postgres
table named `contact_submissions`.

Recommended email setup is Resend because Google App Passwords may be
unavailable for some Workspace accounts.

```bash
DATABASE_URL=<Railway Postgres connection string>
CONTACT_TO_EMAIL=team@dentalmotiongraphic.com
RESEND_API_KEY=<Resend API key>
# RESEND_KEY is also supported if that is the variable name used in Railway.
RESEND_FROM_EMAIL=Dental Motion <hello@dentalmotiongraphic.com>
```

SMTP is also supported as a fallback:

```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=team@dentalmotiongraphic.com
SMTP_PASS=<Google app password>
SMTP_FROM_EMAIL=team@dentalmotiongraphic.com
```

The app creates this table automatically on the first valid form submission:

```sql
SELECT created_at, name, email, offer, email_sent, email_error
FROM contact_submissions
ORDER BY created_at DESC;
```

You can access saved leads from the Railway Postgres service Data/Query tab, or
from a terminal with:

```bash
railway connect Postgres
```

## Railway Email Campaigns

The app also includes a Railway-hosted, admin-only campaign sender for
permission-based email lists. It uses Resend with
`team@dentalmotiongraphic.com`, saves subscribers and campaign history in
Postgres, and adds unsubscribe links to every campaign email.

Required Railway variables:

```bash
EMAIL_ADMIN_TOKEN=<long random secret>
PUBLIC_SITE_URL=https://dentalmotiongraphic.com
EMAIL_CAMPAIGN_FROM_EMAIL=Dental Motion <team@dentalmotiongraphic.com>
EMAIL_FOOTER_ADDRESS=Dental Motion, dentalmotiongraphic.com
EMAIL_CAMPAIGN_BATCH_SIZE=50
EMAIL_CAMPAIGN_DELAY_MS=250
EMAIL_CAMPAIGN_MAX_RECIPIENTS=500
```

Only import people who gave permission to receive email. Every import must
include a `consent_note`.

Example subscriber import file:

```json
{
  "consent_note": "These clinics asked to receive Dental Motion email updates.",
  "subscribers": [
    {
      "email": "owner@example.com",
      "name": "Clinic Owner",
      "clinic": "Example Dental",
      "source": "manual list"
    }
  ]
}
```

Import subscribers through Railway:

```bash
railway run --service dental-motion-atelier node scripts/email-admin.js import subscribers.json
```

Example campaign file:

```json
{
  "subject": "Dental motion graphic videos for your clinic",
  "preview_text": "Show treatments clearly with elegant dental animation.",
  "html": "<h1>Dental motion graphic videos</h1><p>We create colorful, elegant dental motion graphic videos for clinics and dental brands.</p><p>Reply to this email if you want a short custom video quote.</p>",
  "text": "Dental motion graphic videos\n\nWe create colorful, elegant dental motion graphic videos for clinics and dental brands.\n\nReply to this email if you want a short custom video quote.",
  "limit": 100,
  "batch_size": 50,
  "send": true
}
```

Send a campaign through Railway:

```bash
railway run --service dental-motion-atelier node scripts/email-admin.js send campaign.json
```

Check subscriber totals:

```bash
railway run --service dental-motion-atelier node scripts/email-admin.js stats
```

The app creates these tables automatically:

```sql
SELECT email, name, clinic, source, unsubscribed_at, last_sent_at
FROM email_subscribers
ORDER BY created_at DESC;

SELECT id, subject, status, total_recipients, sent_count, failed_count
FROM email_campaigns
ORDER BY created_at DESC;
```
