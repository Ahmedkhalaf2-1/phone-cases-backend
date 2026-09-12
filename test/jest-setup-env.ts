import 'dotenv/config';

// e2e tests must run against the dedicated test database, never the dev
// one. TEST_DATABASE_URL is loaded from .env above; dotenv does not
// override a variable that is already set, so setting DATABASE_URL here
// (before ConfigModule ever loads) makes the whole app under test use it.
if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Copy .env.example to .env and start the ' +
      '"postgres_test" docker-compose service before running e2e tests.',
  );
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = 'test';

// Order-creation e2e tests need a payment method configured to exercise
// the endpoint at all - "none" (the real default) is covered by a
// dedicated test that builds its own app instance with this overridden.
// This is the clearly-labeled dev/test-only simulation described in
// docs/DECISIONS.md - never used outside NODE_ENV=test/development.
process.env.PAYMENT_METHOD ??= 'mock_dev_only';
process.env.RESERVATION_TTL_MINUTES ??= '15';
