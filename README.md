# Dental Motion Atelier

Luxury landing page for selling dental motion graphic videos.

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
