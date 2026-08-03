# NUAN Business Manager

Sales, expenses, inventory, profit, settings, and trend monitoring for NUAN Pastillas.

## Firebase setup

1. Create a Firebase project and Web App.
2. Enable Email/Password under Authentication.
3. Create a Firestore database.
4. Copy `.env.example` to `.env.local` and add the Firebase Web App configuration.
5. Publish the included `firestore.rules` before using real business records.

## Development

```bash
npm install
npm run dev
```

Configure the same `NEXT_PUBLIC_FIREBASE_*` variables in Vercel.
