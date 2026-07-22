import { ConnectionConfig } from 'e2b';
import { describe, expect, it } from 'vitest';
import packageJson from '../package.json' with { type: 'json' };
// Importing the provider module runs `ConnectionConfig.setIntegration(...)` at
// load time. This suite uses the real `e2b` module (no mock) so it exercises
// the actual User-Agent the SDK sends.
import '../src/e2b-sandbox';

describe('SDK integration attribution', () => {
  it('tags the User-Agent with e2b-ai-sdk-sandbox/<version>', () => {
    const token = `e2b-ai-sdk-sandbox/${packageJson.version}`;
    const userAgent = new ConnectionConfig().headers?.['User-Agent'] ?? '';
    expect(userAgent.split(/\s+/)).toContain(token);
  });
});
