# Nova Spark Backend API

Node.js + Express API backend for Nova Spark.

## Setup Instructions

1. **Configure Environment Variables**
   Copy the example environment file and fill in your Supabase credentials:
   ```bash
   cp .env.example .env
   ```
   Fill in `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env`.

2. **Run Database Migrations**
   Open the Supabase dashboard SQL Editor and run the SQL script found in:
   ```
   backend/sql/schema.sql
   ```

3. **Start the Development Server**
   ```bash
   npm run dev
   ```
   The backend API will run at `http://localhost:4000`.

## Testing the API with curl

Run these 4 curl commands to test the endpoints:

1. **Health Check**
   ```bash
   curl http://localhost:4000/api/health
   ```
   Expected response: `{"ok":true}`

2. **Get Roadmap**
   ```bash
   curl http://localhost:4000/api/roadmap
   ```
   Expected response: JSON array of roadmap milestones.

3. **Get Team**
   ```bash
   curl http://localhost:4000/api/team
   ```
   Expected response: JSON array of team members.

4. **Subscribe to Newsletter**
   ```bash
   curl -X POST http://localhost:4000/api/subscribe \
     -H "Content-Type: application/json" \
     -d '{"email":"user@example.com","website":""}'
   ```
   Expected response: `{"ok":true}`
