# Implementation Plan: Add GET /health Endpoint

## Overview

Add a `GET /health` endpoint returning `{ status: 'healthy', uptime: process.uptime() }` to the Express API. This involves splitting the monolithic `src/index.ts` into a testable app module (`src/app.ts`) and a thin entrypoint (`src/index.ts`), installing supertest for HTTP-level testing, and following strict TDD (red → green).

---

## Task 1: Install test dependencies

### Description

Add `supertest` and `@types/supertest` as dev dependencies. These are required for HTTP-level testing of Express routes without starting a real server.

### Steps

1. Run: `npm install -D supertest@^7.0.0 @types/supertest@^6.0.0`
2. Verify `package.json` now lists both packages under `devDependencies`.

### Verification

```bash
node -e "require('supertest')" 2>/dev/null && echo 'supertest OK' || echo 'FAIL'
```

### Files

- `package.json` (modified — two new devDependencies added)

---

## Task 2: Extract app module and write tests (TDD red)

### Description

Split `src/index.ts` into two files: `src/app.ts` (pure app definition, no side effects) and `src/index.ts` (thin entrypoint that listens). Then create `src/app.test.ts` with tests for both `GET /` and `GET /health`. At this point, the `/health` route does **not** exist yet, so the `/health` tests must fail (TDD red state) while the `GET /` test passes.

### Steps

**Step 1 — Create `src/app.ts`** with the existing `GET /` route but **without** the `/health` route and **without** `app.listen()`:

```typescript
// src/app.ts
import express from "express";

const app = express();

app.get("/", (req, res) => {
  res.json({ status: "ok" });
});

export { app };
```

**Step 2 — Rewrite `src/index.ts`** to be a thin entrypoint that imports the app and starts the server:

```typescript
// src/index.ts
import { app } from "./app.js";

const port = 3000;

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
```

**Step 3 — Create `src/app.test.ts`** with all tests:

```typescript
// src/app.test.ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "./app.js";

describe("GET /", () => {
  it("returns 200 with { status: 'ok' }", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("GET /health", () => {
  it("returns 200 with content-type json", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/json/);
  });

  it("returns { status: 'healthy', uptime: <number> }", async () => {
    const res = await request(app).get("/health");
    expect(res.body.status).toBe("healthy");
    expect(res.body.uptime).toBeTypeOf("number");
  });
});
```

### Verification

Run tests — expect 1 pass (`GET /`) and 2 failures (`GET /health` tests):

```bash
npx vitest run src/app.test.ts
```

Expected output: 1 passed, 2 failed (the two `/health` tests return 404).

### Files

- `src/app.ts` (created)
- `src/index.ts` (rewritten)
- `src/app.test.ts` (created)

---

## Task 3: Add the /health route (TDD green)

### Description

Add the `GET /health` route handler to `src/app.ts`. The handler returns `{ status: 'healthy', uptime: process.uptime() }`. This makes all failing tests pass, completing the TDD red → green cycle.

### Steps

**Step 1 — Update `src/app.ts`** to add the `/health` route after the existing `GET /` route:

```typescript
// src/app.ts
import express from "express";

const app = express();

app.get("/", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/health", (req, res) => {
  res.json({ status: "healthy", uptime: process.uptime() });
});

export { app };
```

### Verification

Run tests — all 3 tests should pass:

```bash
npx vitest run src/app.test.ts
```

Expected output: 3 passed, 0 failed.

### Files

- `src/app.ts` (modified — `/health` route added)

---

## Summary

| Task | State | Tests |
|------|-------|-------|
| 1. Install test deps | Setup | N/A |
| 2. Extract app + write tests | TDD Red | 1 pass, 2 fail |
| 3. Add /health route | TDD Green | 3 pass |

```superteam-tasks
- title: Install test dependencies
  description: "Add supertest and @types/supertest as dev dependencies for HTTP-level route testing. Run: npm install -D supertest@^7.0.0 @types/supertest@^6.0.0. Verify package.json lists both."
  files: [package.json]
- title: Extract app module and write tests (TDD red)
  description: |
    Split src/index.ts into src/app.ts (pure app definition with GET / route, no listen) and src/index.ts (thin entrypoint importing app and calling app.listen). Create src/app.test.ts with supertest tests for GET / (expects 200, { status: 'ok' }) and GET /health (expects 200 json with { status: 'healthy', uptime: <number> }). The /health route is NOT added yet so 2 tests fail (TDD red). Verify with: npx vitest run src/app.test.ts (expect 1 pass, 2 fail).

    src/app.ts content:
    ```typescript
    import express from "express";
    const app = express();
    app.get("/", (req, res) => { res.json({ status: "ok" }); });
    export { app };
    ```

    src/index.ts content:
    ```typescript
    import { app } from "./app.js";
    const port = 3000;
    app.listen(port, () => { console.log(`Server running on port ${port}`); });
    ```

    src/app.test.ts content:
    ```typescript
    import { describe, it, expect } from "vitest";
    import request from "supertest";
    import { app } from "./app.js";

    describe("GET /", () => {
      it("returns 200 with { status: 'ok' }", async () => {
        const res = await request(app).get("/");
        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toMatch(/json/);
        expect(res.body).toEqual({ status: "ok" });
      });
    });

    describe("GET /health", () => {
      it("returns 200 with content-type json", async () => {
        const res = await request(app).get("/health");
        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toMatch(/json/);
      });

      it("returns { status: 'healthy', uptime: <number> }", async () => {
        const res = await request(app).get("/health");
        expect(res.body.status).toBe("healthy");
        expect(res.body.uptime).toBeTypeOf("number");
      });
    });
    ```
  files: [src/app.ts, src/index.ts, src/app.test.ts]
- title: Add the /health route (TDD green)
  description: |
    Add the GET /health route handler to src/app.ts after the existing GET / route. The handler returns res.json({ status: 'healthy', uptime: process.uptime() }). This makes all 3 tests pass. Verify with: npx vitest run src/app.test.ts (expect 3 pass, 0 fail).

    Updated src/app.ts content:
    ```typescript
    import express from "express";
    const app = express();
    app.get("/", (req, res) => { res.json({ status: "ok" }); });
    app.get("/health", (req, res) => { res.json({ status: "healthy", uptime: process.uptime() }); });
    export { app };
    ```
  files: [src/app.ts]
```
