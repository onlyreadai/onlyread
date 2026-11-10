// Before any suite: the extension under test must be the plain development build. One made for a Pro service
// (ONLYREAD_SERVICE_URL) moves the test browser off the fixture's mock when its worker starts (background/messages.ts
// applyBuildService), and a release has no dev sink to drive it. The npm e2e scripts build it so; `npx playwright test`
// run directly takes whatever extension/dist holds, so it is checked here.
import { readFileSync } from 'node:fs';

export default function globalSetup(): void {
  let info: { dist?: unknown; serviceUrl?: unknown };
  try { info = JSON.parse(readFileSync('extension/dist/build-info.json', 'utf8')); } catch {
    throw new Error('extension/dist has no build-info.json: build it first (npm run build, or run npm run e2e)');
  }
  if (info.dist) throw new Error('extension/dist holds a release build; the e2e suites need the development build (npm run build)');
  if (info.serviceUrl) {
    throw new Error(`extension/dist was built for ${String(info.serviceUrl)} (ONLYREAD_SERVICE_URL); the e2e suites need the mock: rebuild with it unset (npm run build), or run npm run e2e`);
  }
}
