# The Common Notebook

A shared, real-time chat page where signed-in users exchange notes on one common "notebook".

- Live notes over WebSockets, with an online list and typing indicator
- Notes persist to `data/notes.json` (last 500 kept)
- Enter to send a note, Shift+Enter for a new line; URLs become links

## Accounts

There is no self-signup — **only admins can create accounts**.

- On first start (when `data/users.json` doesn't exist) the server creates an `admin` account and prints a
  temporary password to the console. Set `ADMIN_USERNAME` / `ADMIN_PASSWORD` to choose them yourself.
- Admins open **Manage users** in the sidebar to create users (Member or Admin), reset passwords,
  change roles, disable/enable or delete accounts. Deleted users' notes stay in the notebook.
- New or reset accounts get a temporary password; the user must choose their own at first sign-in.
- Disabling, deleting or resetting a user signs them out everywhere immediately.
- Lost admin access? Stop the server, run `npm run create-admin -- <username>`, then start it again.

Passwords are hashed with scrypt; sessions are HttpOnly cookies valid for 30 days. Failed sign-ins are
throttled per IP. Set `COOKIE_SECURE=1` when serving over HTTPS (or behind a proxy that sets
`X-Forwarded-Proto: https`).

## Run

```bash
npm install
npm start            # http://localhost:3000  (override with PORT=8080 npm start)
```

Data files (`data/users.json`, `data/sessions.json`, `data/notes.json`) are created automatically.

## Run with Docker

Build and start the container with Docker Compose:

```bash
docker compose up --build -d
docker compose logs -f notebook
```

Open <http://localhost:3000>. On first start, the server creates an admin account and prints its
temporary password in the container logs. Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` in your
environment before starting to configure the initial account yourself. The data files are kept in
the `notebook-data` named volume across container rebuilds and restarts.

To stop the container, run `docker compose down`. The named volume is retained; use
`docker compose down -v` only if you also want to delete the stored users, sessions, and notes.
When serving over HTTPS, set `COOKIE_SECURE=1`.
